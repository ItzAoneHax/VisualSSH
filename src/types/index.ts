export type AuthMethod = "password" | "privateKey";

/** 已保存的连接配置（前端持久化于 localStorage，M2 迁移至系统加密存储） */
export interface SshProfile {
  id: string;
  alias: string;
  host: string;
  port: number;
  username: string;
  authMethod: AuthMethod;
  /** 仅密码认证时存在；MVP 阶段明文存于本地，见 README 安全说明 */
  password?: string;
  privateKeyPath?: string;
  passphrase?: string;
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
