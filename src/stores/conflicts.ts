import { defineStore } from "pinia";
import { computed, ref } from "vue";

import { listDir } from "@/api/ssh";
import { useSettingsStore, type ConflictResolveOption } from "@/stores/settings";
import type { FileEntry } from "@/types";

/** 一项待写入目标目录的内容（本地上传或远端粘贴共用） */
export interface IncomingItem {
  name: string;
  size: number | null;
  mtime: number | null;
  /** 远端粘贴时携带；本地上传缺省按文件展示 */
  kind?: FileEntry["kind"];
}

/** 冲突决策：skip 的项执行时剔除，proceed 以 finalName 写入目标目录 */
export interface ConflictDecision {
  name: string;
  finalName: string;
  action: "proceed" | "skip";
}

/** 多目录批次决策（递归传输：目录 → 该目录各传入项的决策） */
export type MultiDecisions = Map<string, ConflictDecision[]>;

/** 多目录批次的一组：目标目录 + 传入清单 + 调用方预取的已有项快照
 *  （下载 = 本地 fs 探测构造；上传 = listDir 结果；单目录粘贴 = store 内部 listDir） */
export interface ConflictGroup {
  targetDir: string;
  incoming: IncomingItem[];
  existing: Map<string, FileEntry>;
}

/** 对话框一行：传入项 vs 已有项 + 用户决策（targetDir 区分多目录批次的同名行） */
export interface ConflictRow {
  targetDir: string;
  name: string;
  incoming: IncomingItem;
  existing: FileEntry;
  resolution: ConflictResolveOption;
  /** 生成新名称策略下的目标名（可内联编辑） */
  newName: string;
}

/**
 * 传输/粘贴冲突对话框状态（Files FilesystemOperationDialog 的远端版）：
 * resolve() 做目标目录 listDir 精确名比对（Linux 大小写敏感，Files
 * FilesystemHelpers.GetCollisions 的远端版），无冲突静默放行；
 * 有冲突挂起调用方，用户决策后以决策列表放行。聚合策略变化写回设置
 * conflictsResolveOption（Files FileSystemDialogViewModel.SaveConflictResolveOption）。
 * resolveMulti() 为递归传输扩展：多个目标目录的冲突合并在一个对话框决策。
 */
export const useConflictStore = defineStore("conflicts", () => {
  /** 行键（多目录批次同名行不撞 key） */
  function rowKey(row: Pick<ConflictRow, "targetDir" | "name">): string {
    return `${row.targetDir}\u0000${row.name}`;
  }

  const session = ref<{ targetDir: string; rows: ConflictRow[]; multi: boolean } | null>(null);
  /** 聚合下拉（Files AggregatedResolveOption；custom = 各项不一致） */
  const aggregate = ref<ConflictResolveOption | "custom">("custom");

  let pending: ((decisions: MultiDecisions | null) => void) | null = null;
  /** 各组：目标目录 + 传入清单 + 已有项快照 */
  let allGroups: ConflictGroup[] = [];
  /** 目标目录 → 已有名集合 */
  let listingByDir = new Map<string, Set<string>>();

  const rows = computed(() => session.value?.rows ?? []);
  /** 继续按钮可用性：所有「生成新名称」行的新名合法且互不冲突 */
  const canContinue = computed(() =>
    rows.value.every((r) => r.resolution !== "newName" || isNewNameValid(r)),
  );

  /** 单目录入口（粘贴/单文件上传沿用）：内部 listDir 后转 resolveMulti */
  async function resolve(
    connectionId: string,
    targetDir: string,
    incoming: IncomingItem[],
  ): Promise<ConflictDecision[] | null> {
    const entries = await listDir(connectionId, targetDir);
    const decisions = await resolveMulti([
      {
        targetDir,
        incoming,
        existing: new Map(entries.map((e) => [e.name, e])),
      },
    ]);
    if (!decisions) return null;
    return decisions.get(targetDir) ?? [];
  }

  /** 多目录批次：调用方预取各组已有项快照，冲突合并在一个对话框决策。
   *  无任何冲突时静默放行（各组全部 proceed）。取消返回 null。 */
  async function resolveMulti(groups: ConflictGroup[]): Promise<MultiDecisions | null> {
    allGroups = groups;
    listingByDir = new Map(groups.map((g) => [g.targetDir, new Set(g.existing.keys())]));

    const conflictRows: ConflictRow[] = [];
    for (const g of groups) {
      for (const i of g.incoming) {
        const existing = g.existing.get(i.name);
        if (!existing) continue;
        conflictRows.push({
          targetDir: g.targetDir,
          name: i.name,
          incoming: i,
          existing,
          resolution: useSettingsStore().settings.conflictsResolveOption,
          newName: "",
        });
      }
    }

    // 建议名逐项生成，保证同目录批次内互不相同（对照该目录快照递增）
    for (const row of conflictRows) {
      row.newName = suggestName(row.name, takenNames(row.targetDir, row));
    }

    if (!conflictRows.length) {
      return proceedAll(groups);
    }

    aggregate.value = useSettingsStore().settings.conflictsResolveOption;
    const first = groups[0]?.targetDir ?? "";
    const multi = groups.length > 1;
    session.value = { targetDir: first, rows: conflictRows, multi };
    return new Promise((res) => {
      pending = res;
    });
  }

  /** 无冲突放行：每组全 proceed */
  function proceedAll(groups: ConflictGroup[]): MultiDecisions {
    const out: MultiDecisions = new Map();
    for (const g of groups) {
      out.set(
        g.targetDir,
        g.incoming.map((i) => ({ name: i.name, finalName: i.name, action: "proceed" as const })),
      );
    }
    return out;
  }

  /** 聚合下拉变化：下发到每个冲突项（Files ApplyConflictOptionToAll） */
  function applyAggregate(value: ConflictResolveOption | "custom") {
    aggregate.value = value;
    if (value !== "custom") {
      for (const row of rows.value) {
        row.resolution = value;
        if (value === "newName" && !row.newName) {
          row.newName = suggestName(row.name, takenNames(row.targetDir, row));
        }
      }
    }
  }

  /** 单项变化后重算聚合态：全部一致 → 该值，否则 custom（Files 102-116 行） */
  function setRowResolution(row: ConflictRow, value: ConflictResolveOption) {
    row.resolution = value;
    if (value === "newName" && !row.newName) {
      row.newName = suggestName(row.name, takenNames(row.targetDir, row));
    }
    const first = rows.value[0]?.resolution;
    aggregate.value = rows.value.every((r) => r.resolution === first)
      ? (first ?? "custom")
      : "custom";
  }

  /** 继续：非冲突项直通，冲突项按各自决策输出（按组归集） */
  function confirm() {
    if (!session.value || !canContinue.value) return;
    const out: MultiDecisions = new Map();
    for (const g of allGroups) {
      out.set(
        g.targetDir,
        g.incoming.map((i) => {
          const row = session.value?.rows.find(
            (r) => r.targetDir === g.targetDir && r.name === i.name,
          );
          if (!row || row.resolution === "skip") {
            return { name: i.name, finalName: i.name, action: "skip" as const };
          }
          return {
            name: i.name,
            finalName: row.resolution === "newName" ? row.newName.trim() : i.name,
            action: "proceed" as const,
          };
        }),
      );
    }
    finish(out);
  }

  /** 全部跳过：冲突项剔除，非冲突项照常（Files Secondary = ApplyToAll(Skip)） */
  function skipAllConflicts() {
    if (!session.value) return;
    const conflicting = new Set(rows.value.map((r) => rowKey(r)));
    const out: MultiDecisions = new Map();
    for (const g of allGroups) {
      out.set(
        g.targetDir,
        g.incoming.map((i) => ({
          name: i.name,
          finalName: i.name,
          action: conflicting.has(rowKey({ targetDir: g.targetDir, name: i.name }))
            ? ("skip" as const)
            : ("proceed" as const),
        })),
      );
    }
    finish(out);
  }

  /** 取消：整批不动 */
  function cancel() {
    finish(null);
  }

  function finish(decisions: MultiDecisions | null) {
    // 记住聚合策略（Files SaveConflictResolveOption：custom 不写）
    if (decisions && aggregate.value !== "custom") {
      const settings = useSettingsStore();
      if (settings.settings.conflictsResolveOption !== aggregate.value) {
        settings.update({ conflictsResolveOption: aggregate.value });
      }
    }
    session.value = null;
    pending?.(decisions);
    pending = null;
  }

  /** 某目录内的新名占用集合：该目录快照 + 该目录批次全部传入名 + 其他行的新名 */
  function takenNames(targetDir: string, except?: ConflictRow): Set<string> {
    const taken = new Set(listingByDir.get(targetDir) ?? []);
    for (const g of allGroups) {
      if (g.targetDir !== targetDir) continue;
      for (const i of g.incoming) taken.add(i.name);
    }
    for (const r of rows.value) {
      if (r.targetDir !== targetDir || r === except) continue;
      if (r.newName) taken.add(r.newName);
    }
    return taken;
  }

  /** 行级新名校验：非空、无斜杠、异于原名、不与目录快照/同目录批次内其他名冲突 */
  function isNewNameValid(row: ConflictRow): boolean {
    const name = row.newName.trim();
    if (!name || name.includes("/") || name === row.name) return false;
    return !takenNames(row.targetDir, row).has(name);
  }

  /** 主名 (2)、(3)… 递增到不冲突（「name.ext」→「name (2).ext」） */
  function suggestName(original: string, taken: Set<string>): string {
    const dot = original.lastIndexOf(".");
    const base = dot > 0 ? original.slice(0, dot) : original;
    const ext = dot > 0 ? original.slice(dot) : "";
    for (let n = 2; ; n++) {
      const candidate = `${base} (${n})${ext}`;
      if (!taken.has(candidate)) return candidate;
    }
  }

  return {
    session,
    aggregate,
    rows,
    canContinue,
    resolve,
    resolveMulti,
    applyAggregate,
    setRowResolution,
    confirm,
    skipAllConflicts,
    cancel,
    isNewNameValid,
    rowKey,
  };
});
