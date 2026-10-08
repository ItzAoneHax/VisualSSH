import { listen } from "@tauri-apps/api/event";

import {
  archiveCancel,
  archiveStart,
  type ArchiveDone,
} from "@/api/archive";
import { execSsh, mkdirSsh } from "@/api/ssh";
import { useConflictStore } from "@/stores/conflicts";
import type { ExplorerStore } from "@/stores/explorer";
import { useToastStore } from "@/stores/toast";
import { useTransferStore } from "@/stores/transfer";
import type { FileEntry } from "@/types";
import {
  archiveBaseName,
  archiveFamilyOf,
  createCommand,
  extractCommand,
  familyLabel,
  gunzipCommand,
  listCommand,
  parseEntries,
  planExtraction,
  requiredToolFor,
  uniqueName,
  unsafeEntries,
  type CompressFormat,
} from "@/utils/archive";
import { joinPath } from "@/utils/format";

/**
 * 压缩/解压编排（第五阶段块 C）：冲突决策 → 不定进度 exec 卡（可取消）→
 * 完成 toast + 重载 + 选中产物。解压前先列条目做 ZipSlip 校验（C4），
 * smart 模式按 Files 语义判定解到当前目录还是子文件夹（C3）。
 */

/** 等待一次 archive://done:{runId}（注册竞态与终态幂等处理） */
function onceArchiveDone(runId: string): Promise<ArchiveDone> {
  return new Promise((resolve) => {
    let unlisten: (() => void) | null = null;
    let settled = false;
    const finish = (payload: ArchiveDone) => {
      if (settled) return;
      settled = true;
      unlisten?.();
      resolve(payload);
    };
    void listen<ArchiveDone>(`archive://done:${runId}`, (event) =>
      finish(event.payload),
    ).then((u) => {
      unlisten = u;
      if (settled) u();
    });
  });
}

/** 压缩（C2）：outName 已由对话框给出，冲突决策后 exec 创建 */
export async function compressSelection(
  ex: ExplorerStore,
  connectionId: string,
  names: string[],
  format: CompressFormat,
  outName: string,
): Promise<void> {
  const conflicts = useConflictStore();
  const decisions = await conflicts.resolve(connectionId, ex.cwd, [
    { name: outName, size: null, mtime: null, kind: "file" },
  ]);
  const decision = decisions?.[0];
  if (!decisions || !decision || decision.action !== "proceed") return;

  const cmd = createCommand(format, ex.cwd, decision.finalName, names);
  const transfers = useTransferStore();
  const card = transfers.startArchiveOp(
    `正在压缩 ${names.length} 项到 ${decision.finalName}`,
  );
  transfers.registerArchiveCancel(card.id, () => void archiveCancel(card.id));
  const done = onceArchiveDone(card.id);
  try {
    await archiveStart(card.id, connectionId, cmd.program, cmd.args);
  } catch (e) {
    card.setFailed(e instanceof Error ? e.message : String(e));
    return;
  }
  const result = await done;
  if (result.cancelled) {
    card.setCancelled();
    return;
  }
  if (result.ok) {
    card.setDone(`已压缩到 ${decision.finalName}`);
    useToastStore().show(`已压缩到 ${decision.finalName}`);
    await ex.reloadPreserve();
    ex.selectedNames = new Set([decision.finalName]);
  } else {
    card.setFailed(
      result.stderr.trim() ||
        `压缩失败（退出码 ${result.exitCode ?? "未知"}）`,
    );
  }
}

/**
 * 解压（C3/C4）：mode = here（当前目录）/ subdir（强制子文件夹）/ smart
 * （列条目后按 Files 语义判定）。zipSlip 不安全条目一律拒绝。
 * 返回 void；失败写 explorer.error。
 */
export async function extractArchive(
  ex: ExplorerStore,
  connectionId: string,
  entry: FileEntry,
  mode: "here" | "subdir" | "smart",
  tools: { has: (tool: string) => boolean },
): Promise<void> {
  const family = archiveFamilyOf(entry.name);
  if (!family) return;
  const tool = requiredToolFor(family);
  if (!tools.has(tool)) {
    ex.error = `服务器缺少 ${tool} 命令，无法解压 ${familyLabel(family)} 档案`;
    return;
  }

  const transfers = useTransferStore();
  const archivePath = joinPath(ex.cwd, entry.name);

  // —— gz 单文件：无条目可列（流式无路径穿越风险），直接冲突决策后 gunzip ——
  if (family === "gz") {
    const outName = archiveBaseName(entry.name);
    const conflicts = useConflictStore();
    const decisions = await conflicts.resolve(connectionId, ex.cwd, [
      { name: outName, size: null, mtime: null, kind: "file" },
    ]);
    const decision = decisions?.[0];
    if (!decisions || !decision || decision.action !== "proceed") return;
    const cmd = gunzipCommand(archivePath, joinPath(ex.cwd, decision.finalName));
    await runArchiveCard(
      ex,
      transfers,
      cardTitle(`解压`, entry.name),
      connectionId,
      cmd,
      `已解压到 ${decision.finalName}`,
      decision.finalName,
    );
    return;
  }

  // —— 列条目（C4 安全防线）——
  const spec = listCommand(family, archivePath);
  if (!spec) return;
  let entries: string[];
  try {
    const out = await execSsh(connectionId, spec.program, spec.args);
    if (out.exitCode !== 0 && !out.stdout.trim()) {
      ex.error =
        out.stderr.trim() || `读取档案条目失败（退出码 ${out.exitCode ?? "未知"}）`;
      return;
    }
    entries = parseEntries(out.stdout);
  } catch (e) {
    ex.error = e instanceof Error ? e.message : String(e);
    return;
  }
  const unsafe = unsafeEntries(entries);
  if (unsafe.length) {
    // StorageArchiveService.cs:365-401 ZipSlip 防护意图的等价拒绝
    ex.error = `拒绝解压：档案包含不安全路径（如 ${unsafe[0]}）`;
    return;
  }

  // —— 目标目录决策 ——
  let targetDir = ex.cwd;
  let productName = "";
  if (mode === "subdir" || (mode === "smart" && planExtraction(entries) === "subdir")) {
    const taken = new Set(
      ex.entries.filter((e) => e.kind === "dir").map((e) => e.name),
    );
    const name = uniqueName(archiveBaseName(entry.name), taken);
    try {
      await mkdirSsh(connectionId, joinPath(ex.cwd, name));
    } catch (e) {
      ex.error = e instanceof Error ? e.message : String(e);
      return;
    }
    targetDir = joinPath(ex.cwd, name);
    productName = name;
  }

  const cmd = extractCommand(family, archivePath, targetDir);
  await runArchiveCard(
    ex,
    transfers,
    cardTitle("解压", entry.name),
    connectionId,
    cmd,
    productName
      ? `已解压到 ${productName}`
      : `已解压 ${entry.name} 到当前目录`,
    productName,
  );
}

function cardTitle(verb: string, name: string): string {
  return `正在${verb} ${name}`;
}

/** exec 卡生命周期包装：启动 → 等终态 → 卡片转轨 + toast + 重载 + 选中产物 */
async function runArchiveCard(
  ex: ExplorerStore,
  transfers: ReturnType<typeof useTransferStore>,
  runningTitle: string,
  connectionId: string,
  cmd: { program: string; args: string[] },
  doneTitle: string,
  productName: string,
): Promise<void> {
  const card = transfers.startArchiveOp(runningTitle);
  transfers.registerArchiveCancel(card.id, () => void archiveCancel(card.id));
  const done = onceArchiveDone(card.id);
  try {
    await archiveStart(card.id, connectionId, cmd.program, cmd.args);
  } catch (e) {
    card.setFailed(e instanceof Error ? e.message : String(e));
    return;
  }
  const result = await done;
  if (result.cancelled) {
    card.setCancelled();
    return;
  }
  if (result.ok) {
    card.setDone(doneTitle);
    useToastStore().show(doneTitle);
    await ex.reloadPreserve();
    if (productName) ex.selectedNames = new Set([productName]);
  } else {
    card.setFailed(
      result.stderr.trim() ||
        `操作失败（退出码 ${result.exitCode ?? "未知"}）`,
    );
  }
}
