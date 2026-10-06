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
