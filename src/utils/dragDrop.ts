/**
 * 文件拖拽的纯函数：载荷形状、模式判定、跨连接/同目录判定。
 * 拖拽会话本体（长按武装、ghost、命中、落点分发）在 utils/fileDrag.ts；
 * 标签重排仍走 HTML5 DnD（application/x-visualssh-tab，TabBar 内部）。
 */

/** 行拖拽载荷（长按武装时构建、落点执行器消费） */
export interface FilesDragPayload {
  connectionId: string;
  /** 源目录 */
  dir: string;
  /** 拖动的条目名集合（多选拖整集合） */
  names: string[];
}

/** 落点模式：按住 Ctrl = 复制，否则移动（Explorer/Files 惯例） */
export type DropMode = "move" | "copy";

export function resolveDropMode(ctrlKey: boolean): DropMode {
  return ctrlKey ? "copy" : "move";
}

/** 跨连接判定（v1 限制：跨连接拖拽走「暂存下载→上传」管线，文件夹跳过） */
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
