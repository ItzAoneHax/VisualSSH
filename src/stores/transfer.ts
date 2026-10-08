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
export type TransferDirection =
  | "upload"
  | "download"
  | "remote-copy"
  | "remote-move"
  | "folder-download"
  | "folder-upload"
  | "archive";

/** 聚合卡批次状态（编排层驱动；进度统计由子行实时聚合，见 TransferCenter） */
export interface FolderBatchState {
  /** walking=枚举清单中；transferring=逐文件传输中 */
  phase: "walking" | "transferring";
  /** 决策后待传文件数与总字节（进度分母） */
  filesTotal: number;
  bytesTotal: number;
  /** 枚举阶段已发现条目数（walk 事件） */
  discovered: number;
  /** 跳过的符号链接数 */
  skippedLinks: number;
  /** 终态失败清单快照（子行被「清除已完成」删掉后统计仍可显示） */
  failedItems?: { name: string; error: string }[];
  /** 整批失败原因（walk 失败等；单文件失败不置此字段） */
  error?: string;
}

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
  /** 子传输归属的聚合卡 id（渲染层折叠进父卡） */
  batchId?: string;
  /** 聚合卡批次状态（仅聚合卡行携带） */
  batch?: FolderBatchState;
}

/** 聚合卡动作句柄（编排层注册：整批取消 / 重试失败项） */
export interface BatchHandle {
  cancel: () => void;
  retryFailed?: () => void;
  /** 是否可重试（由编排层按失败清单动态判定） */
  canRetry: () => boolean;
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

/** 压缩/解压 exec 卡句柄：终态转轨由编排层在 archive://done 事件回调里调（终态后不可再改） */
export interface ArchiveOpHandle {
  id: string;
  setDone: (doneTitle: string) => void;
  setFailed: (error: string) => void;
  setCancelled: () => void;
}

/** 远端批次取消函数登记（取消即停止批次剩余项） */
const remoteOpCancels = new Map<string, () => void>();

/** 聚合卡动作句柄登记（cancel/retryFailed 由编排层闭包实现） */
const batchHandles = new Map<string, BatchHandle>();

/** 单文件重试参数登记（断连失败后可重试；D3） */
interface RetryInfo {
  direction: "upload" | "download";
  connectionId: string;
  /** 上传=本地路径；下载=远端路径 */
  src: string;
  /** 上传=远端目录；下载=本地路径 */
  dst: string;
  fileName: string;
}
const retryInfos = new Map<string, RetryInfo>();

export const useTransferStore = defineStore("transfer", () => {
  /** 最新在前 */
  const rows = ref<TransferRow[]>([]);
  let unlisten: (() => void) | null = null;

  /** 活动计数：批次子行由聚合卡代表，不重复计入（Files 聚合卡语义） */
  const activeCount = computed(
    () =>
      rows.value.filter(
        (r) =>
          !r.batchId && (r.status === "queued" || r.status === "running"),
      ).length,
  );
  /** 总速度：批次子行已聚合进父卡（applyEvent 维护），不重复计入 */
  const totalSpeedBps = computed(() =>
    rows.value
      .filter((r) => r.status === "running" && !r.batchId)
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
      // 批次子行：聚合速度写回父卡（字节加权同 Files StatusCenterItemProgressModel）
      if (row.batchId) {
        const parent = rows.value.find((r) => r.id === row.batchId);
        if (parent?.batch) {
          const speed = rows.value
            .filter((r) => r.batchId === row.batchId && r.status === "running")
            .reduce((s, r) => s + r.speedBps, 0);
          parent.speedBps = speed;
          parent.speedHistory.push(speed);
          if (parent.speedHistory.length > SPEED_SAMPLES) parent.speedHistory.shift();
        }
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

  /** 上传并入队，返回 transferId（await 返回 = 已注册，非终态；终态等事件/waitAllDone） */
  async function startUpload(
    connectionId: string,
    localPath: string,
    remoteDir: string,
    /** 冲突改名后的远端名；缺省用本地文件名 */
    remoteName?: string,
    /** 递归批次归属（聚合卡折叠子行） */
    batchId?: string,
  ): Promise<string> {
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
      batchId,
    });
    try {
      await uploadTransfer(id, connectionId, localPath, joinPath(remoteDir, fileName));
      retryInfos.set(id, {
        direction: "upload",
        connectionId,
        src: localPath,
        dst: remoteDir,
        fileName,
      });
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
    return id;
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
    batchId?: string,
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
      batchId,
    });
    try {
      await downloadTransfer(id, connectionId, remotePath, localPath);
      retryInfos.set(id, {
        direction: "download",
        connectionId,
        src: remotePath,
        dst: localPath,
        fileName,
      });
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

  /** —— 压缩/解压 exec 卡（第五阶段块 C，不定进度同远端批次卡）—— */

  /** 取消闭包登记（取消 = ssh_archive_cancel 杀远端通道） */
  const archiveCancels = new Map<string, () => void>();

  /** 创建不定进度 exec 卡（压缩/解压共用） */
  function startArchiveOp(runningTitle: string): ArchiveOpHandle {
    const id = crypto.randomUUID();
    rows.value.unshift({
      id,
      direction: "archive",
      fileName: runningTitle,
      bytes: 0,
      total: 0,
      speedBps: 0,
      status: "running",
      speedHistory: [],
    });
    const rowOf = () => rows.value.find((r) => r.id === id);
    const terminal = () => {
      const status = rowOf()?.status;
      return status === "done" || status === "failed" || status === "cancelled";
    };
    return {
      id,
      setDone: (doneTitle: string) => {
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
          row.error = error;
        }
      },
      setCancelled: () => {
        const row = rowOf();
        if (row && !terminal()) row.status = "cancelled";
      },
    };
  }

  /** 编排层登记取消闭包（卡片 ⋯ 菜单 → cancelArchiveOp） */
  function registerArchiveCancel(id: string, cancel: () => void) {
    archiveCancels.set(id, cancel);
  }

  /** 取消 exec 卡：杀远端通道；行转已取消（done 事件迟到时终态保护跳过） */
  function cancelArchiveOp(id: string) {
    archiveCancels.get(id)?.();
    archiveCancels.delete(id);
    const row = rows.value.find((r) => r.id === id);
    if (row && row.status === "running") row.status = "cancelled";
  }

  /** —— 递归目录批次聚合卡（Files StatusCenterHelper.AddCard_Copy 聚合范式）—— */

  /** 创建聚合卡（phase=walking：枚举清单中）；返回批次 id（即卡行 id） */
  function startFolderBatch(
    kind: "folder-download" | "folder-upload",
    folderName: string,
    targetLabel: string,
  ): string {
    const id = crypto.randomUUID();
    const verb = kind === "folder-download" ? "下载" : "上传";
    rows.value.unshift({
      id,
      direction: kind,
      fileName: `${verb}文件夹「${folderName}」到 ${targetLabel}`,
      bytes: 0,
      total: 0,
      speedBps: 0,
      status: "running",
      speedHistory: [],
      batch: {
        phase: "walking",
        filesTotal: 0,
        bytesTotal: 0,
        discovered: 0,
        skippedLinks: 0,
      },
    });
    return id;
  }

  /** 编排层更新批次状态（phase/caption 数据/终态转轨） */
  function updateBatch(
    batchId: string,
    patch: Partial<FolderBatchState> & { status?: TransferStatus; fileName?: string },
  ) {
    const row = rows.value.find((r) => r.id === batchId);
    if (!row?.batch) return;
    const { status, fileName, ...batchPatch } = patch;
    Object.assign(row.batch, batchPatch);
    if (status) row.status = status;
    if (fileName) row.fileName = fileName;
  }

  /** 编排层注册动作句柄（整批取消 / 重试失败项闭包） */
  function registerBatchHandle(batchId: string, handle: BatchHandle) {
    batchHandles.set(batchId, handle);
  }

  /** 整批取消：编排闭包（walk 取消 + 子传输逐个取消 + 停止后续项），卡片转已取消 */
  function cancelBatch(batchId: string) {
    batchHandles.get(batchId)?.cancel();
    batchHandles.delete(batchId);
    const row = rows.value.find((r) => r.id === batchId);
    if (row && row.status === "running") {
      row.status = "cancelled";
      if (row.batch) row.batch.phase = "transferring";
    }
  }

  /** 重试失败项（编排闭包：对失败文件重新入队，跳过冲突直接覆盖） */
  function retryBatch(batchId: string) {
    batchHandles.get(batchId)?.retryFailed?.();
  }

  function hasBatchRetry(batchId: string): boolean {
    return batchHandles.get(batchId)?.canRetry() ?? false;
  }

  /** —— D3 断连联动 —— */

  /** 连接断开：该连接全部活动行置失败（后端已取消任务），批次卡转失败并释放句柄 */
  function markConnectionLost(connectionId: string) {
    void connectionId;
    for (const handle of batchHandles.values()) handle.cancel();
    batchHandles.clear();
    // exec 卡随会话消亡：登记的取消闭包已无意义，直接清（行在下方循环统一标失败）
    archiveCancels.clear();
    for (const row of rows.value) {
      if (row.status !== "queued" && row.status !== "running") continue;
      if (row.batchId || !row.batch) {
        // 子行与普通行
        row.status = "failed";
        row.error = "连接已断开";
        row.speedBps = 0;
      } else {
        // 顶层批次卡
        row.status = "failed";
        row.batch.phase = "transferring";
        row.batch.error = "连接已断开";
      }
    }
  }

  /** 重连成功：重试参数指向新连接标识 */
  function remapConnection(oldId: string, newId: string) {
    for (const info of retryInfos.values()) {
      if (info.connectionId === oldId) info.connectionId = newId;
    }
  }

  /** 行级重试（断连失败的传输；用当前连接标识重新入队） */
  function retryRow(id: string) {
    const info = retryInfos.get(id);
    const row = rows.value.find((r) => r.id === id);
    if (!info || !row || row.status !== "failed") return;
    if (info.direction === "upload") {
      void startUpload(info.connectionId, info.src, info.dst, info.fileName);
    } else {
      void startDownloadTo(info.connectionId, info.src, info.dst);
    }
    removeRow(id);
  }

  function hasRowRetry(id: string): boolean {
    return retryInfos.has(id);
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
    startArchiveOp,
    registerArchiveCancel,
    cancelArchiveOp,
    startFolderBatch,
    updateBatch,
    registerBatchHandle,
    cancelBatch,
    retryBatch,
    hasBatchRetry,
    markConnectionLost,
    remapConnection,
    retryRow,
    hasRowRetry,
    waitAllDone,
    cancel,
    removeRow,
    clearFinished,
  };
});
