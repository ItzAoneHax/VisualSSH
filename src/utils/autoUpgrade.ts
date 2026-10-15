/**
 * 自动换版（运行中交付的热更新）。
 *
 * pack-exe 撞锁时把运行中的 exe 改名 <name>.old[N] 腾位，本进程继续从改名
 * 文件运行——Rust 侧 upgrade_state 据此报告「有待启用的新版本」。本模块每
 * 30s 轮询：待启用 且 MCP 不忙 且 任务清空（传输/终端会话/编辑器/确认
 * 弹窗/退出确认）且 用户闲置 5 分钟时，写会话快照（标签/窗格目录/视图）
 * 并调 upgrade_apply——Rust 拉起 canonical 新版、本进程退出；新版启动时
 * 恢复快照：重连各连接、重建标签与目录、回到原页面。
 */
import { invoke } from "@tauri-apps/api/core";

import { mcpPendingConfirms } from "@/api/mcp";
import { useConflictStore } from "@/stores/conflicts";
import { useConnectionsStore } from "@/stores/connections";
import { useEditorStore } from "@/stores/editor";
import { useExplorer } from "@/stores/explorer";
import { useExitGuardStore } from "@/stores/exitGuard";
import { useSettingsStore } from "@/stores/settings";
import { useTerminalStore } from "@/stores/terminal";
import { useToastStore } from "@/stores/toast";
import { useTransferStore } from "@/stores/transfer";
import { useWorkspaceStore, type WorkspaceTab } from "@/stores/workspace";

const KEY = "visualssh:upgrade-session:v1";
/** 调试追踪（换版排障用：门禁命中/apply 结果落盘，跨进程可读；上限保留最近 40 条） */
const KEY_DBG = "visualssh:upgrade-debug:v1";
const POLL_MS = 30_000;
/** 闲置阈值：窗口内无指针/键盘/滚轮输入达 5 分钟视为不在操作 */
const IDLE_MS = 5 * 60_000;

function trace(stage: string): void {
  try {
    const lines: string[] = JSON.parse(localStorage.getItem(KEY_DBG) ?? "[]");
    lines.push(`${new Date().toISOString().slice(11, 23)} ${stage}`);
    localStorage.setItem(KEY_DBG, JSON.stringify(lines.slice(-40)));
  } catch {
    // 调试路径不设防
  }
}

interface SnapshotTab {
  profileId: string;
  alias: string;
  arrangement: "vertical" | "horizontal" | null;
  paneRatio: number;
  activePaneIndex: number;
  panes: Array<{ cwd: string | null }>;
}

interface UpgradeSnapshot {
  v: 1;
  savedAt: number;
  settingsOpen: boolean;
  activeTabIndex: number;
  tabs: SnapshotTab[];
}

function collectSnapshot(): UpgradeSnapshot {
  const workspace = useWorkspaceStore();
  const settings = useSettingsStore();
  return {
    v: 1,
    savedAt: Date.now(),
    settingsOpen: settings.settingsOpen,
    activeTabIndex: workspace.tabs.findIndex((t) => t.id === workspace.activeTabId),
    tabs: workspace.tabs.map((tab) => ({
      profileId: tab.profileId,
      alias: tab.alias,
      arrangement: tab.arrangement,
      paneRatio: tab.paneRatio,
      activePaneIndex: Math.max(0, tab.panes.findIndex((p) => p.id === tab.activePaneId)),
      // 窗格目录存在 explorer 实例里（非活动标签不渲染 DOM 但状态健在）
      panes: tab.panes.map((p) => ({ cwd: useExplorer(p.id).cwd || null })),
    })),
  };
}

/** 换版条件检查（轮询单次）。任一任务在途/用户在操作则本轮放弃，下轮再看。 */
async function checkAndApply(lastActivity: () => number): Promise<void> {
  let state: { pending: boolean; mcpBusy: boolean };
  try {
    state = await invoke<{ pending: boolean; mcpBusy: boolean }>("upgrade_state");
  } catch (e) {
    trace(`upgrade_state 调用失败: ${String(e).slice(0, 80)}`);
    return;
  }
  if (!state.pending) return; // 常态（无待启用更新）不记录，避免 30s 一条刷屏
  if (state.mcpBusy) {
    trace("gate:mcpBusy");
    return;
  }

  const transfers = useTransferStore();
  const terminal = useTerminalStore();
  const editor = useEditorStore();
  const conflicts = useConflictStore();
  const exitGuard = useExitGuardStore();
  // 传输在途；挂起中的冲突对话框同样是未落地的流程（此时 activeCount 可能是 0）
  if (transfers.activeCount > 0) {
    trace(`gate:transfers(${transfers.activeCount})`);
    return;
  }
  if (conflicts.session) {
    trace("gate:conflicts");
    return;
  }
  // 终端悬浮窗开着：远端 pty 可能跑着 vim/htop，重启会杀前台进程
  //（窗口关闭时会话即删，open 即代表有存活会话）
  if (terminal.open) {
    trace("gate:terminal");
    return;
  }
  // 编辑器悬浮窗开着：未保存内容会随重启丢失
  if (editor.open) {
    trace("gate:editor");
    return;
  }
  if (exitGuard.pending) {
    trace("gate:exitGuard");
    return;
  }
  // MCP 确认弹窗待用户点击（危险操作拦截/首次接入批准）
  try {
    const confirms = await mcpPendingConfirms();
    if (confirms.length > 0) {
      trace(`gate:confirms(${confirms.length})`);
      return;
    }
  } catch (e) {
    trace(`mcp_pending_confirms 失败: ${String(e).slice(0, 80)}`);
    return;
  }
  // 用户闲置
  const idleMs = Date.now() - lastActivity();
  if (idleMs < IDLE_MS) {
    trace(`gate:idle(${Math.round(idleMs)}ms)`);
    return;
  }
  trace("全门通过 → 写快照并 upgrade_apply");
  try {
    localStorage.setItem(KEY, JSON.stringify(collectSnapshot()));
  } catch {
    return;
  }
  try {
    await invoke("upgrade_apply");
  } catch (e) {
    trace(`upgrade_apply 失败: ${String(e).slice(0, 120)}`);
    // 拉起失败回滚快照，避免下次手动启动误恢复陈旧会话
    localStorage.removeItem(KEY);
  }
}

/** 启动换版监视（App 挂载 / 会话恢复完成后调用一次）。 */
export function initAutoUpgrade(): void {
  if (!("__TAURI_INTERNALS__" in window)) return;
  trace("initAutoUpgrade 启动");
  let lastActivityAt = Date.now();
  const touch = () => {
    lastActivityAt = Date.now();
  };
  for (const type of ["pointerdown", "pointermove", "wheel", "keydown", "touchstart"] as const) {
    window.addEventListener(type, touch, { capture: true, passive: true });
  }
  window.setInterval(() => void checkAndApply(() => lastActivityAt), POLL_MS);
}

/** 取走并消费换版会话快照（不存在返回 null）。 */
export function consumeUpgradeSnapshot(): UpgradeSnapshot | null {
  if (!("__TAURI_INTERNALS__" in window)) return null;
  const raw = localStorage.getItem(KEY);
  if (!raw) return null;
  localStorage.removeItem(KEY);
  try {
    const snap = JSON.parse(raw) as UpgradeSnapshot;
    if (snap.v !== 1 || !Array.isArray(snap.tabs)) return null;
    return snap;
  } catch {
    return null;
  }
}

/** 换版重启后的会话恢复：重连各连接，重建标签/窗格/目录与视图。 */
export async function restoreUpgradeSession(snap: UpgradeSnapshot): Promise<void> {
  const connections = useConnectionsStore();
  const workspace = useWorkspaceStore();
  const settings = useSettingsStore();
  const toast = useToastStore();

  if (snap.settingsOpen) settings.settingsOpen = true;

  workspace.restoringSession = true;
  try {
    // 快照涉及的 profile 逐个重连（凭据从 keyring 静默读取；失败的跳过其标签）
    const connByProfile = new Map<string, string>();
    const failedProfiles: string[] = [];
    for (const pid of [...new Set(snap.tabs.map((t) => t.profileId))]) {
      const profile = connections.profiles.find((p) => p.id === pid);
      if (!profile) {
        failedProfiles.push(pid);
        continue;
      }
      await connections.connect(profile);
      const conn = Object.values(connections.byId).find((c) => c.profile.id === pid);
      if (conn) connByProfile.set(pid, conn.connectionId);
      else failedProfiles.push(pid);
    }

    const built: WorkspaceTab[] = [];
    for (const tab of snap.tabs) {
      const cid = connByProfile.get(tab.profileId);
      if (!cid) continue;
      const conn = connections.byId[cid];
      const t = workspace.openTab(cid, tab.profileId, tab.alias);
      const cwd = tab.panes[0]?.cwd;
      workspace.initPane(t.activePaneId, cid, cwd ?? conn.rootPath, tab.profileId, cwd ?? undefined);
      if (tab.panes.length > 1) {
        const cwd2 = tab.panes[1]?.cwd;
        workspace.openSecondaryPane(tab.arrangement ?? "vertical", cwd2 ?? conn.rootPath);
        t.paneRatio = tab.paneRatio ?? 50;
        if (tab.activePaneIndex > 0) workspace.setActivePane(t.panes[1].id);
      }
      built.push(t);
    }

    // 恢复活动标签与「最近连接」（App 视图切换的信号）
    const at = built[Math.min(Math.max(snap.activeTabIndex, 0), built.length - 1)];
    if (at) {
      workspace.activateTab(at.id);
      const conn = connections.byId[at.connectionId];
      if (conn) connections.active = conn;
    }

    if (built.length || failedProfiles.length) {
      toast.show(
        failedProfiles.length
          ? `VisualSSH 已更新，恢复 ${built.length} 个标签（${failedProfiles.length} 个连接失败）`
          : "VisualSSH 已更新，会话已恢复",
      );
    } else if (snap.settingsOpen) {
      toast.show("VisualSSH 已更新");
    }
  } finally {
    workspace.restoringSession = false;
  }
}
