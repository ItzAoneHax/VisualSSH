/**
 * 第五阶段 mock 自查（vite dev 4274 + Edge headless CDP，注入 __TAURI_INTERNALS__）：
 * A InfoPane 判别链/缓存命中/tab 记忆/窄窗位置切换；B 缩略图视口优先/并发上限/失败回退；
 * C 能力探测/smart 判定/ZipSlip 拒绝/压缩卡终态；D 输入即定位与让位/scp 菜单。
 * 运行：node scripts/mock-check5.mjs
 */
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const VITE_PORT = 4274;
const CDP_PORT = 9334;
const APP_URL = `http://127.0.0.1:${VITE_PORT}/`;
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

let failures = 0;
const results = [];
function ok(label) {
  results.push(`  ok  ${label}`);
  console.log(`  ok  ${label}`);
}
function fail(label, err) {
  failures += 1;
  const msg = String(err).split("\n")[0];
  results.push(`  FAIL ${label} — ${msg}`);
  console.error(`  FAIL ${label} — ${msg}`);
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
    this.consoleErrors = [];
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.method === "Runtime.consoleAPICalled" &&
          ["error", "warning"].includes(msg.params.type)) {
        const text = msg.params.args.map((a) => a.value ?? a.description ?? "").join(" ");
        this.consoleErrors.push(text.slice(0, 300));
      }
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

async function main() {
  const vite = spawn("npx", ["vite", "--port", `${VITE_PORT}`, "--strictPort"], {
    shell: true,
    stdio: "ignore",
  });
  await waitHttp(APP_URL);
  console.log("vite dev server ready");

  const edge = spawn(
    EDGE,
    [
      "--headless=new",
      "--no-first-run",
      "--disable-gpu",
      "--window-size=1440,900",
      `--user-data-dir=${process.env.TEMP}\\vssh-mock5-${Date.now()}`,
      `--remote-debugging-port=${CDP_PORT}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  await waitHttp(`http://127.0.0.1:${CDP_PORT}/json/version`, 60000);
  const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  const page = targets.find((t) => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", reject);
  });
  const cdp = new Cdp(ws);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");

  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: buildMockSource(),
  });

  await cdp.send("Page.navigate", { url: APP_URL });
  await sleep(2500);

  const cases = [
    ["环境与应用就绪", caseReady],
    ["A: 判别链分支与缓存命中/tab 记忆", caseInfoPane],
    ["A: 窄窗位置切换（右→底）", caseInfoPanePosition],
    ["B: 缩略图视口优先/并发上限/失败回退", caseThumbs],
    ["C: 能力探测 + smart 判定 + ZipSlip 拒绝 + 压缩卡", caseArchives],
    ["D: 输入即定位与让位 + scp 菜单", caseTypeAhead],
  ];
  for (const [label, fn] of cases) {
    try {
      await fn(cdp);
      ok(label);
    } catch (e) {
      fail(label, e.message ?? e);
    }
  }

  console.log(`\n${results.length - failures}/${results.length} 通过`);
  ws.close();
  edge.kill();
  vite.kill();
  process.exit(failures ? 1 : 0);
}

/** 1×1 PNG（base64） */
const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function buildMockSource() {
  return String.raw`
  window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 16);

  // 清掉上一轮运行遗留的持久化状态（会话目录记忆/设置缓存），保证用例确定性
  try {
    localStorage.removeItem("visualssh:session:v1");
    localStorage.removeItem("visualssh:settings:v1");
    localStorage.removeItem("visualssh:search-history:v1");
  } catch {}

  window.__errors = [];
  window.addEventListener("error", (e) => window.__errors.push(String(e.message)));
  window.addEventListener("unhandledrejection", (e) => window.__errors.push(String(e.reason)));

  const S = (window.__mock = {
    handlers: new Map(),
    cbSeq: 1,
    calls: {},
    listDirByPath: {},
    listDirCalls: {},
    readB64Calls: [],
    readB64Fail: new Set(),
    readB64Delay: 50,
    readB64InFlight: 0,
    readB64MaxConcurrent: 0,
    readTextByPath: {},
    readTextCalls: [],
    probeOut: "tar\nzip\nunzip\ngzip\n",
    tarListing: "",
    zipListing: "",
    mkdirCalls: [],
    archiveStarts: [],
    archiveOk: true,
    clipboard: null,
  });

  function emit(event, payload) {
    const handlers = S.handlers.get(event) ?? [];
    for (const hid of handlers) {
      const cb = window["_" + hid];
      if (cb) cb({ event, id: S.cbSeq++, payload });
    }
  }

  try {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: (t) => { S.clipboard = t; return Promise.resolve(); } },
    });
  } catch {}

  async function invoke(cmd, args = {}) {
    S.calls[cmd] = (S.calls[cmd] ?? 0) + 1;
    switch (cmd) {
      case "plugin:event|listen": {
        const { event, handler } = args;
        if (!S.handlers.has(event)) S.handlers.set(event, new Set());
        S.handlers.get(event).add(handler);
        return handler;
      }
      case "plugin:event|unlisten": return null;
      case "ssh_connect":
        return { connectionId: "cid-1", rootPath: "/root", latencyMs: 3 };
      case "ssh_list_dir": {
        S.listDirCalls[args.path] = (S.listDirCalls[args.path] ?? 0) + 1;
        // 返回副本：与真实后端一致（每次反序列化新数组），同引用回写不触发响应式
        return (S.listDirByPath[args.path] ?? []).map((e) => ({ ...e }));
      }
      case "ssh_read_file_base64": {
        S.readB64Calls.push(args.path);
        if (S.readB64Fail.has(args.path)) throw new Error("mock read fail: " + args.path);
        S.readB64InFlight++;
        S.readB64MaxConcurrent = Math.max(S.readB64MaxConcurrent, S.readB64InFlight);
        await new Promise((r) => setTimeout(r, S.readB64Delay));
        S.readB64InFlight--;
        return "${TINY_PNG}";
      }
      case "ssh_read_file": {
        S.readTextCalls.push(args.path);
        const text = S.readTextByPath[args.path];
        if (text === undefined) throw new Error(args.path + " 不是 UTF-8 文本，无法预览");
        return text;
      }
      case "ssh_exec": {
        const line = (args.args ?? []).join(" ");
        if (args.program === "sh") return { stdout: S.probeOut, stderr: "", exitCode: 0 };
        if (line.includes("-Z1")) return { stdout: S.zipListing, stderr: "", exitCode: 0 };
        if (/t[zjJ]?f/.test(line)) return { stdout: S.tarListing, stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      case "ssh_mkdir": { S.mkdirCalls.push(args.path); return null; }
      case "ssh_archive_start": { S.archiveStarts.push(args); return null; }
      case "ssh_archive_cancel": return true;
      case "ssh_stat": return { kind: "file", size: 1 };
      case "ssh_fs_info": return null;
      case "credential_get": return "mock-secret";
      case "plugin:dialog|save": return "C:\\dst\\saved.bin";
      case "plugin:dialog|open": return "C:\\dst";
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
  window.__mock.ready = true;
  `;
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

const ENTRY = (name, kind, size, mtime = 100) =>
  `({ name: ${JSON.stringify(name)}, kind: ${JSON.stringify(kind)}, size: ${size}, permissions: "-rw-r--r--", mtime: ${mtime}, owner: "u", group: "g", atime: null })`;

async function caseReady(cdp) {
  const ready = await evalJs(cdp, `window.__mock?.ready ?? false`);
  if (!ready) throw new Error("mock 未注入");
  await evalJs(cdp, `
    (async () => {
      const { useConnectionsStore } = await import("/src/stores/connections.ts");
      const conn = useConnectionsStore();
      if (conn.active) return true;
      await conn.connect({ id: "p1", alias: "mock", host: "h", port: 22, username: "u", authMethod: "password", createdAt: 0 });
      if (!conn.active) throw new Error("connect 失败");
      return true;
    })()
  `);
  // 连接后 App 切到工作区视图（Workspace 挂载并初始化窗格）——重渲染异步，轮询等待
  const deadline = Date.now() + 10000;
  let paneReady = null;
  while (Date.now() < deadline) {
    paneReady = await evalJs(cdp, `
      (async () => {
        const { useWorkspaceStore } = await import("/src/stores/workspace.ts");
        const ws = useWorkspaceStore();
        return { tabs: ws.tabs.length, paneId: ws.activePaneId };
      })()
    `);
    if (paneReady.paneId) break;
    await sleep(300);
  }
  if (!paneReady?.paneId) throw new Error("workspace 未初始化");
  await sleep(800);
}

/** 进入 /data 目录（含缩略图用图片行），开启信息窗格 + 预览 tab */
async function setupDataDir(cdp) {
  const setup = await evalJs(cdp, `
    (async () => {
      const { useWorkspaceStore } = await import("/src/stores/workspace.ts");
      const { useExplorer } = await import("/src/stores/explorer.ts");
      const { useSettingsStore } = await import("/src/stores/settings.ts");
      const S = window.__mock;
      const ws = useWorkspaceStore();
      const ex = useExplorer(ws.activePaneId);
      S.listDirByPath["/data"] = [
        ${ENTRY("sub", "dir", 0)},
        ${ENTRY("a.png", "file", 1234)},
        ${ENTRY("b.png", "file", 1234)},
        ${ENTRY("r.md", "file", 30)},
        ${ENTRY("note.txt", "file", 20)},
        ${ENTRY("app.exe", "file", 999)},
        ${ENTRY("apple.txt", "file", 5)},
        ${ENTRY("banana.txt", "file", 6)},
        ${ENTRY("cherry.md", "file", 7)},
      ];
      S.readTextByPath["/data/r.md"] = "# 标题\\n\\n正文";
      S.readTextByPath["/data/note.txt"] = "hello world";
      S.readTextByPath["/data/cherry.md"] = "# C";
      await ex.open("/data");
      const settings = useSettingsStore();
      const n1 = ex.entries.length;
      // A 用例关闭缩略图：隔离预览读取计数（缩略图与预览是两套独立缓存，同图各读一次）
      settings.update({ infoPaneEnabled: true, infoPaneTab: "preview", showThumbnails: false });
      const n2 = ex.entries.length;
      await new Promise((r) => setTimeout(r, 100));
      const n3 = ex.entries.length;
      return { cwd: ex.cwd, n1, n2, n3 };
    })()
  `);
  if (process.env.MOCK_DEBUG) console.log("DEBUG immediate:", JSON.stringify(setup));
  await sleep(400);
  if (process.env.MOCK_DEBUG) {
    const dump = await evalJs(cdp, `
      (async () => {
        const { useWorkspaceStore } = await import("/src/stores/workspace.ts");
        const { useExplorer } = await import("/src/stores/explorer.ts");
        const S = window.__mock;
        const ex = useExplorer(useWorkspaceStore().activePaneId);
        return {
          cwd: ex.cwd,
          cid: ex.connectionId,
          err: ex.error,
          loading: ex.loading,
          listDirCalls: S.listDirCalls,
          mockData: (S.listDirByPath["/data"] ?? []).map((e) => e.name),
          entries: ex.entries.map((e) => e.name),
          rows: document.querySelectorAll("[data-row]").length,
          pane: !!document.querySelector('[aria-label="信息窗格"]'),
        };
      })()
    `);
    console.log("DEBUG setupDataDir:", JSON.stringify(dump));
  }
}

async function caseInfoPane(cdp) {
  await setupDataDir(cdp);
  const pane = `document.querySelector('[aria-label="信息窗格"]')`;
  const hasPane = await evalJs(cdp, `!!${pane}`);
  if (!hasPane) throw new Error("信息窗格未渲染");

  // ① 文件夹：提示选择文件以预览
  await evalJs(cdp, `document.querySelector('[data-row="sub"]').click()`);
  await sleep(200);
  let folderHint = await evalJs(cdp, `${pane}.textContent.includes("选择文件以预览")`);
  if (!folderHint && process.env.MOCK_DEBUG) {
    const dump = await evalJs(cdp, `
      (async () => {
        const { useWorkspaceStore } = await import("/src/stores/workspace.ts");
        const { useExplorer } = await import("/src/stores/explorer.ts");
        const ex = useExplorer(useWorkspaceStore().activePaneId);
        return {
          sel: [...ex.selectedNames],
          tab: JSON.parse(localStorage.getItem("visualssh:settings:v1") || "{}").infoPaneTab,
          paneText: document.querySelector('[aria-label="信息窗格"]')?.textContent?.slice(0, 120),
          errors: window.__errors.slice(0, 5),
          console: ${JSON.stringify(cdp.consoleErrors.slice(-5))},
        };
      })()
    `);
    console.log("DEBUG folder:", JSON.stringify(dump));
    folderHint = false;
  }
  if (!folderHint) throw new Error("文件夹分支提示缺失");

  // ② 图片：blob URL 展示；再切走再切回 = 缓存命中（不重复 invoke）
  await evalJs(cdp, `document.querySelector('[data-row="a.png"]').click()`);
  await sleep(400);
  const imgShown = await evalJs(cdp, `!!${pane}.querySelector("img")`);
  if (!imgShown) throw new Error("图片预览未渲染");
  const calls1 = await evalJs(cdp, `window.__mock.readB64Calls.filter(p => p === "/data/a.png").length`);
  if (calls1 !== 1) throw new Error("图片应恰好读取 1 次，实际 " + calls1);
  await evalJs(cdp, `document.querySelector('[data-row="note.txt"]').click()`);
  await sleep(300);
  await evalJs(cdp, `document.querySelector('[data-row="a.png"]').click()`);
  await sleep(250);
  const calls2 = await evalJs(cdp, `window.__mock.readB64Calls.filter(p => p === "/data/a.png").length`);
  if (calls2 !== 1) throw new Error("缓存命中失败：读取了 " + calls2 + " 次");
  const imgShown2 = await evalJs(cdp, `!!${pane}.querySelector("img")`);
  if (!imgShown2) throw new Error("缓存回显图片失败");

  // ③ Markdown：渲染后的标题
  await evalJs(cdp, `document.querySelector('[data-row="r.md"]').click()`);
  await sleep(350);
  const mdOk = await evalJs(cdp, `
    (() => {
      const el = ${pane}.querySelector(".md-preview h1");
      return el ? el.textContent : "";
    })()
  `);
  if (mdOk !== "标题") throw new Error("markdown 渲染异常: " + mdOk);

  // ④ 文本：CodeMirror 只读挂载
  await evalJs(cdp, `document.querySelector('[data-row="note.txt"]').click()`);
  await sleep(400);
  const cmOk = await evalJs(cdp, `!!${pane}.querySelector(".cm-editor")`);
  if (!cmOk) throw new Error("文本预览 CodeMirror 未挂载");

  // ⑤ basic：exe → 该类型暂不支持预览
  await evalJs(cdp, `document.querySelector('[data-row="app.exe"]').click()`);
  await sleep(200);
  const basicHint = await evalJs(cdp, `${pane}.textContent.includes("该类型暂不支持预览")`);
  if (!basicHint) throw new Error("basic 兜底文案缺失");

  // 二进制文本（.txt 在白名单内但 read_file 抛 UTF-8 错误）→ 兜底
  await evalJs(cdp, `
    (() => {
      const S = window.__mock;
      S.listDirByPath["/data"].push({ name: "bin.txt", kind: "file", size: 5, permissions: "-rw-r--r--", mtime: 100, owner: "u", group: "g", atime: null });
      return true;
    })()
  `);
  // 重新加载目录以出现新行（走缓存，快）
  await evalJs(cdp, `
    (async () => {
      const { useWorkspaceStore } = await import("/src/stores/workspace.ts");
      const { useExplorer } = await import("/src/stores/explorer.ts");
      const ex = useExplorer(useWorkspaceStore().activePaneId);
      await ex.reloadPreserve();
      // 等 Vue 重渲染出新行再点击
      await new Promise((r) => setTimeout(r, 120));
      const row = document.querySelector('[data-row="bin.txt"]');
      if (!row) {
        throw new Error("bin.txt 行未渲染: entries=" + ex.entries.map((e) => e.name).join(",") +
          " rows=" + document.querySelectorAll("[data-row]").length +
          " mock=" + (window.__mock.listDirByPath["/data"] ?? []).map((e) => e.name).join(","));
      }
      row.click();
      return true;
    })()
  `);
  await sleep(300);
  const binHint = await evalJs(cdp, `${pane}.textContent.includes("二进制文件")`);
  if (!binHint) throw new Error("二进制兜底文案缺失");

  // tab 记忆：详情 tab 点击 → localStorage 持久化
  await evalJs(cdp, `
    (() => {
      const btns = [...document.querySelectorAll('[aria-label="信息窗格视图"] button')];
      btns.find((b) => b.textContent.trim() === "详情")?.click();
      return true;
    })()
  `);
  await sleep(150);
  const tabPersisted = await evalJs(cdp, `
    JSON.parse(localStorage.getItem("visualssh:settings:v1")).infoPaneTab
  `);
  if (tabPersisted !== "details") throw new Error("tab 记忆失败: " + tabPersisted);
  // 切回预览（后续用例需要）
  await evalJs(cdp, `
    (() => {
      const btns = [...document.querySelectorAll('[aria-label="信息窗格视图"] button')];
      btns.find((b) => b.textContent.trim() === "预览")?.click();
      return true;
    })()
  `);
  await sleep(100);
}

async function caseInfoPanePosition(cdp) {
  // 窄窗：主行宽 < 700 → 底部（分隔条 title 变「拖拽调整高度」）
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 600, height: 900, deviceScaleFactor: 1, mobile: false,
  });
  await sleep(500);
  const bottom = await evalJs(cdp, `!!document.querySelector('[title^="拖拽调整高度"]')`);
  await cdp.send("Emulation.clearDeviceMetricsOverride", {});
  await sleep(400);
  if (!bottom) throw new Error("窄窗未切到底部");
  const right = await evalJs(cdp, `!!document.querySelector('[title^="拖拽调整宽度"]')`);
  if (!right) throw new Error("恢复宽窗未回到右侧");
}

async function caseThumbs(cdp) {
  // 40 张图 + 1 张必败：视口优先（一次性不全拉）、并发 ≤4、失败回退
  await evalJs(cdp, `
    (async () => {
      const { useWorkspaceStore } = await import("/src/stores/workspace.ts");
      const { useExplorer } = await import("/src/stores/explorer.ts");
      const { useSettingsStore } = await import("/src/stores/settings.ts");
      const S = window.__mock;
      const ex = useExplorer(useWorkspaceStore().activePaneId);
      useSettingsStore().update({ showThumbnails: true });
      S.readB64Calls.length = 0;
      S.readB64MaxConcurrent = 0;
      const list = [];
      for (let i = 0; i < 40; i++) {
        list.push({ name: "img" + i + ".png", kind: "file", size: 100, permissions: "-rw-r--r--", mtime: 200 + i, owner: "u", group: "g", atime: null });
      }
      list.push({ name: "bad.jpg", kind: "file", size: 100, permissions: "-rw-r--r--", mtime: 999, owner: "u", group: "g", atime: null });
      S.listDirByPath["/imgs"] = list;
      S.readB64Fail.add("/imgs/bad.jpg");
      await ex.open("/imgs");
      return true;
    })()
  `);
  // 等视口稳定 + 空闲调度 + 并发 4 × 50ms
  await sleep(2500);
  const stats1 = await evalJs(cdp, `
    (() => {
      const S = window.__mock;
      return { fetched: S.readB64Calls.length, maxCon: S.readB64MaxConcurrent };
    })()
  `);
  if (stats1.fetched === 0) throw new Error("视口内缩略图未拉取");
  if (stats1.fetched >= 41) throw new Error("视口外也被拉取（" + stats1.fetched + "）");
  if (stats1.maxCon > 4) throw new Error("并发超上限: " + stats1.maxCon);
  // 失败回退：bad.jpg 行没有 img
  const badHasImg = await evalJs(
    cdp,
    `!!document.querySelector('[data-row="bad.jpg"] img')`,
  );
  if (badHasImg) throw new Error("失败行不应有缩略图");
  // 滚动到底部 → 视口外行补拉
  await evalJs(cdp, `
    (() => {
      const area = document.querySelector(".overflow-y-auto.rounded-lg");
      area.scrollTop = area.scrollHeight;
      area.dispatchEvent(new Event("scroll"));
      return true;
    })()
  `);
  await sleep(2500);
  const stats2 = await evalJs(cdp, `window.__mock.readB64Calls.length`);
  if (stats2 <= stats1.fetched) throw new Error("滚动后未补拉视口外缩略图");
  // 成功行确有缩略图
  const anyImg = await evalJs(cdp, `!!document.querySelector('[data-row="img0.png"] img, [data-row="img39.png"] img')`);
  if (!anyImg) throw new Error("成功行未见缩略图");
}

async function caseArchives(cdp) {
  // —— C1 能力探测 ——
  await evalJs(cdp, `
    (async () => {
      const { useWorkspaceStore } = await import("/src/stores/workspace.ts");
      const { useExplorer } = await import("/src/stores/explorer.ts");
      const { useArchivesStore } = await import("/src/stores/archives.ts");
      const S = window.__mock;
      const ws = useWorkspaceStore();
      const ex = useExplorer(ws.activePaneId);
      const archives = useArchivesStore();
      S.listDirByPath["/data"] = S.listDirByPath["/data"].filter((e) =>
        !e.name.startsWith("arc") && e.name !== "out.tar.gz");
      await ex.open("/data");
      await archives.ensureProbe(ex.connectionId);
      return { tar: archives.has(ex.connectionId, "tar"), zip: archives.has(ex.connectionId, "zip") };
    })()
  `).then((r) => {
    if (!r.tar || !r.zip) throw new Error("探测结果异常: " + JSON.stringify(r));
  });

  // —— C2 压缩：冲突静默放行 → exec 卡 → done 事件 → 完成+选中产物 ——
  const before = await evalJs(cdp, `window.__mock.archiveStarts.length`);
  await evalJs(cdp, `
    (async () => {
      const { useWorkspaceStore } = await import("/src/stores/workspace.ts");
      const { useExplorer } = await import("/src/stores/explorer.ts");
      const { compressSelection } = await import("/src/utils/archiveOps.ts");
      const ws = useWorkspaceStore();
      const ex = useExplorer(ws.activePaneId);
      const p = compressSelection(ex, ex.connectionId, ["a.png", "r.md"], "tar.gz", "out.tar.gz");
      // 等 archive_start 注册后推 done（ok）
      await new Promise((r) => setTimeout(r, 200));
      const starts = window.__mock.archiveStarts;
      const start = starts[starts.length - 1];
      window.__mock.emit("archive://done:" + start.runId, {
        runId: start.runId, ok: true, exitCode: 0, stderr: "", cancelled: false,
      });
      await p;
      return true;
    })()
  `);
  const after = await evalJs(cdp, `window.__mock.archiveStarts.length`);
  if (after !== before + 1) throw new Error("压缩未发起 archive_start");
  const createCmd = await evalJs(cdp, `
    (() => {
      const s = window.__mock.archiveStarts[window.__mock.archiveStarts.length - 1];
      return { program: s.program, line: s.args.join(" ") };
    })()
  `);
  if (createCmd.program !== "sh" || !createCmd.line.includes("tar czf 'out.tar.gz'")) {
    throw new Error("压缩命令异常: " + JSON.stringify(createCmd));
  }
  const createState = await evalJs(cdp, `
    (async () => {
      const { useTransferStore } = await import("/src/stores/transfer.ts");
      const rows = useTransferStore().rows;
      return { name: rows[0]?.fileName, status: rows[0]?.status };
    })()
  `);
  if (createState.name !== "已压缩到 out.tar.gz" || createState.status !== "done") {
    throw new Error("压缩卡终态异常: " + JSON.stringify(createState));
  }

  // —— C3 smart 多根 → 建子目录后 -C 解压 ——
  await evalJs(cdp, `
    (async () => {
      const S = window.__mock;
      S.tarListing = "readme.txt\\nsub/x.txt\\n";
      const { useWorkspaceStore } = await import("/src/stores/workspace.ts");
      const { useExplorer } = await import("/src/stores/explorer.ts");
      const { extractArchive } = await import("/src/utils/archiveOps.ts");
      const ws = useWorkspaceStore();
      const ex = useExplorer(ws.activePaneId);
      const entry = { name: "multi.tgz", kind: "file", size: 10, permissions: "-rw-r--r--", mtime: 1, owner: null, group: null, atime: null };
      const p = extractArchive(ex, ex.connectionId, entry, "smart", { has: () => true });
      await new Promise((r) => setTimeout(r, 250));
      const starts = window.__mock.archiveStarts;
      const start = starts[starts.length - 1];
      window.__mock.emit("archive://done:" + start.runId, { runId: start.runId, ok: true, exitCode: 0, stderr: "", cancelled: false });
      await p;
      return true;
    })()
  `);
  await sleep(200);
  const smartResult = await evalJs(cdp, `
    (() => {
      const S = window.__mock;
      const s = S.archiveStarts[S.archiveStarts.length - 1];
      return { mkdir: S.mkdirCalls[S.mkdirCalls.length - 1], line: s.args.join(" ") };
    })()
  `);
  if (smartResult.mkdir !== "/data/multi") throw new Error("smart 多根未建子目录: " + smartResult.mkdir);
  // 引号由后端 exec 层添加，前端拼装的 argv 为裸参数
  if (!smartResult.line.includes("xzf /data/multi.tgz -C /data/multi")) {
    throw new Error("smart 多根解压命令异常: " + smartResult.line);
  }

  // —— C3 smart 单根 → 当前目录（不建目录） ——
  await evalJs(cdp, `
    (async () => {
      const S = window.__mock;
      S.tarListing = "root/a.txt\\nroot/b.txt\\n";
      const { useWorkspaceStore } = await import("/src/stores/workspace.ts");
      const { useExplorer } = await import("/src/stores/explorer.ts");
      const { extractArchive } = await import("/src/utils/archiveOps.ts");
      const ex = useExplorer(useWorkspaceStore().activePaneId);
      const entry = { name: "single.tgz", kind: "file", size: 10, permissions: "-rw-r--r--", mtime: 1, owner: null, group: null, atime: null };
      const p = extractArchive(ex, ex.connectionId, entry, "smart", { has: () => true });
      await new Promise((r) => setTimeout(r, 250));
      const starts = window.__mock.archiveStarts;
      const start = starts[starts.length - 1];
      window.__mock.emit("archive://done:" + start.runId, { runId: start.runId, ok: true, exitCode: 0, stderr: "", cancelled: false });
      await p;
      return true;
    })()
  `);
  await sleep(200);
  const singleLine = await evalJs(cdp, `
    window.__mock.archiveStarts[window.__mock.archiveStarts.length - 1].args.join(" ")
  `);
  if (!singleLine.includes("-C /data")) throw new Error("smart 单根应解到当前目录: " + singleLine);
  const mkdirCount = await evalJs(cdp, `window.__mock.mkdirCalls.length`);
  if (mkdirCount !== 1) throw new Error("单根不应建目录，mkdir 次数 " + mkdirCount);

  // —— C4 ZipSlip：拒绝且不发起解压 ——
  const slipBefore = await evalJs(cdp, `window.__mock.archiveStarts.length`);
  await evalJs(cdp, `
    (async () => {
      const S = window.__mock;
      S.tarListing = "/abs/evil\\n../up.txt\\nok.txt\\n";
      const { useWorkspaceStore } = await import("/src/stores/workspace.ts");
      const { useExplorer } = await import("/src/stores/explorer.ts");
      const { extractArchive } = await import("/src/utils/archiveOps.ts");
      const ex = useExplorer(useWorkspaceStore().activePaneId);
      const entry = { name: "evil.tgz", kind: "file", size: 10, permissions: "-rw-r--r--", mtime: 1, owner: null, group: null, atime: null };
      await extractArchive(ex, ex.connectionId, entry, "smart", { has: () => true });
      return ex.error;
    })()
  `).then((err) => {
    if (!String(err).includes("拒绝解压")) throw new Error("ZipSlip 未拒绝: " + err);
  });
  const slipAfter = await evalJs(cdp, `window.__mock.archiveStarts.length`);
  if (slipAfter !== slipBefore) throw new Error("ZipSlip 拒绝后仍发起了解压");
}

async function caseTypeAhead(cdp) {
  await evalJs(cdp, `
    (async () => {
      const { useWorkspaceStore } = await import("/src/stores/workspace.ts");
      const { useExplorer } = await import("/src/stores/explorer.ts");
      const ex = useExplorer(useWorkspaceStore().activePaneId);
      await ex.open("/data");
      return true;
    })()
  `);
  await sleep(400);
  // 敲 b → 首个 b 前缀行（排序在 banana.txt 前的 b.png）；300ms 内拼 a → banana.txt；超时后 c → cherry.md
  await evalJs(cdp, `
    (() => {
      const key = (k) => window.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
      key("b");
      return true;
    })()
  `);
  await evalJs(cdp, `
    (async () => {
      const { useWorkspaceStore } = await import("/src/stores/workspace.ts");
      const { useExplorer } = await import("/src/stores/explorer.ts");
      const ex = useExplorer(useWorkspaceStore().activePaneId);
      window.__mock.sel1 = [...ex.selectedNames];
      return true;
    })()
  `);
  const sel1 = await evalJs(cdp, `window.__mock.sel1`);
  if (JSON.stringify(sel1) !== JSON.stringify(["b.png"])) {
    throw new Error("前缀定位失败: " + JSON.stringify(sel1));
  }
  // 连续输入拼接：ba → banana.txt
  await evalJs(cdp, `
    (() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
      return true;
    })()
  `);
  await sleep(80);
  const selConcat = await evalJs(cdp, `
    (async () => {
      const { useWorkspaceStore } = await import("/src/stores/workspace.ts");
      const { useExplorer } = await import("/src/stores/explorer.ts");
      return [...useExplorer(useWorkspaceStore().activePaneId).selectedNames];
    })()
  `);
  if (JSON.stringify(selConcat) !== JSON.stringify(["banana.txt"])) {
    throw new Error("连续输入拼接失败: " + JSON.stringify(selConcat));
  }
  // 让位：编辑器打开时敲键不改变选择
  const yieldOk = await evalJs(cdp, `
    (async () => {
      const { useEditorStore } = await import("/src/stores/editor.ts");
      const { useWorkspaceStore } = await import("/src/stores/workspace.ts");
      const { useExplorer } = await import("/src/stores/explorer.ts");
      const editor = useEditorStore();
      const ex = useExplorer(useWorkspaceStore().activePaneId);
      editor.open = true;
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
      await new Promise((r) => setTimeout(r, 50));
      const sel = [...ex.selectedNames];
      editor.open = false;
      return sel;
    })()
  `);
  if (JSON.stringify(yieldOk) !== JSON.stringify(["banana.txt"])) {
    throw new Error("编辑器打开未让位: " + JSON.stringify(yieldOk));
  }
  // 超时重置后 c → cherry.md
  await sleep(400);
  await evalJs(cdp, `
    (() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "c", bubbles: true }));
      return true;
    })()
  `);
  await sleep(100);
  const sel2 = await evalJs(cdp, `
    (async () => {
      const { useWorkspaceStore } = await import("/src/stores/workspace.ts");
      const { useExplorer } = await import("/src/stores/explorer.ts");
      return [...useExplorer(useWorkspaceStore().activePaneId).selectedNames];
    })()
  `);
  if (JSON.stringify(sel2) !== JSON.stringify(["cherry.md"])) {
    throw new Error("超时重置失败: " + JSON.stringify(sel2));
  }

  // scp 菜单：右键 apple.txt → 点「复制 scp 命令」→ 剪贴板
  await evalJs(cdp, `
    document.querySelector('[data-row="apple.txt"]')
      ?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    true
  `);
  await sleep(250);
  await evalJs(cdp, `
    (() => {
      const btn = [...document.querySelectorAll('[role="menuitem"]')]
        .find((b) => b.textContent.includes("复制 scp 命令"));
      if (!btn) throw new Error("菜单缺少「复制 scp 命令」");
      btn.click();
      return true;
    })()
  `);
  await sleep(250);
  const clip = await evalJs(cdp, `window.__mock.clipboard`);
  if (clip !== 'scp "u@h:/data/apple.txt" .') {
    throw new Error("scp 命令拼装异常: " + clip);
  }
}

main().catch((e) => {
  console.error("mock 自查失败:", e);
  process.exit(1);
});
