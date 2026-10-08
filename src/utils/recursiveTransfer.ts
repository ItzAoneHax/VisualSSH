import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";

import { localFileMeta, type LocalFileMeta } from "@/api/transfer";
import { listDir, mkdirSsh, statSsh } from "@/api/ssh";
import {
  localMkdirP,
  walkCancel,
  walkLocal,
  walkRemote,
  onWalkProgress,
  type WalkOutput,
} from "@/api/walk";
import { useConflictStore, type ConflictGroup, type MultiDecisions } from "@/stores/conflicts";
import { useToastStore } from "@/stores/toast";
import { useTransferStore } from "@/stores/transfer";
import { dirCacheOf } from "@/utils/dirCache";
import type { FileEntry } from "@/types";
import { joinPath, pathBaseName } from "@/utils/format";

/**
 * 递归目录传输编排（第四阶段块 A）：
 * 下载 = 右键「下载文件夹…」→ 通用远端 walk 清单 → 选本地目标 → 本地 fs 冲突探测
 *        → 冲突对话框（多目录合并）→ 本地逐级建目录 → 逐文件走现有下载管线；
 * 上传 = 外部拖入/HDROP 粘贴含目录 → 本地 walk 清单（Rust 侧，不跟随符号链接）
 *        → 涉及目标目录集合各一次 listDir 冲突比对 → 冲突对话框 → 远端逐级 create_dir
 *        （已存在当成功）→ 逐文件走现有上传管线。
 * 一个目录批次 = 一张聚合卡；单文件失败不中断整批；取消 = 停止剩余项（已完成文件保留）；
 * 失败清单可整批重试（跳过冲突直接覆盖——首次执行已做过冲突决策）。
 * 落点语义同 Files：下载文件夹 foo 到 D → D/foo/...；上传 foo 到 /target → /target/foo/...
 */

/** 批内一个待传文件 */
interface BatchJob {
  /** 清单相对路径（posix，冲突改名后的最终相对路径） */
  rel: string;
  size: number;
  /** 传输一端的完整路径（下载=远端；上传=本地） */
  src: string;
  /** 另一端的完整路径（下载=本地；上传=远端） */
  dst: string;
}

/** 子行 id 容器（取消句柄与编排循环共享；ids 与入队 jobs 同序一一对应） */
interface ChildRef {
  ids: string[];
}

function stripTrailingSlash(p: string): string {
  return p.replace(/[\\/]+$/, "");
}

/** 本地 root + posix 相对路径 → Windows 绝对路径 */
function localJoin(root: string, rel: string): string {
  return `${stripTrailingSlash(root)}\\${rel.replace(/\//g, "\\")}`;
}

/** posix 路径父目录（root 边界由调用方保证） */
function posixParent(p: string): string | null {
  const idx = p.lastIndexOf("/");
  return idx < 0 ? null : idx === 0 ? "/" : p.slice(0, idx);
}

/** 决策表（决策目录 → 各项决策）展开为改名映射：批次相对路径 → 最终相对路径。
 *  dirToRel 把决策目录（下载=本地绝对 / 上传=远端绝对）还原为批次相对父目录。 */
function renamesFromDecisions(
  decisions: MultiDecisions,
  dirToRel: (dir: string) => string,
): Map<string, string> {
  const renames = new Map<string, string>();
  for (const [dir, list] of decisions) {
    const parentRel = dirToRel(dir);
    for (const d of list) {
      if (d.action !== "proceed" || d.finalName === d.name) continue;
      renames.set(
        parentRel ? `${parentRel}/${d.name}` : d.name,
        parentRel ? `${parentRel}/${d.finalName}` : d.finalName,
      );
    }
  }
  return renames;
}

/** 批次执行：逐文件入队（现有管线）→ 等待终态 → 卡片收尾 + 失败重试句柄。
 *  取消在下一项前停止（已完成文件保留）。 */
async function runBatchJobs(
  batchId: string,
  jobs: BatchJob[],
  startOne: (job: BatchJob) => Promise<string>,
  prepareDirs: () => Promise<void>,
  isCancelled: { value: boolean },
  childRef: ChildRef,
  onDone?: () => void,
): Promise<void> {
  const transfers = useTransferStore();
  transfers.updateBatch(batchId, {
    phase: "transferring",
    filesTotal: jobs.length,
    bytesTotal: jobs.reduce((s, j) => s + j.size, 0),
  });

  await prepareDirs();

  if (!jobs.length) {
    transfers.updateBatch(batchId, { status: "done" });
    return;
  }

  childRef.ids = [];
  for (const job of jobs) {
    if (isCancelled.value) break;
    childRef.ids.push(await startOne(job));
  }
  await transfers.waitAllDone(childRef.ids);
  if (isCancelled.value) return; // 取消态已由 cancelBatch 写入

  // 终态统计：ids 与入队 jobs 同序一一对应（取消提前截断时未入队项不计失败）
  const failedItems: { name: string; error: string; job: BatchJob }[] = [];
  for (let i = 0; i < childRef.ids.length; i++) {
    const row = transfers.rows.find((r) => r.id === childRef.ids[i]);
    if (!row || row.status !== "done") {
      failedItems.push({
        name: pathBaseName(jobs[i].rel),
        error: row?.error ?? "失败",
        job: jobs[i],
      });
    }
  }
  const failedJobs = failedItems.map((f) => f.job);
  if (failedItems.length === jobs.length) {
    transfers.updateBatch(batchId, {
      status: "failed",
      error: `全部 ${failedItems.length} 项传输失败`,
      failedItems: failedItems.map(({ name, error }) => ({ name, error })),
    });
    return;
  }
  transfers.updateBatch(batchId, {
    status: "done",
    failedItems: failedItems.map(({ name, error }) => ({ name, error })),
  });
  if (!failedItems.length) onDone?.();
  // 失败清单可重试：对失败文件直接覆盖传输（首次已做过冲突决策，跳过对话框）；
  // 重试覆盖原批取消句柄（枚举已结束，取消 = 停止重试循环 + 取消活动子项）
  if (failedJobs.length) {
    transfers.registerBatchHandle(batchId, {
      canRetry: () => true,
      cancel: () => {
        isCancelled.value = true;
        for (const id of childRef.ids) void transfers.cancel(id);
      },
      retryFailed: () => {
        void retryJobs(failedJobs, startOne, isCancelled, childRef);
      },
    });
  }
}

/** 重试执行：复用原批次卡（文件计数以本轮入队为准，行状态由事件驱动） */
async function retryJobs(
  failedJobs: BatchJob[],
  startOne: (job: BatchJob) => Promise<string>,
  isCancelled: { value: boolean },
  childRef: ChildRef,
): Promise<void> {
  const transfers = useTransferStore();
  childRef.ids = [];
  for (const job of failedJobs) {
    if (isCancelled.value) break;
    childRef.ids.push(await startOne(job));
  }
  await transfers.waitAllDone(childRef.ids);
}

/** 注册整批取消句柄（枚举阶段取消 walk；传输阶段逐子取消，已完成文件保留） */
function bindCancelHandle(
  transfers: ReturnType<typeof useTransferStore>,
  batchId: string,
  getWalkId: () => string | null,
  isCancelled: { value: boolean },
  childRef: ChildRef,
) {
  transfers.registerBatchHandle(batchId, {
    canRetry: () => false,
    cancel: () => {
      isCancelled.value = true;
      const walkId = getWalkId();
      if (walkId) void walkCancel(walkId).catch(() => {});
      for (const id of childRef.ids) void transfers.cancel(id);
    },
  });
}

/** —— A1：远端 → 本地（下载文件夹）—— */

/** 右键「下载文件夹…」：walk 清单 → 选目标目录 → 冲突 → 逐文件下载 */
export async function downloadFolderTo(connectionId: string, remoteDir: string): Promise<void> {
  const transfers = useTransferStore();
  const conflicts = useConflictStore();
  const toast = useToastStore();
  const folderName = pathBaseName(remoteDir) || remoteDir;

  // 先选目标本地目录（枚举可能较久，选择是最便宜的决策）
  const picked = await openDialog({
    directory: true,
    multiple: false,
    title: `选择「${folderName}」的下载位置`,
  });
  if (typeof picked !== "string" || !picked) return;
  // 落点语义：下载文件夹 foo 到 D → D/foo/...
  const localRoot = stripTrailingSlash(picked);
  const localTarget = localJoin(localRoot, folderName);

  const batchId = transfers.startFolderBatch("folder-download", folderName, localRoot);
  const isCancelled = { value: false };
  let walkId: string | null = null;
  const childRef: ChildRef = { ids: [] };
  bindCancelHandle(transfers, batchId, () => walkId, isCancelled, childRef);

  // 枚举远端清单（进度事件更新「已发现 N 项」）
  walkId = crypto.randomUUID();
  const unlisten = await onWalkProgress(walkId, (p) => {
    transfers.updateBatch(batchId, { discovered: p.files + p.dirs });
  });
  let output: WalkOutput;
  try {
    const result = await walkRemote(walkId, connectionId, remoteDir);
    output = result.output;
    if (result.cancelled) {
      unlisten();
      transfers.updateBatch(batchId, {
        status: "cancelled",
        phase: "transferring",
        skippedLinks: output.skippedLinks,
      });
      return;
    }
  } catch (e) {
    unlisten();
    transfers.updateBatch(batchId, {
      status: "failed",
      error: e instanceof Error ? e.message : String(e),
    });
    return;
  }
  unlisten();
  walkId = null;
  if (isCancelled.value) return;

  // 冲突收集：本地 fs 逐路径探测（目录命中按「合并」放行，不进对话框）
  const listFiles = output.files.filter((f) => f.kind === "file");
  const targetAbs = listFiles.map((f) => localJoin(localTarget, f.path));
  const metas = await localFileMeta(targetAbs).catch(() => [] as (LocalFileMeta | null)[]);
  const groups = new Map<string, ConflictGroup>();
  for (let i = 0; i < listFiles.length; i++) {
    const f = listFiles[i];
    const meta = metas[i] ?? null;
    if (!meta || meta.isDir) continue;
    const name = pathBaseName(f.path);
    const parentRel = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "";
    const dirAbs = parentRel ? localJoin(localTarget, parentRel) : localTarget;
    if (!groups.has(dirAbs)) {
      groups.set(dirAbs, { targetDir: dirAbs, incoming: [], existing: new Map() });
    }
    const g = groups.get(dirAbs)!;
    g.incoming.push({ name, size: f.size, mtime: null, kind: "file" });
    g.existing.set(name, {
      name,
      kind: "file",
      size: meta.size,
      mtime: meta.mtime,
      permissions: "",
      owner: null,
      group: null,
      atime: null,
    });
  }

  // 冲突对话框（多目录合并；取消 = 整批不动）
  let decisions: MultiDecisions;
  try {
    const resolved = await conflicts.resolveMulti([...groups.values()]);
    if (!resolved) {
      transfers.updateBatch(batchId, { status: "cancelled", phase: "transferring" });
      return;
    }
    decisions = resolved;
  } catch (e) {
    transfers.updateBatch(batchId, {
      status: "failed",
      error: e instanceof Error ? e.message : String(e),
    });
    return;
  }
  if (isCancelled.value) return;

  const renames = renamesFromDecisions(decisions, (dir) =>
    dir === localTarget ? "" : dir.slice(localTarget.length + 1).replace(/\\/g, "/"),
  );
  const jobs: BatchJob[] = listFiles.map((f) => {
    const rel = renames.get(f.path) ?? f.path;
    return {
      rel,
      size: f.size,
      src: joinPath(remoteDir, rel),
      dst: localJoin(localTarget, rel),
    };
  });

  await runBatchJobs(
    batchId,
    jobs,
    (job) => transfers.startDownloadTo(connectionId, job.src, job.dst, batchId),
    async () => {
      // 本地逐级建目录（create_dir_all 幂等；落点根目录 + 完整结构语义）
      await localMkdirP(localTarget).catch(() => {});
      for (const rel of output.dirs) {
        if (isCancelled.value) return;
        await localMkdirP(localJoin(localTarget, rel)).catch(() => {});
      }
    },
    isCancelled,
    childRef,
    // C2：文件夹下载完成 toast +「打开目标目录」
    () =>
      toast.show(`已下载文件夹「${folderName}」`, {
        label: "打开目标目录",
        run: () => void revealItemInDir(localTarget).catch(() => {}),
      }),
  );
}

/** —— A2：本地 → 远端（上传文件夹）—— */

/** 拖入/粘贴含目录时调用：本地 walk → 冲突 → 远端逐级建目录 → 逐文件上传。
 *  落点语义：上传 foo 到 /target → /target/foo/... */
export async function uploadFolderTo(
  connectionId: string,
  localDir: string,
  targetRemoteDir: string,
): Promise<void> {
  const transfers = useTransferStore();
  const conflicts = useConflictStore();
  const folderName = pathBaseName(localDir) || localDir;
  const remoteRoot = joinPath(targetRemoteDir, folderName);

  const batchId = transfers.startFolderBatch("folder-upload", folderName, targetRemoteDir);
  const isCancelled = { value: false };
  const childRef: ChildRef = { ids: [] };
  bindCancelHandle(transfers, batchId, () => null, isCancelled, childRef);

  // 本地 walk（Rust 侧 std::fs，不跟随符号链接防环防越界）
  let output: WalkOutput;
  try {
    output = await walkLocal(localDir);
  } catch (e) {
    transfers.updateBatch(batchId, {
      status: "failed",
      error: e instanceof Error ? e.message : String(e),
    });
    return;
  }
  if (isCancelled.value) return;

  // 冲突收集：涉及的目标目录集合各一次 listDir 比对（目录名冲突=合并放行）
  const listFiles = output.files.filter((f) => f.kind === "file");
  const sizeByPath = new Map(listFiles.map((f) => [f.path, f.size]));
  const parentRelOf = (rel: string) =>
    rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
  const remoteDirOf = (parentRel: string) =>
    parentRel ? joinPath(remoteRoot, parentRel) : remoteRoot;

  const targetDirs = new Set<string>([remoteRoot]);
  for (const rel of listFiles.map((f) => f.path)) targetDirs.add(remoteDirOf(parentRelOf(rel)));
  const groups = new Map<string, ConflictGroup>();
  for (const dir of targetDirs) {
    let entries: FileEntry[] = [];
    try {
      entries = await listDir(connectionId, dir);
    } catch {
      // 目录尚不存在：无冲突（后续 create_dir 阶段建立）
    }
    groups.set(dir, { targetDir: dir, incoming: [], existing: new Map(entries.map((e) => [e.name, e])) });
  }
  for (const rel of listFiles.map((f) => f.path)) {
    const dir = remoteDirOf(parentRelOf(rel));
    groups.get(dir)!.incoming.push({
      name: pathBaseName(rel),
      size: sizeByPath.get(rel) ?? null,
      mtime: null,
      kind: "file",
    });
  }

  let decisions: MultiDecisions;
  try {
    const resolved = await conflicts.resolveMulti([...groups.values()]);
    if (!resolved) {
      transfers.updateBatch(batchId, { status: "cancelled", phase: "transferring" });
      return;
    }
    decisions = resolved;
  } catch (e) {
    transfers.updateBatch(batchId, {
      status: "failed",
      error: e instanceof Error ? e.message : String(e),
    });
    return;
  }
  if (isCancelled.value) return;

  const renames = renamesFromDecisions(decisions, (dir) =>
    dir === remoteRoot ? "" : dir.slice(remoteRoot.length + 1),
  );
  const jobs: BatchJob[] = listFiles.map((f) => {
    const rel = renames.get(f.path) ?? f.path;
    return {
      rel,
      size: f.size,
      src: localJoin(localDir, rel),
      dst: joinPath(remoteRoot, rel),
    };
  });

  await runBatchJobs(
    batchId,
    jobs,
    (job) => {
      const parentDir = remoteDirOf(parentRelOf(job.rel));
      return transfers.startUpload(connectionId, job.src, parentDir, pathBaseName(job.rel), batchId);
    },
    async () => {
      // 远端逐级 create_dir（自顶向下补父链；已存在错误当成功——mkdir 失败后 stat 判定）
      const ensured = new Set<string>();
      const ensureDir = async (dir: string) => {
        if (ensured.has(dir)) return;
        ensured.add(dir);
        const parent = posixParent(dir);
        if (parent && dir !== remoteRoot && dir !== "/") await ensureDir(parent);
        try {
          await mkdirSsh(connectionId, dir);
        } catch {
          const st = await statSsh(connectionId, dir).catch(() => null);
          if (!st || st.kind !== "dir") {
            throw new Error(`无法创建远端目录 ${dir}`);
          }
        }
      };
      const dirsToEnsure = new Set<string>([remoteRoot]);
      for (const job of jobs) dirsToEnsure.add(remoteDirOf(parentRelOf(job.rel)));
      for (const dir of dirsToEnsure) {
        if (isCancelled.value) return;
        await ensureDir(dir);
      }
    },
    isCancelled,
    childRef,
  );
  // 块 E：本会话文件操作强制失效目标目录缓存（无论成败，可能有部分文件写入）
  dirCacheOf(connectionId).invalidate(remoteRoot);
}

/** —— 拖入/粘贴统一入口（外部路径混合分流）—— */

/** 单文件上传冲突解析（ExplorerPane 拖放/粘贴与 Workspace 外部拖入共用）：
 *  有同名先弹对话框；取消/出错返回 null */
export async function resolveUploadDecisions(
  connectionId: string,
  targetDir: string,
  localPaths: string[],
): Promise<{ path: string; finalName: string }[] | null> {
  const conflicts = useConflictStore();
  const metas = await localFileMeta(localPaths).catch(() => [] as (LocalFileMeta | null)[]);
  const incoming = localPaths.map((p, i) => ({
    name: pathBaseName(p),
    size: metas[i]?.size ?? null,
    mtime: metas[i]?.mtime ?? null,
  }));
  try {
    const decisions = await conflicts.resolve(connectionId, targetDir, incoming);
    if (!decisions) return null;
    const out: { path: string; finalName: string }[] = [];
    for (const d of decisions) {
      if (d.action !== "proceed") continue;
      const path = localPaths.find((lp) => pathBaseName(lp) === d.name);
      if (path) out.push({ path, finalName: d.finalName });
    }
    return out;
  } catch (e) {
    throw e instanceof Error ? e : new Error(String(e));
  }
}

/** 外部路径上传分流：目录走递归上传（聚合卡编排），文件走冲突对话框 + 逐个上传 */
export async function uploadMixedPaths(
  connectionId: string,
  localPaths: string[],
  targetRemoteDir: string,
): Promise<void> {
  const transfers = useTransferStore();
  const metas = await localFileMeta(localPaths).catch(() => [] as (LocalFileMeta | null)[]);
  const folders: string[] = [];
  const files: string[] = [];
  localPaths.forEach((p, i) => {
    if (metas[i]?.isDir) folders.push(p);
    else files.push(p);
  });
  for (const dir of folders) {
    await uploadFolderTo(connectionId, dir, targetRemoteDir);
  }
  if (!files.length) return;
  // 冲突对话框取消（null）= 文件部分不动；listDir 等错误向上抛（组件横幅展示）
  const resolved = await resolveUploadDecisions(connectionId, targetRemoteDir, files);
  if (!resolved) return;
  for (const item of resolved) {
    void transfers.startUpload(connectionId, item.path, targetRemoteDir, item.finalName);
  }
  // 块 E：本会话文件操作强制失效目标目录缓存
  dirCacheOf(connectionId).invalidate(targetRemoteDir);
}
