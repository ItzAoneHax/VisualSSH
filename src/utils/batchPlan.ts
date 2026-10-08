import type { IncomingItem, ConflictGroup, MultiDecisions } from "@/stores/conflicts";
import type { WalkOutput } from "@/api/walk";

/**
 * 递归传输的清单编排纯函数（第四阶段块 A）：与 store/命令零运行时依赖，
 * 供单测直接断言（冲突改名映射、文件批过滤、跳过链接计数）。
 */

/** 批内一个待传文件 */
export interface BatchJob {
  /** 清单相对路径（posix，冲突改名后的最终相对路径） */
  rel: string;
  size: number;
  /** 传输一端的完整路径（下载=远端；上传=本地） */
  src: string;
  /** 另一端的完整路径（下载=本地；上传=远端） */
  dst: string;
}

/** 决策表（决策目录 → 各项决策）展开为改名映射：批次相对路径 → 最终相对路径。
 *  dirToRel 把决策目录（下载=本地绝对 / 上传=远端绝对）还原为批次相对父目录。 */
export function renamesFromDecisions(
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

/** 清单 → 待传文件批：仅真实文件（符号链接/other 跳过），应用改名映射。
 *  冲突改名只影响目标端（源端保持原始 rel），mapPaths 分别接收原始与最终相对路径。 */
export function jobsFromOutput(
  output: WalkOutput,
  mapPaths: (rel: string, finalRel: string) => { src: string; dst: string },
  renames: Map<string, string>,
): BatchJob[] {
  const jobs: BatchJob[] = [];
  for (const f of output.files) {
    if (f.kind !== "file") continue;
    const finalRel = renames.get(f.path) ?? f.path;
    const { src, dst } = mapPaths(f.path, finalRel);
    jobs.push({ rel: finalRel, size: f.size, src, dst });
  }
  return jobs;
}

/** 跳过统计：清单中符号链接数量（跳过不传，结果汇总「跳过 N 个链接」） */
export function skippedLinkCount(output: WalkOutput): number {
  return output.files.filter((f) => f.kind === "symlink").length;
}

/** 冲突收集：各组按目录快照名比对，命中的构成冲突行键（store 生成完整 UI 行前的核心判定） */
export function collectConflictKeys(groups: ConflictGroup[]): { targetDir: string; name: string }[] {
  const keys: { targetDir: string; name: string }[] = [];
  for (const g of groups) {
    for (const i of g.incoming) {
      if (g.existing.has(i.name)) keys.push({ targetDir: g.targetDir, name: i.name });
    }
  }
  return keys;
}

/** 供类型引用复用（避免未用警告）：IncomingItem 在冲突收集语义上原样透传 */
export type { IncomingItem, ConflictGroup, MultiDecisions };
