/**
 * 第五阶段纯函数单测（node --experimental-strip-types 直跑，带 .ts 扩展名 import）：
 * 覆盖 —— A 判别链映射表 / 权限八进制 / 预览 LRU；B 缩略图候选；
 * C 档案判型与命令拼装 / 条目解析 / ZipSlip 校验 / smart 判定 / 探测解析；
 * D scp 命令拼装。
 * 运行：npm run test:phase5
 */
import assert from "node:assert/strict";

import {
  archiveBaseName,
  archiveFamilyOf,
  createCommand,
  defaultArchiveName,
  extractCommand,
  familyLabel,
  gunzipCommand,
  listCommand,
  parseEntries,
  parseProbe,
  planExtraction,
  requiredToolFor,
  shQuote,
  swapArchiveExt,
  uniqueName,
  unsafeEntries,
} from "../src/utils/archive.ts";
import { buildScpCommand } from "../src/utils/scp.ts";
import {
  isThumbnailCandidate,
  LruPreviewCache,
  permissionsOctal,
  previewKindOf,
  type FileEntry,
} from "../src/utils/preview.ts";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(label: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${label}`);
  } catch (e) {
    failed++;
    const msg = e instanceof Error ? e.message : String(e);
    failures.push(`${label} — ${msg.split("\n")[0]}`);
    console.error(`  FAIL ${label} — ${msg.split("\n")[0]}`);
  }
}

function entryOf(patch: Partial<FileEntry>): FileEntry {
  return {
    name: "a.txt",
    kind: "file",
    size: 10,
    permissions: "-rw-r--r--",
    mtime: 100,
    ...patch,
  };
}

// —— A：预览判别链映射表 ——
check("判别链: 文件夹 → folder", () => {
  assert.equal(previewKindOf(entryOf({ kind: "dir", name: "d" })), "folder");
  assert.equal(previewKindOf(entryOf({ kind: "other", name: "x" })), "folder");
});

check("判别链: 图片各扩展名 ≤10MB → image，超限 → basic", () => {
  for (const ext of ["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif"]) {
    assert.equal(previewKindOf(entryOf({ name: `a.${ext}` })), "image", ext);
    assert.equal(previewKindOf(entryOf({ name: `a.${ext.toUpperCase()}` })), "image", ext);
  }
  assert.equal(
    previewKindOf(entryOf({ name: "a.png", size: 10 * 1024 * 1024 })),
    "image",
  );
  assert.equal(
    previewKindOf(entryOf({ name: "a.png", size: 10 * 1024 * 1024 + 1 })),
    "basic",
  );
});

check("判别链: md ≤2MB → markdown，超限 → basic", () => {
  assert.equal(previewKindOf(entryOf({ name: "r.md" })), "markdown");
  assert.equal(
    previewKindOf(entryOf({ name: "r.md", size: 2 * 1024 * 1024 })),
    "markdown",
  );
  assert.equal(
    previewKindOf(entryOf({ name: "r.md", size: 2 * 1024 * 1024 + 1 })),
    "basic",
  );
});

check("判别链: 文本白名单 → text，白名单外 → basic", () => {
  for (const ext of ["txt", "json", "yaml", "yml", "log", "conf", "ini", "toml", "env", "sh", "py"]) {
    assert.equal(previewKindOf(entryOf({ name: `f.${ext}` })), "text", ext);
  }
  assert.equal(previewKindOf(entryOf({ name: "f.exe" })), "basic");
  assert.equal(previewKindOf(entryOf({ name: "noext" })), "basic");
  assert.equal(
    previewKindOf(entryOf({ name: "f.txt", size: 2 * 1024 * 1024 + 1 })),
    "basic",
  );
});

check("判别链: 大小写不敏感（A.PNG → image / R.MD → markdown）", () => {
  assert.equal(previewKindOf(entryOf({ name: "A.PNG" })), "image");
  assert.equal(previewKindOf(entryOf({ name: "R.MD" })), "markdown");
});

check("权限八进制: rwxr-xr-x→755 / rw-r--r--→644 / 全开→777 / 短串→—", () => {
  assert.equal(permissionsOctal("drwxr-xr-x"), "755");
  assert.equal(permissionsOctal("-rw-r--r--"), "644");
  assert.equal(permissionsOctal("lrwxrwxrwx"), "777");
  assert.equal(permissionsOctal("-rwx------"), "700");
  assert.equal(permissionsOctal("d---------"), "000");
  assert.equal(permissionsOctal("x"), "—");
});

check("预览 LRU: touch 逐出最久未用 / 上限逐出 / URL 回收", () => {
  const cache = new LruPreviewCache(100, 0);
  cache.put("a", "url-a", 40, true);
  cache.put("b", "url-b", 40, true);
  cache.get("a"); // touch a → b 变最久未用
  cache.put("c", "url-c", 40, true); // 超 100 → 逐出 b
  assert.ok(cache.has("a"));
  assert.ok(!cache.has("b"));
  assert.ok(cache.has("c"));
});

check("预览 LRU: 条数上限 / 单条超预算不缓存", () => {
  const cache = new LruPreviewCache(0, 2);
  cache.put("a", "1", 1, false);
  cache.put("b", "2", 1, false);
  cache.put("c", "3", 1, false);
  assert.ok(!cache.has("a"));
  assert.equal(cache.get("c"), "3");
  // 仅条数预算（maxBytes=0）不设字节上限；字节预算超限拒绝缓存
  assert.ok(cache.fits(200));
  const byteCache = new LruPreviewCache(100, 0);
  assert.ok(!byteCache.fits(200));
  assert.ok(byteCache.fits(100));
});

// —— B：缩略图候选 ——
check("缩略图候选: 仅 file 且图片扩展名且 ≤2MB", () => {
  assert.ok(isThumbnailCandidate(entryOf({ name: "p.jpg", kind: "file" })));
  assert.ok(!isThumbnailCandidate(entryOf({ name: "p.jpg", kind: "dir" })));
  assert.ok(!isThumbnailCandidate(entryOf({ name: "p.jpg", kind: "symlink" })));
  assert.ok(!isThumbnailCandidate(entryOf({ name: "p.txt" })));
  assert.ok(
    !isThumbnailCandidate(entryOf({ name: "p.jpg", size: 2 * 1024 * 1024 + 1 })),
  );
});

// —— C：档案判型 ——
check("判型: 全扩展名表 / 大小写 / 非档案 → null", () => {
  assert.equal(archiveFamilyOf("a.tar.gz"), "tar-gz");
  assert.equal(archiveFamilyOf("a.tgz"), "tar-gz");
  assert.equal(archiveFamilyOf("a.TAR.BZ2"), "tar-bz2");
  assert.equal(archiveFamilyOf("a.tbz2"), "tar-bz2");
  assert.equal(archiveFamilyOf("a.tar.xz"), "tar-xz");
  assert.equal(archiveFamilyOf("a.txz"), "tar-xz");
  assert.equal(archiveFamilyOf("a.tar"), "tar");
  assert.equal(archiveFamilyOf("a.zip"), "zip");
  assert.equal(archiveFamilyOf("a.gz"), "gz");
  assert.equal(archiveFamilyOf("a.7z"), null);
  assert.equal(archiveFamilyOf("a.rar"), null);
  assert.equal(archiveFamilyOf("file"), null); // 无扩展名
  assert.equal(archiveFamilyOf("atar.gz"), "gz"); // 「atar」+ .gz 是合法单文件 gzip
});

check("判型: .tar.gz 优先于 .gz（不判成单文件 gzip）", () => {
  assert.notEqual(archiveFamilyOf("x.tar.gz"), "gz");
});

check("去扩展名: a.tar.gz→a / proj.zip→proj / data.tgz→data", () => {
  assert.equal(archiveBaseName("a.tar.gz"), "a");
  assert.equal(archiveBaseName("proj.zip"), "proj");
  assert.equal(archiveBaseName("data.tgz"), "data");
  assert.equal(archiveBaseName("backup.TAR.XZ"), "backup");
  assert.equal(archiveBaseName("plain.txt"), "plain.txt");
});

// —— C：命令拼装 ——
check("创建命令: tar.gz = cd+tar czf -- 逐项单引号", () => {
  const cmd = createCommand("tar.gz", "/home/u", "a.tar.gz", ["a.txt", "b dir"]);
  assert.equal(cmd.program, "sh");
  assert.equal(cmd.args.length, 2);
  assert.equal(cmd.args[0], "-c");
  assert.equal(cmd.args[1], "cd '/home/u' && tar czf 'a.tar.gz' -- 'a.txt' 'b dir'");
});

check("创建命令: zip = cd+zip -q -r --", () => {
  const cmd = createCommand("zip", "/home/u", "a.zip", ["x"]);
  assert.equal(cmd.args[1], "cd '/home/u' && zip -q -r 'a.zip' -- 'x'");
});

check("创建命令: 单引号注入转义（a'b → '\\''）", () => {
  const cmd = createCommand("tar.gz", "/d", "o.tgz", ["a'b"]);
  assert.ok(cmd.args[1].includes(`'a'\\''b'`));
});

check("列条目命令: tzf/tjf/tJf/tf/unzip -Z1/gz→null", () => {
  assert.deepEqual(listCommand("tar-gz", "/a.tgz"), {
    program: "tar",
    args: ["tzf", "/a.tgz"],
  });
  assert.deepEqual(listCommand("tar-bz2", "/a"), { program: "tar", args: ["tjf", "/a"] });
  assert.deepEqual(listCommand("tar-xz", "/a"), { program: "tar", args: ["tJf", "/a"] });
  assert.deepEqual(listCommand("tar", "/a"), { program: "tar", args: ["tf", "/a"] });
  assert.deepEqual(listCommand("zip", "/a"), { program: "unzip", args: ["-Z1", "/a"] });
  assert.equal(listCommand("gz", "/a"), null);
});

check("解压命令: xzf/xjf/xJf/xf -C / unzip -o -q -d", () => {
  assert.deepEqual(extractCommand("tar-gz", "/a", "/t"), {
    program: "tar",
    args: ["xzf", "/a", "-C", "/t"],
  });
  assert.deepEqual(extractCommand("tar-xz", "/a", "/t"), {
    program: "tar",
    args: ["xJf", "/a", "-C", "/t"],
  });
  assert.deepEqual(extractCommand("zip", "/a", "/t"), {
    program: "unzip",
    args: ["-o", "-q", "/a", "-d", "/t"],
  });
});

check("gunzip 命令: sh -c 重定向保原名", () => {
  const cmd = gunzipCommand("/a/x.gz", "/a/x");
  assert.equal(cmd.program, "sh");
  assert.equal(cmd.args[1], "gzip -dc '/a/x.gz' > '/a/x'");
});

check("shQuote: 纯文本包裹 / 单引号转义", () => {
  assert.equal(shQuote("abc"), "'abc'");
  assert.equal(shQuote("a'b"), `'a'\\''b'`);
  assert.equal(shQuote(""), "''");
});

// —— C：条目解析与 ZipSlip ——
check("条目解析: 逐行 trimEnd，滤空行，兼容 CRLF", () => {
  assert.deepEqual(parseEntries("a.txt\nb/\r\nc d.txt\n"), ["a.txt", "b/", "c d.txt"]);
  assert.deepEqual(parseEntries(""), []);
});

check("ZipSlip: 绝对路径与 .. 段拒绝，正常混合放行", () => {
  assert.deepEqual(
    unsafeEntries(["normal/a.txt", "/etc/passwd", "sub/../../evil", "deep/dir/file.log", "..", "a/..b/c"]),
    ["/etc/passwd", "sub/../../evil", ".."],
  );
});

check("ZipSlip: .. 中段与首段都命中，..b 不误判", () => {
  assert.deepEqual(unsafeEntries(["a/../b"]), ["a/../b"]);
  assert.deepEqual(unsafeEntries(["../x"]), ["../x"]);
  assert.deepEqual(unsafeEntries(["a/..b/c"]), []);
});

// —— C：smart 判定 ——
check("smart: 单根目录 → here（嵌套也算单根）", () => {
  assert.equal(planExtraction(["proj/a.txt", "proj/sub/b.txt"]), "here");
  assert.equal(planExtraction(["proj/"]), "here");
  assert.equal(planExtraction([]), "here"); // 空档案按 here（解压为空操作）
  assert.equal(planExtraction(["single-file.txt"]), "here"); // 单文件条目
});

check("smart: 多根 → subdir（Files GetFirstMeaningfulSegment 语义）", () => {
  assert.equal(planExtraction(["a.txt", "b.txt"]), "subdir");
  assert.equal(planExtraction(["proj/a.txt", "readme.md"]), "subdir");
  assert.equal(planExtraction(["./a.txt", "b/c.txt"]), "subdir");
});

// —— C：其他 ——
check("uniqueName: 无占用原样 / 占用递增 (2) (3)", () => {
  assert.equal(uniqueName("proj", new Set()), "proj");
  assert.equal(uniqueName("proj", new Set(["proj"])), "proj (2)");
  assert.equal(uniqueName("a.zip", new Set(["a.zip", "a (2).zip"])), "a (3).zip");
});

check("defaultArchiveName: 单选去扩展名 / 多选 archive / 无 tar 用 zip", () => {
  assert.equal(defaultArchiveName("a.txt", "tar.gz"), "a.tar.gz");
  assert.equal(defaultArchiveName("a.txt", "zip"), "a.zip");
  assert.equal(defaultArchiveName("proj", "tar.gz"), "proj.tar.gz");
  assert.equal(defaultArchiveName(null, "tar.gz"), "archive.tar.gz");
});

check("defaultArchiveName: 档案名输入完整剥后缀（a.tar.gz → a.tar.gz 不叠加）", () => {
  assert.equal(defaultArchiveName("a.tar.gz", "tar.gz"), "a.tar.gz");
  assert.equal(defaultArchiveName("a.tar.gz", "zip"), "a.zip");
  assert.equal(defaultArchiveName("b.zip", "tar.gz"), "b.tar.gz");
});

check("swapArchiveExt: 换格式完整剥档案后缀（a.tar.gz → a.zip 不留冗余 .tar）", () => {
  assert.equal(swapArchiveExt("a.tar.gz", "zip"), "a.zip");
  assert.equal(swapArchiveExt("a.zip", "tar.gz"), "a.tar.gz");
  assert.equal(swapArchiveExt("b.tgz", "zip"), "b.zip");
  assert.equal(swapArchiveExt("c.tar.bz2", "zip"), "c.zip");
  assert.equal(swapArchiveExt("a.tar.gz", "tar.gz"), "a.tar.gz");
  // 非档案后缀按最后一个点剥；无点直接拼
  assert.equal(swapArchiveExt("custom.txt", "zip"), "custom.zip");
  assert.equal(swapArchiveExt("noext", "tar.gz"), "noext.tar.gz");
});

check("探测解析: 逐行工具名 / 空输出", () => {
  assert.deepEqual([...parseProbe("/usr/bin/tar\n/usr/bin/unzip\n")], ["tar", "unzip"]);
  assert.equal(parseProbe("").size, 0);
});

check("工具映射: zip→unzip / gz→gzip / tar 家族→tar", () => {
  assert.equal(requiredToolFor("zip"), "unzip");
  assert.equal(requiredToolFor("gz"), "gzip");
  assert.equal(requiredToolFor("tar-gz"), "tar");
  assert.equal(requiredToolFor("tar"), "tar");
  assert.equal(familyLabel("tar-xz"), "tar.xz");
});

// —— D：scp 拼装 ——
check("scp: 端口 22 不带 -P / 非 22 带 -P", () => {
  assert.equal(
    buildScpCommand({ host: "h", port: 22, username: "u" }, ["/a/b.txt"]),
    'scp "u@h:/a/b.txt" .',
  );
  assert.equal(
    buildScpCommand({ host: "h", port: 2222, username: "u" }, ["/a/b.txt"]),
    'scp -P 2222 "u@h:/a/b.txt" .',
  );
});

check("scp: 多选空格连接多路径（路径原样不转义）", () => {
  assert.equal(
    buildScpCommand({ host: "h", port: 22, username: "root" }, ["/a 1.txt", "/b.log"]),
    'scp "root@h:/a 1.txt" "root@h:/b.log" .',
  );
});

// 汇总
console.log(`\n${passed}/${passed + failed} 通过`);
if (failed) {
  console.error(failures.join("\n"));
  process.exit(1);
}
