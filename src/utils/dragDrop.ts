/**
 * 行内拖拽（M7 步骤 4）的纯函数：payload 序列化、模式判定、目标解析。
 * HTML5 DnD 无法在 mock 环境真实合成，执行层（ExplorerPane/TabBar/侧栏）只做
 * 事件接线，判定逻辑全部收敛在此，便于脚本断言。
 */

/** 行拖拽的自定义数据类型（dataTransfer.types 中出现即视为文件拖拽） */
export const FILES_DND_TYPE = "application/x-visualssh-files";
/** 标签重排的自定义数据类型（TabBar 内部） */
export const TAB_DND_TYPE = "application/x-visualssh-tab";

/** 行拖拽载荷（dragstart 写入、drop 读出） */
export interface FilesDragPayload {
  connectionId: string;
  /** 源目录 */
  dir: string;
  /** 拖动的条目名集合（多选拖整集合） */
  names: string[];
}

/** 最小 DataTransfer 形状（真实 DataTransfer 的子集，测试用 stub 可满足） */
export interface DataTransferLike {
  setData(type: string, value: string): void;
  getData(type: string): string;
  types: readonly string[];
}

export function writeFilesPayload(dt: DataTransferLike, payload: FilesDragPayload): void {
  dt.setData(FILES_DND_TYPE, JSON.stringify(payload));
  // effectAllowed：move 优先，目标 dragover 按修饰键收敛 dropEffect
  try {
    (dt as DataTransfer).effectAllowed = "copyMove";
  } catch {
    // stub 无 effectAllowed 时忽略
  }
}

/** drop 阶段读载荷；非本应用拖拽（类型缺失/JSON 损坏）返回 null */
export function readFilesPayload(dt: DataTransferLike): FilesDragPayload | null {
  const raw = dt.getData(FILES_DND_TYPE);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<FilesDragPayload>;
    if (
      typeof parsed.connectionId === "string" &&
      typeof parsed.dir === "string" &&
      Array.isArray(parsed.names) &&
      parsed.names.every((n) => typeof n === "string")
    ) {
      return { connectionId: parsed.connectionId, dir: parsed.dir, names: parsed.names };
    }
    return null;
  } catch {
    return null;
  }
}

/** dragover 阶段判定是否本应用的文件拖拽（此时 getData 被浏览器安全限制为空，只看 types） */
export function hasFilesPayload(dt: DataTransferLike): boolean {
  return dt.types.includes(FILES_DND_TYPE);
}

/** 落点模式：按住 Ctrl = 复制，否则移动（Explorer/Files 惯例） */
export type DropMode = "move" | "copy";

export function resolveDropMode(ctrlKey: boolean): DropMode {
  return ctrlKey ? "copy" : "move";
}

/** 拖拽落点（解析自 drop 事件的挂载点） */
export type DropTarget =
  | { kind: "blank"; dir: string }
  | { kind: "folder"; dir: string }
  | { kind: "breadcrumb"; dir: string }
  | { kind: "pinned-item"; dir: string }
  | { kind: "pinned-blank" }
  | { kind: "tab"; dir: string }
  | { kind: "tab-new" };

/** 源目录下的具体落点目录（pinned-blank / tab-new 无目标目录，由调用方分支处理） */
export function targetDirOf(target: DropTarget): string | null {
  switch (target.kind) {
    case "blank":
    case "folder":
    case "breadcrumb":
    case "pinned-item":
    case "tab":
      return target.dir;
    default:
      return null;
  }
}

/** 跨连接判定（v1 限制：跨连接拖拽不执行，提示 toast） */
export function isCrossConnection(payload: FilesDragPayload, currentConnectionId: string): boolean {
  return payload.connectionId !== currentConnectionId;
}

/** 同目录自落（拖到自身所在目录）：无操作 */
export function isSameDir(payload: FilesDragPayload, targetDir: string): boolean {
  return payload.dir === targetDir;
}

/** 多选拖拽的集合解析：拖的行在选中集合内且集合 >1 → 整个集合；否则仅该行 */
export function resolveDragNames(name: string, selectedNames: ReadonlySet<string>): string[] {
  if (selectedNames.has(name) && selectedNames.size > 1) return [...selectedNames];
  return [name];
}
