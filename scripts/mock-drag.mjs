/**
 * 长按拖拽回归（vite dev + Edge headless CDP）：mock 进工作区 → 合成 PointerEvent
 * 驱动「按下 400ms 武装 → 拖到文件夹行 → 松手落点」→ 断言 ghost/caption/落点执行
 * （ssh_rename）、多选双快照、快速拖动回落框选、悬停 1300ms 打开。
 * 运行：node scripts/mock-drag.mjs
 */
import { spawn } from "node:child_process";
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

const MOCK = String.raw`
window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 16);
window.__errs = [];
window.addEventListener("error", (e) => window.__errs.push(String(e.message)));
const S = (window.__mock = { handlers: new Map(), cbSeq: 1, renames: [], execs: [], lists: [] });
function emit(event, payload) {
  for (const hid of S.handlers.get(event) ?? []) {
    const cb = window["_" + hid];
    if (cb) cb({ event, id: S.cbSeq++, payload });
  }
}
const FILES = [
  { name: "a.txt", kind: "file", size: 1, permissions: "-rw-r--r--", mtime: 1, owner: null, group: null, atime: null },
  { name: "b.txt", kind: "file", size: 2, permissions: "-rw-r--r--", mtime: 1, owner: null, group: null, atime: null },
  { name: "cdir", kind: "dir", size: 0, permissions: "drwxr-xr-x", mtime: 1, owner: null, group: null, atime: null },
];
async function invoke(cmd, args = {}) {
  switch (cmd) {
    case "plugin:event|listen": {
      const { event, handler } = args;
      if (!S.handlers.has(event)) S.handlers.set(event, new Set());
      S.handlers.get(event).add(handler);
      return handler;
    }
    case "ssh_list_dir": {
      S.lists.push(args.path);
      if (args.path === "/cdir") return [];
      return FILES;
    }
    case "ssh_rename":
      S.renames.push([args.oldPath, args.newPath]);
      return null;
    case "ssh_exec":
      S.execs.push([args.program, ...args.args]);
      return { exitCode: 0, stdout: "", stderr: "" };
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
`;

async function main() {
  const vite = spawn("npx", ["vite", "--port", `${VITE_PORT}`, "--strictPort"], {
    shell: true,
    stdio: "ignore",
  });
  await waitHttp(APP_URL);
  const edge = spawn(EDGE, [
    "--headless=new", "--no-first-run", "--disable-gpu", "--window-size=1440,900",
    `--user-data-dir=${process.env.TEMP}\\vssh-drag-profile`,
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

  // 1b. 单击不得闪武装动画（用户真机报告的 bug 回归锚点）：
  //     按下等待期（<400ms）行上无 file-row-armed/origin 类、无 ghost
  const click1 = await evalJs(cdp, `
    (async () => {
      const fdUrl = performance.getEntriesByType("resource").map((r) => r.name).find((n) => n.includes("/src/utils/fileDrag")) ?? "/src/utils/fileDrag.ts";
      const { fileDrag } = await import(fdUrl);
      const aRow = document.querySelector('[data-row="a.txt"]');
      const r = aRow.getBoundingClientRect();
      aRow.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, clientX: r.left + 60, clientY: r.top + r.height / 2, pointerId: 7, isPrimary: true }));
      await new Promise((res) => setTimeout(res, 120));
      const duringPress = {
        armed: aRow.classList.contains("file-row-armed"),
        origin: aRow.classList.contains("file-row-origin"),
        ghost: !!document.querySelector(".file-drag-ghost"),
      };
      window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: r.left + 60, clientY: r.top + r.height / 2, pointerId: 7 }));
      await new Promise((res) => setTimeout(res, 80));
      return { duringPress, phaseAfter: fileDrag.phase, ghostAfter: !!document.querySelector(".file-drag-ghost") };
    })()
  `);
  console.log("单击无动画:", JSON.stringify(click1));
  assert("单击按下期无武装动画", !click1.duringPress.armed && !click1.duringPress.origin && !click1.duringPress.ghost);
  assert("单击结束会话干净", click1.phaseAfter === "idle" && !click1.ghostAfter);

  // 2. 长按 a.txt → 武装（仅行微抬，无 ghost）→ 拖到 cdir → 松手 = 移动（ssh_rename）
  const drag1 = await evalJs(cdp, `
    (async () => {
      const fdUrl = performance.getEntriesByType("resource").map((r) => r.name).find((n) => n.includes("/src/utils/fileDrag")) ?? "/src/utils/fileDrag.ts";
      const { fileDrag } = await import(fdUrl);
      const S = window.__mock;
      const aRow = document.querySelector('[data-row="a.txt"]');
      const cRow = document.querySelector('[data-row="cdir"]');
      if (!aRow || !cRow) return { error: "行未找到" };
      const a = aRow.getBoundingClientRect();
      const c = cRow.getBoundingClientRect();
      const startX = a.left + 60, startY = a.top + a.height / 2;
      aRow.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, clientX: startX, clientY: startY, pointerId: 1, isPrimary: true }));
      // 亚阈值（2px）移动不取消长按
      window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: startX + 2, clientY: startY + 1, pointerId: 1 }));
      const earlyPhase = fileDrag.phase;
      const waitPhase = aRow.classList.contains("file-row-armed");
      await new Promise((r) => setTimeout(r, 520));
      const armed = fileDrag.phase;
      // 武装时点：仅行微抬；ghost/变暗推迟到真移动（DragStarting 语义）
      const armedLift = aRow.classList.contains("file-row-armed");
      const armedGhost = !!document.querySelector(".file-drag-ghost");
      const armedDim = aRow.classList.contains("file-row-origin");
      // 拖到 cdir 行中心
      const tx = c.left + 60, ty = c.top + c.height / 2;
      window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: tx, clientY: ty, pointerId: 1 }));
      await new Promise((r) => setTimeout(r, 60));
      const ghostLayers = document.querySelectorAll(".file-drag-ghost-layer").length;
      const srcDim = aRow.classList.contains("file-row-origin");
      const liftCleared = !aRow.classList.contains("file-row-armed");
      const caption = document.querySelector(".file-drag-caption")?.textContent ?? null;
      const captionShown = document.querySelector(".file-drag-caption")?.style.display !== "none";
      const targetDir = fileDrag.target?.dir ?? null;
      window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: tx, clientY: ty, pointerId: 1 }));
      await new Promise((r) => setTimeout(r, 300));
      return { earlyPhase, waitPhase, armed, armedLift, armedGhost, armedDim, ghostLayers, srcDim, liftCleared, caption, captionShown, targetDir, renames: S.renames.slice(), phaseAfter: fileDrag.phase, ghostGone: !document.querySelector(".file-drag-ghost") };
    })()
  `);
  console.log("单选拖拽:", JSON.stringify(drag1));
  assert("亚阈值移动保持长按计时", drag1.earlyPhase === "holding");
  assert("等待期无武装动画", drag1.waitPhase === false);
  assert("长按 400ms 武装", drag1.armed === "dragging");
  assert("武装仅行微抬（无 ghost/变暗）", drag1.armedLift === true && drag1.armedGhost === false && drag1.armedDim === false);
  assert("移动后 ghost 单快照", drag1.ghostLayers === 1);
  assert("移动后源行淡化 0.8", drag1.srcDim === true && drag1.liftCleared === true);
  assert("caption = 移动到 cdir", drag1.caption === "移动到 cdir" && drag1.captionShown);
  assert("命中 /cdir", drag1.targetDir === "/cdir");
  assert("落点执行 ssh_rename", JSON.stringify(drag1.renames) === JSON.stringify([["/a.txt", "/cdir/a.txt"]]));
  assert("会话收尾干净", drag1.phaseAfter === "idle" && drag1.ghostGone);

  // 3. 多选双快照 + Ctrl 复制（ssh_exec cp -a）
  const drag2 = await evalJs(cdp, `
    (async () => {
      const { useExplorer } = await import("/src/stores/explorer.ts");
      const { useWorkspaceStore } = await import("/src/stores/workspace.ts");
      const fdUrl = performance.getEntriesByType("resource").map((r) => r.name).find((n) => n.includes("/src/utils/fileDrag")) ?? "/src/utils/fileDrag.ts";
      const { fileDrag } = await import(fdUrl);
      const S = window.__mock;
      S.renames.length = 0; S.execs.length = 0;
      const ex = useExplorer(useWorkspaceStore().activePaneId);
      ex.selectedNames = new Set(["a.txt", "b.txt"]);
      const aRow = document.querySelector('[data-row="a.txt"]');
      const cRow = document.querySelector('[data-row="cdir"]');
      const a = aRow.getBoundingClientRect();
      const c = cRow.getBoundingClientRect();
      const startX = a.left + 60, startY = a.top + a.height / 2;
      aRow.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, clientX: startX, clientY: startY, pointerId: 2, isPrimary: true }));
      await new Promise((r) => setTimeout(r, 520));
      const tx = c.left + 60, ty = c.top + c.height / 2;
      window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: startX + 20, clientY: startY, pointerId: 2 }));
      window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: tx, clientY: ty, ctrlKey: true, pointerId: 2 }));
      await new Promise((r) => setTimeout(r, 60));
      const layers = document.querySelectorAll(".file-drag-ghost-layer").length;
      const caption = document.querySelector(".file-drag-caption")?.textContent ?? null;
      const mode = fileDrag.mode;
      window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: tx, clientY: ty, ctrlKey: true, pointerId: 2 }));
      await new Promise((r) => setTimeout(r, 300));
      return { layers, caption, mode, execs: S.execs.slice(), renames: S.renames.slice() };
    })()
  `);
  console.log("多选+Ctrl:", JSON.stringify(drag2));
  assert("多选 ghost 两层快照", drag2.layers === 2);
  assert("Ctrl caption = 复制到 cdir", drag2.caption === "复制到 cdir");
  assert("模式 = copy", drag2.mode === "copy");
  assert("执行 cp -a", drag2.execs.length === 2 && drag2.execs.every((e) => e[0] === "cp" && e[1] === "-a"));
  assert("copy 不走 rename", drag2.renames.length === 0);

  // 4. 快速拖动（不长按）回落为框选，不产生拖拽会话
  const rubber = await evalJs(cdp, `
    (async () => {
      const { useExplorer } = await import("/src/stores/explorer.ts");
      const { useWorkspaceStore } = await import("/src/stores/workspace.ts");
      const ex = useExplorer(useWorkspaceStore().activePaneId);
      ex.selectedNames = new Set(["a.txt"]);
      const container = document.querySelector("[data-drop-kind='blank']");
      // 排序目录优先：cdir 在首行，b.txt 是末行；从其下方真空白起步向上扫过全部三行
      const bRow = document.querySelector('[data-row="b.txt"]');
      const r = bRow.getBoundingClientRect();
      const x1 = r.left + 40, y1 = r.bottom + 8;
      const y2 = y1 - 90;
      container.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, clientX: x1, clientY: y1, pointerId: 3, isPrimary: true }));
      window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: x1, clientY: y2, pointerId: 3 }));
      await new Promise((res) => setTimeout(res, 100));
      const selected = [...ex.selectedNames];
      window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: x1, clientY: y2, pointerId: 3 }));
      await new Promise((res) => setTimeout(res, 50));
      return { selected, ghostAbsent: !document.querySelector(".file-drag-ghost") };
    })()
  `);
  console.log("快速拖动框选:", JSON.stringify(rubber));
  assert("未长按仍是框选（向上扫过三行并替换选择）",
    rubber.selected.length === 3 && rubber.selected.includes("cdir") && rubber.ghostAbsent);

  // 5b. 从文件夹行起拖多选（scope 修复回归）+ Escape 取消
  const folderStart = await evalJs(cdp, `
    (async () => {
      const { useExplorer } = await import("/src/stores/explorer.ts");
      const { useWorkspaceStore } = await import("/src/stores/workspace.ts");
      const fdUrl = performance.getEntriesByType("resource").map((r) => r.name).find((n) => n.includes("/src/utils/fileDrag")) ?? "/src/utils/fileDrag.ts";
      const { fileDrag } = await import(fdUrl);
      const ex = useExplorer(useWorkspaceStore().activePaneId);
      ex.selectedNames = new Set(["a.txt", "cdir"]);
      const cRow = document.querySelector('[data-row="cdir"]');
      const c = cRow.getBoundingClientRect();
      cRow.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, clientX: c.left + 60, clientY: c.top + c.height / 2, pointerId: 5, isPrimary: true }));
      await new Promise((r) => setTimeout(r, 520));
      window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: c.left + 90, clientY: c.top + c.height / 2, pointerId: 5 }));
      await new Promise((r) => setTimeout(r, 60));
      const layers = document.querySelectorAll(".file-drag-ghost-layer").length;
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await new Promise((r) => setTimeout(r, 60));
      return { layers, phase: fileDrag.phase, ghostGone: !document.querySelector(".file-drag-ghost"), cwd: ex.cwd };
    })()
  `);
  console.log("文件夹行起拖+Esc:", JSON.stringify(folderStart));
  assert("文件夹行起拖多选 ghost 两层", folderStart.layers === 2);
  assert("Escape 取消会话", folderStart.phase === "idle" && folderStart.ghostGone && folderStart.cwd === "/");

  // 6. 悬停文件夹 1300ms 自动进入（HoverToOpenTimespan）
  const hover = await evalJs(cdp, `
    (async () => {
      const { useExplorer } = await import("/src/stores/explorer.ts");
      const { useWorkspaceStore } = await import("/src/stores/workspace.ts");
      const fdUrl = performance.getEntriesByType("resource").map((r) => r.name).find((n) => n.includes("/src/utils/fileDrag")) ?? "/src/utils/fileDrag.ts";
      const { fileDrag } = await import(fdUrl);
      const ex = useExplorer(useWorkspaceStore().activePaneId);
      ex.selectedNames = new Set(["a.txt"]);
      const before = ex.cwd;
      const aRow = document.querySelector('[data-row="a.txt"]');
      const cRow = document.querySelector('[data-row="cdir"]');
      const a = aRow.getBoundingClientRect();
      const c = cRow.getBoundingClientRect();
      aRow.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, clientX: a.left + 60, clientY: a.top + a.height / 2, pointerId: 4, isPrimary: true }));
      await new Promise((r) => setTimeout(r, 480));
      const phase = fileDrag.phase;
      const tx = c.left + 60, ty = c.top + c.height / 2;
      window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: tx, clientY: ty, pointerId: 4 }));
      await new Promise((r) => setTimeout(r, 80));
      const layers = document.querySelectorAll(".file-drag-ghost-layer").length;
      const caption = document.querySelector(".file-drag-caption")?.textContent ?? null;
      const targetNow = fileDrag.target ? { kind: fileDrag.target.kind, dir: fileDrag.target.dir } : null;
      const atPoint = document.elementFromPoint(tx, ty)?.outerHTML?.slice(0, 120) ?? null;
      await new Promise((r) => setTimeout(r, 1450));
      const cwd = ex.cwd;
      window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: tx, clientY: ty, pointerId: 4 }));
      await new Promise((r) => setTimeout(r, 100));
      return { before, phase, layers, caption, targetNow, atPoint, cwd, errs: window.__errs.slice(-3) };
    })()
  `);
  console.log("悬停自动进入:", JSON.stringify(hover));
  assert("悬停前已武装且命中 cdir", hover.phase === "dragging" && hover.layers >= 1 && hover.caption === "移动到 cdir");
  assert("悬停 1300ms 进入 cdir", hover.before === "/" && hover.cwd === "/cdir");

  ws.close(); edge.kill(); vite.kill();
  console.log(failures ? `\n${failures} 项失败` : "\n全部通过");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error("异常:", e); process.exit(1); });
