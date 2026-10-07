import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { defineStore } from "pinia";
import { computed, reactive, ref } from "vue";

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

/** 单连接的终端会话（同一连接的多个标签共享；面板展示「活动标签连接」的会话） */
interface TerminalSession {
  connectionId: string;
  terminalId: string;
  /** shell 已退出 */
  exited: boolean;
  /** 组件注入的数据出口（xterm.write）——仅该会话处于展示中时非空 */
  onData: ((bytes: Uint8Array) => void) | null;
  onExit: ((status: number | null) => void) | null;
  /** xterm 未在展示时的输出缓冲（回到该会话时 flush） */
  backlog: Uint8Array[];
  /** 完整输出日志（切换标签回来重放；超上限从头丢弃） */
  outputLog: Uint8Array[];
  logBytes: number;
}

/** outputLog 容量上限（bytes 累计，超限丢头部） */
const LOG_CAP_BYTES = 1024 * 1024;

/**
 * 终端多会话状态（M7）：按 connectionId 存会话。xterm 实例与 DOM 渲染在
 * TerminalPanel 组件内，本 store 管会话生命周期与数据转发：
 * terminal://data 按 terminalId 路由到对应会话（后台会话输出照常入日志，
 * 切换标签 = 面板切内容，不断开）。
 */
export const useTerminalStore = defineStore("terminal", () => {
  /** 面板是否可见（全局浮层，不随标签切换关闭） */
  const open = ref(false);
  /** 面板当前展示的连接（决定 write/resize/sink 的目标会话） */
  const activeConnectionId = ref("");
  /** 当前展示会话的错误文案 */
  const error = ref<string | null>(null);
  const opening = ref(false);

  const sessions = ref(new Map<string, TerminalSession>());
  /** terminalId → connectionId（事件路由） */
  const byTerminalId = new Map<string, string>();

  const activeSession = computed(() => sessions.value.get(activeConnectionId.value) ?? null);
  /** 展示中会话的 terminalId（组件据此挂载 xterm） */
  const activeTerminalId = computed(() => activeSession.value?.terminalId ?? "");
  const activeExited = computed(() => activeSession.value?.exited ?? false);

  function createSession(connectionId: string): TerminalSession {
    // reactive 包装：sessions 是 ref(Map)，存入后取出的才是同一代理——
    // 持原始对象引用赋值 terminalId 不会触发 activeSession 等计算属性
    const session = reactive<TerminalSession>({
      connectionId,
      terminalId: "",
      exited: false,
      onData: null,
      onExit: null,
      backlog: [],
      outputLog: [],
      logBytes: 0,
    });
    sessions.value.set(connectionId, session);
    return session;
  }

  function emitData(session: TerminalSession, bytes: Uint8Array) {
    // 输出日志恒记录（重放用），超限从头丢
    session.outputLog.push(bytes);
    session.logBytes += bytes.length;
    while (session.logBytes > LOG_CAP_BYTES && session.outputLog.length > 1) {
      const head = session.outputLog.shift()!;
      session.logBytes -= head.length;
    }
    if (session.onData) session.onData(bytes);
    else session.backlog.push(bytes);
  }

  let unlistenData: UnlistenFn | null = null;
  let unlistenExit: UnlistenFn | null = null;

  const isTauri = () => "__TAURI_INTERNALS__" in window;

  /** 全局事件监听一次：按 terminalId 路由到会话（不按展示中过滤） */
  async function bindEvents() {
    if (unlistenData || !isTauri()) return;
    unlistenData = await listen<TerminalDataPayload>("terminal://data", (event) => {
      const cid = byTerminalId.get(event.payload.terminalId);
      if (!cid) return;
      const session = sessions.value.get(cid);
      if (session && session.terminalId === event.payload.terminalId) {
        emitData(session, fromBase64(event.payload.data));
      }
    });
    unlistenExit = await listen<TerminalExitPayload>("terminal://exit", (event) => {
      const cid = byTerminalId.get(event.payload.terminalId);
      if (!cid) return;
      const session = sessions.value.get(cid);
      if (session && session.terminalId === event.payload.terminalId) {
        session.exited = true;
        session.onExit?.(event.payload.exitStatus);
      }
    });
    void unlistenExit;
  }

  /** 切换展示的会话：摘掉旧会话 sink（输出转 backlog），新会话由组件重放日志 */
  function setDisplayed(connectionId: string) {
    if (activeConnectionId.value === connectionId) return;
    const old = activeSession.value;
    if (old) {
      old.onData = null;
      old.onExit = null;
    }
    activeConnectionId.value = connectionId;
    error.value = null;
  }

  /** 打开终端：该连接已有会话则直接展示（不断开），否则新建 */
  async function openIn(cwd: string, connectionId: string) {
    const existing = sessions.value.get(connectionId);
    if (existing && existing.terminalId) {
      setDisplayed(connectionId);
      open.value = true;
      return;
    }
    if (opening.value) return;
    opening.value = true;
    error.value = null;
    open.value = true;
    setDisplayed(connectionId);
    const session = sessions.value.get(connectionId) ?? createSession(connectionId);
    await bindEvents();
    try {
      session.terminalId = await openTerminal(connectionId, cwd);
      byTerminalId.set(session.terminalId, connectionId);
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
      open.value = false;
      sessions.value.delete(connectionId);
    } finally {
      opening.value = false;
    }
  }

  function write(bytes: Uint8Array) {
    const session = activeSession.value;
    if (session?.terminalId && !session.exited) {
      void writeTerminal(session.terminalId, bytes).catch(() => {
        // 终端已死：交给 exit 事件收尾
      });
    }
  }

  function resize(cols: number, rows: number) {
    const session = activeSession.value;
    if (session?.terminalId && !session.exited) {
      void resizeTerminal(session.terminalId, cols, rows).catch(() => {});
    }
  }

  /** 用户关闭面板：结束当前展示的会话（其他连接的会话保持后台） */
  async function close() {
    const session = activeSession.value;
    open.value = false;
    error.value = null;
    if (!session) return;
    detachSession(session);
    const id = session.terminalId;
    if (id) {
      try {
        const { closeTerminal } = await import("@/api/terminal");
        await closeTerminal(id);
      } catch {
        // 会话已结束：后端自然清理
      }
    }
    sessions.value.delete(session.connectionId);
  }

  function detachSession(session: TerminalSession) {
    if (session.terminalId) byTerminalId.delete(session.terminalId);
    session.onData = null;
    session.onExit = null;
  }

  /** 断开连接/工作区销毁：全部会话复位（后端 ssh_disconnect 也会联动关闭 pty） */
  function reset() {
    open.value = false;
    error.value = null;
    opening.value = false;
    for (const session of sessions.value.values()) {
      detachSession(session);
    }
    sessions.value.clear();
    activeConnectionId.value = "";
  }

  /** 组件注入展示中会话的数据出口。注入时同步重放完整输出日志（含 backlog 段）——
   *  单线程保证重放先于后续新数据，切换会话/重挂载都不丢不重 */
  function setSink(
    data: ((bytes: Uint8Array) => void) | null,
    exit: ((status: number | null) => void) | null,
  ) {
    const session = activeSession.value;
    if (!session) return;
    session.onData = data;
    session.onExit = exit;
    if (data) {
      for (const bytes of session.outputLog) data(bytes);
      session.backlog = [];
    }
  }

  /** 展示中会话的完整输出日志（组件切换会话时整体重放到 xterm） */
  function replayLog(): Uint8Array[] {
    return activeSession.value?.outputLog ?? [];
  }

  return {
    open,
    activeConnectionId,
    activeTerminalId,
    activeExited,
    error,
    opening,
    bindEvents,
    openIn,
    setDisplayed,
    replayLog,
    write,
    resize,
    close,
    reset,
    setSink,
  };
});
