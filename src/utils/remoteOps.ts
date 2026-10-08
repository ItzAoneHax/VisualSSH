import { tempDir } from "@tauri-apps/api/path";

import type { IncomingItem } from "@/stores/conflicts";
import { useConflictStore } from "@/stores/conflicts";
import { useTransferStore } from "@/stores/transfer";
import type { FileEntry } from "@/types";
import { joinPath } from "@/utils/format";
import { deleteSsh, execSsh, listDir, renameSsh, type ExecOutput } from "@/api/ssh";

/**
 * 远端移动/复制执行管线（M7 步骤 4）：内部剪贴板粘贴（pasteRemote）与行内拖拽共用。
 * cut = SFTP rename → exec mv -f 回退；copy = exec cp -a → 单文件「暂存下载→上传」回退。
 * 冲突走冲突对话框（目标目录同名检测），批次进度入传输中心卡片。
 */

export interface RemoteMoveCopyResult {
  done: number;
  failed: string[];
  /** 批次是否被用户取消 */
  cancelled: boolean;
  /** 实际执行的最终名（冲突解析后，含「生成新名称」），用于刷新后定位 */
  executed: { name: string; finalName: string }[];
}

/** 远端移动/复制一组条目到目标目录；全部跳过时 done=0 且 executed 为空 */
export async function remoteMoveCopy(
  connectionId: string,
  sourceDir: string,
  names: string[],
  targetDir: string,
  mode: "move" | "copy",
): Promise<RemoteMoveCopyResult> {
  const conflicts = useConflictStore();
  const transfers = useTransferStore();

  // 源目录现状：取条目元数据（同时校验源项仍存在，删除/移动后自然失效）
  let sourceEntries: FileEntry[];
  try {
    sourceEntries = await listDir(connectionId, sourceDir);
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : String(e));
  }
  const byName = new Map(sourceEntries.map((e) => [e.name, e]));
  const present = names.filter((n) => byName.has(n));
  if (!present.length) return { done: 0, failed: [], cancelled: false, executed: [] };

  const incoming: IncomingItem[] = present.map((n) => {
    const e = byName.get(n)!;
    return { name: e.name, size: e.size, mtime: e.mtime, kind: e.kind };
  });

  const decisions = await conflicts.resolve(connectionId, targetDir, incoming);
  if (!decisions) throw new Error("cancelled");
  const jobs = decisions
    .filter((d) => d.action === "proceed")
    .map((d) => ({ ...d, source: byName.get(d.name)! }));
  if (!jobs.length) return { done: 0, failed: [], cancelled: false, executed: [] };

  const op = await transfers.startRemoteOp(
    mode === "move" ? "remote-move" : "remote-copy",
    jobs.length,
    targetDir,
  );
  const failed: string[] = [];
  const executed: { name: string; finalName: string }[] = [];
  let done = 0;
  for (const job of jobs) {
    if (op.isCancelled()) break;
    const src = joinPath(sourceDir, job.name);
    const dst = joinPath(targetDir, job.finalName);
    try {
      if (mode === "move") {
        try {
          // 同文件系统跨目录改名零拷贝
          await renameSsh(connectionId, src, dst);
        } catch {
          const r = await execSsh(connectionId, "mv", ["-f", "--", src, dst]);
          if (r.exitCode !== 0) {
            throw new Error(r.stderr.trim() || `mv 退出码 ${r.exitCode ?? "未知"}`);
          }
        }
      } else {
        let result: ExecOutput | null = null;
        try {
          result = await execSsh(connectionId, "cp", ["-a", "--", src, dst]);
        } catch {
          result = null;
        }
        if (!result || result.exitCode === 126 || result.exitCode === 127) {
          // shell/cp 不可用：仅单文件可走「暂存下载→上传」回退
          if (job.source.kind !== "file") {
            throw new Error("服务器 shell 不可用，无法复制文件夹");
          }
          await fallbackCopyViaTemp(connectionId, src, job.finalName, targetDir);
        } else if (result.exitCode !== 0) {
          throw new Error(result.stderr.trim() || `cp 退出码 ${result.exitCode ?? "未知"}`);
        }
      }
      done += 1;
      executed.push({ name: job.name, finalName: job.finalName });
    } catch (e) {
      failed.push(`${job.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (op.isCancelled()) {
    // cancelRemoteOp 已把卡片置为已取消
  } else if (failed.length) {
    op.setFailed(`完成 ${done} 项，失败 ${failed.length} 项 — ${failed[0]}`);
  } else {
    op.setDone();
  }
  return { done, failed, cancelled: op.isCancelled(), executed };
}

/** exec 不可用时的单文件复制回退：暂存下载到本地临时目录再上传（复用传输中心管线） */
async function fallbackCopyViaTemp(
  connectionId: string,
  remotePath: string,
  name: string,
  targetDir: string,
) {
  const transfers = useTransferStore();
  const base = (await tempDir()).replace(/[\\/]+$/, "");
  const local = `${base}/VisualSSH/${crypto.randomUUID()}-${name}`;
  const transferId = await transfers.startDownloadTo(connectionId, remotePath, local);
  const ok = await transfers.waitAllDone([transferId]);
  if (!ok) throw new Error(`暂存下载失败（${name}）`);
  await transfers.startUpload(connectionId, local, targetDir, name);
}

/** 跨连接传输（Ctrl+C/V 与拖拽共用）：文件逐个「暂存下载 → 上传」（传输中心显示进度）；
 *  文件夹需递归下载、超出当前传输能力，跳过。move = 复制确认后删源文件。
 *  冲突解析取消时 throw Error("cancelled")，调用方静默。 */
export async function crossConnectionTransfer(
  sourceCid: string,
  sourceDir: string,
  names: string[],
  mode: "copy" | "move",
  targetCid: string,
  targetDir: string,
): Promise<{ done: number; skippedFolders: number; failed: string[] }> {
  const conflicts = useConflictStore();
  const transfers = useTransferStore();

  let sourceEntries: FileEntry[];
  try {
    sourceEntries = await listDir(sourceCid, sourceDir);
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : String(e));
  }
  const byName = new Map(sourceEntries.map((e) => [e.name, e]));
  const present = names.filter((n) => byName.has(n));
  const files = present.filter((n) => byName.get(n)!.kind === "file");
  const skippedFolders = present.length - files.length;
  if (!files.length) return { done: 0, skippedFolders, failed: [] };

  const incoming: IncomingItem[] = files.map((n) => {
    const e = byName.get(n)!;
    return { name: e.name, size: e.size, mtime: e.mtime };
  });
  const decisions = await conflicts.resolve(targetCid, targetDir, incoming);
  if (!decisions) throw new Error("cancelled");
  const jobs = decisions.filter((d) => d.action === "proceed");
  if (!jobs.length) return { done: 0, skippedFolders, failed: [] };

  const base = (await tempDir()).replace(/[\\/]+$/, "");
  const failed: string[] = [];
  let done = 0;
  for (const job of jobs) {
    const local = `${base}/VisualSSH/${crypto.randomUUID()}-${job.finalName}`;
    try {
      const dl = await transfers.startDownloadTo(sourceCid, joinPath(sourceDir, job.name), local);
      if (!(await transfers.waitAllDone([dl]))) {
        throw new Error("暂存下载失败");
      }
      // startUpload 返回 id（已注册非终态），waitAllDone 等待真实成败（move 删源前必须确认）
      const upId = await transfers.startUpload(targetCid, local, targetDir, job.finalName);
      if (!(await transfers.waitAllDone([upId]))) {
        throw new Error("上传失败");
      }
      done += 1;
      if (mode === "move") {
        try {
          await deleteSsh(sourceCid, joinPath(sourceDir, job.name), false);
        } catch {
          // 删源失败不回滚已复制的文件，计入 failed 提示
          failed.push(`${job.name}: 源文件删除失败`);
        }
      }
    } catch (e) {
      failed.push(`${job.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { done, skippedFolders, failed };
}
