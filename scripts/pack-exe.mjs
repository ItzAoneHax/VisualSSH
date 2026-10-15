/**
 * 一键打包单文件 exe：
 *   1. 调用 tauri build（前端构建 + Rust release 编译）
 *   2. 把 src-tauri/target/release/VisualSSH.exe 复制到项目根目录
 *
 * 默认 --no-bundle（跳过 MSI/NSIS 安装包——单文件 exe 用不到，省二三十秒）；
 * 需要安装包时传 --bundle：npm run exe:bundle（或 node scripts/pack-exe.mjs --bundle）
 *
 * 根目录 exe 正在运行（日常使用 / MCP stdio shim）时复制会撞文件锁：
 * Windows 不允许覆盖/删除运行中的 exe，但允许改名——自动把旧版改名为
 * VisualSSH.exe.old[N] 腾位，运行中的进程（含 MCP 会话）不受影响，
 * 下次启动/spawn 即新版；残留由本脚本与 GUI 启动时接力清理。
 *
 * 用法：npm run exe
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, join, resolve, dirname } from "node:path";
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

// 换版残留接力清理：上一轮改名的旧 exe，此刻已无进程占用的直接删掉
// （仍被旧 GUI/shim 占用的删除会失败，静默留给下一轮或 GUI 启动时清）
for (const name of readdirSync(root)) {
  if (name.startsWith("VisualSSH.exe.old")) {
    try {
      rmSync(join(root, name));
      console.log(`✓ 清理换版残留 ${name}`);
    } catch {
      // 仍被运行中的旧进程占用
    }
  }
}

try {
  copyFileSync(source, target);
} catch (first) {
  // 目标被运行中的进程锁定：改名腾位后重试（运行中的进程不受影响）
  let stale = `${target}.old`;
  while (existsSync(stale)) stale = `${target}.old${Date.now()}`;
  try {
    renameSync(target, stale);
    copyFileSync(source, target);
    console.log(
      `⚠ VisualSSH.exe 正在运行 — 旧版已改名 ${basename(stale)} 腾位，新版已就位；` +
        "运行中的 GUI 将在任务清空且用户闲置 5 分钟后自动升级并恢复原页面（MCP 会话不受影响），也可手动重启立即生效",
    );
  } catch {
    console.error(
      `✗ 无法写入根目录 VisualSSH.exe（${first.code ?? first.message}），改名换版也失败 — 请检查文件占用后重试`,
    );
    process.exit(1);
  }
}

const mb = statSync(target).size / 1024 / 1024;
console.log(`\n✓ 单文件已就绪：${target}（${mb.toFixed(1)} MB）`);
