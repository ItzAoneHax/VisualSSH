import { defineStore } from "pinia";
import { computed, ref } from "vue";

import { credentialDelete, credentialGet, credentialKey, credentialPut } from "@/api/credentials";
import { connectSsh, disconnectSsh, testSsh, trustHost } from "@/api/ssh";
import { useTerminalStore } from "@/stores/terminal";
import { useTransferStore } from "@/stores/transfer";
import type { SshProfile, SshProfileInput, TestState } from "@/types";
import { dropDirCache } from "@/utils/dirCache";
import { useWorkspaceStore } from "@/stores/workspace";

const STORAGE_KEY = "visualssh:profiles:v1";
/** 明文凭据已迁移进系统加密存储的标记 */
const SECURE_FLAG = "visualssh:secure:v1";

/** 旧版 profile 里可能残留的明文凭据字段（迁移用） */
interface LegacySecrets {
  password?: string;
  passphrase?: string;
}

function loadProfiles(): SshProfile[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as SshProfile[]) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * 首次启动迁移：把 localStorage 里的明文 password/passphrase
 * 写入系统加密存储后剥离明文。任何一步失败都保留原状，下次启动重试。
 */
async function migratePlaintextCredentials(profiles: SshProfile[]) {
  let dirty = false;
  for (const profile of profiles as (SshProfile & LegacySecrets)[]) {
    if (profile.password !== undefined) {
      await credentialPut(credentialKey(profile.id, "password"), profile.password);
    }
    if (profile.passphrase !== undefined) {
      await credentialPut(credentialKey(profile.id, "passphrase"), profile.passphrase);
    }
    if (profile.password !== undefined || profile.passphrase !== undefined) {
      delete profile.password;
      delete profile.passphrase;
      dirty = true;
    }
  }
  if (dirty) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(profiles));
  }
  localStorage.setItem(SECURE_FLAG, "1");
}

/** 连接运行态（块 D）：connected 正常；reconnecting 自动重连中；
 *  disconnected 已断开（需交互输入凭据或用户取消）；failed 重连失败终态 */
export type ConnState = "connected" | "reconnecting" | "disconnected" | "failed";

export interface ActiveConnection {
  connectionId: string;
  alias: string;
  profile: SshProfile;
  rootPath: string;
  latencyMs: number;
  state: ConnState;
  /** 自动重连当前次数（D4 横幅「第 n/5 次」） */
  reconnectAttempt: number;
  /** 断开/失败原因提示（横幅副文案） */
  reconnectHint?: string;
}

/** 指纹变更确认弹窗状态（ssh_connect 返回 HOSTKEY_CHANGED 前缀错误时置位） */
export interface HostKeyPrompt {
  profile: SshProfile;
  host: string;
  port: number;
  oldFingerprint: string;
  newFingerprint: string;
  algorithm: string;
}

/** 后端协议：HOSTKEY_CHANGED|新指纹|旧指纹|算法 */
function parseHostKeyError(
  message: string,
): { newFingerprint: string; oldFingerprint: string; algorithm: string } | null {
  const parts = message.split("|");
  if (parts[0] !== "HOSTKEY_CHANGED" || parts.length < 4) return null;
  return {
    newFingerprint: parts[1],
    oldFingerprint: parts[2],
    algorithm: parts[3],
  };
}

export const useConnectionsStore = defineStore("connections", () => {
  /** 所有已保存的连接配置 */
  const profiles = ref<SshProfile[]>(loadProfiles());
  /** 每个配置最近一次「测试连接」的结果，key 为 profile.id */
  const testStates = ref<Record<string, TestState>>({});
  /** 正在发起正式连接的 profile.id */
  const connectingId = ref<string | null>(null);
  /** 连接失败时展示在管理器上的错误文案 */
  const lastError = ref<string | null>(null);
  /** 指纹变更待确认（非空时主页弹 ContentDialog） */
  const hostKeyPrompt = ref<HostKeyPrompt | null>(null);
  /** 当前活跃连接（多连接，M7 多标签：key = connectionId；标签各自绑定其一） */
  const byId = ref<Record<string, ActiveConnection>>({});
  /** 最近一次建立的连接（主页 ⇄ 工作区视图切换的信号） */
  const active = ref<ActiveConnection | null>(null);

  /** 连接数（0 = 主页视图） */
  const connectionCount = computed(() => Object.keys(byId.value).length);

  function persist() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(profiles.value));
  }

  /** 启动时执行一次：迁移旧明文凭据；失败静默保留，下次启动重试 */
  async function migrateCredentials() {
    if (localStorage.getItem(SECURE_FLAG)) return;
    try {
      await migratePlaintextCredentials(profiles.value);
    } catch {
      // 系统凭据存储暂不可用（如浏览器预览）：不动数据，正式应用内重试
    }
  }
  void migrateCredentials();

  /** secrets 仅在用户本次输入了新值时出现；编辑留空 = 保持已存凭据 */
  async function upsert(
    profile: SshProfile,
    secrets?: { password?: string; passphrase?: string },
  ) {
    if (secrets?.password !== undefined) {
      await credentialPut(credentialKey(profile.id, "password"), secrets.password);
    }
    if (secrets?.passphrase !== undefined) {
      await credentialPut(credentialKey(profile.id, "passphrase"), secrets.passphrase);
    }
    const idx = profiles.value.findIndex((p) => p.id === profile.id);
    if (idx >= 0) {
      profiles.value.splice(idx, 1, profile);
    } else {
      profiles.value.push(profile);
    }
    persist();
  }

  function remove(id: string) {
    profiles.value = profiles.value.filter((p) => p.id !== id);
    delete testStates.value[id];
    persist();
    // 清理系统凭据为尽力而为；失败不阻塞配置删除
    void credentialDelete(credentialKey(id, "password")).catch(() => {});
    void credentialDelete(credentialKey(id, "passphrase")).catch(() => {});
  }

  async function test(profile: SshProfile) {
    testStates.value[profile.id] = { status: "testing" };
    try {
      const result = await testSsh(await toInput(profile));
      let message = result.message;
      if (message && parseHostKeyError(message)) {
        message = "服务器指纹已变更 — 请点击「连接」并在弹窗中确认新指纹";
      }
      testStates.value[profile.id] = result.ok
        ? { status: "ok", latencyMs: result.latencyMs }
        : { status: "fail", message: message ?? "连接失败" };
    } catch (e) {
      testStates.value[profile.id] = {
        status: "fail",
        message: e instanceof Error ? e.message : String(e),
      };
    }
  }

  async function connect(profile: SshProfile) {
    connectingId.value = profile.id;
    lastError.value = null;
    hostKeyPrompt.value = null;
    try {
      const result = await connectSsh(profile.alias, await toInput(profile));
      const conn: ActiveConnection = {
        connectionId: result.connectionId,
        alias: profile.alias,
        profile,
        rootPath: result.rootPath,
        latencyMs: result.latencyMs,
        state: "connected",
        reconnectAttempt: 0,
      };
      byId.value = { ...byId.value, [conn.connectionId]: conn };
      active.value = conn;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const changed = parseHostKeyError(message);
      if (changed) {
        hostKeyPrompt.value = {
          profile,
          host: profile.host,
          port: profile.port,
          ...changed,
        };
      } else {
        lastError.value = message;
      }
    } finally {
      connectingId.value = null;
    }
  }

  /** —— 块 D：断线感知与自动重连 —— */

  /** 重连循环控制：connectionId → 打断标志（取消/立即重连共用） */
  const reconnectCtl = new Map<string, { cancelled: boolean; immediate: boolean }>();
  let unlistenLost: (() => void) | null = null;

  /** 幂等订阅后端断开事件（ssh://disconnected） */
  async function bindDisconnectEvents() {
    if (unlistenLost || !("__TAURI_INTERNALS__" in window)) return;
    const { listen } = await import("@tauri-apps/api/event");
    unlistenLost = await listen<{ connectionId: string }>("ssh://disconnected", (event) => {
      void handleLost(event.payload.connectionId);
    });
  }

  /** 凭据是否可静默获取（keyring 命中）：否则不自动重连，指引回主页 */
  async function hasSilentCredentials(profile: SshProfile): Promise<boolean> {
    if (profile.authMethod === "privateKey") return true; // 私钥文件本地读取，无需交互
    const secret = await credentialGet(credentialKey(profile.id, "password"));
    return !!secret;
  }

  function patchConn(connectionId: string, patch: Partial<ActiveConnection>) {
    const conn = byId.value[connectionId];
    if (!conn) return false;
    byId.value = { ...byId.value, [connectionId]: { ...conn, ...patch } };
    if (active.value?.connectionId === connectionId) {
      active.value = { ...active.value, ...patch };
    }
    return true;
  }

  /** 异常断开入口：置状态、联动失败/占位，并启动自动重连（凭据可静默获取时） */
  async function handleLost(connectionId: string) {
    const conn = byId.value[connectionId];
    if (!conn || conn.state !== "connected") return;
    // D3：传输中心任务标失败、终端会话标记退出、窗格转断开占位
    useTransferStore().markConnectionLost(connectionId);
    useTerminalStore().markConnectionLost(connectionId);
    useWorkspaceStore().markConnectionLost(connectionId);

    if (!(await hasSilentCredentials(conn.profile))) {
      patchConn(connectionId, {
        state: "disconnected",
        reconnectHint: "需要手动输入密码，请回到主页重新连接",
      });
      return;
    }
    patchConn(connectionId, { state: "reconnecting", reconnectHint: undefined });
    void reconnectLoop(connectionId);
  }

  async function reconnectLoop(connectionId: string) {
    const conn = byId.value[connectionId];
    if (!conn) return;
    const ctl = { cancelled: false, immediate: false };
    reconnectCtl.set(connectionId, ctl);
    try {
      for (let attempt = 1; attempt <= 5; attempt++) {
        patchConn(connectionId, { reconnectAttempt: attempt });
        // 指数退避等待（可被打断：取消 / 立即重连）
        const waitSec = 2 ** (attempt - 1);
        const deadline = Date.now() + waitSec * 1000;
        while (Date.now() < deadline) {
          if (ctl.cancelled || ctl.immediate) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        if (ctl.cancelled) {
          patchConn(connectionId, {
            state: "disconnected",
            reconnectHint: "已取消自动重连，可回到主页重新连接",
          });
          return;
        }
        try {
          const input = await toInput(conn.profile);
          const result = await connectSsh(conn.alias, input);
          remapConnection(connectionId, result.connectionId, result.rootPath);
          patchConn(result.connectionId, {
            state: "connected",
            reconnectAttempt: 0,
            reconnectHint: undefined,
          });
          // D3 恢复：各标签窗格回到断开时路径（explorer 状态未清，静默刷新即可）
          useWorkspaceStore().markConnectionRestored(connectionId, result.connectionId);
          return;
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          if (parseHostKeyError(message)) {
            patchConn(connectionId, {
              state: "failed",
              reconnectHint: "主机指纹已变更，请回主页确认后重连",
            });
            return;
          }
          patchConn(connectionId, { reconnectHint: message });
        }
      }
      patchConn(connectionId, {
        state: "failed",
        reconnectHint: `已重试 ${5} 次仍未成功`,
      });
    } finally {
      reconnectCtl.delete(connectionId);
    }
  }

  /** 重连成功：后端新 connectionId 替换旧标识（byId 键 + 标签/窗格/剪贴板联动） */
  function remapConnection(oldId: string, newId: string, rootPath: string) {
    const conn = byId.value[oldId];
    if (!conn) return;
    delete byId.value[oldId];
    conn.connectionId = newId;
    conn.rootPath = rootPath;
    byId.value = { ...byId.value, [newId]: conn };
    if (active.value?.connectionId === oldId) {
      active.value = conn;
    }
    // 旧连接的目录缓存随旧标识丢弃（重连后按需重建，等效强制失效）
    dropDirCache(oldId);
    useTransferStore().remapConnection(oldId, newId);
    useWorkspaceStore().remapConnection(oldId, newId);
  }

  /** D4 横幅「立即重连」：打断退避等待，立刻尝试 */
  function reconnectNow(connectionId: string) {
    const ctl = reconnectCtl.get(connectionId);
    if (ctl) {
      ctl.immediate = true;
      return;
    }
    // 不在循环中（disconnected/failed 态）：重新走断开流程
    patchConn(connectionId, { state: "reconnecting", reconnectHint: undefined });
    void reconnectLoop(connectionId);
  }

  /** D4 横幅「取消」：停止自动重连（转 disconnected 终态，不触发手动断开） */
  function cancelReconnect(connectionId: string) {
    const ctl = reconnectCtl.get(connectionId);
    if (ctl) {
      ctl.cancelled = true;
      return;
    }
    patchConn(connectionId, {
      state: "disconnected",
      reconnectHint: "已取消自动重连，可回到主页重新连接",
    });
  }

  /** 指纹变更弹窗：用户确认 → 更新 known_hosts 并自动重连 */
  async function confirmHostKey() {
    const prompt = hostKeyPrompt.value;
    if (!prompt) return;
    hostKeyPrompt.value = null;
    try {
      await trustHost(prompt.host, prompt.port, prompt.algorithm, prompt.newFingerprint);
    } catch (e) {
      lastError.value = `更新主机指纹记录失败: ${e instanceof Error ? e.message : String(e)}`;
      return;
    }
    await connect(prompt.profile);
  }

  /** 指纹变更弹窗：用户取消连接 */
  function cancelHostKey() {
    const prompt = hostKeyPrompt.value;
    hostKeyPrompt.value = null;
    if (prompt) {
      lastError.value = `已取消连接：${prompt.host} 的指纹已变更且未经确认`;
    }
  }

  /** 主页「断开连接」：结束全部连接并清空（工作区组件卸载联动回收标签状态） */
  async function disconnect() {
    if (!active.value && connectionCount.value === 0) return;
    const ids = Object.keys(byId.value);
    active.value = null;
    byId.value = {};
    for (const id of ids) {
      try {
        await disconnectSsh(id);
      } catch {
        // 会话可能已被服务端断开，直接丢弃本地句柄即可
      }
    }
  }

  return {
    profiles,
    testStates,
    connectingId,
    lastError,
    hostKeyPrompt,
    byId,
    active,
    connectionCount,
    upsert,
    remove,
    migrateCredentials,
    test,
    connect,
    confirmHostKey,
    cancelHostKey,
    disconnect,
    bindDisconnectEvents,
    handleLost,
    reconnectNow,
    cancelReconnect,
  };
});

/** 连接/测试时从系统加密存储现取凭据 */
async function toInput(profile: SshProfile): Promise<SshProfileInput> {
  const password =
    profile.authMethod === "password"
      ? (await credentialGet(credentialKey(profile.id, "password"))) ?? undefined
      : undefined;
  const passphrase =
    profile.authMethod === "privateKey"
      ? (await credentialGet(credentialKey(profile.id, "passphrase"))) ?? undefined
      : undefined;
  return {
    host: profile.host,
    port: profile.port,
    username: profile.username,
    password,
    privateKeyPath:
      profile.authMethod === "privateKey" ? profile.privateKeyPath : undefined,
    passphrase,
  };
}
