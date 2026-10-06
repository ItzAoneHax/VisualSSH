import { listen } from "@tauri-apps/api/event";
import { defineStore } from "pinia";
import { computed, ref } from "vue";

import {
  cancelTransfer,
  downloadTransfer,
  removeTransfer,
  uploadTransfer,
} from "@/api/transfer";
import { joinPath } from "@/utils/format";

export type TransferStatus = "queued" | "running" | "done" | "failed" | "cancelled";
export type TransferDirection = "upload" | "download";

/** 面板行 */
export interface TransferRow {
  id: string;
  direction: TransferDirection;
  fileName: string;
  bytes: number;
  total: number;
  speedBps: number;
  status: TransferStatus;
  error?: string;
}

/** transfer://progress 事件负载（与后端 TransferInfo 的 camelCase 序列化对应） */
interface TransferPayload {
  transferId: string;
  direction: TransferDirection;
  fileName: string;
  bytes: number;
  total: number;
  speedBps: number;
  status: TransferStatus;
  error?: string;
}

/** 浏览器预览（无 Tauri）时跳过事件绑定；mock 自测由 bindEvents 手动重入 */
const isTauri = () => "__TAURI_INTERNALS__" in window;

function localBaseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function remoteBaseName(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

/**
 * 传输中心状态：行数据全部由后端 transfer://progress 事件驱动；
 * 动作（上传/下载/取消/清除）只发起命令，不本地乐观改状态。
 */
export const useTransferStore = defineStore("transfer", () => {
  /** 最新在前 */
  const rows = ref<TransferRow[]>([]);
  let unlisten: (() => void) | null = null;

  const activeCount = computed(
    () =>
      rows.value.filter((r) => r.status === "queued" || r.status === "running")
        .length,
  );
  const totalSpeedBps = computed(() =>
    rows.value
      .filter((r) => r.status === "running")
      .reduce((sum, r) => sum + r.speedBps, 0),
  );

  function applyEvent(p: TransferPayload) {
    const row = rows.value.find((r) => r.id === p.transferId);
    if (row) {
      row.direction = p.direction;
      row.fileName = p.fileName;
      row.bytes = p.bytes;
      row.total = p.total;
      row.speedBps = p.speedBps;
      row.status = p.status;
      row.error = p.error;
    } else {
      rows.value.unshift({
        id: p.transferId,
        direction: p.direction,
        fileName: p.fileName,
        bytes: p.bytes,
        total: p.total,
        speedBps: p.speedBps,
        status: p.status,
        error: p.error,
      });
    }
  }

  /** 订阅后端事件；幂等（已绑定或环境不支持则直接返回） */
  async function bindEvents() {
    if (unlisten || !isTauri()) return;
    unlisten = await listen<TransferPayload>("transfer://progress", (event) =>
      applyEvent(event.payload),
    );
  }

  async function startUpload(connectionId: string, localPath: string, remoteDir: string) {
    const id = crypto.randomUUID();
    const fileName = localBaseName(localPath);
    rows.value.unshift({
      id,
      direction: "upload",
      fileName,
      bytes: 0,
      total: 0,
      speedBps: 0,
      status: "queued",
    });
    try {
      await uploadTransfer(id, connectionId, localPath, joinPath(remoteDir, fileName));
    } catch (e) {
      applyEvent({
        transferId: id,
        direction: "upload",
        fileName,
        bytes: 0,
        total: 0,
        speedBps: 0,
        status: "failed",
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  async function startDownload(
    connectionId: string,
    remotePath: string,
    localPath: string,
  ) {
    const id = crypto.randomUUID();
    const fileName = remoteBaseName(remotePath);
    rows.value.unshift({
      id,
      direction: "download",
      fileName,
      bytes: 0,
      total: 0,
      speedBps: 0,
      status: "queued",
    });
    try {
      await downloadTransfer(id, connectionId, remotePath, localPath);
    } catch (e) {
      applyEvent({
        transferId: id,
        direction: "download",
        fileName,
        bytes: 0,
        total: 0,
        speedBps: 0,
        status: "failed",
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /** 取消：状态由后端事件回写（≤150ms 轮询） */
  async function cancel(id: string) {
    try {
      await cancelTransfer(id);
    } catch {
      // 已结束或不存在：等终态事件/列表兜底
    }
  }

  /** 清除已结束的行 */
  async function removeRow(id: string) {
    try {
      if (await removeTransfer(id)) {
        rows.value = rows.value.filter((r) => r.id !== id);
      }
    } catch {
      // 仍在进行中等后端拒绝：保留行
    }
  }

  return {
    rows,
    activeCount,
    totalSpeedBps,
    bindEvents,
    applyEvent,
    startUpload,
    startDownload,
    cancel,
    removeRow,
  };
});
