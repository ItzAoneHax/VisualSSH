import { invoke } from "@tauri-apps/api/core";

/**
 * 系统加密凭据存储（Windows 凭据管理器 / DPAPI）的薄封装。
 * 密码与私钥口令不再进入 localStorage，按键 per-profile 存取。
 */

export type CredentialKind = "password" | "passphrase";

export function credentialKey(profileId: string, kind: CredentialKind): string {
  return `profile:${profileId}:${kind}`;
}

export function credentialGet(key: string): Promise<string | null> {
  return invoke("credential_get", { key });
}

export function credentialPut(key: string, value: string): Promise<void> {
  return invoke("credential_put", { key, value });
}

export function credentialDelete(key: string): Promise<void> {
  return invoke("credential_delete", { key });
}
