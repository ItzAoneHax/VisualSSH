/**
 * 框选回归排查脚本：mock 进工作区 → 合成 PointerEvent 驱动橡皮筋框选 →
 * 断言 selectedNames 变化与 rubber 视觉。定位「拖拽框选不生效」断点。
 */
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const VITE_PORT = 4273;
const CDP_PORT = 9337;
const APP_URL = `http://127.0.0.1:${VITE_PORT}/`;
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

async function waitHttp(url, timeoutMs = 30000) {
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

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

async function evalJs(cdp, expr) {
  const res = await cdp.send("Runtime.evaluate", {
    expression: expr,
    awaitPromise: true,
    returnByValue: true,
  });
  if (res.exceptionDetails) {
    throw new Error(res.exceptionDetails.exception?.description ?? "evaluate failed");
  }
  return res.result?.value;
}

const MOCK = String.raw`
window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 16);
const S = (window.__mock = { handlers: new Map(), cbSeq: 1 });
function emit(event, payload) {
  for (const hid of S.handlers.get(event) ?? []) {
    const cb = window["_" + hid];
    if (cb) cb({ event, id: S.cbSeq++, payload });
  }
}
async function invoke(cmd, args = {}) {
  switch (cmd) {
    case "plugin:event|listen": {
      const { event, handler } = args;
      if (!S.handlers.has(event)) S.handlers.set(event, new Set());
      S.handlers.get(event).add(handler);
      return handler;
    }
    case "ssh_list_dir": return [
      { name: "a.txt", kind: "file", size: 1, permissions: "-rw-r--r--", mtime: 1, owner: null, group: null, atime: null },
      { name: "b.txt", kind: "file", size: 2, permissions: "-rw-r--r--", mtime: 1, owner: null, group: null, atime: null },
      { name: "cdir", kind: "dir", size: 0, permissions: "drwxr-xr-x", mtime: 1, owner: null, group: null, atime: null },
    ];
    case "ssh_fs_info": return null;
    case "plugin:event|unlisten": return null;
    default: return null;
  }
}
window.__TAURI_INTERNALS__ = {
  invoke,
  transformCallback: (cb) => { const id = S.cbSeq++; window["_" + id] = cb; return id; },
  metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
  plugins: {},
};
window.__mock.emit = emit;
`;

async function main() {
  const vite = spawn("npx", ["vite", "--port", `${VITE_PORT}`, "--strictPort"], {
    shell: true,
    stdio: "ignore",
  });
  await waitHttp(APP_URL);
  const edge = spawn(EDGE, [
    "--headless=new", "--no-first-run", "--disable-gpu", "--window-size=1440,900",
    `--user-data-dir=${process.env.TEMP}\\vssh-rubber-profile`,
    `--remote-debugging-port=${CDP_PORT}`, "about:blank",
  ], { stdio: "ignore" });
  await waitHttp(`http://127.0.0.1:${CDP_PORT}/json/version`, 60000);
  const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener("open", r); ws.addEventListener("error", j); });
  const cdp = new Cdp(ws);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: MOCK });
  await cdp.send("Page.navigate", { url: APP_URL });
  await sleep(2500);

  // 1. 进工作区（byId + active 双写）
  await evalJs(cdp, `
    (async () => {
      const { useConnectionsStore } = await import("/src/stores/connections.ts");
      const conn = useConnectionsStore();
      const fake = { connectionId: "c1", alias: "mock", profile: { id: "p1", alias: "mock", host: "h", port: 22, username: "u", authMethod: "password", createdAt: 0 }, rootPath: "/", latencyMs: 3 };
      conn.byId = { c1: fake };
      conn.active = fake;
      await new Promise((r) => setTimeout(r, 1200));
      return document.querySelectorAll("[data-row]").length;
    })()
  `);

  // 2. 行矩形 + 容器
  const rect = await evalJs(cdp, `
    (() => {
      const row = document.querySelector("[data-row]");
      const container = document.querySelector(".px-2.pb-3");
      if (!row || !container) return null;
      const r = row.getBoundingClientRect();
      const c = container.getBoundingClientRect();
      return { rowTop: r.top, rowBottom: r.bottom, rowLeft: r.left, rowRight: r.right, containerTag: container.tagName };
    })()
  `);
  console.log("行/容器矩形:", JSON.stringify(rect));

  // 3. 合成框选：pointerdown 在行坐标（target=容器，避开 [data-row] closest 检查）→ move → up
  const result = await evalJs(cdp, `
    (async () => {
      const { useExplorer } = await import("/src/stores/explorer.ts");
      const { useWorkspaceStore } = await import("/src/stores/workspace.ts");
      const workspace = useWorkspaceStore();
      const ex = useExplorer(workspace.activePaneId);
      const row = document.querySelector("[data-row]").getBoundingClientRect();
      const container = document.querySelector(".px-2.pb-3");

      // 起点在行上方空白（列头下方），向下扫过第一行
      const x1 = row.left + 40;
      const y1 = row.top - 6;
      const x2 = row.right;
      const y2 = row.bottom + 4;

      const before = ex.selectedNames.size;
      const pd = new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, clientX: x1, clientY: y1, pointerId: 1, isPrimary: true });
      container.dispatchEvent(pd);
      const downDefaultNotPrevented = pd.defaultPrevented === false;

      // 模拟拖动（超过 4px 阈值）
      window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: x1 + 10, clientY: y1 + 10, pointerId: 1 }));
      window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: x2, clientY: y2, pointerId: 1 }));
      await new Promise((r) => setTimeout(r, 100)); // rAF 节流后
      const midCount = ex.selectedNames.size;
      const namesMid = [...ex.selectedNames];

      window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: x2, clientY: y2, pointerId: 1 }));
      await new Promise((r) => setTimeout(r, 50));
      return { before, downDefaultNotPrevented, midCount, namesMid, afterCount: ex.selectedNames.size };
    })()
  `);
  console.log("框选驱动结果:", JSON.stringify(result));

  // 5. 行上单击（不拖动）：不得清空行选择（onRow 分支——行选中交由行自身处理）
  const clickOnRow = await evalJs(cdp, `
    (async () => {
      const { useExplorer } = await import("/src/stores/explorer.ts");
      const { useWorkspaceStore } = await import("/src/stores/workspace.ts");
      const ex = useExplorer(useWorkspaceStore().activePaneId);
      const row = document.querySelector("[data-row]");
      const r = row.getBoundingClientRect();
      // 行自身的 pointerdown 处理先选中该行（selectOnly）
      row.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: r.left + 100, clientY: r.top + 5, pointerId: 2, isPrimary: true }));
      await new Promise((res) => setTimeout(res, 10));
      const selectedAfterDown = ex.selectedNames.size;
      // 容器 up（moved=false，onRow=true）——不应 clearSelection
      window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: r.left + 100, clientY: r.top + 5, pointerId: 2 }));
      await new Promise((res) => setTimeout(res, 30));
      return { selectedAfterDown, selectedAfterUp: ex.selectedNames.size };
    })()
  `);
  console.log("行上单击保留选择:", JSON.stringify(clickOnRow));

  // 4. 状态栏计数可见性（辅助判断）
  ws.close(); edge.kill(); vite.kill();
  process.exit(0);
}

main().catch((e) => { console.error("异常:", e); process.exit(1); });
