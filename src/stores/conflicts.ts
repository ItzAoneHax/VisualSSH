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

/** 对话框一行：传入项 vs 远端已有项 + 用户决策 */
export interface ConflictRow {
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
 */
export const useConflictStore = defineStore("conflicts", () => {
  const session = ref<{ targetDir: string; rows: ConflictRow[] } | null>(null);
  /** 聚合下拉（Files AggregatedResolveOption；custom = 各项不一致） */
  const aggregate = ref<ConflictResolveOption | "custom">("custom");

  let pending: ((decisions: ConflictDecision[] | null) => void) | null = null;
  /** 目标目录本次 listDir 快照（校验建议名/新名不撞车用） */
  let listingNames = new Set<string>();
  let allIncoming: IncomingItem[] = [];

  const rows = computed(() => session.value?.rows ?? []);
  /** 继续按钮可用性：所有「生成新名称」行的新名合法且互不冲突 */
  const canContinue = computed(() =>
    rows.value.every((r) => r.resolution !== "newName" || isNewNameValid(r)),
  );

  async function resolve(
    connectionId: string,
    targetDir: string,
    incoming: IncomingItem[],
  ): Promise<ConflictDecision[] | null> {
    const entries = await listDir(connectionId, targetDir);
    const byName = new Map(entries.map((e) => [e.name, e]));
    listingNames = new Set(entries.map((e) => e.name));
    allIncoming = incoming;

    const conflictRows: ConflictRow[] = incoming
      .filter((i) => byName.has(i.name))
      .map((i) => ({
        name: i.name,
        incoming: i,
        existing: byName.get(i.name)!,
        resolution: useSettingsStore().settings.conflictsResolveOption,
        newName: "",
      }));

    if (!conflictRows.length) {
      return incoming.map((i) => ({
        name: i.name,
        finalName: i.name,
        action: "proceed" as const,
      }));
    }

    // 建议名逐项生成，保证批次内互不相同（对照本次 listDir 结果递增）
    for (const row of conflictRows) {
      row.newName = suggestName(row.name, takenNames());
    }

    aggregate.value = useSettingsStore().settings.conflictsResolveOption;
    session.value = { targetDir, rows: conflictRows };
    return new Promise((res) => {
      pending = res;
    });
  }

  /** 聚合下拉变化：下发到每个冲突项（Files ApplyConflictOptionToAll） */
  function applyAggregate(value: ConflictResolveOption | "custom") {
    aggregate.value = value;
    if (value !== "custom") {
      for (const row of rows.value) {
        row.resolution = value;
        if (value === "newName" && !row.newName) {
          row.newName = suggestName(row.name, takenNames(row));
        }
      }
    }
  }

  /** 单项变化后重算聚合态：全部一致 → 该值，否则 custom（Files 102-116 行） */
  function setRowResolution(row: ConflictRow, value: ConflictResolveOption) {
    row.resolution = value;
    if (value === "newName" && !row.newName) {
      row.newName = suggestName(row.name, takenNames(row));
    }
    const first = rows.value[0]?.resolution;
    aggregate.value = rows.value.every((r) => r.resolution === first)
      ? (first ?? "custom")
      : "custom";
  }

  /** 继续：非冲突项直通，冲突项按各自决策输出 */
  function confirm() {
    if (!session.value || !canContinue.value) return;
    finish(
      allIncoming.map((i) => {
        const row = session.value?.rows.find((r) => r.name === i.name);
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

  /** 全部跳过：冲突项剔除，非冲突项照常（Files Secondary = ApplyToAll(Skip)） */
  function skipAllConflicts() {
    if (!session.value) return;
    const conflicting = new Set(session.value.rows.map((r) => r.name));
    finish(
      allIncoming.map((i) => ({
        name: i.name,
        finalName: i.name,
        action: conflicting.has(i.name) ? ("skip" as const) : ("proceed" as const),
      })),
    );
  }

  /** 取消：整批不动 */
  function cancel() {
    finish(null);
  }

  function finish(decisions: ConflictDecision[] | null) {
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

  /** 新名占用集合：目标目录快照 + 批次全部传入名 + 其他行的新名 */
  function takenNames(except?: ConflictRow): Set<string> {
    const taken = new Set(listingNames);
    for (const i of allIncoming) taken.add(i.name);
    for (const r of rows.value) {
      if (r !== except && r.newName) taken.add(r.newName);
    }
    return taken;
  }

  /** 行级新名校验：非空、无斜杠、异于原名、不与目录快照/批次内其他名冲突 */
  function isNewNameValid(row: ConflictRow): boolean {
    const name = row.newName.trim();
    if (!name || name.includes("/") || name === row.name) return false;
    return !takenNames(row).has(name);
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
    applyAggregate,
    setRowResolution,
    confirm,
    skipAllConflicts,
    cancel,
    isNewNameValid,
  };
});
