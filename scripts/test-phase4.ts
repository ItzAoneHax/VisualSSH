/**
 * 第四阶段纯函数单测（node --experimental-strip-types 直跑 TS）：
 * 目录缓存 LRU（块 E）、重连退避序列（块 D）、清单编排（块 A：冲突改名映射 /
 * 文件批过滤 / 跳过链接计数 / 冲突收集键）。
 * 运行：node --experimental-strip-types scripts/test-phase4.ts
 */
import assert from "node:assert/strict";

import { DirCache } from "../src/utils/dirCache.ts";
import {
  BACKOFF_SEQUENCE,
  backoffDelaySec,
  MAX_RECONNECT_ATTEMPTS,
} from "../src/utils/reconnectBackoff.ts";
import {
  collectConflictKeys,
  jobsFromOutput,
  renamesFromDecisions,
  skippedLinkCount,
} from "../src/utils/batchPlan.ts";
import type { FileEntry } from "../src/types/index.ts";

let passed = 0;
function check(label: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ok  ${label}`);
}

function entry(name: string, kind: FileEntry["kind"] = "file", size = 1): FileEntry {
  return { name, kind, size, permissions: "", mtime: null, owner: null, group: null, atime: null };
}

// —— 块 E：目录缓存 LRU ——

check("get 命中 touch 后不被逐出（LRU 顺序生效）", () => {
  const c = new DirCache();
  for (let i = 0; i < 99; i++) c.put(`/filler${i}`, [entry("f")]);
  c.put("/oldest-candidate", [entry("x")]); // 此时 100 条满，此条最旧
  // 访问它一次 → 移到最新
  assert.ok(c.get("/oldest-candidate"));
  // 塞入新条目触发逐出：被逐出的是未访问过的最早条目 filler0
  c.put("/fresh", [entry("y")]);
  assert.equal(c.size, 100);
  assert.equal(c.get("/filler0"), null);
  assert.ok(c.get("/oldest-candidate")); // 被 touch 过，仍在
  assert.ok(c.get("/fresh"));
});

check("超出上限逐出最旧", () => {
  const c = new DirCache();
  for (let i = 0; i < 100; i++) c.put(`/p${i}`, [entry("f")]);
  assert.equal(c.size, 100);
  c.put("/new", []); // 逐出 /p0
  assert.equal(c.size, 100);
  assert.equal(c.get("/p0"), null);
  assert.ok(c.get("/new"));
});

check("invalidate 删除自身与前缀子目录", () => {
  const c = new DirCache();
  c.put("/a", []);
  c.put("/a/sub", []);
  c.put("/a/sub/deep", []);
  c.put("/ab", []); // 前缀字符串相同但路径不同，不得误删
  c.put("/b", []);
  c.invalidate("/a");
  assert.equal(c.get("/a"), null);
  assert.equal(c.get("/a/sub"), null);
  assert.equal(c.get("/a/sub/deep"), null);
  assert.ok(c.get("/ab"));
  assert.ok(c.get("/b"));
});

check("isStale：30s 内新鲜，超过过期", () => {
  const now = Date.now();
  const fresh = { entries: [], fetchedAt: now - 29_999 };
  const stale = { entries: [], fetchedAt: now - 30_001 };
  assert.equal(DirCache.isStale(fresh, now), false);
  assert.equal(DirCache.isStale(stale, now), true);
});

// —— 块 D：重连退避序列 ——

check("退避序列为 1/2/4/8/16 秒，最多 5 次", () => {
  assert.deepEqual(BACKOFF_SEQUENCE, [1, 2, 4, 8, 16]);
  assert.equal(MAX_RECONNECT_ATTEMPTS, 5);
  assert.equal(backoffDelaySec(0), 1); // 越界收敛到边界
  assert.equal(backoffDelaySec(99), 16);
});

// —— 块 A：清单编排 ——

check("冲突收集键：按目录快照精确名比对", () => {
  const keys = collectConflictKeys([
    {
      targetDir: "/tgt",
      incoming: [
        { name: "a.txt", size: 1, mtime: null },
        { name: "b.txt", size: 2, mtime: null },
      ],
      existing: new Map([["a.txt", entry("a.txt")]]),
    },
    {
      targetDir: "/tgt/sub",
      incoming: [{ name: "a.txt", size: 3, mtime: null }],
      existing: new Map([["a.txt", entry("a.txt")]]),
    },
  ]);
  assert.deepEqual(keys, [
    { targetDir: "/tgt", name: "a.txt" },
    { targetDir: "/tgt/sub", name: "a.txt" },
  ]);
});

check("改名映射：多目录决策还原为批次相对路径", () => {
  const decisions = new Map([
    [
      "/tgt",
      [
        { name: "a.txt", finalName: "a.txt", action: "proceed" as const },
        { name: "b.txt", finalName: "b (2).txt", action: "proceed" as const },
      ],
    ],
    [
      "/tgt/sub",
      [{ name: "a.txt", finalName: "a.txt", action: "proceed" as const }],
    ],
  ]);
  const renames = renamesFromDecisions(decisions, (dir) =>
    dir === "/tgt" ? "" : dir.slice("/tgt/".length),
  );
  assert.deepEqual([...renames.entries()], [["b.txt", "b (2).txt"]]);
});

check("文件批过滤：符号链接跳过并计数，other 不入批", () => {
  const output = {
    dirs: ["sub"],
    files: [
      { path: "keep.txt", size: 10, kind: "file" as const },
      { path: "link", size: 4, kind: "symlink" as const },
      { path: "sub/sock", size: 0, kind: "other" as const },
      { path: "sub/inner.txt", size: 20, kind: "file" as const },
    ],
    skippedLinks: 1,
    failedDirs: 0,
  };
  assert.equal(skippedLinkCount(output), 1);
  const jobs = jobsFromOutput(
    output,
    (rel, finalRel) => ({
      src: `/remote/${rel}`, // 源端保持原始名
      dst: `C:\\dst\\${finalRel.replace(/\//g, "\\")}`, // 目标端用改名后的最终名
    }),
    new Map([["keep.txt", "keep (2).txt"]]),
  );
  assert.deepEqual(
    jobs.map((j) => j.rel),
    ["keep (2).txt", "sub/inner.txt"],
  );
  // 冲突改名只影响目标端：远端源仍是 keep.txt
  assert.equal(jobs[0].src, "/remote/keep.txt");
  assert.equal(jobs[0].dst, "C:\\dst\\keep (2).txt");
});

console.log(`\n${passed} 断言全部通过`);
