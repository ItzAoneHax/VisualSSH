/**
 * 压缩/解压纯函数（第五阶段块 C）：格式判型、exec 命令拼装、条目解析、
 * ZipSlip 安全校验、smart 解压判定。执行编排在 utils/archiveOps.ts。
 *
 * 语义对照 files-community/Files：
 * - smart 判定 = BaseDecompressArchiveAction.cs:93-150（条目首个有效路径段
 *   全部相同 → 当前目录；否则建「压缩包名」子文件夹）；
 * - ZipSlip = StorageArchiveService.cs:365-401 防护意图的远端工具侧等价：
 *   条目含绝对路径或 .. 段一律拒绝解压。
 */

export type ArchiveFamily =
  | "tar-gz"
  | "tar-bz2"
  | "tar-xz"
  | "tar"
  | "zip"
  | "gz"
  | null;

/** 支持的档案扩展名（C5 清单；.gz 为单文件 gzip） */
export function archiveFamilyOf(name: string): ArchiveFamily {
  const lower = name.toLowerCase();
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) return "tar-gz";
  if (lower.endsWith(".tar.bz2") || lower.endsWith(".tbz2")) return "tar-bz2";
  if (lower.endsWith(".tar.xz") || lower.endsWith(".txz")) return "tar-xz";
  if (lower.endsWith(".tar")) return "tar";
  if (lower.endsWith(".zip")) return "zip";
  if (lower.endsWith(".gz")) return "gz";
  return null;
}

/** 去掉档案扩展名（保留原名大小写）：a.tar.gz → a；proj.zip → proj */
export function archiveBaseName(name: string): string {
  const lower = name.toLowerCase();
  const suffixes = [
    ".tar.gz", ".tgz", ".tar.bz2", ".tbz2", ".tar.xz", ".txz", ".tar", ".zip", ".gz",
  ];
  for (const suffix of suffixes) {
    if (lower.endsWith(suffix)) return name.slice(0, -suffix.length);
  }
  return name;
}

/** 压缩格式 → 扩展名 */
export type CompressFormat = "tar.gz" | "zip";

/** exec 参数（program + args 由后端逐个 POSIX 单引号包裹执行） */
export interface ExecSpec {
  program: string;
  args: string[];
}

/** 创建档案（C2）：在源目录内执行（cd + 相对条目名），档案内存相对路径——
 *  zip 对绝对路径会剥掉根但保留整条目录链（破坏 smart 判定与解压观感），
 *  tar 用相对名同理；命令行整体走 sh -c，逐段 POSIX 单引号防注入 */
export function createCommand(
  format: CompressFormat,
  cwd: string,
  outName: string,
  items: string[],
): ExecSpec {
  const quotedItems = items.map((item) => shQuote(item)).join(" ");
  const inner =
    format === "zip"
      ? `zip -q -r ${shQuote(outName)} -- ${quotedItems}`
      : `tar czf ${shQuote(outName)} -- ${quotedItems}`;
  return { program: "sh", args: ["-c", `cd ${shQuote(cwd)} && ${inner}`] };
}

/** 列档案条目（C4 安全防线第一步；gz 单文件无条目可列，返回 null 由调用方特判） */
export function listCommand(
  family: Exclude<ArchiveFamily, null>,
  archivePath: string,
): ExecSpec | null {
  switch (family) {
    case "tar-gz":
      return { program: "tar", args: ["tzf", archivePath] };
    case "tar-bz2":
      return { program: "tar", args: ["tjf", archivePath] };
    case "tar-xz":
      return { program: "tar", args: ["tJf", archivePath] };
    case "tar":
      return { program: "tar", args: ["tf", archivePath] };
    case "zip":
      // -Z1 = zipinfo 模式裸名列表（unzip 内建，免依赖独立 zipinfo）
      return { program: "unzip", args: ["-Z1", archivePath] };
    case "gz":
      return null;
  }
}

/** 解压命令（tar 用 -C 限定目标目录；zip -o 静默覆盖，冲突在目录层决策） */
export function extractCommand(
  family: Exclude<ArchiveFamily, null>,
  archivePath: string,
  targetDir: string,
): ExecSpec {
  switch (family) {
    case "tar-gz":
      return { program: "tar", args: ["xzf", archivePath, "-C", targetDir] };
    case "tar-bz2":
      return { program: "tar", args: ["xjf", archivePath, "-C", targetDir] };
    case "tar-xz":
      return { program: "tar", args: ["xJf", archivePath, "-C", targetDir] };
    case "tar":
      return { program: "tar", args: ["xf", archivePath, "-C", targetDir] };
    case "zip":
      return { program: "unzip", args: ["-o", "-q", archivePath, "-d", targetDir] };
    case "gz":
      // 单文件 gunzip 保原名：输出路径由调用方经冲突决策后给出（见 gunzipCommand）
      throw new Error("gz 请使用 gunzipCommand");
  }
}

/** POSIX 单引号包裹（与后端 shell_quote 同规则：内部 ' 转义为 '\''） */
export function shQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/** 单文件 gzip 解压：gzip -dc 读流重定向保原文件（busybox 无 -k 也可用） */
export function gunzipCommand(
  archivePath: string,
  outPath: string,
): ExecSpec {
  return {
    program: "sh",
    args: ["-c", `gzip -dc ${shQuote(archivePath)} > ${shQuote(outPath)}`],
  };
}

/** 解析列条目输出：tar tf / unzip -Z1 每行一条 */
export function parseEntries(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

/** ZipSlip 校验：返回不安全条目（绝对路径或含 .. 段）；空数组 = 安全 */
export function unsafeEntries(entries: string[]): string[] {
  return entries.filter((entry) => {
    if (entry.startsWith("/")) return true;
    return entry.split("/").some((segment) => segment === "..");
  });
}

/** 条目首个有效路径段（Files GetFirstMeaningfulSegment：跳过空段/./..） */
function firstMeaningfulSegment(entry: string): string | null {
  for (const segment of entry.split("/")) {
    if (segment === "" || segment === "." || segment === "..") continue;
    return segment;
  }
  return null;
}

/** smart 判定（Files BaseDecompressArchiveAction:93-150）：
 *  条目根段全部相同（≤1 个不同根）→ here；多根 → subdir */
export function planExtraction(entries: string[]): "here" | "subdir" {
  const roots = new Set<string>();
  for (const entry of entries) {
    const segment = firstMeaningfulSegment(entry);
    if (segment) roots.add(segment);
  }
  return roots.size <= 1 ? "here" : "subdir";
}

/** 目标名占用时递增后缀：a → a (2)（同 conflicts suggestName 规则） */
export function uniqueName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  for (let n = 2; ; n++) {
    const candidate = `${stem} (${n})${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** 压缩输出默认名：单选取首项去扩展名（a.txt → a；本身就是档案后缀的完整剥，
 *  避免 a.tar.gz → a.tar.tar.gz），多选 archive */
export function defaultArchiveName(firstItemName: string | null, format: CompressFormat): string {
  let base = "archive";
  if (firstItemName) {
    const stripped = archiveBaseName(firstItemName);
    if (stripped !== firstItemName) {
      base = stripped;
    } else {
      const dot = firstItemName.lastIndexOf(".");
      base = dot > 0 ? firstItemName.slice(0, dot) : firstItemName;
    }
  }
  return `${base}.${format}`;
}

/** 换压缩格式时同步输出名扩展名：完整剥档案后缀（a.tar.gz → a.zip 而非 a.tar.zip）；
 *  无档案后缀的名按最后一个点剥（custom.txt → custom.zip），无点直接拼 */
export function swapArchiveExt(name: string, format: CompressFormat): string {
  const base = archiveBaseName(name);
  if (base !== name) return `${base}.${format}`;
  const dot = name.lastIndexOf(".");
  return `${dot > 0 ? name.slice(0, dot) : name}.${format}`;
}

/** 能力探测（C1）：单条 sh 循环逐个 command -v，输出可用工具名（每行一个） */
export const PROBE_SCRIPT =
  'for t in tar zip unzip gzip xz bzip2; do command -v "$t" >/dev/null 2>&1 && echo "$t"; done';

/** 解析探测输出：取每行末段（脚本回显工具名，对回显全路径也稳） */
export function parseProbe(stdout: string): Set<string> {
  return new Set(
    stdout
      .split(/\r?\n/)
      .map((line) => {
        const trimmed = line.trim();
        const idx = trimmed.lastIndexOf("/");
        return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
      })
      .filter(Boolean),
  );
}

/** 档案家族 → 解压所需工具（tar 自带 -z/-j/-J，无需独立 gzip/xz/bzip2） */
export function requiredToolFor(family: Exclude<ArchiveFamily, null>): string {
  switch (family) {
    case "zip":
      return "unzip";
    case "gz":
      return "gzip";
    default:
      return "tar";
  }
}

/** 档案家族展示名（菜单/错误提示用） */
export function familyLabel(family: Exclude<ArchiveFamily, null>): string {
  switch (family) {
    case "tar-gz":
      return "tar.gz";
    case "tar-bz2":
      return "tar.bz2";
    case "tar-xz":
      return "tar.xz";
    case "tar":
      return "tar";
    case "zip":
      return "zip";
    case "gz":
      return "gzip";
  }
}
