/**
 * 一键打包单文件 exe：
 *   1. 调用 tauri build（前端构建 + Rust release 编译）
 *   2. 把 src-tauri/target/release/VisualSSH.exe 复制到项目根目录
 *
 * 用法：npm run exe
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";

console.log("▶ npm run tauri build（首次编译 Rust 依赖需数分钟）…");
const build = spawnSync(npmCmd, ["run", "tauri", "build"], {
  cwd: root,
  stdio: "inherit",
  shell: true,
});
if (build.status !== 0) {
  console.error("✗ 构建失败");
  process.exit(build.status ?? 1);
}

const source = join(root, "src-tauri", "target", "release", "VisualSSH.exe");
const target = join(root, "VisualSSH.exe");
copyFileSync(source, target);

const mb = statSync(target).size / 1024 / 1024;
console.log(`\n✓ 单文件已就绪：${target}（${mb.toFixed(1)} MB）`);
