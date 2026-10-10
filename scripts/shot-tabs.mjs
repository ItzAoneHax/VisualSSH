/**
 * 标签条几何截图（vite dev 4274 + Edge headless CDP，deviceScaleFactor=3）：
 * 驱动真实 workspace store 开 3 个标签，分别激活首标签/中间标签截取标签条区域。
 * 运行：node scripts/shot-tabs.mjs   输出：%TEMP%\vssh-tabs-first.png / -mid.png
 */
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const VITE_PORT = 4274;
const CDP_PORT = 9334;
const APP_URL = `http://127.0.0.1:${VITE_PORT}/`;
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const OUT = process.env.TEMP;

async function waitHttp(url, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {}
    await sleep(300);
  }
  throw new Error(`等待 ${url} 超时`);
}

// 最小 Tauri mock：未识别命令一律返回 null，连接/列目录给出空结果即可渲染标签条
const MOCK = String.raw`
  window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 16);
  const handlers = new Map();
  let seq = 1;
  function emit(event, payload) {
    for (const hid of handlers.get(event) ?? []) {
      const cb = window["_" + hid];
      if (cb) cb({ event, id: seq++, payload });
    }
  }
  async function invoke(cmd, args = {}) {
    switch (cmd) {
      case "plugin:event|listen": {
        if (!handlers.has(args.event)) handlers.set(args.event, new Set());
        handlers.get(args.event).add(args.handler);
        return args.handler;
      }
      case "plugin:event|unlisten": return null;
      case "ssh_connect": return { connectionId: "cid-1", rootPath: "/root", latencyMs: 3 };
      case "ssh_list_dir": return [];
      case "credential_get": return "mock-secret";
      case "ssh_transfer_list": return [];
      default: return null;
    }
  }
  window.__TAURI_INTERNALS__ = {
    invoke,
    transformCallback: (cb) => { const id = seq++; window["_" + id] = cb; return id; },
    metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
    plugins: {},
  };
  window.__mockEmit = emit;
`;

async function evalJs(cdp, expr) {
  const res = await cdp.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (res.exceptionDetails) {
    throw new Error(res.exceptionDetails.exception?.description ?? "evaluate failed");
  }
  return res.result?.value;
}

async function main() {
  const vite = spawn("npx", ["vite", "--port", `${VITE_PORT}`, "--strictPort"], { shell: true, stdio: "ignore" });
  const edge = spawn(
    EDGE,
    [
      "--headless=new",
      "--no-first-run",
      "--disable-gpu",
      "--window-size=1440,900",
      `--user-data-dir=${OUT}\\vssh-shot-profile`,
      `--remote-debugging-port=${CDP_PORT}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  try {
    await waitHttp(APP_URL);
    await waitHttp(`http://127.0.0.1:${CDP_PORT}/json/version`);
    const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    const page = targets.find((t) => t.type === "page");
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve);
      ws.addEventListener("error", reject);
    });
    let id = 0;
    const pending = new Map();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      }
    });
    const send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const i = ++id;
        pending.set(i, { resolve, reject });
        ws.send(JSON.stringify({ id: i, method, params }));
      });
    const cdp = { send };

    await send("Page.enable");
    await send("Runtime.enable");
    await send("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 900,
      deviceScaleFactor: 3,
      mobile: false,
    });
    await send("Page.addScriptToEvaluateOnNewDocument", { source: MOCK });
    // 收集页面错误，便于判断应用是否真的挂载
    const pageErrors = [];
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.method === "Runtime.exceptionThrown") {
        pageErrors.push(msg.params?.exceptionDetails?.exception?.description ?? "?");
      }
    });
    await send("Runtime.enable");

    await send("Page.navigate", { url: APP_URL });
    await sleep(3000);

    const diag = await evalJs(cdp, `
      (() => ({
        mockReady: !!window.__TAURI_INTERNALS__,
        hasApp: !!document.querySelector("#app"),
        kids: document.querySelector("#app")?.children.length ?? -1,
        text: (document.body.innerText || "").replace(/\\s+/g, " ").slice(0, 160),
      }))()
    `);
    console.log("diag:", JSON.stringify(diag));
    if (pageErrors.length) console.log("pageErrors:", pageErrors.slice(0, 3).join(" | "));

    // 先建立连接（Workspace 仅在 connections.active 时渲染），再开 3 个标签
    await evalJs(cdp, `
      (async () => {
        const { useConnectionsStore } = await import("/src/stores/connections.ts");
        const conn = useConnectionsStore();
        await conn.connect({ id: "p1", alias: "mock", host: "h", port: 22, username: "u", authMethod: "password", createdAt: 0 });
        if (!conn.active) throw new Error("connect 失败");
        return conn.active.connectionId;
      })()
    `);
    await sleep(600);
    await evalJs(cdp, `
      (async () => {
        const { useConnectionsStore } = await import("/src/stores/connections.ts");
        const { useWorkspaceStore } = await import("/src/stores/workspace.ts");
        const cid = useConnectionsStore().active.connectionId;
        const ws = useWorkspaceStore();
        ws.openTab(cid, "p1", "alpha");
        ws.openTab(cid, "p1", "beta");
        ws.openTab(cid, "p1", "gamma");
        return ws.tabs.length;
      })()
    `);
    await sleep(800);

    const shoot = async (label, activateIndex) => {
      await evalJs(cdp, `
        (async () => {
          const { useWorkspaceStore } = await import("/src/stores/workspace.ts");
          const ws = useWorkspaceStore();
          ws.activateTab(ws.tabs[${activateIndex}].id);
          return true;
        })()
      `);
      await sleep(500);
      const rect = JSON.parse(
        await evalJs(cdp, `
          (() => {
            const el = document.querySelector("[data-active-tab]");
            if (!el) return "null";
            const bar = el.parentElement.getBoundingClientRect();
            const r = el.getBoundingClientRect();
            // 截取：标签条 + 卡片顶部 24px，水平取标签前后 60px
            return JSON.stringify({ x: Math.max(0, r.left - 60), y: bar.top, width: Math.min(window.innerWidth, r.right + 60) - Math.max(0, r.left - 60), height: bar.height + 24, tabLeft: r.left, tabRight: r.right, tabTop: r.top, tabBottom: r.bottom });
          })()
        `),
      );
      if (!rect) throw new Error("未找到 data-active-tab");
      console.log(label, JSON.stringify(rect));
      const shot = await send("Page.captureScreenshot", {
        format: "png",
        clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 },
      });
      const path = join(OUT, `vssh-tabs-${label}.png`);
      writeFileSync(path, Buffer.from(shot.data, "base64"));
      console.log("saved", path);
    };

    await shoot("first", 0);
    await shoot("mid", 1);

    ws.close();
  } finally {
    edge.kill();
    vite.kill();
  }
}

main().catch((e) => {
  console.error("截图失败:", e.message ?? e);
  process.exit(1);
});
