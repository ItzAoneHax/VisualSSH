import { defineStore } from "pinia";
import { ref } from "vue";

import { credentialDelete, credentialGet, credentialKey, credentialPut } from "@/api/credentials";
import { connectSsh, disconnectSsh, testSsh, trustHost } from "@/api/ssh";
import type { SshProfile, SshProfileInput, TestState } from "@/types";

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
