import { invoke } from "@tauri-apps/api/core";

/**
 * 压缩/解压命令薄封装（第五阶段块 C）：启动后台 exec 任务与取消。
 * 命令参数（program/args）由 utils/archive.ts 纯函数拼装，后端逐个 POSIX 单引号包裹。
 */

/** 启动后台压缩/解压 exec；终态经 archive://done:{runId} 事件推送 */
export function archiveStart(
  runId: string,
  connectionId: string,
  program: string,
  args: string[],
): Promise<void> {
  return invoke("ssh_archive_start", { runId, connectionId, program, args });
}

/** 请求取消（杀远端通道）；false = 任务不存在或已结束 */
export function archiveCancel(runId: string): Promise<boolean> {
  return invoke("ssh_archive_cancel", { runId });
}

/** archive://done:{runId} 事件负载 */
export interface ArchiveDone {
  runId: string;
  ok: boolean;
  exitCode: number | null;
  stderr: string;
  cancelled: boolean;
}
