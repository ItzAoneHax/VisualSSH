import type { SortKey } from "@/stores/explorer";

/**
 * 按目录记忆视图偏好（仿 Files LayoutPreferencesManager，Files 存注册表
 * LayoutPreferencesDatabase，此处换 localStorage——报告注明差异）：
 * map["<profileId>:<absPath>"] → { sortKey, sortDesc, columns }，LRU 上限 200 条。
 * 行高是全局设置不入目录记忆（与 Files 一致：DetailsViewSize 为全局 Layout 设置）。
 */

export interface ColumnState {
  key: SortKey;
  /** 列宽 px；name 列恒为弹性 1fr，忽略此值 */
  width: number;
  visible: boolean;
}

export interface FolderPref {
  sortKey: SortKey;
  sortDesc: boolean;
  columns: ColumnState[];
  /** LRU 时间戳 */
  ts: number;
}

const STORAGE_KEY = "visualssh:folderprefs:v1";
const LIMIT = 200;

type PrefMap = Record<string, FolderPref>;

export function prefKey(profileId: string, path: string): string {
  return `${profileId}:${path}`;
}

function loadAll(): PrefMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as PrefMap) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function persistAll(map: PrefMap) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // 隐私模式：仅会话内生效
  }
}

export function getFolderPref(profileId: string, path: string): FolderPref | null {
  if (!profileId) return null;
  return loadAll()[prefKey(profileId, path)] ?? null;
}

/** 写回即刷新 LRU 时间戳；超上限淘汰最旧条目 */
export function putFolderPref(
  profileId: string,
  path: string,
  pref: Omit<FolderPref, "ts">,
) {
  if (!profileId) return;
  const map = loadAll();
  map[prefKey(profileId, path)] = { ...pref, ts: Date.now() };
  const keys = Object.keys(map);
  if (keys.length > LIMIT) {
    keys
      .sort((a, b) => map[a].ts - map[b].ts)
      .slice(0, keys.length - LIMIT)
      .forEach((k) => delete map[k]);
  }
  persistAll(map);
}
