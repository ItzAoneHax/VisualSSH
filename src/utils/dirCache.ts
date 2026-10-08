import type { FileEntry } from "@/types";

/**
 * 远端目录列表缓存（第四阶段块 E）：每连接一份 LRU（上限 100 目录）。
 * 后退/前进/切标签命中先瞬时渲染；fetchedAt 距今超过 30s 再后台静默刷新。
 * invalidate(path) 删除该目录及以它为前缀的子目录（文件操作/重连后强制失效）。
 */

export interface DirCacheEntry {
  entries: FileEntry[];
  /** 写入时刻（epoch ms） */
  fetchedAt: number;
}

/** 缓存新鲜期：以内不再刷新（导航直接用），超过触发静默刷新 */
export const DIR_CACHE_STALE_MS = 30_000;
/** 每连接 LRU 上限 */
export const DIR_CACHE_LIMIT = 100;

export class DirCache {
  /** Map 插入序 = LRU 近似（get 移到末尾） */
  private map = new Map<string, DirCacheEntry>();

  private touch(path: string, entry: DirCacheEntry) {
    this.map.delete(path);
    this.map.set(path, entry);
  }

  /** 命中返回条目并移到最新；未命中返回 null */
  get(path: string): DirCacheEntry | null {
    const entry = this.map.get(path);
    if (!entry) return null;
    this.touch(path, entry);
    return entry;
  }

  put(path: string, entries: FileEntry[]) {
    const entry = { entries, fetchedAt: Date.now() };
    this.touch(path, entry);
    // LRU 淘汰：超出上限时逐出最旧（Map 首个键）
    while (this.map.size > DIR_CACHE_LIMIT) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  /** 强制失效：目录自身 + 其下所有子目录缓存 */
  invalidate(path: string) {
    const prefix = path.endsWith("/") ? path : `${path}/`;
    for (const key of [...this.map.keys()]) {
      if (key === path || key.startsWith(prefix)) this.map.delete(key);
    }
  }

  clear() {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }

  /** 新鲜度判定（供调用方决定是否静默刷新） */
  static isStale(entry: DirCacheEntry, now = Date.now()): boolean {
    return now - entry.fetchedAt > DIR_CACHE_STALE_MS;
  }
}

/** connectionId → 缓存（模块级：跨 explorer 实例共享同一连接的缓存） */
const registries = new Map<string, DirCache>();

export function dirCacheOf(connectionId: string): DirCache {
  let cache = registries.get(connectionId);
  if (!cache) {
    cache = new DirCache();
    registries.set(connectionId, cache);
  }
  return cache;
}

/** 连接标识变更/断开时丢弃缓存（防泄漏；重连后按需重建） */
export function dropDirCache(connectionId: string) {
  registries.delete(connectionId);
}
