import { defineStore } from "pinia";
import { ref } from "vue";

import { connectSsh, disconnectSsh, testSsh } from "@/api/ssh";
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

export const useConnectionsStore = defineStore("connections", () => {
  /** 所有已保存的连接配置 */
  const profiles = ref<SshProfile[]>(loadProfiles());
  /** 每个配置最近一次「测试连接」的结果，key 为 profile.id */
  const testStates = ref<Record<string, TestState>>({});
  /** 正在发起正式连接的 profile.id */
  const connectingId = ref<string | null>(null);
  /** 连接失败时展示在管理器上的错误文案 */
  const lastError = ref<string | null>(null);
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
      testStates.value[profile.id] = result.ok
        ? { status: "ok", latencyMs: result.latencyMs }
        : { status: "fail", message: result.message ?? "连接失败" };
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
      lastError.value = e instanceof Error ? e.message : String(e);
    } finally {
      connectingId.value = null;
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
    active,
    upsert,
    remove,
    test,
    connect,
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
