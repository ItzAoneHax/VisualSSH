/**
 * 空态（标签全部关闭）验证：vite dev 4277 + Edge headless CDP。
 * 链路：连接→挂载自动建 1 标签 → 点标签 X（真实 UI 路径，关最后一个标签无确认弹窗）
 * → 空态页出现 + 熔接顶线隐藏 → 点「新建标签」→ 菜单选会话 → 标签重建。
 * 运行：node scripts/mock-emptytab.mjs
 */
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const VITE_PORT = 4277;
const CDP_PORT = 9347;
const APP_URL = `http://127.0.0.1:${VITE_PORT}/`;
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const OUT = join(process.cwd(), ".zcode-shots");

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

const MOCK = String.raw`
  (() => {
  if (window.__mock) return;
  window.__mock = true;
  try { localStorage.clear(); } catch {}
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
  })();
`;

async function main() {
  const vite = spawn("npx", ["vite", "--port", `${VITE_PORT}`, "--strictPort"], { shell: true, stdio: "ignore" });
  const profile = join(process.env.TEMP, `vssh-empty-${Date.now()}`);
  const edge = spawn(
    EDGE,
    [
      "--headless=new",
      "--no-first-run",
      "--disable-gpu",
      "--window-position=-32000,-32000",
      "--start-minimized",
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${CDP_PORT}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  let failed = 0;
  const rows = [];
  const check = (name, pass, detail = "") => {
    rows.push({ name, pass, detail });
    if (!pass) failed += 1;
  };
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
    const evalJs = async (expr) => {
      const res = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
      if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? "evaluate failed");
      return res.result?.value;
    };

    await send("Page.enable");
    await send("Runtime.enable");
    await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await send("Page.addScriptToEvaluateOnNewDocument", { source: MOCK });
    const pageErrors = [];
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.method === "Runtime.exceptionThrown") {
        pageErrors.push(msg.params?.exceptionDetails?.exception?.description ?? "?");
      }
    });
    await send("Page.navigate", { url: APP_URL });
    let diag = null;
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      diag = await evalJs(`(() => ({ mockReady: !!window.__TAURI_INTERNALS__, kids: document.querySelector("#app")?.children.length ?? -1 }))()`);
      if (diag.mockReady && diag.kids > 0) break;
    }
    if (!diag?.mockReady || diag.kids <= 0) throw new Error("应用未挂载");
    if (pageErrors.length) console.log("pageErrors:", pageErrors.slice(0, 3).join(" | "));

    // 连接 → 工作区挂载自动建首标签
    await evalJs(`
      (async () => {
        const { useConnectionsStore } = await import("/src/stores/connections.ts");
        const conn = useConnectionsStore();
        await conn.connect({ id: "p1", alias: "mock", host: "h", port: 22, username: "u", authMethod: "password", createdAt: 0 });
        if (!conn.active) throw new Error("connect 失败");
        return true;
      })()
    `);
    await sleep(1000);
    const afterConnect = await evalJs(`
      (() => {
        const { useWorkspaceStore } = window.__pinia?._s ? {} : {};
        return null;
      })()
    `);
    const state1 = await evalJs(`
      (() => {
        const app = document.querySelector("#app");
        const pinia = app.__vue_app__._context.config.globalProperties.$pinia;
        window.__pinia = pinia;
        const ws = pinia._s.get("workspace");
        return { tabs: ws.tabs.length, pane: !!document.querySelector("[data-toolbar-card], .explorer-pane, [aria-label*='窗格']") };
      })()
    `);
    check("连接后 1 个标签", state1.tabs === 1, JSON.stringify(state1));

    // 真实 UI 路径：点标签上的 X（关最后一个标签，不应有确认弹窗）
    await evalJs(`
      (() => {
        const btn = document.querySelector('button[aria-label^="关闭标签"]');
        if (!btn) throw new Error("找不到标签关闭按钮");
        btn.click();
        return true;
      })()
    `);
    await sleep(700);
    const state2 = await evalJs(`
      (() => {
        const ws = window.__pinia._s.get("workspace");
        const text = document.body.innerText || "";
        return {
          tabs: ws.tabs.length,
          empty: text.includes("没有打开的标签"),
          hint: text.includes("连接仍在后台运行"),
          newBtn: !!document.querySelector(".btn-secondary"),
          fusionGone: !document.querySelector("[data-fusion-line]"),
          guardDialog: text.includes("仍有传输进行中"),
          statusConn: text.includes("ms"),
        };
      })()
    `);
    check("X 关闭后 0 标签", state2.tabs === 0, JSON.stringify(state2.tabs));
    check("空态页出现", state2.empty && state2.hint, JSON.stringify({ empty: state2.empty, hint: state2.hint }));
    check("无确认弹窗", !state2.guardDialog, `guardDialog=${state2.guardDialog}`);
    check("熔接顶线隐藏", state2.fusionGone, `fusionGone=${state2.fusionGone}`);
    check("空态有新建按钮", state2.newBtn, `newBtn=${state2.newBtn}`);
    check("状态栏仍在（连接态可见）", state2.statusConn, `statusConn=${state2.statusConn}`);

    // 截一张空态图供目检
    const shot = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(OUT, "empty-tabs.png"), Buffer.from(shot.data, "base64"));

    // 点「新建标签」→ 菜单 → 选会话（conn:cid-1）
    await evalJs(`
      (() => {
        const btn = [...document.querySelectorAll(".btn-secondary")].find((b) => b.textContent.includes("新建标签"));
        if (!btn) throw new Error("找不到新建标签按钮");
        btn.click();
        return true;
      })()
    `);
    await sleep(500);
    const menu = await evalJs(`
      (() => {
        const items = [...document.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent.trim());
        const target = [...document.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent.includes("mock"));
        if (target) target.click();
        return { items, clicked: !!target };
      })()
    `);
    check("菜单含会话项", menu.clicked, JSON.stringify(menu.items).slice(0, 120));
    await sleep(700);
    const state3 = await evalJs(`
      (() => {
        const ws = window.__pinia._s.get("workspace");
        return { tabs: ws.tabs.length, emptyGone: !document.body.innerText.includes("没有打开的标签"), fusionBack: !!document.querySelector("[data-fusion-line]") };
      })()
    `);
    check("重开后 1 个标签", state3.tabs === 1, JSON.stringify(state3.tabs));
    check("空态页消失", state3.emptyGone, `emptyGone=${state3.emptyGone}`);
    check("熔接顶线恢复", state3.fusionBack, `fusionBack=${state3.fusionBack}`);
    check("无页面异常", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));

    console.log("\n—— 断言结果 ——");
    for (const r of rows) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}  (${r.detail})`);
    console.log(`\n${rows.length - failed}/${rows.length} 通过`);
    ws.close();
  } finally {
    try { spawnSync("taskkill", ["/PID", String(edge.pid), "/T", "/F"], { stdio: "ignore" }); } catch {}
    try { spawnSync("taskkill", ["/PID", String(vite.pid), "/T", "/F"], { stdio: "ignore" }); } catch {}
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("空态验证失败:", e.message ?? e);
  process.exit(1);
});
