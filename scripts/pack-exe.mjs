/**
 * 一键打包单文件 exe：
 *   1. 调用 tauri build（前端构建 + Rust release 编译）
 *   2. 把 src-tauri/target/release/VisualSSH.exe 复制到项目根目录
 *
 * 默认 --no-bundle（跳过 MSI/NSIS 安装包——单文件 exe 用不到，省二三十秒）；
 * 需要安装包时传 --bundle：npm run exe:bundle（或 node scripts/pack-exe.mjs --bundle）
 *
 * 用法：npm run exe
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npxCmd = process.platform === "win32" ? "npx.cmd" : "npx";
const wantBundle = process.argv.includes("--bundle");

const args = ["tauri", "build"];
if (!wantBundle) args.push("--no-bundle");
console.log(`▶ npx ${args.join(" ")}${wantBundle ? "" : "（跳过安装包打包）"}…`);
const build = spawnSync(npxCmd, args, {
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
try {
  copyFileSync(source, target);
} catch {
  console.error("✗ 无法写入根目录 VisualSSH.exe — 请先关闭正在运行的 VisualSSH 再执行 npm run exe");
  process.exit(1);
}

const mb = statSync(target).size / 1024 / 1024;
console.log(`\n✓ 单文件已就绪：${target}（${mb.toFixed(1)} MB）`);
