import { listen } from "@tauri-apps/api/event";
import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";

import {
  cancelTransfer,
  downloadTransfer,
  removeTransfer,
  uploadTransfer,
} from "@/api/transfer";
import { joinPath } from "@/utils/format";

export type TransferStatus = "queued" | "running" | "done" | "failed" | "cancelled";
export type TransferDirection = "upload" | "download" | "remote-copy" | "remote-move";

/** 面板行（speedHistory 为速度折线采样，最新在末尾） */
export interface TransferRow {
  id: string;
  direction: TransferDirection;
  fileName: string;
  bytes: number;
  total: number;
  speedBps: number;
  status: TransferStatus;
  error?: string;
  speedHistory: number[];
}

/** 速度折线最大采样数（Files SpeedGraph 同款滑动窗口思路） */
const SPEED_SAMPLES = 48;

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
/** 远端操作句柄：前端编排批次，isCancelled 控制逐项停止 */
export interface RemoteOpHandle {
  id: string;
  isCancelled: () => boolean;
  setDone: () => void;
  setFailed: (error: string) => void;
}

/** 远端批次取消函数登记（取消即停止批次剩余项） */
const remoteOpCancels = new Map<string, () => void>();

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
      if (p.status === "running" && p.speedBps > 0) {
        row.speedHistory.push(p.speedBps);
        if (row.speedHistory.length > SPEED_SAMPLES) row.speedHistory.shift();
      }
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
        speedHistory: [],
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

  async function startUpload(
    connectionId: string,
    localPath: string,
    remoteDir: string,
    /** 冲突改名后的远端名；缺省用本地文件名 */
    remoteName?: string,
  ) {
    const id = crypto.randomUUID();
    const fileName = remoteName ?? localBaseName(localPath);
    rows.value.unshift({
      id,
      direction: "upload",
      fileName,
      bytes: 0,
      total: 0,
      speedBps: 0,
      status: "queued",
      speedHistory: [],
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
    await startDownloadTo(connectionId, remotePath, localPath);
  }

  /** 下载并入队，返回 transferId（剪贴板编排需要等待其完成） */
  async function startDownloadTo(
    connectionId: string,
    remotePath: string,
    localPath: string,
  ): Promise<string> {
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
      speedHistory: [],
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
    return id;
  }

  /** 等待一组传输全部到达终态；全部成功返回 true（事件驱动，无轮询开销） */
  function waitAllDone(ids: string[]): Promise<boolean> {
    return new Promise((resolve) => {
      const terminal = new Map<string, string>();
      const check = () => {
        let ready = true;
        for (const id of ids) {
          const row = rows.value.find((r) => r.id === id);
          if (!row || !["done", "failed", "cancelled"].includes(row.status)) {
            ready = false;
            break;
          }
          terminal.set(id, row.status);
        }
        if (ready) {
          unwatch();
          resolve([...terminal.values()].every((s) => s === "done"));
        }
      };
      const unwatch = watch(rows, check, { deep: true });
      check();
    });
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

  /** 面板头部「清除已完成」（Files StatusCenter 同款）：清掉全部终态行 */
  async function clearFinished() {
    const finished = rows.value
      .filter((r) => !isActiveStatus(r.status))
      .map((r) => r.id);
    for (const id of finished) {
      await removeRow(id);
    }
  }

  function isActiveStatus(status: TransferStatus): boolean {
    return status === "queued" || status === "running";
  }

  /**
   * 远端内部复制/移动卡片（Files StatusCenterHelper.AddCard_Copy/AddCard_Move 的
   * 文案模式）：不定进度，取消 = 停止批次剩余项；完成/失败留结果卡。
   */
  async function startRemoteOp(
    kind: "remote-copy" | "remote-move",
    itemCount: number,
    targetDir: string,
  ): Promise<RemoteOpHandle> {
    const id = crypto.randomUUID();
    const verb = kind === "remote-copy" ? "复制" : "移动";
    const runningTitle = `正在${verb} ${itemCount} 个项目到 ${targetDir}`;
    const doneTitle = `已${verb} ${itemCount} 个项目到 ${targetDir}`;
    rows.value.unshift({
      id,
      direction: kind,
      fileName: runningTitle,
      bytes: 0,
      total: 0,
      speedBps: 0,
      status: "running",
      speedHistory: [],
    });
    let cancelled = false;
    remoteOpCancels.set(id, () => {
      cancelled = true;
    });
    const rowOf = () => rows.value.find((r) => r.id === id);
    const terminal = () => {
      const status = rowOf()?.status;
      return status === "done" || status === "failed" || status === "cancelled";
    };
    return {
      id,
      isCancelled: () => cancelled,
      setDone: () => {
        const row = rowOf();
        if (row && !terminal()) {
          row.status = "done";
          row.fileName = doneTitle;
        }
      },
      setFailed: (error: string) => {
        const row = rowOf();
        if (row && !terminal()) {
          row.status = "failed";
          row.fileName = `无法${verb} ${itemCount} 个项目到 ${targetDir}`;
          row.error = error;
        }
      },
    };
  }

  /** 取消远端批次（卡片置已取消，编排循环在下一项前停止） */
  function cancelRemoteOp(id: string) {
    remoteOpCancels.get(id)?.();
    remoteOpCancels.delete(id);
    const row = rows.value.find((r) => r.id === id);
    if (row && row.status === "running") {
      row.status = "cancelled";
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
    startDownloadTo,
    startRemoteOp,
    cancelRemoteOp,
    waitAllDone,
    cancel,
    removeRow,
    clearFinished,
  };
});
