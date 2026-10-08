import type { FileEntry } from "@/types";

/**
 * 预览判别链与内容缓存（预览窗格 + 表格缩略图共用，第五阶段块 A/B）。
 * 判别链简化自 Files InfoPaneViewModel.cs:249-388（HTML/PDF 官方已停用，
 * 压缩包内浏览不做）：文件夹 → 图片 → Markdown → 文本 → Basic 兜底。
 */

/** 图片扩展名（判别链②与缩略图共用一套） */
export const IMAGE_EXTS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif",
]);

/** 文本/代码扩展名白名单（与编辑器 editor.ts 的 TEXT_EXTS 同清单；md 走渲染分支） */
export const TEXT_EXTS = new Set([
  "txt", "json", "yaml", "yml", "log", "md", "conf", "ini", "toml", "env", "sh", "py",
]);

/** 图片预览大小上限（判别链②） */
export const IMAGE_PREVIEW_MAX = 10 * 1024 * 1024;
/** 文本/Markdown 预览大小上限（后端 read_file 同款限制） */
export const TEXT_PREVIEW_MAX = 2 * 1024 * 1024;
/** 缩略图候选大小上限（表格行，块 B） */
export const THUMBNAIL_MAX = 2 * 1024 * 1024;

export type PreviewKind = "folder" | "image" | "markdown" | "text" | "basic";

export function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/**
 * 预览判别链（简化自 InfoPaneViewModel.GetBuiltInPreviewControlAsync，按序）：
 * ① 非普通文件（文件夹等） → folder（提示选择文件以预览）；
 * ② 图片且 ≤10MB → image；③ .md（≤2MB）→ markdown；
 * ④ 文本白名单且 ≤2MB → text；⑤ 其余/超限 → basic。
 */
export function previewKindOf(entry: FileEntry): PreviewKind {
  if (entry.kind !== "file" && entry.kind !== "symlink") return "folder";
  const ext = extOf(entry.name);
  if (IMAGE_EXTS.has(ext) && entry.size <= IMAGE_PREVIEW_MAX) return "image";
  if (ext === "md" && entry.size <= TEXT_PREVIEW_MAX) return "markdown";
  if (TEXT_EXTS.has(ext) && entry.size <= TEXT_PREVIEW_MAX) return "text";
  return "basic";
}

/** 表格缩略图候选：图片扩展名且 ≤2MB（块 B；symlink 指向的图片不追读） */
export function isThumbnailCandidate(entry: FileEntry): boolean {
  return entry.kind === "file" && IMAGE_EXTS.has(extOf(entry.name)) && entry.size <= THUMBNAIL_MAX;
}

/** 图片 MIME（blob 类型；未知扩展名退 octet-stream） */
export function imageMimeOf(name: string): string {
  switch (extOf(name)) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "bmp":
      return "image/bmp";
    case "ico":
      return "image/x-icon";
    case "avif":
      return "image/avif";
    default:
      return "application/octet-stream";
  }
}

/** base64 → 字节（atob 逐字符，远端读图 ≤10MB 可接受）；缓冲显式 ArrayBuffer 可直接作 BlobPart */
export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const buffer = new ArrayBuffer(bin.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** 符号权限串 → 三位八进制（drwxr-xr-x → 755；mode_string 只输出 r/w/x/-） */
export function permissionsOctal(symbolic: string): string {
  const bits = symbolic.slice(1, 10);
  if (bits.length < 9) return "—";
  let value = 0;
  for (let i = 0; i < 9; i++) {
    const on = bits[i] !== "-";
    value = value * 2 + (on ? 1 : 0);
  }
  // 9 位二进制 → 3 位八进制
  const octal = value.toString(8).padStart(3, "0");
  return octal;
}

interface CacheEntry {
  value: string;
  bytes: number;
  /** blob URL（evict 时 revoke；文本预览为空） */
  isUrl: boolean;
}

/**
 * 预览内容 LRU（key = connectionId:path:mtime）：上限 64MB（A 预览）；
 * 缩略图单独实例上限 256 条（B）。超限逐出最久未用项并回收 blob URL；
 * mtime 变化即换键，旧条目等 LRU 自然逐出。
 */
export class LruPreviewCache {
  private map = new Map<string, CacheEntry>();
  private total = 0;
  /** 字节预算（A=64MB）；0 = 不按字节限制 */
  private readonly maxBytes: number;
  /** 条数预算（B=256）；0 = 不按条数限制 */
  private readonly maxEntries: number;

  // 显式赋值而非构造器参数属性（node strip-types 不支持 parameter properties）
  constructor(maxBytes: number, maxEntries: number) {
    this.maxBytes = maxBytes;
    this.maxEntries = maxEntries;
  }


  get(key: string): string | null {
    const entry = this.map.get(key);
    if (!entry) return null;
    // touch（LRU：删后重插移到末尾）
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  put(key: string, value: string, bytes: number, isUrl: boolean): void {
    this.drop(key);
    this.map.set(key, { value, bytes, isUrl });
    this.total += bytes;
    this.evict();
  }

  /** 单条超预算的内容不缓存（避免逐出全部热数据）；预算 0 = 不按字节限制 */
  fits(bytes: number): boolean {
    return this.maxBytes <= 0 || bytes <= this.maxBytes;
  }

  private drop(key: string): void {
    const entry = this.map.get(key);
    if (!entry) return;
    this.map.delete(key);
    this.total -= entry.bytes;
    if (entry.isUrl) URL.revokeObjectURL(entry.value);
  }

  private evict(): void {
    while (this.map.size > 0) {
      const overBytes = this.maxBytes > 0 && this.total > this.maxBytes;
      const overCount = this.maxEntries > 0 && this.map.size > this.maxEntries;
      if (!overBytes && !overCount) break;
      // Map 迭代序 = 插入序，首项即最久未用
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.drop(oldest);
    }
  }
}

/** A 块：预览窗格内容缓存（64MB） */
export const previewCache = new LruPreviewCache(64 * 1024 * 1024, 0);
/** B 块：缩略图缓存（256 条） */
export const thumbnailCache = new LruPreviewCache(0, 256);
