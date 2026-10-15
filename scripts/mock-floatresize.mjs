/**
 * 悬浮窗全边界 resize 回归（vite dev + Edge headless CDP）：mock 进工作区 →
 * 打开编辑器/终端悬浮窗 → 合成 PointerEvent 拖 8 向句柄 → 断言：
 * ① 东/南/东南向：对侧边缘不动、拖拽侧 1:1 跟手（终端旧实现居中态只走一半）；
 * ② 西/北向：对侧边缘锚定、本侧跟手；③ 超限 clamp 到 min 尺寸时对侧不漂移；
 * ④ 关闭重开复位居中。运行：node scripts/mock-floatresize.mjs
 */
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const VITE_PORT = 4273;
const CDP_PORT = 9338;
const APP_URL = `http://127.0.0.1:${VITE_PORT}/`;
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

let failures = 0;
function ok(label) {
  console.log(`  ok  ${label}`);
}
function fail(label, err) {
  failures += 1;
  console.error(`  FAIL ${label} — ${String(err).split("\n")[0]}`);
}
function assert(label, cond, detail) {
  if (cond) ok(label);
  else fail(label, detail ?? "条件为假");
}

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

/** 页内工作区布置片段（嵌入各 evalJs 表达式；整页刷新后需重新执行） */
const SETUP_WS_BODY = `
      const { useConnectionsStore } = await import("/src/stores/connections.ts");
      const conn = useConnectionsStore();
      const fake = { connectionId: "c1", alias: "mock", profile: { id: "p1", alias: "mock", host: "h", port: 22, username: "u", authMethod: "password", createdAt: 0 }, rootPath: "/", latencyMs: 3 };
      conn.byId = { c1: fake };
      conn.active = fake;
      await new Promise((r) => setTimeout(r, 1200));
`;

/** 页内拖拽 + 断言工具（注入一次，两窗共用） */
const PAGE_TOOLS = `
window.__drag = (label, dir, dx, dy) => {
  const dlg = document.querySelector('[aria-label="' + label + '"]');
  if (!dlg) return { error: "窗体未找到" };
  const h = dlg.querySelector('[data-resize-dir="' + dir + '"]');
  if (!h) return { error: "句柄未找到: " + dir };
  const before = dlg.getBoundingClientRect();
  const r = h.getBoundingClientRect();
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  h.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y, pointerId: 9, isPrimary: true }));
  window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: x + dx, clientY: y + dy, pointerId: 9 }));
  window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: x + dx, clientY: y + dy, pointerId: 9 }));
  return new Promise((res) => setTimeout(() => {
    const after = dlg.getBoundingClientRect();
    res({
      dLeft: +(after.left - before.left).toFixed(1),
      dTop: +(after.top - before.top).toFixed(1),
      dRight: +(after.right - before.right).toFixed(1),
      dBottom: +(after.bottom - before.bottom).toFixed(1),
      w: +after.width.toFixed(1),
      h: +after.height.toFixed(1),
      maxW: Math.round(window.innerWidth * 0.92),
      maxH: Math.round(window.innerHeight * 0.9),
    });
  }, 200));
};
window.__center = (label) => {
  const dlg = document.querySelector('[aria-label="' + label + '"]');
  if (!dlg) return null;
  const r = dlg.getBoundingClientRect();
  const o = dlg.parentElement.getBoundingClientRect();
  // 居中断言对照遮罩中心（页面出现滚动条时视口中心会偏移）
  return { cx: +(r.left + r.width / 2).toFixed(1), maskCx: +((o.left + o.right) / 2).toFixed(1) };
};
`;

const MOCK = String.raw`
(() => { if (window.__mock) return; // 同文档重复注入守卫（导航中间提交会二次执行）
window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 16);
window.__errs = [];
window.addEventListener("error", (e) => window.__errs.push(String(e.message)));
const S = (window.__mock = { handlers: new Map(), cbSeq: 1, resizes: [] });
function emit(event, payload) {
  for (const hid of S.handlers.get(event) ?? []) {
    const cb = window["_" + hid];
    if (cb) cb({ event, id: S.cbSeq++, payload });
  }
}
const FILES = [
  { name: "a.txt", kind: "file", size: 1, permissions: "-rw-r--r--", mtime: 1, owner: null, group: null, atime: null },
];
async function invoke(cmd, args = {}) {
  switch (cmd) {
    case "plugin:event|listen": {
      const { event, handler } = args;
      if (!S.handlers.has(event)) S.handlers.set(event, new Set());
      S.handlers.get(event).add(handler);
      return handler;
    }
    case "ssh_list_dir": return FILES;
    case "ssh_read_file": return "line1\nline2\n";
    case "ssh_open_terminal": return "t-mock";
    case "ssh_terminal_write": return null;
    case "ssh_terminal_resize": { S.resizes.push([args.cols, args.rows]); return null; }
    case "ssh_terminal_close": return null;
    case "ssh_exec": return { exitCode: 0, stdout: "", stderr: "" };
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
${PAGE_TOOLS}
})();
`;



const near = (v, expect, tol = 2) => Math.abs(v - expect) <= tol;

/** Windows 下 spawn(shell:true) 的 kill() 只杀 shell：taskkill 连进程树一起收，
 *  否则残留 vite 占住 4273，下轮 strictPort 起不来、waitHttp 命中旧服务（旧模块） */
function killTree(proc) {
  if (!proc.pid) return;
  if (process.platform === "win32") {
    // spawnSync：紧跟的 process.exit 不给异步 taskkill 执行机会
    spawnSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { shell: true, stdio: "ignore" });
  } else {
    proc.kill();
  }
}

async function main() {
  const vite = spawn("npx", ["vite", "--port", `${VITE_PORT}`, "--strictPort"], {
    shell: true,
    stdio: "ignore",
  });
  await waitHttp(APP_URL);
  const edge = spawn(EDGE, [
    "--headless=new", "--no-first-run", "--disable-gpu", "--window-size=1440,900",
    `--user-data-dir=${process.env.TEMP}\\vssh-floatresize-profile`,
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

  // 1. 进工作区 + 注入页面工具
  const boot = await evalJs(cdp, `
    (async () => {
      const diag = {
        mock: !!window.__mock,
        tauri: !!window.__TAURI_INTERNALS__,
        appChildren: document.getElementById("app")?.children.length ?? -1,
        errs: window.__errs?.slice(0, 5) ?? ["__errs 缺失（MOCK 未注入）"],
      };
      try {
        const { useConnectionsStore } = await import("/src/stores/connections.ts");
        const conn = useConnectionsStore();
        const fake = { connectionId: "c1", alias: "mock", profile: { id: "p1", alias: "mock", host: "h", port: 22, username: "u", authMethod: "password", createdAt: 0 }, rootPath: "/", latencyMs: 3 };
        conn.byId = { c1: fake };
        conn.active = fake;
        await new Promise((r) => setTimeout(r, 1200));
        diag.rows = document.querySelectorAll("[data-row]").length;
      } catch (e) {
        diag.err = String(e?.message ?? e);
      }
      return diag;
    })()
  `);
  console.log("启动诊断:", JSON.stringify(boot));
  if (boot.err) throw new Error(`应用启动异常: ${boot.err}`);

  // ============ 编辑器悬浮窗 ============
  // 预热：首次打开会触发 vite 依赖优化整页刷新（CodeMirror 动态导入），刷新后
  // store/DOM 全复位——先空跑一轮等刷新落地，再重新布置场景开始断言
  await evalJs(cdp, `
    (async () => {
      ${SETUP_WS_BODY}
      const { useEditorStore } = await import("/src/stores/editor.ts");
      await useEditorStore().openEntry(
        { name: "a.txt", kind: "file", size: 8, permissions: "-rw-r--r--", mtime: 1, owner: null, group: null, atime: null },
        "/", "c1");
      await new Promise((r) => setTimeout(r, 2600));
      return true;
    })()
  `);
  const edReady = await evalJs(cdp, `
    (async () => {
      ${SETUP_WS_BODY}
      const { useEditorStore } = await import("/src/stores/editor.ts");
      const ed = useEditorStore();
      if (ed.open) ed.closeNow();
      await new Promise((r) => setTimeout(r, 200));
      await ed.openEntry(
        { name: "a.txt", kind: "file", size: 8, permissions: "-rw-r--r--", mtime: 1, owner: null, group: null, atime: null },
        "/", "c1");
      await new Promise((r) => setTimeout(r, 500));
      const dlg = document.querySelector('[aria-label="文件编辑器"]');
      return { dlg: !!dlg, handles: dlg ? dlg.querySelectorAll("[data-resize-dir]").length : 0 };
    })()
  `);
  console.log("编辑器场景:", JSON.stringify(edReady));
  if (!edReady.dlg || edReady.handles !== 8) throw new Error(`编辑器场景布置失败: ${JSON.stringify(edReady)}`);

  const ED = "文件编辑器";
  // 收缩方向验证 1:1（不触上下限），随后显式 clamp 断言
  const edE = await evalJs(cdp, `window.__drag(${JSON.stringify(ED)}, "e", 150, 0)`);
  console.log("编辑器·东:", JSON.stringify(edE));
  assert("东缘拖 +150 → 右缘 1:1、左缘不动", near(edE.dLeft, 0) && near(edE.dRight, 150), JSON.stringify(edE));

  const edW = await evalJs(cdp, `window.__drag(${JSON.stringify(ED)}, "w", 80, 0)`);
  console.log("编辑器·西:", JSON.stringify(edW));
  assert("西缘拖 +80 → 左缘 1:1、右缘锚定", near(edW.dLeft, 80) && near(edW.dRight, 0), JSON.stringify(edW));

  const edN = await evalJs(cdp, `window.__drag(${JSON.stringify(ED)}, "n", 0, 60)`);
  console.log("编辑器·北:", JSON.stringify(edN));
  assert("北缘拖 +60 → 顶缘 1:1、底缘锚定", near(edN.dTop, 60) && near(edN.dBottom, 0), JSON.stringify(edN));

  const edS = await evalJs(cdp, `window.__drag(${JSON.stringify(ED)}, "s", 0, -50)`);
  console.log("编辑器·南:", JSON.stringify(edS));
  assert("南缘拖 -50 → 底缘 1:1、顶缘不动", near(edS.dTop, 0) && near(edS.dBottom, -50), JSON.stringify(edS));

  const edSE = await evalJs(cdp, `window.__drag(${JSON.stringify(ED)}, "se", -70, -40)`);
  console.log("编辑器·东南角:", JSON.stringify(edSE));
  assert("东南角 -70/-40 → 两轴全额、左上不动", near(edSE.dLeft, 0) && near(edSE.dTop, 0) && near(edSE.dRight, -70) && near(edSE.dBottom, -40), JSON.stringify(edSE));

  const edNW = await evalJs(cdp, `window.__drag(${JSON.stringify(ED)}, "nw", 40, 30)`);
  console.log("编辑器·西北角:", JSON.stringify(edNW));
  assert("西北角 +40/+30 → 两轴全额、右下锚定", near(edNW.dLeft, 40) && near(edNW.dTop, 30) && near(edNW.dRight, 0) && near(edNW.dBottom, 0), JSON.stringify(edNW));

  const edClampW = await evalJs(cdp, `window.__drag(${JSON.stringify(ED)}, "w", 2000, 0)`);
  console.log("编辑器·西缘拖穿:", JSON.stringify(edClampW));
  assert("西缘拖穿 → clamp minW 480、右缘不漂移", near(edClampW.w, 480) && near(edClampW.dRight, 0), JSON.stringify(edClampW));

  const edClampN = await evalJs(cdp, `window.__drag(${JSON.stringify(ED)}, "n", 0, 2000)`);
  console.log("编辑器·北缘拖穿:", JSON.stringify(edClampN));
  assert("北缘拖穿 → clamp minH 280、底缘不漂移", near(edClampN.h, 280) && near(edClampN.dBottom, 0), JSON.stringify(edClampN));

  const edClampE = await evalJs(cdp, `window.__drag(${JSON.stringify(ED)}, "e", 2000, 0)`);
  console.log("编辑器·东缘拖穿:", JSON.stringify(edClampE));
  assert("东缘拖穿 → clamp maxW、左缘不漂移", near(edClampE.w, edClampE.maxW) && near(edClampE.dLeft, 0), JSON.stringify(edClampE));

  // 关闭重开 → 复位居中
  await evalJs(cdp, `
    (async () => {
      const { useEditorStore } = await import("/src/stores/editor.ts");
      const ed = useEditorStore();
      ed.closeNow();
      await new Promise((r) => setTimeout(r, 300));
      await ed.openEntry(
        { name: "a.txt", kind: "file", size: 8, permissions: "-rw-r--r--", mtime: 1, owner: null, group: null, atime: null },
        "/", "c1");
      await new Promise((r) => setTimeout(r, 500));
      return true;
    })()
  `);
  const edRe = await evalJs(cdp, `window.__center(${JSON.stringify(ED)})`);
  assert("关闭重开 → 水平复位居中", near(edRe.cx, edRe.maskCx, 2), JSON.stringify(edRe));

  // ============ 终端悬浮窗 ============
  // 预热一轮（xterm 依赖优化可能整页刷新）→ 重新布置 → 校验
  await evalJs(cdp, `
    (async () => {
      const { useEditorStore } = await import("/src/stores/editor.ts");
      useEditorStore().closeNow();
      const { useTerminalStore } = await import("/src/stores/terminal.ts");
      await useTerminalStore().openIn("/", "c1");
      await new Promise((r) => setTimeout(r, 2600));
      return true;
    })()
  `);
  const tmReady = await evalJs(cdp, `
    (async () => {
      ${SETUP_WS_BODY}
      const { useTerminalStore } = await import("/src/stores/terminal.ts");
      const t = useTerminalStore();
      if (!t.open) await t.openIn("/", "c1");
      await new Promise((r) => setTimeout(r, 800));
      const dlg = document.querySelector('[aria-label="终端"]');
      return { dlg: !!dlg, handles: dlg ? dlg.querySelectorAll("[data-resize-dir]").length : 0, tid: t.activeTerminalId };
    })()
  `);
  console.log("终端场景:", JSON.stringify(tmReady));
  if (!tmReady.dlg || tmReady.handles !== 8) throw new Error(`终端场景布置失败: ${JSON.stringify(tmReady)}`);

  const TM = "终端";
  const tmE = await evalJs(cdp, `window.__drag(${JSON.stringify(TM)}, "e", 150, 0)`);
  console.log("终端·东:", JSON.stringify(tmE));
  assert("终端东缘拖 +150 → 右缘 1:1（旧实现居中态仅 +75）、左缘不动", near(tmE.dLeft, 0) && near(tmE.dRight, 150), JSON.stringify(tmE));

  const tmW = await evalJs(cdp, `window.__drag(${JSON.stringify(TM)}, "w", 80, 0)`);
  console.log("终端·西:", JSON.stringify(tmW));
  assert("终端西缘拖 +80 → 左缘 1:1、右缘锚定", near(tmW.dLeft, 80) && near(tmW.dRight, 0), JSON.stringify(tmW));

  const tmN = await evalJs(cdp, `window.__drag(${JSON.stringify(TM)}, "n", 0, 60)`);
  console.log("终端·北:", JSON.stringify(tmN));
  assert("终端北缘拖 +60 → 顶缘 1:1、底缘锚定", near(tmN.dTop, 60) && near(tmN.dBottom, 0), JSON.stringify(tmN));

  const tmS = await evalJs(cdp, `window.__drag(${JSON.stringify(TM)}, "s", 0, -50)`);
  console.log("终端·南:", JSON.stringify(tmS));
  assert("终端南缘拖 -50 → 底缘 1:1、顶缘不动", near(tmS.dTop, 0) && near(tmS.dBottom, -50), JSON.stringify(tmS));

  const tmSE = await evalJs(cdp, `window.__drag(${JSON.stringify(TM)}, "se", -70, -40)`);
  console.log("终端·东南角:", JSON.stringify(tmSE));
  assert("终端东南角 -70/-40 → 两轴全额、左上不动", near(tmSE.dLeft, 0) && near(tmSE.dTop, 0) && near(tmSE.dRight, -70) && near(tmSE.dBottom, -40), JSON.stringify(tmSE));

  const tmNW = await evalJs(cdp, `window.__drag(${JSON.stringify(TM)}, "nw", 40, 30)`);
  console.log("终端·西北角:", JSON.stringify(tmNW));
  assert("终端西北角 +40/+30 → 两轴全额、右下锚定", near(tmNW.dLeft, 40) && near(tmNW.dTop, 30) && near(tmNW.dRight, 0) && near(tmNW.dBottom, 0), JSON.stringify(tmNW));

  const tmClampW = await evalJs(cdp, `window.__drag(${JSON.stringify(TM)}, "w", 2000, 0)`);
  console.log("终端·西缘拖穿:", JSON.stringify(tmClampW));
  assert("终端西缘拖穿 → clamp minW 480、右缘不漂移", near(tmClampW.w, 480) && near(tmClampW.dRight, 0), JSON.stringify(tmClampW));

  const tmClampN = await evalJs(cdp, `window.__drag(${JSON.stringify(TM)}, "n", 0, 2000)`);
  console.log("终端·北缘拖穿:", JSON.stringify(tmClampN));
  assert("终端北缘拖穿 → clamp minH 240、底缘不漂移", near(tmClampN.h, 240) && near(tmClampN.dBottom, 0), JSON.stringify(tmClampN));

  const tmClampE = await evalJs(cdp, `window.__drag(${JSON.stringify(TM)}, "e", 2000, 0)`);
  console.log("终端·东缘拖穿:", JSON.stringify(tmClampE));
  assert("终端东缘拖穿 → clamp maxW、左缘不漂移", near(tmClampE.w, tmClampE.maxW) && near(tmClampE.dLeft, 0), JSON.stringify(tmClampE));

  // 关闭重开 → 复位居中
  await evalJs(cdp, `
    (async () => {
      const { useTerminalStore } = await import("/src/stores/terminal.ts");
      await useTerminalStore().close();
      await new Promise((r) => setTimeout(r, 300));
      await useTerminalStore().openIn("/", "c1");
      await new Promise((r) => setTimeout(r, 800));
      return true;
    })()
  `);
  const tmRe = await evalJs(cdp, `window.__center(${JSON.stringify(TM)})`);
  assert("终端关闭重开 → 水平复位居中", near(tmRe.cx, tmRe.maskCx, 2), JSON.stringify(tmRe));

  const errs = await evalJs(cdp, `window.__errs.slice(0, 5)`);
  console.log("页面错误:", JSON.stringify(errs));

  ws.close(); killTree(edge); killTree(vite);
  console.log(failures ? `\n${failures} 项失败` : "\n全部通过");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error("异常:", e); process.exit(1); });
