import { defineStore } from "pinia";
import { ref } from "vue";

import { connectSsh, disconnectSsh, testSsh, trustHost } from "@/api/ssh";
import type { SshProfile, SshProfileInput, TestState } from "@/types";

const STORAGE_KEY = "visualssh:profiles:v1";

function loadProfiles(): SshProfile[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as SshProfile[]) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export interface ActiveConnection {
  connectionId: string;
  alias: string;
  profile: SshProfile;
  rootPath: string;
  latencyMs: number;
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
  /** 当前活跃连接；非空时应用进入工作区视图 */
  const active = ref<ActiveConnection | null>(null);

  function persist() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(profiles.value));
  }

  function upsert(profile: SshProfile) {
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
  }

  async function test(profile: SshProfile) {
    testStates.value[profile.id] = { status: "testing" };
    try {
      const result = await testSsh(toInput(profile));
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
      const result = await connectSsh(profile.alias, toInput(profile));
      active.value = {
        connectionId: result.connectionId,
        alias: profile.alias,
        profile,
        rootPath: result.rootPath,
        latencyMs: result.latencyMs,
      };
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

  async function disconnect() {
    if (!active.value) return;
    const { connectionId } = active.value;
    active.value = null;
    try {
      await disconnectSsh(connectionId);
    } catch {
      // 会话可能已被服务端断开，直接丢弃本地句柄即可
    }
  }

  return {
    profiles,
    testStates,
    connectingId,
    lastError,
    hostKeyPrompt,
    active,
    upsert,
    remove,
    test,
    connect,
    confirmHostKey,
    cancelHostKey,
    disconnect,
  };
});

function toInput(profile: SshProfile): SshProfileInput {
  return {
    host: profile.host,
    port: profile.port,
    username: profile.username,
    password: profile.authMethod === "password" ? profile.password : undefined,
    privateKeyPath:
      profile.authMethod === "privateKey" ? profile.privateKeyPath : undefined,
    passphrase:
      profile.authMethod === "privateKey" ? profile.passphrase : undefined,
  };
}
