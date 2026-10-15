/**
 * 背景图渲染自查（dev 4273 + Edge headless CDP 注入 mock convertFileSrc）：
 * 断言 App.vue 背景图层的几何与像素——
 *   ① img 铺满窗口（fixed 替换元素 auto 尺寸取固有值不拉伸的修复）
 *   ② 模糊补边按像素外扩 1.5×半径：边缘无半透明淡出沿、几何随 blur 精确变化
 *   ③ 取景稳定：四色条带图边界随 blur 40 的漂移 = bleed（±8px），
 *      而旧实现 scale(1+blur/100) 会移 ~360px
 *   ④ 契合/对齐语义：contain 留边、cover 铺满、垂直对齐 start/end 生效
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import process from "node:process";

const PORT = 4273;
const CDP = 9349;
const SHOTS = join(process.cwd(), ".zcode-shots");
mkdirSync(SHOTS, { recursive: true });

function kill(pattern) {
  spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `Get-CimInstance Win32_Process -Filter "Name='node.exe' or Name='msedge.exe'" | Where-Object { $_.CommandLine -match '${pattern}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`,
    ],
    { encoding: "utf8" },
  );
}
kill(`vite.*--port ${PORT}`);
kill(`remote-debugging-port=${CDP}`);

const vite = spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], {
  shell: true,
  stdio: "ignore",
});
const edgeProfile = join(homedir(), "AppData", "Local", "Temp", `vssh-bg-${Date.now()}`);
const edge = spawn(
  join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe"),
  [
    "--headless=new",
    "--window-position=-32000,-32000",
    "--start-minimized",
    `--remote-debugging-port=${CDP}`,
    `--user-data-dir=${edgeProfile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--force-device-scale-factor=1",
    "--window-size=1440,900",
    "about:blank",
  ],
  { stdio: "ignore" },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdpConnect() {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP}/json/version`);
      const info = await res.json();
      const ws = new WebSocket(info.webSocketDebuggerUrl);
      await new Promise((ok, bad) => {
        ws.onopen = ok;
        ws.onerror = bad;
      });
      return ws;
    } catch {
      await sleep(300);
    }
  }
  throw new Error("CDP 连接超时");
}

let seq = 0;
const pending = new Map();
function send(ws, method, params = {}, sessionId) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}

async function waitVite() {
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(`http://127.0.0.1:${PORT}/`);
      return true;
    } catch {
      await sleep(400);
    }
  }
  throw new Error("vite 未就绪");
}

/** 画布合成测试图（mock 注入期同步生成 data URL）：
 *  solid=1200×700 纯色（比窗口小，验证拉伸铺满）；split=2000×1000 四色竖条带；
 *  splitTB=2000×1000 上下双色 */
const MOCK_JS = `(() => {
  if (window.__mock) return;
  for (const k of Object.keys(localStorage)) if (k.startsWith('visualssh:')) localStorage.removeItem(k);
  const mk = (w, h, paint) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    paint(ctx, w, h);
    return c.toDataURL('image/png');
  };
  const IMGS = {
    solid:  mk(1200, 700, (ctx, w, h) => { ctx.fillStyle = '#e8399b'; ctx.fillRect(0, 0, w, h); }),
    split:  mk(2000, 1000, (ctx, w, h) => {
      ['#ff0000', '#00ff00', '#0000ff', '#ffff00'].forEach((col, i) => {
        ctx.fillStyle = col; ctx.fillRect(i * w / 4, 0, w / 4, h);
      });
    }),
    splitTB: mk(2000, 1000, (ctx, w, h) => {
      ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, w, h / 2);
      ctx.fillStyle = '#0000ff'; ctx.fillRect(0, h / 2, w, h / 2);
    }),
  };
  window.__mock = { imgs: IMGS };
  window.__TAURI_INTERNALS__ = {
    invoke: async () => {},
    transformCallback: () => 0,
    unregisterCallback: () => {},
    convertFileSrc: (path) => IMGS[path] ?? IMGS.solid,
  };
})();`;

async function evalJs(ws, sessionId, expr) {
  const r = await send(
    ws,
    "Runtime.evaluate",
    { expression: expr, returnByValue: true, awaitPromise: true },
    sessionId,
  );
  if (r.exceptionDetails) throw new Error("eval 失败: " + JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r.result.value;
}

/** 极简 PNG 解码（仅 Chromium 截图输出形态：8bit RGB/RGBA 非交错） */
function decodePng(buf) {
  let pos = 8;
  let w = 0;
  let h = 0;
  let ct = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    pos += 4;
    const type = buf.toString("ascii", pos, pos + 4);
    pos += 4;
    const data = buf.subarray(pos, pos + len);
    pos += len + 4;
    if (type === "IHDR") {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      ct = data[8];
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
  }
  const bpp = ct === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const out = Buffer.alloc(w * h * bpp);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v;
      if (f === 0) v = line[x];
      else if (f === 1) v = line[x] + a;
      else if (f === 2) v = line[x] + b;
      else if (f === 3) v = line[x] + ((a + b) >> 1);
      else {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v = line[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      cur[x] = v & 255;
    }
    prev = cur;
  }
  return {
    w,
    h,
    px(x, y) {
      const o = (y * w + x) * bpp;
      return [out[o], out[o + 1], out[o + 2]];
    },
  };
}

async function screenshot(ws, sessionId, name) {
  const shot = await send(ws, "Page.captureScreenshot", { format: "png" }, sessionId);
  const raw = Buffer.from(shot.data, "base64");
  if (name) writeFileSync(join(SHOTS, name), raw);
  return decodePng(raw);
}

function near(actual, expected, tol, label) {
  const d = Math.max(
    Math.abs(actual[0] - expected[0]),
    Math.abs(actual[1] - expected[1]),
    Math.abs(actual[2] - expected[2]),
  );
  return { ok: d <= tol, d, label: `${label} got rgb(${actual}) want rgb(${expected}) Δ${d}` };
}

/** 四色条带图在行 y 上的条带边界 x（最近邻分类后找切换列） */
function stripeBoundaries(img, y, colors, W) {
  const classify = (p) => {
    let best = 0;
    let bd = Infinity;
    colors.forEach((c, i) => {
      const d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2;
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  };
  const bounds = [];
  let last = classify(img.px(1, y));
  for (let x = 2; x < W - 1; x++) {
    const k = classify(img.px(x, y));
    if (k !== last) { bounds.push(x); last = k; }
  }
  return bounds;
}

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`  ok ${name}`);
  else { failures++; console.error(`  FAIL ${name} ${detail}`); }
}

const STRIPES = [
  [255, 0, 0],
  [0, 255, 0],
  [0, 0, 255],
  [255, 255, 0],
];
const SOLID = [0xe8, 0x39, 0x9b];
const BLEED40 = 93; // blur 40 → round(40*2.33)

try {
  await waitVite();
  const ws = await cdpConnect();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id).resolve(msg.result ?? msg);
      pending.delete(msg.id);
    }
  };
  const pages = (await send(ws, "Target.getTargets")).targetInfos.filter((t) => t.type === "page");
  const { targetId } = pages[0];
  const { sessionId } = await send(ws, "Target.attachToTarget", { targetId, flatten: true });
  await send(ws, "Page.addScriptToEvaluateOnNewDocument", { source: MOCK_JS }, sessionId);
  await send(ws, "Page.navigate", { url: `http://127.0.0.1:${PORT}/` }, sessionId);
  await sleep(3200);
  const navOk = await evalJs(ws, sessionId, `(() => ({
    url: location.href, ready: document.readyState, hasApp: !!document.querySelector('#app'),
  }))()`).catch(() => null);
  if (!navOk || !navOk.url.includes(String(PORT)) || !navOk.hasApp) {
    throw new Error(`页面未加载成功: ${JSON.stringify(navOk)}`);
  }
  await evalJs(ws, sessionId, MOCK_JS);

  // 等应用挂载
  let mounted = null;
  for (let i = 0; i < 40 && !mounted; i++) {
    mounted = await evalJs(ws, sessionId, `!!document.querySelector('#app')?.__vue_app__`).catch(() => null);
    if (!mounted) await sleep(500);
  }
  check("应用挂载", mounted === true);

  // 隐藏内容层，露出背景图；取 body 底色做留边比对
  const bodyBg = await evalJs(ws, sessionId, `(() => {
    document.querySelector('#app > div.relative.z-10').style.display = 'none';
    const cs = getComputedStyle(document.body);
    const m = /rgba?\\((\\d+), (\\d+), (\\d+)/.exec(cs.backgroundColor);
    return m ? [+m[1], +m[2], +m[3]] : [255, 255, 255];
  })()`);
  await sleep(300);

  const setBg = (patch) =>
    evalJs(ws, sessionId, `(() => {
      const pinia = document.querySelector('#app').__vue_app__._context.config.globalProperties.$pinia;
      pinia._s.get('settings').update(${JSON.stringify(patch)});
    })()`);
  const geometry = () =>
    evalJs(ws, sessionId, `(() => {
      const img = document.querySelector('#app > img[aria-hidden="true"]');
      if (!img) return null;
      const r = img.getBoundingClientRect();
      const cs = getComputedStyle(img);
      return {
        x: r.x, y: r.y, w: r.width, h: r.height,
        W: innerWidth, H: innerHeight,
        filter: cs.filter, transform: cs.transform,
        objectFit: cs.objectFit, objectPosition: cs.objectPosition,
        natural: [img.naturalWidth, img.naturalHeight],
      };
    })()`);

  // —— ① blur 0：几何铺满 + 纯色小图（1200×700 < 窗口）四沿皆图色 ——
  await setBg({
    bgImage: "solid", bgImageOpacity: 1, bgImageBlur: 0,
    bgImageFit: "uniformToFill", bgImageVAlign: "center", bgImageHAlign: "center",
  });
  await sleep(400);
  const g0 = await geometry();
  check("blur0 背景图层存在", !!g0);
  check(
    "blur0 盒子铺满窗口（替换元素拉伸修复）",
    g0 && g0.x === 0 && g0.y === 0 && g0.w === g0.W && g0.h === g0.H,
    JSON.stringify(g0),
  );
  check("blur0 无 filter/transform", g0 && g0.filter === "none" && g0.transform === "none",
    `filter=${g0?.filter} transform=${g0?.transform}`);
  check("blur0 object-fit=cover", g0?.objectFit === "cover", g0?.objectFit);
  const s0 = await screenshot(ws, sessionId, "bg-solid-blur0.png");
  check("截图尺寸=视口", s0.w === g0.W && s0.h === g0.H, `${s0.w}x${s0.h} vs ${g0.W}x${g0.H}`);
  const edges0 = [
    near(s0.px(2, 2), SOLID, 3, "左上角"),
    near(s0.px(s0.w - 3, 2), SOLID, 3, "右上角"),
    near(s0.px(2, s0.h - 3), SOLID, 3, "左下角"),
    near(s0.px(s0.w - 3, s0.h - 3), SOLID, 3, "右下角"),
    near(s0.px(s0.w >> 1, 1), SOLID, 3, "顶边中点"),
    near(s0.px(s0.w >> 1, s0.h - 2), SOLID, 3, "底边中点"),
    near(s0.px(1, s0.h >> 1), SOLID, 3, "左边中点"),
    near(s0.px(s0.w - 2, s0.h >> 1), SOLID, 3, "右边中点"),
  ];
  for (const r of edges0) check(`blur0 ${r.label}为图色`, r.ok, `Δ${r.d}`);

  // —— ② blur 40：几何外扩 1.5×半径、四沿仍不透底 ——
  await setBg({ bgImageBlur: 40 });
  await sleep(500);
  const g40 = await geometry();
  check(
    `blur40 盒子四边外扩 ${BLEED40}px`,
    g40.x === -BLEED40 && g40.y === -BLEED40 && g40.w === g40.W + BLEED40 * 2 && g40.h === g40.H + BLEED40 * 2,
    JSON.stringify({ x: g40.x, y: g40.y, w: g40.w, h: g40.h }),
  );
  check("blur40 filter=blur(40px) 且无 transform", g40.filter === "blur(40px)" && g40.transform === "none",
    `filter=${g40.filter} transform=${g40.transform}`);
  const s40 = await screenshot(ws, sessionId, "bg-solid-blur40.png");
  const edges40 = [
    near(s40.px(2, 2), SOLID, 3, "左上角"),
    near(s40.px(s40.w - 3, 2), SOLID, 3, "右上角"),
    near(s40.px(2, s40.h - 3), SOLID, 3, "左下角"),
    near(s40.px(s40.w - 3, s40.h - 3), SOLID, 3, "右下角"),
    near(s40.px(s40.w >> 1, 1), SOLID, 3, "顶边中点"),
    near(s40.px(s40.w >> 1, s40.h - 2), SOLID, 3, "底边中点"),
    near(s40.px(1, s40.h >> 1), SOLID, 3, "左边中点"),
    near(s40.px(s40.w - 2, s40.h >> 1), SOLID, 3, "右边中点"),
    near(s40.px(s40.w >> 1, s40.h >> 1), SOLID, 3, "中心"),
  ];
  for (const r of edges40) check(`blur40 ${r.label}不透底`, r.ok, `${r.label} Δ${r.d}`);

  // —— ②' blur 1：最小档外扩 2px 不透底 ——
  await setBg({ bgImageBlur: 1 });
  await sleep(400);
  const g1 = await geometry();
  check("blur1 盒子外扩 2px", g1.x === -2 && g1.y === -2 && g1.w === g1.W + 4 && g1.h === g1.H + 4,
    JSON.stringify({ x: g1.x, y: g1.y, w: g1.w, h: g1.h }));
  const s1 = await screenshot(ws, sessionId);
  const e1 = near(s1.px(s1.w - 2, s1.h >> 1), SOLID, 3, "右边中点");
  check("blur1 右边中点不透底", e1.ok, `Δ${e1.d}`);

  // —— ③ 取景稳定：四色条带 cover，边界位置随 blur 的移动 = 外扩量 ——
  await setBg({ bgImageBlur: 0, bgImage: "split" });
  await sleep(500);
  const W = g0.W;
  const H = g0.H;
  const sb0 = await screenshot(ws, sessionId, "bg-strip-blur0.png");
  const b0 = stripeBoundaries(sb0, H >> 1, STRIPES, W);
  // cover：scale = H/1000（2:1 图在 1.6:1 窗口按高约束），边界 x = W/2 + (500k-1000)*scale
  const s0scale = H / 1000;
  const want0 = [1, 2, 3].map((k) => W / 2 + (500 * k - 1000) * s0scale);
  check(
    "blur0 条带边界位置符合 cover 公式",
    b0.length === 3 && b0.every((x, i) => Math.abs(x - want0[i]) <= 3),
    `got ${JSON.stringify(b0)} want ${JSON.stringify(want0.map((x) => Math.round(x)))}`,
  );
  await setBg({ bgImageBlur: 40 });
  await sleep(500);
  const sb40 = await screenshot(ws, sessionId, "bg-strip-blur40.png");
  const b40 = stripeBoundaries(sb40, H >> 1, STRIPES, W);
  const s40scale = (H + BLEED40 * 2) / 1000;
  const want40 = [1, 2, 3].map((k) => W / 2 + (500 * k - 1000) * s40scale);
  check(
    "blur40 条带边界只随外扩重排（±8px）",
    b40.length === 3 && b40.every((x, i) => Math.abs(x - want40[i]) <= 8),
    `got ${JSON.stringify(b40)} want ${JSON.stringify(want40.map((x) => Math.round(x)))}（旧 scale 实现会移 ~360px）`,
  );
  const drifts = b40.map((x, i) => x - b0[i]);
  check(
    "调模糊度不再缩放画面（外边界漂移 = bleed）",
    drifts.every((d, i) => Math.abs(Math.abs(d) - (i === 1 ? 0 : BLEED40)) <= 10),
    JSON.stringify(drifts),
  );

  // —— ④ 契合/对齐语义 ——
  await setBg({ bgImageBlur: 0, bgImage: "split", bgImageFit: "uniform" });
  await sleep(400);
  const sc = await screenshot(ws, sessionId);
  // contain：1440×720 居中，上下 90px 留边 = body 底色
  const topBar = near(sc.px(W >> 1, 10), bodyBg, 4, "contain 顶留边");
  const botBar = near(sc.px(W >> 1, H - 11), bodyBg, 4, "contain 底留边");
  const midRed = near(sc.px((W >> 1) - 300, H >> 1), STRIPES[1], 6, "contain 中部左二条带");
  check("contain 顶部留边为底色", topBar.ok, `Δ${topBar.d}`);
  check("contain 底部留边为底色", botBar.ok, `Δ${botBar.d}`);
  check("contain 中部仍是图（绿条带）", midRed.ok, `Δ${midRed.d}`);

  await setBg({ bgImage: "splitTB", bgImageFit: "uniform", bgImageVAlign: "start" });
  await sleep(400);
  const sa = await screenshot(ws, sessionId);
  const topRed = near(sa.px(W >> 1, 15), STRIPES[0], 6, "顶对齐顶部红");
  const botBg = near(sa.px(W >> 1, H - 15), bodyBg, 4, "顶对齐底部留边");
  check("垂直对齐 start：图贴顶", topRed.ok, `Δ${topRed.d}`);
  check("垂直对齐 start：底部留边为底色", botBg.ok, `Δ${botBg.d}`);
  await setBg({ bgImageVAlign: "end" });
  await sleep(400);
  const sb = await screenshot(ws, sessionId);
  const topBg = near(sb.px(W >> 1, 15), bodyBg, 4, "底对齐顶部留边");
  const botBlue = near(sb.px(W >> 1, H - 15), STRIPES[2], 6, "底对齐底部蓝");
  check("垂直对齐 end：顶部留边为底色", topBg.ok, `Δ${topBg.d}`);
  check("垂直对齐 end：图贴底", botBlue.ok, `Δ${botBlue.d}`);

  // —— 回归：blur 归零恢复无滤镜几何 ——
  await setBg({ bgImageBlur: 0, bgImageFit: "uniformToFill", bgImageVAlign: "center" });
  await sleep(400);
  const gr = await geometry();
  check("模糊归零恢复几何", gr.x === 0 && gr.y === 0 && gr.w === gr.W && gr.h === gr.H && gr.filter === "none",
    JSON.stringify({ x: gr.x, y: gr.y, w: gr.w, h: gr.h, filter: gr.filter }));

  console.log("  截图证据目录：" + SHOTS);
  console.log(failures === 0 ? "\n背景图渲染自查全部通过" : `\n${failures} 项失败`);
} finally {
  spawnSync("taskkill", ["/PID", String(edge.pid), "/T", "/F"], { stdio: "ignore" });
  spawnSync("taskkill", ["/PID", String(vite.pid), "/T", "/F"], { stdio: "ignore" });
  spawnSync(
    "powershell",
    ["-NoProfile", "-Command",
     `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -match 'remote-debugging-port=${CDP}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`],
    { stdio: "ignore" },
  );
}
process.exit(failures === 0 ? 0 : 1);
