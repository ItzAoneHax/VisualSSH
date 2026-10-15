/**
 * 标签-卡片熔接缝像素复验（vite dev 4275 + Edge headless CDP，dsf=1 与真机 1:1）：
 * 首标签/中间标签 × 暗/亮主题，截取标签缝区并在 Node 侧逐像素断言——
 * ①两角楔形楔斑（ac15ffe 回归）：标签底 8px 带内左右 12px 处填充须与中部一致；
 * ②首标签左线芯均匀 + 跨缝同色（ac15ffe 目标，不得回退）；
 * ③轮廓外侧环影柱：左带（首标签延到缝/中间标签到凹弧顶）、右缘存在；
 * ④缝中段豁免：标签正下方卡顶线缺口处 = 填充色（连体内部无影）。
 * 运行：node scripts/verify-tabseam.mjs [tag]  → .zcode-shots/seam-<tag>-*.png + 断言表
 */
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import zlib from "node:zlib";

const TAG = process.argv[2] ?? "run";
const VITE_PORT = 4275;
const CDP_PORT = 9345;
const APP_URL = `http://127.0.0.1:${VITE_PORT}/`;
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const OUT = join(process.cwd(), ".zcode-shots");
mkdirSync(OUT, { recursive: true });

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

// 最小 Tauri mock；localStorage 清底防上次会话残留（目录缓存/会话恢复坑）
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

// —— PNG 解码（RGBA8，无交错）——
function decodePng(buf) {
  let pos = 8, w = 0, h = 0, ch = 4;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      if (data[9] === 2) ch = 3;
    } else if (type === "IDAT") idat.push(data);
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const px = Buffer.alloc(w * h * ch);
  let rp = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[rp++];
    const row = raw.subarray(rp, rp + stride);
    rp += stride;
    const out = px.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? out[x - ch] : 0;
      const b = y > 0 ? px[(y - 1) * stride + x] : 0;
      const c = x >= ch && y > 0 ? px[(y - 1) * stride + x - ch] : 0;
      let v = row[x];
      if (f === 1) v = (v + a) & 255;
      else if (f === 2) v = (v + b) & 255;
      else if (f === 3) v = (v + ((a + b) >> 1)) & 255;
      else if (f === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
      out[x] = v;
    }
  }
  return {
    w, h,
    lum(x, y) {
      if (x < 0 || y < 0 || x >= w || y >= h) return null;
      const o = (y * w + x) * ch;
      return ch === 1 ? px[o] : Math.round(0.299 * px[o] + 0.587 * px[o + 1] + 0.114 * px[o + 2]);
    },
  };
}

async function main() {
  const vite = spawn("npx", ["vite", "--port", `${VITE_PORT}`, "--strictPort"], { shell: true, stdio: "ignore" });
  const profile = join(process.env.TEMP, `vssh-seam-${Date.now()}`);
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
      if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
        pageErrors.push("console.error: " + JSON.stringify(msg.params.args?.map((a) => a.value ?? a.description ?? "").slice(0, 2)));
      }
    });
    await send("Page.navigate", { url: APP_URL });
    // 等应用真正挂载（vite 冷转换/依赖优化重载会造成 #app 短暂为空）
    let diag = null;
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      diag = await evalJs(`
        (() => ({
          mockReady: !!window.__TAURI_INTERNALS__,
          kids: document.querySelector("#app")?.children.length ?? -1,
        }))()
      `);
      if (diag.mockReady && diag.kids > 0) break;
    }
    console.log("diag:", JSON.stringify(diag));
    if (pageErrors.length) console.log("pageErrors:", pageErrors.slice(0, 4).join(" | "));

    // 连接 + 3 标签
    await evalJs(`
      (async () => {
        const { useConnectionsStore } = await import("/src/stores/connections.ts");
        const conn = useConnectionsStore();
        await conn.connect({ id: "p1", alias: "mock", host: "h", port: 22, username: "u", authMethod: "password", createdAt: 0 });
        if (!conn.active) throw new Error("connect 失败");
        const { useWorkspaceStore } = await import("/src/stores/workspace.ts");
        const ws = useWorkspaceStore();
        ws.openTab(conn.active.connectionId, "p1", "alpha");
        ws.openTab(conn.active.connectionId, "p1", "beta");
        ws.openTab(conn.active.connectionId, "p1", "gamma");
        return ws.tabs.length;
      })()
    `);
    await sleep(800);
    // 预热一轮（依赖优化/首帧稳定）
    await evalJs(`(async()=>{const {useWorkspaceStore}=await import("/src/stores/workspace.ts");const ws=useWorkspaceStore();ws.activateTab(ws.tabs[1].id);ws.activateTab(ws.tabs[0].id);return true;})()`);
    await sleep(600);

    const setTheme = async (theme) => {
      await evalJs(`
        (async () => {
          const { useSettingsStore } = await import("/src/stores/settings.ts");
          useSettingsStore().update({ theme: "${theme}" });
          return document.documentElement.className;
        })()
      `);
      await sleep(400);
    };

    const capture = async () => {
      const rect = JSON.parse(await evalJs(`
        (() => {
          const el = document.querySelector("[data-active-tab]");
          if (!el) return "null";
          const bar = el.parentElement.getBoundingClientRect();
          const r = el.getBoundingClientRect();
          return JSON.stringify({ x: Math.max(0, Math.floor(r.left) - 48), y: Math.floor(bar.top), w: Math.min(window.innerWidth, Math.ceil(r.right) + 48) - Math.max(0, Math.floor(r.left) - 48), h: Math.ceil(bar.height) + 20, L: r.left, R: r.right, T: r.top, B: r.bottom });
        })()
      `));
      const shot = await send("Page.captureScreenshot", {
        format: "png",
        clip: { x: rect.x, y: rect.y, width: rect.w, height: rect.h, scale: 1 },
      });
      const buf = Buffer.from(shot.data, "base64");
      return { rect, buf, img: decodePng(buf) };
    };

    const rows = [];
    const check = (name, pass, detail) => {
      rows.push({ name, pass, detail });
      if (!pass) failed += 1;
    };

    for (const tabIndex of [0, 1]) {
      for (const theme of ["dark", "light"]) {
        await setTheme(theme);
        await evalJs(`(async()=>{const {useWorkspaceStore}=await import("/src/stores/workspace.ts");const ws=useWorkspaceStore();ws.activateTab(ws.tabs[${tabIndex}].id);return true;})()`);
        await sleep(500);
        const { rect, buf, img } = await capture();
        const L = Math.round(rect.L), R = Math.round(rect.R), T = Math.round(rect.T), B = Math.round(rect.B);
        const W = R - L;
        const X = (x) => x - rect.x, Y = (y) => y - rect.y;
        const P = (x, y) => img.lum(X(x), Y(y));
        const tag = `tab${tabIndex}-${theme}`;
        writeFileSync(join(OUT, `seam-${TAG}-${tag}.png`), buf);
        const fillMid = P(L + (W >> 1), B - 4);
        console.log(`[${tag}] L=${L} R=${R} T=${T} B=${B} fillMid=${fillMid}`);

        // ① 楔形暗斑回归：底 8px 带内左右（旧 12px 带内缘 L+11/R-11，取带正中）vs 中部
        const wl = P(L + 5, B - 4), wr = P(R - 5, B - 4);
        check(`${tag} 楔斑左`, Math.abs(wl - fillMid) <= 3, `x=L+5 y=B-4 → ${wl} vs fill ${fillMid}`);
        check(`${tag} 楔斑右`, Math.abs(wr - fillMid) <= 3, `x=R-5 y=B-4 → ${wr} vs fill ${fillMid}`);
        // ③ 缝中段豁免：标签正下方缺口行 = 填充
        const ex = P(L + (W >> 1), B);
        check(`${tag} 缝中豁免`, Math.abs(ex - fillMid) <= 3, `x=mid y=B → ${ex} vs fill ${fillMid}`);
        // 卡顶线在标签右侧恢复（sanity）
        const cl = P(R + 8, B);
        check(`${tag} 卡顶线在`, Math.abs(cl - fillMid) >= 8, `x=R+8 y=B → ${cl} vs fill ${fillMid}`);

        if (tabIndex === 0) {
          // ② 首标签左线芯：上半 vs 缝上最低段最小值（修前楔斑把线芯压到 61）
          const top = P(L, T + 12);
          let mn = 255;
          for (let y = B - 7; y <= B - 1; y++) mn = Math.min(mn, P(L, y));
          check(`${tag} 线芯均匀`, top - mn <= 3, `x=L 上=${top} 缝上最低=${mn}`);
          // ② 跨缝同色（ac15ffe 目标）
          const above = P(L, B - 1), below = P(L, B + 2);
          check(`${tag} 跨缝线色`, Math.abs(above - below) <= 3, `缝上 ${above} vs 缝下 ${below}`);
          // ③ 左环影柱延到缝 + 跨缝与卡环衔接
          //  （阈值 8：卡影方角处高斯有 2-3px 建立段，暗 Δ2/亮 Δ7，非断柱）
          const bgFar = P(L - 24, B - 2);
          const rs = P(L - 1, B - 2), rb = P(L - 1, B + 2);
          check(`${tag} 左环到缝`, rs <= bgFar - 3, `x=L-1 缝上=${rs} bg=${bgFar}`);
          check(`${tag} 左环跨缝`, Math.abs(rs - rb) <= 8, `缝上 ${rs} vs 缝下 ${rb}`);
          // 右缘环影（凹弧缺口之上）
          const bgFarR = P(R + 24, B - 6);
          const rr = P(R + 1, B - 6);
          check(`${tag} 右环存在`, rr <= bgFarR - 3, `x=R+1 y=B-6 → ${rr} bg=${bgFarR}`);
        } else {
          // 中间标签：左环影柱只到凹弧缺口顶（缝上 5px）；缺口内、凹弧 svg 外
          // 一列（x=L-5）应回归底色（环影已让位给凹弧）
          const bgFar = P(L - 24, B - 2);
          const rs = P(L - 1, B - 7);
          check(`${tag} 左环带上段`, rs <= bgFar - 3, `x=L-1 y=B-7=${rs} bg=${bgFar}`);
          const rl = P(L - 5, B - 2);
          check(`${tag} 凹弧区干净`, Math.abs(rl - bgFar) <= 4, `x=L-5 y=B-2=${rl} bg=${bgFar}`);
        }
      }
    }

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
  console.error("复验失败:", e.message ?? e);
  process.exit(1);
});
