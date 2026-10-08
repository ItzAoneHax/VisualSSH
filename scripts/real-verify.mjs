/**
 * 假说验证：真机行上按下拖动——HTML5 dragstart 是否触发？pointer 事件流是否持续？
 * 同时验证：从行间隙/列表底部能否框选（对照组）。
 */
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const CDP_PORT = 9341;
const EXE = "C:\\Users\\limin\\IdeaProjects\\VisualSSH\\VisualSSH.exe";

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

async function input(cdp, type, x, y, extra = {}) {
  await cdp.send("Input.dispatchMouseEvent", {
    type,
    x: Math.round(x),
    y: Math.round(y),
    button: type === "mouseMoved" ? (extra.button ?? undefined) : "left",
    clickCount: type === "mousePressed" || type === "mouseReleased" ? 1 : 0,
    ...extra,
  });
}

const PATCH = String.raw`
(() => {
  function patch() {
    if (!window.__TAURI_INTERNALS__ || window.__patched) return false;
    window.__patched = true;
    const real = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async function (cmd, args) {
      switch (cmd) {
        case "ssh_connect": return { connectionId: "fake-c1", rootPath: "/", latencyMs: 3 };
        case "credential_get": return "fake-pass";
        case "ssh_list_dir": return [
          { name: "a.txt", kind: "file", size: 1, permissions: "-rw-r--r--", mtime: 1, owner: null, group: null, atime: null },
          { name: "b.txt", kind: "file", size: 2, permissions: "-rw-r--r--", mtime: 1, owner: null, group: null, atime: null },
          { name: "cdir", kind: "dir", size: 0, permissions: "drwxr-xr-x", mtime: 1, owner: null, group: null, atime: null },
        ];
        case "ssh_fs_info": return null;
        default: return real.call(this, cmd, args);
      }
    };
    return true;
  }
  const t = setInterval(() => { if (patch()) clearInterval(t); }, 5);
})();
`;

/** 安装事件记录器 */
const RECORDER = `
window.__evts = [];
for (const t of ["dragstart", "pointercancel"]) {
  window.addEventListener(t, (e) => window.__evts.push(t + "@" + (e.target.dataset?.row ?? e.target.tagName)), true);
}
window.addEventListener("pointermove", (e) => {
  if (window.__dragTracking) window.__evts.push("pointermove");
});
`;

async function main() {
  const exe = spawn(EXE, [], {
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}` },
  });
  await waitHttp(`http://127.0.0.1:${CDP_PORT}/json/version`, 30000);
  let targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  let page = targets.find((t) => t.type === "page" && t.url.includes("tauri"));
  if (!page) {
    await sleep(1500);
    targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    page = targets.find((t) => t.type === "page" && t.url.includes("tauri"));
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener("open", r); ws.addEventListener("error", j); });
  const cdp = new Cdp(ws);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: PATCH });
  await cdp.send("Page.reload");
  await sleep(3000);

  // 连接进工作区（带重试：等待连接卡出现且点击后行渲染）
  let info = null;
  for (let attempt = 0; attempt < 3 && !info; attempt++) {
    const card = await evalJs(cdp, `
      (() => {
        const card = [...document.querySelectorAll("aside .nav-item")][1];
        if (!card) return null;
        const r = card.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()
    `);
    if (card) {
      await input(cdp, "mousePressed", card.x, card.y);
      await input(cdp, "mouseReleased", card.x, card.y);
      await sleep(2500);
    } else {
      await sleep(1000);
    }
    info = await evalJs(cdp, `
      (() => {
        const row = document.querySelector("[data-row]");
        if (!row) return null;
        const rows = document.querySelectorAll("[data-row]").length;
        const r = row.getBoundingClientRect();
        return {
          rows,
          draggable: row.getAttribute("draggable"),
          rowRect: { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) },
        };
      })()
    `).catch(() => null);
  }
  if (!info) throw new Error("工作区未挂载（无 [data-row]）");
  console.log("环境:", JSON.stringify(info));

  // —— 场景 1：行上按下拖动（用户日常框选手势）——
  await evalJs(cdp, RECORDER);
  await evalJs(cdp, `window.__evts = []; window.__dragTracking = true;`);
  const r = info.rowRect;
  await input(cdp, "mouseMoved", r.left + 300, r.top + 10);
  await input(cdp, "mousePressed", r.left + 300, r.top + 10);
  for (let i = 1; i <= 6; i++) {
    await input(cdp, "mouseMoved", r.left + 300 + i * 30, r.top + 10 + i * 15);
    await sleep(40);
  }
  const midEvt1 = await evalJs(cdp, `
    (() => {
      const rubber = !!document.querySelector("div.pointer-events-none.fixed.z-30");
      const selected = document.querySelectorAll(".bg-row-active").length;
      return { evts: window.__evts.filter((e) => e !== "pointermove").slice(0, 6), moves: window.__evts.filter((e) => e === "pointermove").length, rubber, selected };
    })()
  `);
  await input(cdp, "mouseReleased", r.left + 480, r.top + 100);
  await sleep(150);
  const after1 = await evalJs(cdp, `document.querySelectorAll(".bg-row-active").length`);
  console.log("场景1 行上拖动:", JSON.stringify(midEvt1), "| 释放后选中行:", after1);
  await evalJs(cdp, `window.__dragTracking = false;`);

  // —— 场景 2：滚动到底部，末行下方空白拖动（对照组，若列表不满屏）——
  const bottomInfo = await evalJs(cdp, `
    (() => {
      const container = document.querySelector(".px-2.pb-3");
      const scroller = container.closest(".overflow-y-auto") ?? container;
      scroller.scrollTop = scroller.scrollHeight;
      return new Promise((resolve) => setTimeout(() => {
        const rows = [...document.querySelectorAll("[data-row]")];
        const last = rows[rows.length - 1]?.getBoundingClientRect();
        const cRect = scroller.getBoundingClientRect();
        resolve({
          scrollerBottom: Math.round(cRect.bottom),
          lastRowBottom: last ? Math.round(last.bottom) : null,
          blankBelow: last ? Math.round(cRect.bottom - last.bottom) : null,
        });
      }, 150));
    })()
  `);
  console.log("底部空白:", JSON.stringify(bottomInfo));
  if (bottomInfo.blankBelow !== null && bottomInfo.blankBelow > 20) {
    await evalJs(cdp, `window.__evts = []; window.__dragTracking = true;`);
    const y = bottomInfo.lastRowBottom + 10;
    await input(cdp, "mouseMoved", 400, y);
    await input(cdp, "mousePressed", 400, y);
    for (let i = 1; i <= 5; i++) {
      await input(cdp, "mouseMoved", 400 + i * 40, y - i * 40);
      await sleep(40);
    }
    const mid2 = await evalJs(cdp, `
      (() => ({ rubber: !!document.querySelector("div.pointer-events-none.fixed.z-30"), selected: document.querySelectorAll(".bg-row-active").length }))()
    `);
    await input(cdp, "mouseReleased", 600, y - 200);
    await sleep(150);
    const after2 = await evalJs(cdp, `document.querySelectorAll(".bg-row-active").length`);
    console.log("场景2 底部空白拖动:", JSON.stringify(mid2), "| 释放后选中行:", after2);
    await evalJs(cdp, `window.__dragTracking = false;`);
  }

  ws.close();
  exe.kill();
  process.exit(0);
}

main().catch((e) => { console.error("异常:", e); process.exit(1); });
