import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { defineStore } from "pinia";
import { ref } from "vue";

import { fromBase64, openTerminal, resizeTerminal, writeTerminal } from "@/api/terminal";

/** 后端事件负载（camelCase） */
interface TerminalDataPayload {
  terminalId: string;
  data: string;
}

interface TerminalExitPayload {
  terminalId: string;
  exitStatus: number | null;
}

/**
 * 终端面板状态：单工作区单终端。xterm 实例与 DOM 渲染在 TerminalPanel 组件内，
 * 本 store 只管会话生命周期与数据转发（组件经回调把数据写入 xterm）。
 */
export const useTerminalStore = defineStore("terminal", () => {
  const open = ref(false);
  const terminalId = ref("");
  /** shell 已退出（等待用户关闭面板） */
  const exited = ref(false);
  const opening = ref(false);
  const error = ref<string | null>(null);

  /** 组件注入的数据出口（xterm.write）与尺寸回调 */
  let onData: ((bytes: Uint8Array) => void) | null = null;
  let onExit: ((status: number | null) => void) | null = null;
  /** xterm 就绪前的输出缓冲（shell prompt 常早于组件挂载到达） */
  let backlog: Uint8Array[] = [];

  function emitData(bytes: Uint8Array) {
    if (onData) onData(bytes);
    else backlog.push(bytes);
  }

  let unlistenData: UnlistenFn | null = null;
  let unlistenExit: UnlistenFn | null = null;

  const isTauri = () => "__TAURI_INTERNALS__" in window;

  async function bindEvents() {
    if (unlistenData || !isTauri()) return;
    unlistenData = await listen<TerminalDataPayload>("terminal://data", (event) => {
      if (event.payload.terminalId === terminalId.value) {
        emitData(fromBase64(event.payload.data));
      }
    });
    unlistenExit = await listen<TerminalExitPayload>("terminal://exit", (event) => {
      if (event.payload.terminalId === terminalId.value) {
        exited.value = true;
        onExit?.(event.payload.exitStatus);
      }
    });
    void unlistenExit;
  }

  /** 打开终端（已开则仅聚焦面板） */
  async function openIn(cwd: string, connectionId: string) {
    if (open.value && terminalId.value) {
      // 已有会话：面板保持/聚焦（终端 cwd 是打开时的快照，不追随目录切换）
      return;
    }
    if (opening.value) return;
    opening.value = true;
    error.value = null;
    exited.value = false;
    open.value = true;
    await bindEvents();
    try {
      terminalId.value = await openTerminal(connectionId, cwd);
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
      open.value = false;
      terminalId.value = "";
    } finally {
      opening.value = false;
    }
  }

  function write(bytes: Uint8Array) {
    if (terminalId.value && !exited.value) {
      void writeTerminal(terminalId.value, bytes).catch(() => {
        // 终端已死：交给 exit 事件收尾
      });
    }
  }

  function resize(cols: number, rows: number) {
    if (terminalId.value && !exited.value) {
      void resizeTerminal(terminalId.value, cols, rows).catch(() => {});
    }
  }

  /** 用户关闭面板：主动结束 pty 并复位 */
  async function close() {
    const id = terminalId.value;
    open.value = false;
    exited.value = false;
    terminalId.value = "";
    error.value = null;
    if (id) {
      try {
        const { closeTerminal } = await import("@/api/terminal");
        await closeTerminal(id);
      } catch {
        // 会话已结束：后端自然清理
      }
    }
  }

  /** 断开连接时由视图层调用（后端 ssh_disconnect 也会联动关闭 pty） */
  function reset() {
    open.value = false;
    exited.value = false;
    terminalId.value = "";
    error.value = null;
  }

  function setSink(
    data: ((bytes: Uint8Array) => void) | null,
    exit: ((status: number | null) => void) | null,
  ) {
    onData = data;
    onExit = exit;
    if (data) {
      // 挂载早于 terminalId 的竞态：backlog 可能属于上一会话，flush 前校验
      const pending = backlog;
      backlog = [];
      if (terminalId.value) for (const bytes of pending) data(bytes);
    }
  }

  return {
    open,
    terminalId,
    exited,
    opening,
    error,
    bindEvents,
    openIn,
    write,
    resize,
    close,
    reset,
    setSink,
  };
});
