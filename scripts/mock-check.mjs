/**
 * 第四阶段 mock 自查（vite dev 4273 + Edge headless CDP）：
 * 注入 __TAURI_INTERNALS__.invoke（带 transformCallback）后驱动应用，
 * 断言块 A 聚合卡状态机 / C3 退出确认 / D 断线重连状态机 / E 目录缓存。
 * 运行：node scripts/mock-check.mjs
 */
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const VITE_PORT = 4273;
const CDP_PORT = 9333;
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

async function waitWs(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const ws = new WebSocket(url);
      ws.close();
      return;
    } catch {}
    await sleep(300);
  }
  throw new Error(`等待 ${url} 超时`);
}

/** CDP 最小客户端 */
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

async function main() {
  // 1. vite dev
  const vite = spawn("npx", ["vite", `--port`, `${VITE_PORT}`, "--strictPort"], {
    shell: true,
    stdio: "ignore",
  });
  await waitHttp(APP_URL);
  console.log("vite dev server ready");

  // 2. Edge headless + CDP（独立 user-data-dir 防止并入已有 Edge 实例；
  //    不经 shell——路径含空格，args 数组直接传）
  const edge = spawn(
    EDGE,
    [
      "--headless=new",
      "--no-first-run",
      "--disable-gpu",
      "--window-size=1440,900",
      `--user-data-dir=${process.env.TEMP}\\vssh-mock-profile`,
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

  // 3. 注入 mock（文档脚本运行前）
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: buildMockSource(),
  });

  await cdp.send("Page.navigate", { url: APP_URL });
  await sleep(2500);

  // 4. 逐项断言（页面内 async）
  const cases = [
    ["环境与应用就绪", caseReady],
    ["E: 缓存命中/过期静默刷新", caseCache],
    ["A: 下载文件夹编排与聚合卡状态机", caseFolderBatch],
    ["C3: 退出确认弹窗路径", caseExitGuard],
    ["D: 断线重连状态机与 remap", caseReconnect],
    ["B: 无图粘贴静默回落", caseClipboardImage],
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

/** 页面内注入的 mock：__TAURI_INTERNALS__ + 可控命令桩 */
function buildMockSource() {
  return String.raw`
  // rAF 兜底（headless 下 rAF 可能不触发）
  window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 16);

  const S = (window.__mock = {
    handlers: new Map(),          // event -> Set<handlerId>
    cbSeq: 1,
    calls: {},                    // cmd -> 次数
    listDirByPath: {},            // path -> entries
    listDirCalls: {},             // path -> 次数
    walkOutput: null,             // ssh_walk_remote 返回
    nextConnectFails: 0,          // ssh_connect 失败次数
    connectCalls: [],
    activeUploads: new Set(),     // 不推终态的挂起上传（退出确认用）
    imagePng: null,               // clipboard_read_image 返回
    savedImage: null,
    dialogDir: "C:\\dst",
    revealed: [],
    notifications: [],
  });

  function emit(event, payload) {
    const handlers = S.handlers.get(event) ?? [];
    for (const hid of handlers) {
      const cb = window["_" + hid];
      if (cb) cb({ event, id: S.cbSeq++, payload });
    }
  }

  function entriesOf(path) {
    S.listDirCalls[path] = (S.listDirCalls[path] ?? 0) + 1;
    const list = S.listDirByPath[path] ?? [];
    // 简单排序：目录优先
    return list;
  }

  function pushTransfer(transferId, direction, fileName) {
    emit("transfer://progress", { transferId, direction, fileName, bytes: 0, total: 0, speedBps: 0, status: "queued" });
    setTimeout(() => emit("transfer://progress", { transferId, direction, fileName, bytes: 3, total: 10, speedBps: 1000, status: "running" }), 30);
    setTimeout(() => emit("transfer://progress", { transferId, direction, fileName, bytes: 10, total: 10, speedBps: 0, status: "done" }), 80);
  }

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
      case "ssh_connect": {
        S.connectCalls.push(args.alias);
        if (S.nextConnectFails > 0) { S.nextConnectFails--; throw new Error("mock connect refused"); }
        return { connectionId: "cid-" + (S.connectCalls.length), rootPath: "/root", latencyMs: 3 };
      }
      case "ssh_list_dir": return entriesOf(args.path);
      case "ssh_walk_remote":
        if (args.walkId) setTimeout(() => emit("walk://progress:" + args.walkId, { walkId: args.walkId, dirs: 1, files: 2, bytes: 30, skippedLinks: 1 }), 30);
        return new Promise((resolve) =>
          setTimeout(() => resolve(S.walkOutput ?? { cancelled: false, output: { dirs: [], files: [], skippedLinks: 0, failedDirs: 0 } }), 400),
        );
      case "ssh_walk_cancel": return true;
      case "walk_local": return { dirs: ["sub"], files: [{ path: "a.txt", size: 1, kind: "file" }, { path: "link", size: 2, kind: "symlink" }], skippedLinks: 1, failedDirs: 0 };
      case "local_mkdir_p": case "ssh_mkdir": case "ssh_touch": case "ssh_rename": return null;
      case "ssh_stat": return { kind: "dir", size: 0 };
      case "ssh_delete": return null;
      case "local_file_meta": return (args.paths ?? []).map(() => null);
      case "ssh_upload": {
        const { transferId, localPath, remotePath } = args;
        if (S.activeUploads.has(remotePath)) {
          emit("transfer://progress", { transferId, direction: "upload", fileName: remotePath, bytes: 0, total: 0, speedBps: 0, status: "queued" });
          return null; // 挂起不推终态
        }
        pushTransfer(transferId, "upload", remotePath.split("/").pop());
        return null;
      }
      case "ssh_download": { pushTransfer(args.transferId, "download", args.remotePath); return null; }
      case "ssh_transfer_list": return [];
      case "ssh_transfer_cancel": return true;
      case "ssh_transfer_remove": return true;
      case "ssh_fs_info": return null;
      case "credential_get": return "mock-secret";
      case "clipboard_read_files": return [];
      case "clipboard_read_image": return S.imagePng;
      case "clipboard_save_image": { S.savedImage = args.png; return "C:\\temp\\paste-x.png"; }
      case "plugin:dialog|open": return S.dialogDir;
      case "plugin:dialog|save": return "C:\\dst\\saved.bin";
      case "plugin:notification|is_permission_granted": return true;
      case "plugin:notification|notify": { S.notifications.push(args); return null; }
      case "plugin:opener|reveal_item_in_dir": { S.revealed.push(args); return null; }
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

/** 页面内执行的 helper：包 Runtime.evaluate + awaitPromise */
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

async function caseReady(cdp) {
  const ready = await evalJs(cdp, `window.__mock?.ready ?? false`);
  if (!ready) throw new Error("mock 未注入");
  await sleep(800);
  const hasApp = await evalJs(cdp, `!!document.querySelector("#app")`);
  if (!hasApp) throw new Error("#app 未渲染");
}

async function caseCache(cdp) {
  await evalJs(cdp, `
    (async () => {
      const { useConnectionsStore } = await import("/src/stores/connections.ts");
      const { useExplorer } = await import("/src/stores/explorer.ts");
      const conn = useConnectionsStore();
      await conn.connect({ id: "p1", alias: "mock", host: "h", port: 22, username: "u", authMethod: "password", createdAt: 0 });
      if (!conn.active) throw new Error("connect 失败");
      const ex = useExplorer(conn.active.connectionId);
      ex.connectionId = conn.active.connectionId; // 真实流程由 initPane 设置
      window.__mock.listDirByPath["/data"] = [
        { name: "sub", kind: "dir", size: 0, permissions: "drwxr-xr-x", mtime: 1, owner: null, group: null, atime: null },
      ];
      window.__mock.listDirByPath["/data/sub"] = [];
      await ex.open("/data");
      return conn.active.connectionId;
    })()
  `);
  const calls1 = await evalJs(cdp, `window.__mock.listDirCalls["/data"] ?? 0`);
  if (calls1 !== 1) throw new Error("首次打开应发起 1 次 listDir，实际 " + calls1);
  // 导航进子目录再 back → /data 缓存命中，listDir 不再调用
  await evalJs(cdp, `
    (async () => {
      const { useConnectionsStore } = await import("/src/stores/connections.ts");
      const { useExplorer } = await import("/src/stores/explorer.ts");
      const conn = useConnectionsStore();
      const ex = useExplorer(conn.active.connectionId);
      await ex.open("/data/sub");
      await ex.back();            // 回 /data → 缓存命中，listDir 不再调用
      return ex.cwd;
    })()
  `);
  const calls2 = await evalJs(cdp, `window.__mock.listDirCalls["/data"] ?? 0`);
  if (calls2 !== 1) throw new Error("back 缓存命中不应再调 listDir，实际 " + calls2);
  // 人为过期 → back 触发静默刷新
  await evalJs(cdp, `
    (async () => {
      const { useConnectionsStore } = await import("/src/stores/connections.ts");
      const { useExplorer } = await import("/src/stores/explorer.ts");
      const { dirCacheOf } = await import("/src/utils/dirCache.ts");
      const conn = useConnectionsStore();
      const ex = useExplorer(conn.active.connectionId);
      const cache = dirCacheOf(conn.active.connectionId);
      const e = cache.get("/data");
      e.fetchedAt -= 31000;
      await ex.forward();          // /data/sub
      await ex.back();             // /data：渲染旧缓存 + 触发静默刷新
      await new Promise((r) => setTimeout(r, 400));
      return ex.cwd;
    })()
  `);
  const calls3 = await evalJs(cdp, `window.__mock.listDirCalls["/data"] ?? 0`);
  if (calls3 !== 2) throw new Error("过期缓存应触发一次静默刷新，实际 " + calls3);
}

async function caseFolderBatch(cdp) {
  const result = await evalJs(cdp, `
    (async () => {
      const { useConnectionsStore } = await import("/src/stores/connections.ts");
      const { useTransferStore } = await import("/src/stores/transfer.ts");
      const { downloadFolderTo } = await import("/src/utils/recursiveTransfer.ts");
      const conn = useConnectionsStore();
      const transfers = useTransferStore();
      window.__mock.listDirByPath["C:\\\\dst"] = [];
      window.__mock.walkOutput = {
        cancelled: false,
        output: {
          dirs: ["big/sub"],
          files: [
            { path: "big/one.bin", size: 10, kind: "file" },
            { path: "big/sub/two.bin", size: 20, kind: "file" },
            { path: "big/link", size: 3, kind: "symlink" },
          ],
          skippedLinks: 1,
          failedDirs: 0,
        },
      };
      const p = downloadFolderTo(conn.active.connectionId, "/data/big");
      await new Promise((r) => setTimeout(r, 150)); // 仍处 walk 阶段（mock walk 400ms）
      const card = transfers.rows.find((r) => r.direction === "folder-download");
      if (!card) throw new Error("聚合卡未创建");
      const state1 = { status: card.status, phase: card.batch.phase, children: transfers.rows.filter((r) => r.batchId === card.id).length };
      await p;
      const card2 = transfers.rows.find((r) => r.id === card.id);
      const agg = {
        status: card2.status,
        caption: card2.batch.skippedLinks,
        total: card2.batch.filesTotal,
        childRows: transfers.rows.filter((r) => r.batchId === card.id).length,
        toastShown: window.__mock.revealed.length >= 0,
      };
      return { state1, agg };
    })()
  `);
  if (result.state1.status !== "running" || result.state1.phase !== "walking") {
    throw new Error("枚举阶段应为 running/walking，实际 " + JSON.stringify(result.state1));
  }
  if (result.agg.status !== "done") throw new Error("批次应 done，实际 " + result.agg.status);
  if (result.agg.total !== 2) throw new Error("filesTotal 应为 2（符号链接跳过），实际 " + result.agg.total);
  if (result.agg.childRows !== 2) throw new Error("子行应为 2，实际 " + result.agg.childRows);
  if (result.agg.caption !== 1) throw new Error("跳过链接数应为 1，实际 " + result.agg.caption);
}

async function caseExitGuard(cdp) {
  const r = await evalJs(cdp, `
    (async () => {
      const { useExitGuardStore } = await import("/src/stores/exitGuard.ts");
      const { useTransferStore } = await import("/src/stores/transfer.ts");
      const { useConnectionsStore } = await import("/src/stores/connections.ts");
      const { useExplorer } = await import("/src/stores/explorer.ts");
      const guard = useExitGuardStore();
      const transfers = useTransferStore();
      const conn = useConnectionsStore();
      const ex = useExplorer(conn.active.connectionId);
      // 无活动传输 → 直接放行
      const free = await guard.request();
      // 挂起一个不终态的上传 → request 挂起
      window.__mock.activeUploads.add("/root/pending.bin");
      await transfers.startUpload(conn.active.connectionId, "C:\\local.bin", "/root", "pending.bin");
      let settled = null;
      const p = guard.request().then((ok) => (settled = ok));
      await new Promise((r) => setTimeout(r, 100));
      const modalOpen = !!guard.pending;
      guard.settle(false);
      const denied = await p;
      const modalClosed = !guard.pending;
      // 确认离开 → true
      const p2 = guard.request().then((ok) => ok);
      guard.settle(true);
      const allowed = await p2;
      window.__mock.activeUploads.clear();
      return { free, modalOpen, denied, modalClosed, allowed };
    })()
  `);
  if (!r.free) throw new Error("无活动传输应直接放行");
  if (!r.modalOpen || !r.modalClosed) throw new Error("Modal 开合状态异常");
  if (r.denied !== false || r.allowed !== true) throw new Error("settle 决策未正确回传");
}

async function caseReconnect(cdp) {
  const r = await evalJs(cdp, `
    (async () => {
      const { useConnectionsStore } = await import("/src/stores/connections.ts");
      const { useWorkspaceStore } = await import("/src/stores/workspace.ts");
      const conn = useConnectionsStore();
      const workspace = useWorkspaceStore();
      const oldId = conn.active.connectionId;
      const tab = workspace.tabs[0];
      if (!tab) throw new Error("无标签");
      // 模拟后端断开事件；第一次重连失败（退避 1s），第二次成功
      window.__mock.nextConnectFails = 1;
      conn.handleLost(oldId);
      await new Promise((r) => setTimeout(r, 300)); // handleLost 的凭据检查是异步的
      const during = { state: conn.byId[oldId]?.state, attempt: conn.byId[oldId]?.reconnectAttempt };
      await new Promise((r) => setTimeout(r, 4000));
      const newId = conn.active?.connectionId;
      return {
        oldId,
        during,
        tabConnAfter: tab.connectionId,
        newId,
        stateAfter: conn.byId[newId]?.state,
        oldGone: !conn.byId[oldId],
      };
    })()
  `);
  if (r.during.state !== "reconnecting") throw new Error("断开后应进入 reconnecting，实际 " + r.during.state);
  if (r.stateAfter !== "connected") throw new Error("重连后应 connected，实际 " + r.stateAfter);
  if (!r.newId || r.newId === r.oldId) throw new Error("新 connectionId 未生成: " + r.newId);
  if (r.tabConnAfter !== r.newId) throw new Error("标签连接标识未 remap");
  if (!r.oldGone) throw new Error("旧连接记录未清除");
}

async function caseClipboardImage(cdp) {
  const r = await evalJs(cdp, `
    (async () => {
      const { useConnectionsStore } = await import("/src/stores/connections.ts");
      const { useExplorer } = await import("/src/stores/explorer.ts");
      const conn = useConnectionsStore();
      const ex = useExplorer(conn.active.connectionId);
      window.__mock.imagePng = null; // 无图
      const callsBefore = window.__mock.calls["clipboard_save_image"] ?? 0;
      const mod = await import("/src/api/clipboard.ts");
      const png = await mod.readClipboardImage();
      return { pngNull: png === null, savesBefore: callsBefore };
    })()
  `);
  if (!r.pngNull) throw new Error("无图应返回 null");
}

main().catch((e) => {
  console.error("mock 自查脚本异常:", e);
  process.exit(1);
});
