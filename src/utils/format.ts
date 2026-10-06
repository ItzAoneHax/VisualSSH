import type { FileEntry } from "@/types";

const SIZE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;

export function formatSize(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const i = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    SIZE_UNITS.length - 1,
  );
  const value = bytes / 1024 ** i;
  // 目录与空文件会走到这里，保持紧凑
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${SIZE_UNITS[i]}`;
}

const dateTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export function formatMtime(mtime: number | null): string {
  if (mtime == null || mtime <= 0) return "—";
  return dateTimeFormatter.format(new Date(mtime * 1000));
}

export function joinPath(dir: string, name: string): string {
  if (dir === "/") return `/${name}`;
  return `${dir}/${name}`;
}

export function parentPath(path: string): string {
  if (path === "/") return "/";
  const idx = path.lastIndexOf("/");
  return idx <= 0 ? "/" : path.slice(0, idx);
}

/** 详情视图「类型」列文案 */
export function kindLabel(kind: FileEntry["kind"]): string {
  switch (kind) {
    case "dir":
      return "文件夹";
    case "symlink":
      return "链接";
    case "file":
      return "文件";
    default:
      return "其他";
  }
}

/** 传输速度：复用 formatSize */
export function formatSpeed(bps: number): string {
  return `${formatSize(bps)}/s`;
}

/** 剩余时间 mm:ss / h:mm:ss；速度未知返回 — */
export function formatEta(remainingBytes: number, speedBps: number): string {
  if (speedBps <= 0 || remainingBytes <= 0) return "—";
  const secs = Math.ceil(remainingBytes / speedBps);
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

/** 复制到剪贴板：clipboard API 失败时回退 execCommand（WebView2 兼容） */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}
