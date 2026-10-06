import { invoke } from "@tauri-apps/api/core";

/**
 * 终端命令薄封装。数据通道走 terminal://data / terminal://exit 事件，
 * 输入输出均为 base64（JSON 安全且比 number[] 紧凑）。
 */

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export { fromBase64, toBase64 };

export function openTerminal(connectionId: string, cwd: string): Promise<string> {
  return invoke("ssh_open_terminal", { connectionId, cwd });
}

export function writeTerminal(terminalId: string, data: Uint8Array): Promise<void> {
  return invoke("ssh_terminal_write", { terminalId, data: toBase64(data) });
}

export function resizeTerminal(
  terminalId: string,
  cols: number,
  rows: number,
): Promise<void> {
  return invoke("ssh_terminal_resize", { terminalId, cols, rows });
}

export function closeTerminal(terminalId: string): Promise<void> {
  return invoke("ssh_terminal_close", { terminalId });
}
