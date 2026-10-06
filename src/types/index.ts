export type AuthMethod = "password" | "privateKey";

/**
 * 已保存的连接配置（非敏感字段持久化于 localStorage）。
 * 密码/私钥口令等敏感凭据存于系统加密存储（Windows 凭据管理器），
 * 以 profile:{id}:password / :passphrase 为键，见 api/credentials.ts。
 */
export interface SshProfile {
  id: string;
  alias: string;
  host: string;
  port: number;
  username: string;
  authMethod: AuthMethod;
  privateKeyPath?: string;
  createdAt: number;
}

/** 发起连接所需的最小字段 */
export interface SshProfileInput {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKeyPath?: string;
  passphrase?: string;
}

export interface ConnectResult {
  connectionId: string;
  rootPath: string;
  latencyMs: number;
}

export interface TestResult {
  ok: boolean;
  latencyMs: number;
  message: string | null;
}

export type FileKind = "dir" | "file" | "symlink" | "other";

export interface FileEntry {
  name: string;
  kind: FileKind;
  size: number;
  /** 形如 drwxr-xr-x */
  permissions: string;
  /** Unix 秒级时间戳 */
  mtime: number | null;
}

/** 测试连接的瞬时状态 */
export type TestState =
  | { status: "idle" }
  | { status: "testing" }
  | { status: "ok"; latencyMs: number }
  | { status: "fail"; message: string };
