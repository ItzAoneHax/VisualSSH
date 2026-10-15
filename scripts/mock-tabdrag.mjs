/**
 * 标签拖拽重排 + 直角熔接回归（vite dev + Edge headless CDP）：mock 进工作区 →
 * 开 3 个标签 → 断言：
 *  ① 首标签左缘与工具条卡左缘对齐；首标签选中时卡片顶左角转直角 + 熔接线左侧无段；
 *  ② 指针拖拽：ghost 浮起、原位转不可见占位、live 重排（FLIP 滑动）、松手落位收尾干净；
 *  ③ 拖拽结束短窗内 click 不误激活；Escape 取消还原原序；
 *  ④ 非首标签选中：卡片顶左角保持 8px 圆角、熔接线左段自 8px 起、缺口两侧 T 型对接。
 * 运行：node scripts/mock-tabdrag.mjs（截图写入 %TEMP%\vssh-tabshots 供目检）
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const VITE_PORT = 4274;
const CDP_PORT = 9339;
const APP_URL = `http://127.0.0.1:${VITE_PORT}/`;
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const SHOT_DIR = join(process.env.TEMP, "vssh-tabshots");

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
const S = (window.__mock = { handlers: new Map(), cbSeq: 1 });
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
      if (args.path === "/cdir") return [];
      return FILES;
    }
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

/** 指针拖标签的合成事件序列（按下 → 越阈值起拖 → 移到目标 x） */
const DRAG_HELPER = String.raw`
  window.__dragTab = async (tabEl, fromX, fromY, toX, opt = {}) => {
    tabEl.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, clientX: fromX, clientY: fromY, pointerId: 9, isPrimary: true }));
    window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: fromX + 10, clientY: fromY, pointerId: 9 }));
    await new Promise((r) => setTimeout(r, 60));
    window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: toX, clientY: fromY, pointerId: 9 }));
  };
  window.__endTabDrag = (x, y) =>
    window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: x, clientY: y, pointerId: 9 }));
  window.__escTabDrag = () =>
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
`;

async function shot(cdp, name) {
  const res = await cdp.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(SHOT_DIR, name), Buffer.from(res.data, "base64"));
  console.log(`  shot → ${join(SHOT_DIR, name)}`);
}

async function main() {
  mkdirSync(SHOT_DIR, { recursive: true });
  const vite = spawn("npx", ["vite", "--port", `${VITE_PORT}`, "--strictPort"], {
    shell: true,
    stdio: "ignore",
  });
  await waitHttp(APP_URL);
  const edge = spawn(EDGE, [
    "--headless=new", "--no-first-run", "--disable-gpu", "--window-size=1440,900",
    `--user-data-dir=${process.env.TEMP}\\vssh-tabdrag-profile`,
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

  // 1. 进工作区并开满 3 个标签，激活第一个
  const setup = await evalJs(cdp, `
    (async () => {
      const { useConnectionsStore } = await import("/src/stores/connections.ts");
      const { useWorkspaceStore } = await import("/src/stores/workspace.ts");
      const conn = useConnectionsStore();
      const fake = { connectionId: "c1", alias: "mock", profile: { id: "p1", alias: "mock", host: "h", port: 22, username: "u", authMethod: "password", createdAt: 0 }, rootPath: "/", latencyMs: 3 };
      conn.byId = { c1: fake };
      conn.active = fake;
      await new Promise((r) => setTimeout(r, 1200));
      const ws = useWorkspaceStore();
      while (ws.tabs.length < 3) {
        const t = ws.openTab("c1", "p1", "mock");
        ws.initPane(t.activePaneId, "c1", "/", "p1");
      }
      ws.activateTab(ws.tabs[0].id);
      await new Promise((r) => setTimeout(r, 600));
      ${DRAG_HELPER}
      return {
        ids: ws.tabs.map((t) => t.id),
        active: ws.activeTabId,
        rows: document.querySelectorAll("[data-row]").length,
      };
    })()
  `);
  console.log("工作区:", JSON.stringify(setup));
  const [A, B, C] = setup.ids;
  assert("3 个标签就绪", setup.ids.length === 3);
  assert("首标签激活", setup.active === A);
  assert("文件行已渲染", setup.rows === 3);

  // 2. 首标签几何：对齐 + 顶左角直角 + 熔接线左端无段
  const geo1 = await evalJs(cdp, `
    (() => {
      const tab = document.querySelector("[data-tab-id]");
      const card = document.querySelector("[data-toolbar-card]");
      const fusion = document.querySelector("[data-fusion-line]");
      const t = tab.getBoundingClientRect();
      const c = card.getBoundingClientRect();
      const bg = getComputedStyle(fusion).backgroundImage;
      // 解析首个非 transparent 色标的位置（px）
      const stops = [...bg.matchAll(/(rgba?\\([^)]*\\)|transparent) ([0-9.]+)px/g)]
        .filter((m) => !m[1].includes("0, 0, 0, 0"));
      return {
        tabLeft: t.left, cardLeft: c.left,
        corner: getComputedStyle(card).borderTopLeftRadius,
        fusion: bg, firstColorStop: stops[0]?.[2] ?? null,
        tabWidth: t.width,
        arcs: document.querySelectorAll("[data-fusion-line] svg").length,
        tabSvgs: document.querySelectorAll("[data-active-tab] svg").length,
      };
    })()
  `);
  console.log("首标签几何:", JSON.stringify(geo1));
  assert("首标签左缘与卡片左缘对齐", Math.abs(geo1.tabLeft - geo1.cardLeft) < 0.5, `${geo1.tabLeft} vs ${geo1.cardLeft}`);
  assert("首标签选中卡片顶左角 = 直角", geo1.corner === "0px", geo1.corner);
  assert(
    "熔接线左侧无段（首个色标 = 标签右缘+4 凹弧切线段）",
    geo1.firstColorStop !== null && Math.abs(Number(geo1.firstColorStop) - (geo1.tabWidth + 4)) < 1.5,
    `首个色标 ${geo1.firstColorStop}，标签宽 ${geo1.tabWidth}`,
  );
  assert("顶角圆弧数 = 1（首标签直角无左弧，仅右弧）", geo1.arcs === 1, geo1.arcs);
  assert("首标签左侧豁免：标签内 SVG = 5（无左凹弧：2 顶角 + 1 右凹弧 + 2 图标）", geo1.tabSvgs === 5, geo1.tabSvgs);
  await shot(cdp, "1-first-tab-active.png");

  // 3. 拖 A 到末位：ghost/不可见占位/live 重排/FLIP/收尾
  const drag1 = await evalJs(cdp, `
    (async () => {
      const { useWorkspaceStore } = await import("/src/stores/workspace.ts");
      const ws = useWorkspaceStore();
      const els = () => [...document.querySelectorAll("[data-tab-id]:not(.tab-drag-ghost)")];
      const a0 = els()[0].getBoundingClientRect();
      const startX = a0.left + 20, y = a0.top + 16;
      els()[0].dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, clientX: startX, clientY: y, pointerId: 9, isPrimary: true }));
      window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: startX + 10, clientY: y, pointerId: 9 }));
      await new Promise((r) => setTimeout(r, 60));
      const lifted = {
        ghost: !!document.querySelector(".tab-drag-ghost"),
        ghostWidth: document.querySelector(".tab-drag-ghost")?.getBoundingClientRect().width ?? 0,
        originInvisible: els()[0].classList.contains("invisible"),
        bodyClass: document.body.classList.contains("tab-dragging"),
      };
      const c0 = els().at(-1).getBoundingClientRect();
      window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: c0.left + c0.width / 2 + 6, clientY: y, pointerId: 9 }));
      await new Promise((r) => setTimeout(r, 40));
      const midFlip = els().some((el) => el.getAnimations().length > 0);
      await new Promise((r) => setTimeout(r, 320));
      const orderMid = ws.tabs.map((t) => t.id);
      const domMid = els().map((el) => el.dataset.tabId);
      window.__lastX = c0.left + c0.width / 2 + 6; window.__lastY = y;
      window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: window.__lastX, clientY: y, pointerId: 9 }));
      await new Promise((r) => setTimeout(r, 120));
      return {
        ...lifted, midFlip, orderMid, domMid,
        ghostGone: !document.querySelector(".tab-drag-ghost"),
        visibleAgain: els().every((el) => !el.classList.contains("invisible")),
        bodyClean: !document.body.classList.contains("tab-dragging"),
        orderAfter: ws.tabs.map((t) => t.id),
        activeStill: ws.activeTabId,
      };
    })()
  `);
  console.log("拖 A 到末位:", JSON.stringify(drag1));
  assert("ghost 浮起", drag1.ghost && Math.abs(drag1.ghostWidth - 110) < 40, `宽 ${drag1.ghostWidth}`);
  assert("原位转不可见占位", drag1.originInvisible);
  assert("body.tab-dragging 置位", drag1.bodyClass);
  assert("live 重排 = [B,C,A]", JSON.stringify(drag1.orderMid) === JSON.stringify([B, C, A]), drag1.orderMid.join(","));
  assert("DOM 序随 store", JSON.stringify(drag1.domMid) === JSON.stringify([B, C, A]));
  assert("FLIP 滑动动画进行", drag1.midFlip);
  assert("松手收尾干净", drag1.ghostGone && drag1.visibleAgain && drag1.bodyClean);
  assert("落位保持 [B,C,A]", JSON.stringify(drag1.orderAfter) === JSON.stringify([B, C, A]));
  assert("拖拽不改激活", drag1.activeStill === A);

  // 4. 拖拽结束短窗 click 不误激活（先激活 B，再拖 A 后立即 click A）
  const clickGuard = await evalJs(cdp, `
    (async () => {
      const { useWorkspaceStore } = await import("/src/stores/workspace.ts");
      const ws = useWorkspaceStore();
      ws.activateTab(${JSON.stringify(B)});
      await new Promise((r) => setTimeout(r, 80));
      const els = () => [...document.querySelectorAll("[data-tab-id]:not(.tab-drag-ghost)")];
      const aEl = els().at(-1);
      const r0 = aEl.getBoundingClientRect();
      const bW = els()[0].getBoundingClientRect().width;
      const startX = r0.left + 20, y = r0.top + 16;
      aEl.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, clientX: startX, clientY: y, pointerId: 9, isPrimary: true }));
      window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: startX + 10, clientY: y, pointerId: 9 }));
      await new Promise((r) => setTimeout(r, 60));
      // bug2 回归：拖非激活标签时，激活（首）标签的熔接保持——直角 + 缺口签名
      const card = document.querySelector("[data-toolbar-card]");
      const fusionBg = getComputedStyle(document.querySelector("[data-fusion-line]")).backgroundImage;
      const stops = [...fusionBg.matchAll(/(rgba?\\([^)]*\\)|transparent) ([0-9.]+)px/g)]
        .filter((m) => !m[1].includes("0, 0, 0, 0"));
      const duringDrag = { corner: getComputedStyle(card).borderTopLeftRadius, stop: stops[0]?.[2] ?? null };
      window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: startX + 10, clientY: y, pointerId: 9 }));
      aEl.click();
      await new Promise((r) => setTimeout(r, 60));
      return { active: ws.activeTabId, order: ws.tabs.map((t) => t.id), duringDrag, bW };
    })()
  `);
  assert("拖后短窗 click 不激活", clickGuard.active === B, clickGuard.active);
  assert("拖非激活标签：激活（首）标签直角保持", clickGuard.duringDrag.corner === "0px", clickGuard.duringDrag.corner);
  assert(
    "拖非激活标签：激活标签缺口保持（熔接未断）",
    clickGuard.duringDrag.stop !== null && Math.abs(Number(clickGuard.duringDrag.stop) - (clickGuard.bW + 4)) < 1.5,
    `${clickGuard.duringDrag.stop} vs 首标签宽+4 ${clickGuard.bW + 4}`,
  );

  // 5. Escape 取消还原：拖 A（末位）到首位后按 Esc
  const esc = await evalJs(cdp, `
    (async () => {
      const { useWorkspaceStore } = await import("/src/stores/workspace.ts");
      const ws = useWorkspaceStore();
      const before = ws.tabs.map((t) => t.id);
      const els = () => [...document.querySelectorAll("[data-tab-id]:not(.tab-drag-ghost)")];
      const aEl = els().at(-1);
      const r0 = aEl.getBoundingClientRect();
      const startX = r0.left + 20, y = r0.top + 16;
      aEl.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, clientX: startX, clientY: y, pointerId: 9, isPrimary: true }));
      const firstLeft = els()[0].getBoundingClientRect().left;
      window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: firstLeft + 30, clientY: y, pointerId: 9 }));
      await new Promise((r) => setTimeout(r, 60));
      const midOrder = ws.tabs.map((t) => t.id);
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await new Promise((r) => setTimeout(r, 120));
      return { before, midOrder, after: ws.tabs.map((t) => t.id), clean: !document.querySelector(".tab-drag-ghost") };
    })()
  `);
  assert("Escape 前已 live 左移", esc.midOrder[0] === A && esc.midOrder[2] !== A, esc.midOrder.join(","));
  assert("Escape 还原原序", JSON.stringify(esc.after) === JSON.stringify(esc.before), `${esc.after.join(",")} vs ${esc.before.join(",")}`);

  // 5b. 拖拽中的选中首标签不算完整标签：卡片恢复 8px 圆角 + 顶线连续；松手熔接恢复
  const dragFirst = await evalJs(cdp, `
    (async () => {
      const { useWorkspaceStore } = await import("/src/stores/workspace.ts");
      const ws = useWorkspaceStore();
      ws.moveTab(${JSON.stringify(A)}, 0);
      ws.activateTab(${JSON.stringify(A)});
      await new Promise((r) => setTimeout(r, 250));
      const els = () => [...document.querySelectorAll("[data-tab-id]:not(.tab-drag-ghost)")];
      const card = () => document.querySelector("[data-toolbar-card]");
      const firstStop = (bg) => [...bg.matchAll(/(rgba?\\([^)]*\\)|transparent) ([0-9.]+)px/g)]
        .filter((m) => !m[1].includes("0, 0, 0, 0"))[0]?.[2] ?? null;
      const fusionStop = () => firstStop(getComputedStyle(document.querySelector("[data-fusion-line]")).backgroundImage);
      const aEl = els()[0];
      const r0 = aEl.getBoundingClientRect();
      const tabW = r0.width;
      const startX = r0.left + 20, y = r0.top + 16;
      const arcs = () => document.querySelectorAll("[data-fusion-line] svg").length;
      const base = { corner: getComputedStyle(card()).borderTopLeftRadius, stop: fusionStop(), tabW, arcs: arcs() };
      aEl.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, clientX: startX, clientY: y, pointerId: 9, isPrimary: true }));
      // 微移 10px 起拖但不越过下一个标签中点（仍居首位）
      window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: startX + 10, clientY: y, pointerId: 9 }));
      await new Promise((r) => setTimeout(r, 120));
      const during = {
        corner: getComputedStyle(card()).borderTopLeftRadius,
        stop: fusionStop(),
        arcs: arcs(),
        orderUnchanged: ws.tabs.map((t) => t.id)[0] === ${JSON.stringify(A)},
        placeholderInvisible: els()[0].classList.contains("invisible"),
      };
      window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: startX + 10, clientY: y, pointerId: 9 }));
      await new Promise((r) => setTimeout(r, 160));
      const after = { corner: getComputedStyle(card()).borderTopLeftRadius, stop: fusionStop(), arcs: arcs() };
      return { base, during, after };
    })()
  `);
  console.log("拖拽中首标签:", JSON.stringify(dragFirst));
  assert("基线：首标签选中顶左角 = 直角", dragFirst.base.corner === "0px", dragFirst.base.corner);
  assert("拖拽中卡片恢复 8px 圆角", dragFirst.during.corner === "8px", dragFirst.during.corner);
  assert("拖拽中顶线恢复连续（左段自 8px 起）", dragFirst.during.stop === "8", dragFirst.during.stop);
  assert("拖拽中原位占位不可见", dragFirst.during.placeholderInvisible);
  assert("微移未改顺序（仍居首位）", dragFirst.during.orderUnchanged);
  assert("松手熔接恢复直角", dragFirst.after.corner === "0px", dragFirst.after.corner);
  assert("拖拽中顶角圆弧齐全（2 个）", dragFirst.during.arcs === 2, dragFirst.during.arcs);
  assert("松手顶角圆弧恢复（左弧隐，1 个）", dragFirst.after.arcs === 1, dragFirst.after.arcs);
  assert(
    "松手顶线恢复缺口签名",
    dragFirst.after.stop !== null && Math.abs(Number(dragFirst.after.stop) - (dragFirst.base.tabW + 4)) < 1.5,
    `${dragFirst.after.stop} vs 标签宽+4 ${dragFirst.base.tabW + 4}`,
  );

  // 6. 非首标签选中：卡片顶左角 8px 圆角 + 熔接线左段自 8px 起 + 对齐不变
  const geo2 = await evalJs(cdp, `
    (async () => {
      const { useWorkspaceStore } = await import("/src/stores/workspace.ts");
      const ws = useWorkspaceStore();
      // 当前序 [A,B,C]（5b 归位后），激活非首的 C
      ws.activateTab(${JSON.stringify(C)});
      await new Promise((r) => setTimeout(r, 200));
      const els = [...document.querySelectorAll("[data-tab-id]:not(.tab-drag-ghost)")];
      const first = els[0].getBoundingClientRect();
      const card = document.querySelector("[data-toolbar-card]").getBoundingClientRect();
      const fusion = document.querySelector("[data-fusion-line]");
      const bg = getComputedStyle(fusion).backgroundImage;
      const stops = [...bg.matchAll(/(rgba?\\([^)]*\\)|transparent) ([0-9.]+)px/g)]
        .filter((m) => !m[1].includes("0, 0, 0, 0"));
      const activeTab = els.find((el) => el.dataset.activeTab !== undefined).getBoundingClientRect();
      return {
        corner: getComputedStyle(document.querySelector("[data-toolbar-card]")).borderTopLeftRadius,
        firstColorStop: stops[0]?.[2] ?? null,
        tabLeft: first.left, cardLeft: card.left,
        gapStart: stops[1]?.[2] ?? null, gapEnd: stops[2]?.[2] ?? null,
        activeLeft: activeTab.left, activeRight: activeTab.right,
        arcs: document.querySelectorAll("[data-fusion-line] svg").length,
        tabSvgs: document.querySelectorAll("[data-active-tab] svg").length,
      };
    })()
  `);
  console.log("中位标签几何:", JSON.stringify(geo2));
  assert("非首标签卡片顶左角 = 8px", geo2.corner === "8px", geo2.corner);
  assert("顶角圆弧齐全（2 个）", geo2.arcs === 2, geo2.arcs);
  assert("非首标签：标签内 SVG = 6（左右凹弧齐全 + 2 图标）", geo2.tabSvgs === 6, geo2.tabSvgs);
  assert("熔接线左段自 8px 起", Number(geo2.firstColorStop) === 8, geo2.firstColorStop);
  assert("首标签对齐不随激活变化", Math.abs(geo2.tabLeft - geo2.cardLeft) < 0.5);
  assert(
    "缺口 = 激活标签矩形 ±4（凹弧切线段）",
    Math.abs(Number(geo2.gapStart) - (geo2.activeLeft - geo2.cardLeft - 4)) < 1.5 &&
      Math.abs(Number(geo2.gapEnd) - (geo2.activeRight - geo2.cardLeft + 4)) < 1.5,
    `缺口 [${geo2.gapStart}, ${geo2.gapEnd}]，标签 [${geo2.activeLeft - geo2.cardLeft}, ${geo2.activeRight - geo2.cardLeft}]`,
  );
  await shot(cdp, "2-mid-tab-active.png");

  // 7. 拖拽中截图（ghost + 让位空档）+ 控制台无错
  await evalJs(cdp, `
    (async () => {
      const els = [...document.querySelectorAll("[data-tab-id]:not(.tab-drag-ghost)")];
      const r = els[els.length - 1].getBoundingClientRect();
      els[els.length - 1].dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, clientX: r.left + 20, clientY: r.top + 16, pointerId: 9, isPrimary: true }));
      window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: r.left + 20 - 140, clientY: r.top + 16, pointerId: 9 }));
      await new Promise((r2) => setTimeout(r2, 300));
    })()
  `);
  await shot(cdp, "3-mid-drag.png");
  await evalJs(cdp, `
    window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: 300, clientY: 60, pointerId: 9 }))
  `);
  const errs = await evalJs(cdp, `window.__errs.slice()`);
  assert("无控制台错误", errs.length === 0, errs.join(" | "));

  ws.close(); edge.kill(); vite.kill();
  console.log(failures ? `\n${failures} 项失败` : "\n全部通过");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error("异常:", e); process.exit(1); });
