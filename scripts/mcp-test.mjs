/**
 * MCP 端到端自测（开发用）：验证 hub 的 HTTP 直连与 stdio shim 两条通道。
 *
 * 前置：VisualSSH GUI 已运行（或传 --spawn 让脚本拉起 debug exe）。
 * 流程：
 *   1. 读 %APPDATA%/visualssh/mcp.json（token/port；approved=false 时自动置 true
 *      并打警告——首次接入批准门留给人工验证）。
 *   2. HTTP：initialize → tools/list（应含 19 个工具）→ tools/call list_connections。
 *   3. stdio：spawn <exe> mcp → initialize → tools/list → tools/call list_connections。
 *
 * 用法：node scripts/mcp-test.mjs [--exe path\to\visualssh.exe] [--spawn] [--http-only] [--stdio-only]
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const optValue = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const CONFIG_PATH = join(homedir(), "AppData", "Roaming", "visualssh", "mcp.json");

function loadConfig() {
  return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
}

/** --spawn 场景：等 GUI 首次启动写出 mcp.json */
async function waitConfig(timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (existsSync(CONFIG_PATH)) {
      try {
        return loadConfig();
      } catch {
        // 写入中途：继续等
      }
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  console.error(`× ${timeoutMs}ms 内未生成 ${CONFIG_PATH}`);
  process.exit(1);
}

function ensureApproved(cfg) {
  if (cfg.approved) return;
  cfg.approved = true;
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  console.log("! 首次接入未批准：脚本已代批（mcp.json approved=true），人工场景请在 GUI 弹窗批准");
}

const EXPECTED_TOOLS = [
  "list_connections", "connect", "list_dir", "stat", "read_file", "write_file",
  "mkdir", "touch", "rename", "delete", "chmod", "read_link", "search_files",
  "tree", "disk_usage", "exec", "download", "upload", "transfers",
];

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) {
    console.log(`  ok ${name}`);
  } else {
    failures++;
    console.error(`  FAIL ${name} ${detail}`);
  }
}

/** 从 SSE 流式读取中取第一条带 id 的 JSON-RPC 消息（不等待流关闭） */
async function readSseMessage(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    for (const line of buf.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const text = line.slice(5).trim();
      if (!text) continue;
      try {
        const msg = JSON.parse(text);
        if (msg.id != null) {
          await reader.cancel().catch(() => {});
          return msg;
        }
      } catch {
        // 半行/心跳：继续
      }
    }
  }
  throw new Error("SSE 流结束但未收到响应");
}

async function waitHub(port, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      await fetch(`http://127.0.0.1:${port}/rpc/tools`, { method: "GET" });
      return true; // 401 也说明端口在服务
    } catch {
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  return false;
}

async function testHttp(cfg) {
  console.log("\n== HTTP 直连（streamable HTTP /mcp） ==");
  const base = `http://127.0.0.1:${cfg.port}/mcp`;
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${cfg.token}`,
  };
  let sessionId = null;

  async function rpc(method, params) {
    const h = { ...headers };
    if (sessionId) h["mcp-session-id"] = sessionId;
    const res = await fetch(base, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ jsonrpc: "2.0", id: Date.now() % 1e6, method, params }),
    });
    const sid = res.headers.get("mcp-session-id");
    if (sid) sessionId = sid;
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("text/event-stream")) {
      return await readSseMessage(res);
    }
    return JSON.parse(await res.text());
  }

  // ① token 错误 → 401
  const badRes = await fetch(base, {
    method: "POST",
    headers: { ...headers, authorization: "Bearer wrong-token" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
  });
  check("错误 token 被拒（401）", badRes.status === 401, `got ${badRes.status}`);

  // ② initialize
  const init = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "0.0.1" },
  });
  check(
    "initialize 返回 serverInfo=visualssh",
    init?.result?.serverInfo?.name === "visualssh",
    JSON.stringify(init).slice(0, 120),
  );
  await fetch(base, {
    method: "POST",
    headers: { ...headers, ...(sessionId ? { "mcp-session-id": sessionId } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  }).then((r) => r.arrayBuffer()); // drain 202

  // ③ tools/list
  const tools = await rpc("tools/list", {});
  const names = (tools?.result?.tools ?? []).map((t) => t.name);
  check(
    `tools/list 含全部 ${EXPECTED_TOOLS.length} 个工具`,
    EXPECTED_TOOLS.every((n) => names.includes(n)) && names.length === EXPECTED_TOOLS.length,
    `got ${names.length}: ${names.join(",")}`,
  );
  const schemaOk = (tools?.result?.tools ?? []).every((t) => t.inputSchema?.type === "object");
  check("每个工具带 object 类型 JSON Schema", schemaOk);

  // ④ tools/call list_connections（无连接场景也应成功返回结构）
  const call = await rpc("tools/call", {
    name: "list_connections",
    arguments: {},
  });
  const payload = call?.result?.structuredContent ?? {};
  check(
    "list_connections 返回 connections/profiles 结构",
    Array.isArray(payload.connections) && Array.isArray(payload.profiles),
    JSON.stringify(call).slice(0, 160),
  );

  // ⑤ 未知工具 → 工具级错误（isError）
  const bad = await rpc("tools/call", { name: "no_such_tool", arguments: {} });
  check("未知工具返回错误文本", bad?.result?.isError === true || bad?.error != null);
}

function testStdio(exePath, cfg) {
  return new Promise((resolve, reject) => {
    console.log("\n== stdio shim（<exe> mcp） ==");
    const child = spawn(exePath, ["mcp"], { stdio: ["pipe", "pipe", "pipe"] });
    let buf = "";
    const pending = new Map();
    let nextId = 1;

    const timer = setTimeout(() => {
      reject(new Error("stdio 测试超时（30s）"));
      child.kill();
    }, 30000);

    child.stdout.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id != null && pending.has(msg.id)) {
            pending.get(msg.id)(msg);
            pending.delete(msg.id);
          }
        } catch {
          // 忽略非 JSON 行（不应出现）
        }
      }
    });
    child.stderr.on("data", (c) => process.stderr.write(`  [shim] ${c}`));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });

    function request(method, params) {
      const id = nextId++;
      return new Promise((res) => {
        pending.set(id, res);
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
        );
      });
    }

    (async () => {
      const init = await request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "mcp-test", version: "0.0.1" },
      });
      check(
        "stdio initialize 返回 serverInfo=visualssh",
        init?.result?.serverInfo?.name === "visualssh",
        JSON.stringify(init).slice(0, 120),
      );
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
      );

      const tools = await request("tools/list", {});
      const names = (tools?.result?.tools ?? []).map((t) => t.name);
      check(
        `stdio tools/list 含全部 ${EXPECTED_TOOLS.length} 个工具`,
        EXPECTED_TOOLS.every((n) => names.includes(n)),
        `got ${names.length}`,
      );

      const call = await request("tools/call", {
        name: "list_connections",
        arguments: {},
      });
      const payload = call?.result?.structuredContent ?? {};
      check(
        "stdio list_connections 返回结构",
        Array.isArray(payload.connections),
        JSON.stringify(call).slice(0, 160),
      );

      child.stdin.end();
      clearTimeout(timer);
      resolve();
    })().catch((e) => {
      clearTimeout(timer);
      child.kill();
      reject(e);
    });
  });
}

const debugExe = optValue("--exe") ?? join(process.cwd(), "src-tauri", "target", "debug", "visualssh.exe");
if (flag("--spawn")) {
  if (!existsSync(debugExe)) {
    console.error(`× 找不到 ${debugExe}，先 cargo build`);
    process.exit(1);
  }
  console.log(`· 拉起 GUI：${debugExe}`);
  spawn(debugExe, [], { detached: true, stdio: "ignore" }).unref();
}

const cfg = existsSync(CONFIG_PATH) ? loadConfig() : flag("--spawn") ? await waitConfig() : null;
if (!cfg) {
  console.error(`× 未找到 ${CONFIG_PATH} —— 先启动一次 VisualSSH 生成配置，或加 --spawn`);
  process.exit(1);
}
ensureApproved(cfg);

if (!(await waitHub(cfg.port, flag("--spawn") ? 30000 : 3000))) {
  console.error(
    flag("--spawn")
      ? `× hub 端口 ${cfg.port} 30s 未就绪`
      : `× GUI 未运行（端口 ${cfg.port} 无人监听）。启动 VisualSSH 后重试，或加 --spawn`,
  );
  process.exit(1);
}

if (!flag("--stdio-only")) await testHttp(cfg);
if (!flag("--http-only")) {
  const exe = debugExe;
  if (!existsSync(exe)) {
    console.error(`× stdio 测试跳过：找不到 ${exe}（cargo build 后重试或用 --exe 指定）`);
  } else {
    await testStdio(exe, cfg);
  }
}

console.log(
  failures === 0
    ? `\nMCP 自测全部通过（${EXPECTED_TOOLS.length} 工具 × 双通道）`
    : `\n${failures} 项失败`,
);
process.exit(failures === 0 ? 0 : 1);
