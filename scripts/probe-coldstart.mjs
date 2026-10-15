/**
 * 模拟 ZCode 冷启动行为：GUI 未运行时 spawn `<exe> mcp`，立即发 initialize，
 * 计时响应到达——复现"MCP 进程启动失败"。
 */
import { spawn } from "node:child_process";
import process from "node:process";

const exe = process.argv[2] ?? "C:\\Users\\limin\\IdeaProjects\\VisualSSH\\VisualSSH.exe";
const t0 = Date.now();
const child = spawn(exe, ["mcp"], { stdio: ["pipe", "pipe", "pipe"] });
let buf = "";

const timer = setTimeout(() => {
  console.log(`TIMEOUT: 35s 内未收到 initialize 响应（ZCode 会判“进程启动失败”）`);
  child.kill();
  process.exit(1);
}, 35000);

child.on("error", (e) => {
  console.log("spawn 失败:", e.path);
  process.exit(1);
});
child.stderr.on("data", (c) => process.stderr.write("[shim] " + c));
child.stdout.on("data", (c) => {
  buf += c.toString("utf8");
  for (const line of buf.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const m = JSON.parse(t);
      if (m.id === 1) {
        console.log(`initialize 响应到达: ${Date.now() - t0}ms（${m.result?.serverInfo?.name ?? "?"}）`);
        clearTimeout(timer);
        child.stdin.end();
        child.kill();
        process.exit(0);
      }
    } catch {
      // 半行
    }
  }
});

child.stdin.write(
  JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "zcode-sim", version: "0" },
    },
  }) + "\n",
);
