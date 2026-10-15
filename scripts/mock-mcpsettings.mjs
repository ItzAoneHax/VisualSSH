/**
 * MCP 设置分区 mock 自查（dev 4273 + Edge headless CDP 注入 mock invoke）：
 * 断言重写后的 McpSection 布局规范（gap 容器/group-title/无 ! hack/
 * expander 分组/分段选择/NumberBox clamp/令牌显隐/审计行）并截图目检。
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";

const PORT = 4273;
const CDP = 9345;
const SHOTS = join(process.cwd(), ".zcode-shots");
mkdirSync(SHOTS, { recursive: true });

function kill(pattern) {
  const out = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `Get-CimInstance Win32_Process -Filter "Name='node.exe' or Name='msedge.exe'" | Where-Object { $_.CommandLine -match '${pattern}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`,
    ],
    { encoding: "utf8" },
  );
  return out.stdout.trim();
}
// 清残留（严格端口 + 独立 CDP 口防串场）
kill(`vite.*--port ${PORT}`);
kill(`remote-debugging-port=${CDP}`);

const vite = spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], {
  shell: true,
  stdio: "ignore",
});
const edgeProfile = join(homedir(), "AppData", "Local", "Temp", `vssh-mcp-${Date.now()}`);
const edge = spawn(
  join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe"),
  [
    "--headless=new",
    // 三保险：即使 headless 在个别版本失效为有头，窗口也在屏幕外且最小化
    "--window-position=-32000,-32000",
    "--start-minimized",
    `--remote-debugging-port=${CDP}`,
    `--user-data-dir=${edgeProfile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
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

const MOCK_JS = `(() => {
  if (window.__mock) return;
  // localStorage 清持久键（session 恢复等防干扰）
  for (const k of Object.keys(localStorage)) if (k.startsWith('visualssh:')) localStorage.removeItem(k);

  const state = {
    config: {
      enabled: true, port: 27117,
      token: 'f'.repeat(8) + '-' + '0123456789abcdef'.repeat(3) + 'ab',
      approved: true, confirmDelete: false, confirmExec: false, confirmOverwrite: false,
    },
    status: { running: true, enabled: true, port: 27117, error: null },
    audit: [
      { id: 1, atMs: Date.now() - 300000, via: 'http',  tool: 'list_dir',   outcome: 'ok',    detail: '/var/www（45ms）', args: { path: '/var/www' } },
      { id: 2, atMs: Date.now() - 90000,  via: 'http',  tool: 'write_file', outcome: 'error', detail: '/etc/nginx/nginx.conf：操作超时（30s）', args: { path: '/etc/nginx/nginx.conf' } },
      { id: 3, atMs: Date.now() - 4000,   via: 'stdio', tool: 'exec',       outcome: 'ok',    detail: 'exec「systemctl status nginx」（320ms）', args: { command: 'systemctl status nginx' } },
    ],
    calls: [],
  };
  const snippets = {
    guides: [
      { key: 'zcode', name: 'ZCode', steps: ['打开 设置 → MCP，新建服务器，按下面填写（表单模式）：', '名称：visualssh', '类型：stdio（本地命令）', '命令：C:\\\\VisualSSH.exe', '参数：mcp'], code: '// ~/.zcode/cli/config.json → mcp.servers' },
      { key: 'claude-code', name: 'Claude Code', steps: ['在终端执行：'], code: 'claude mcp add visualssh -- "C:\\\\VisualSSH.exe" mcp' },
      { key: 'generic', name: '其他工具（通用）', steps: ['任何支持 MCP 的工具都能接入，两种方式任选其一：', '· 本地命令：命令填 C:\\\\VisualSSH.exe，参数填 mcp'], code: '{ "mcpServers": { "visualssh": { "command": "C:\\\\VisualSSH.exe", "args": ["mcp"] } } }' },
    ],
    httpUrl: 'http://127.0.0.1:27117/mcp',
    httpToken: state.config.token,
    exePath: 'C:\\\\VisualSSH.exe',
  };
  const handlers = {
    mcp_get_config: () => state.config,
    mcp_status: () => state.status,
    mcp_audit_list: ({ sinceId }) => state.audit.filter((e) => e.id > (sinceId ?? 0)),
    mcp_audit_stats: () => ({ total: state.audit.length, diskBytes: 4096, buffered: 2, degraded: null }),
    mcp_audit_export: () => state.audit.length,
    mcp_audit_clear: () => { state.audit = []; },
    mcp_snippets: () => snippets,
    mcp_set_config: (args) => {
      const patch = args.patch ?? {};
      state.calls.push(['mcp_set_config', JSON.stringify(patch)]);
      Object.assign(state.config, patch);
      if (patch.port) state.config.port = Math.max(1024, Math.min(65535, patch.port));
      state.status = { running: state.config.enabled, enabled: state.config.enabled, port: state.config.port, error: null };
      return state.status;
    },
    mcp_reset_token: () => { state.config.token = 'n'.repeat(64); return state.config; },
    mcp_reset_approval: () => { state.config.approved = false; },
  };
  window.__mock = {
    state,
    internals: {
      invoke: async (cmd, args) => {
        state.calls.push([cmd, args ? JSON.stringify(args).slice(0, 80) : '']);
        if (handlers[cmd]) return handlers[cmd](args ?? {});
        throw new Error(\`unmocked command: \${cmd}\`);
      },
      transformCallback: () => 0,
      unregisterCallback: () => {},
    },
  };
  window.__TAURI_INTERNALS__ = window.__mock.internals;
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

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`  ok ${name}`);
  else { failures++; console.error(`  FAIL ${name} ${detail}`); }
}

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
  // 导航结果校验：若加载失败（Edge 可能停在有头错误页），立即失败并收场
  const navOk = await evalJs(ws, sessionId, `(() => ({
    url: location.href,
    ready: document.readyState,
    hasApp: !!document.querySelector('#app'),
  }))()`).catch(() => null);
  if (!navOk || !navOk.url.includes(String(PORT)) || !navOk.hasApp) {
    throw new Error(`页面未加载成功: ${JSON.stringify(navOk)}（vite ${PORT} 是否就绪？）`);
  }
  // 双保险：若 early-injection 未生效（语法/时序问题会在此直接暴露）
  await evalJs(ws, sessionId, MOCK_JS);

  // 轮询等应用挂载 + 进入设置页（dev 首载含依赖预打包，时长抖动大）
  let base = null;
  for (let i = 0; i < 40 && !base; i++) {
    base = await evalJs(ws, sessionId, `(() => {
      const el = document.querySelector('#app');
      const app = el && el.__vue_app__;
      if (!app) return null;
      app._context.config.globalProperties.$pinia._s.get('settings').openSettings();
      return 'ok';
    })()`).catch(() => null);
    if (!base) await sleep(500);
  }
  check("进入设置页", base === "ok");
  await sleep(600);

  // 切到 MCP 分区
  await evalJs(ws, sessionId, `(() => {
    const btns = [...document.querySelectorAll('.nav-item')];
    const mcp = btns.find((b) => b.textContent.includes('MCP'));
    if (!mcp) throw new Error('MCP 导航项不存在');
    mcp.click();
  })()`);
  await sleep(500);

  const layout = await evalJs(ws, sessionId, `(() => {
    const root = document.querySelector('.max-w-3xl');
    return {
      groupTitles: [...root.querySelectorAll('.settings-group-title')].map((e) => e.textContent.trim()),
      gapContainers: root.querySelectorAll(':scope > div.flex.flex-col.gap-1').length,
      cards: root.querySelectorAll(':scope > div.flex.flex-col.gap-1 > .settings-card').length,
      expanders: root.querySelectorAll('.settings-expander').length,
      important: [...root.querySelectorAll('[class*="!"]')].length,
      textBoldTitles: [...root.querySelectorAll('.settings-card > div > p:first-child')].every((p) => p.className.includes('font-medium')),
    };
  })()`);
  check("四节分组标题（服务/安全/Agent 接入/审计）", JSON.stringify(layout.groupTitles) === JSON.stringify(["服务", "安全", "Agent 接入", "审计"]), JSON.stringify(layout.groupTitles));
  check("四节 gap-1 卡片容器", layout.gapContainers === 4, `got ${layout.gapContainers}`);
  check("卡片间距容器的直接子卡 = 4（开关/端口/令牌/批准）", layout.cards === 4, `got ${layout.cards}`);
  check("三个 SettingsExpander 分组", layout.expanders === 3, `got ${layout.expanders}`);
  check("模板零 ! important hack", layout.important === 0, `got ${layout.important}`);
  check("卡片标题 font-medium", layout.textBoldTitles === true);

  const debug = await evalJs(ws, sessionId, `window.__mock ? window.__mock.state.calls.filter((c) => c[0].startsWith('mcp')).slice(0, 6) : 'no-mock'`);
  console.log("  [debug] mcp 调用记录:", JSON.stringify(debug));

  // NumberBox：初值 + 非法输入回退 + clamp
  const portBox = await evalJs(ws, sessionId, `(() => {
    const inputs = [...document.querySelectorAll('input')].map((i) => ({ label: i.getAttribute('aria-label'), value: i.value }));
    const cards = [...document.querySelectorAll('.settings-card')].map((c) => c.querySelector('p')?.textContent);
    const input = document.querySelector('input[aria-label^="MCP HTTP 端口"]');
    if (!input) return { inputs, cards };
    return { value: input.value, width: input.parentElement.getBoundingClientRect().width };
  })()`);
  check("端口 NumberBox 渲染 27117（右侧控件位）", !!portBox && portBox.value === "27117", JSON.stringify(portBox));

  await evalJs(ws, sessionId, `(() => {
    const input = document.querySelector('input[aria-label^="MCP HTTP 端口"]');
    input.value = 'abc'; input.dispatchEvent(new Event('input')); input.dispatchEvent(new Event('blur'));
  })()`);
  await sleep(150);
  const badPort = await evalJs(ws, sessionId, `document.querySelector('input[aria-label^="MCP HTTP 端口"]').value`);
  check("非法端口输入回退旧值", badPort === "27117", `got ${badPort}`);

  await evalJs(ws, sessionId, `(() => {
    const input = document.querySelector('input[aria-label^="MCP HTTP 端口"]');
    input.value = '80'; input.dispatchEvent(new Event('input')); input.dispatchEvent(new Event('blur'));
  })()`);
  await sleep(200);
  const clamped = await evalJs(ws, sessionId, `document.querySelector('input[aria-label^="MCP HTTP 端口"]').value`);
  check("越界端口 clamp 到 1024", clamped === "1024", `got ${clamped}`);
  // 恢复端口值
  await evalJs(ws, sessionId, `(() => {
    const input = document.querySelector('input[aria-label^="MCP HTTP 端口"]');
    input.value = '27117'; input.dispatchEvent(new Event('input')); input.dispatchEvent(new Event('blur'));
  })()`);
  await sleep(200);

  // 令牌：掩码 + 眼睛切换
  const tokenMasked = await evalJs(ws, sessionId, `document.querySelector('.settings-card .truncate.font-mono').textContent`);
  check("令牌默认掩码", tokenMasked.includes("•"), `got ${tokenMasked.slice(0, 8)}`);
  await evalJs(ws, sessionId, `document.querySelector('button[aria-label="显示令牌"]').click()`);
  await sleep(150);
  const tokenShown = await evalJs(ws, sessionId, `document.querySelector('.settings-card .truncate.font-mono').textContent`);
  check("眼睛切换明文", tokenShown.startsWith("ffffffff"), `got ${tokenShown.slice(0, 8)}`);

  // 危险操作拦截 expander：展开 + 三子行（无图标 + font-medium + toggle）
  await evalJs(ws, sessionId, `[...document.querySelectorAll('.settings-expander-header')].find((h) => h.textContent.includes('危险操作拦截')).click()`);
  await sleep(400);
  const intercept = await evalJs(ws, sessionId, `(() => {
    const exp = [...document.querySelectorAll('.settings-expander')].find((e) => e.textContent.includes('删除文件/目录前确认'));
    const items = exp.querySelectorAll('.settings-expander-item');
    return {
      count: items.length,
      noIcon: [...items].every((i) => !i.querySelector('svg') || i.querySelectorAll('svg').length === 0 || [...i.querySelectorAll('svg')].every(s => s.closest('button'))),
      titles: [...items].map((i) => i.querySelector('p').className.includes('font-medium')),
      toggles: exp.querySelectorAll('.toggle-switch').length,
    };
  })()`);
  check("拦截分组三子行", intercept.count === 3, `got ${intercept.count}`);
  check("子行无装饰图标（仅按钮内 svg）", intercept.noIcon === true);
  check("子行标题 font-medium", intercept.titles.every(Boolean));
  check("子行各带开关", intercept.toggles === 3);

  // 接入方法 expander：通用信息 + 工具下拉 + 步骤/代码块随选择切换
  await evalJs(ws, sessionId, `[...document.querySelectorAll('.settings-expander-header')].find((h) => h.textContent.includes('接入方法'))?.click()`);
  await sleep(400);
  const guide1 = await evalJs(ws, sessionId, `(() => {
    const exp = [...document.querySelectorAll('.settings-expander')].find((e) => e.querySelector('ol'));
    return {
      generic: exp.textContent.includes('任何支持 MCP 的工具都能接入'),
      steps: [...exp.querySelectorAll('ol li')].map((li) => li.textContent.trim()),
      code: exp.querySelector('pre')?.textContent ?? '',
    };
  })()`);
  check("接入区含通用连接信息", guide1.generic === true);
  check("默认 ZCode 表单步骤（名称/类型/命令/参数）", guide1.steps.some((t) => t.includes('名称：visualssh')) && guide1.steps.some((t) => t.includes('参数：mcp')), JSON.stringify(guide1.steps).slice(0, 120));
  check("ZCode 代码块（JSON 备选）", guide1.code.includes('mcp.servers'));
  // 下拉切换到「其他工具（通用）」
  await evalJs(ws, sessionId, `[...document.querySelectorAll('.settings-expander button')].find((b) => b.getAttribute('aria-label')?.includes('接入工具'))?.click()`);
  await sleep(200);
  await evalJs(ws, sessionId, `[...document.querySelectorAll('[role="menuitem"]')].find((m) => m.textContent.includes('其他工具'))?.click()`);
  await sleep(200);
  const guide2 = await evalJs(ws, sessionId, `[...document.querySelectorAll('.settings-expander')].find((e) => e.querySelector('ol')).querySelector('pre')?.textContent ?? ''`);
  check("切换到通用指南（标准 mcpServers 片段）", guide2.includes('mcpServers') && guide2.includes('args'), guide2.slice(0, 60));

  // 审计 expander：三行倒序 + 结果色
  await evalJs(ws, sessionId, `[...document.querySelectorAll('.settings-expander-header')].find((h) => h.textContent.includes('调用审计')).click()`);
  await sleep(400);
  const auditRows = await evalJs(ws, sessionId, `(() => {
    const exp = [...document.querySelectorAll('.settings-expander')].find((e) => e.querySelector('.max-h-72'));
    const rows = [...exp.querySelectorAll('.max-h-72 > div')];
    const first = rows[0];
    return {
      count: rows.length,
      newestIsExec: first?.textContent.includes('exec'),
      hasDanger: rows.some((r) => r.querySelector('.text-danger')),
      hasLive: rows.some((r) => r.querySelector('.text-live')),
    };
  })()`);
  check("审计三行倒序（最新在前）", auditRows.count === 3 && auditRows.newestIsExec, JSON.stringify(auditRows));
  check("审计结果着色（成功 live / 失败 danger）", auditRows.hasDanger && auditRows.hasLive);

  const statsBar = await evalJs(ws, sessionId, `[...document.querySelectorAll('.settings-expander')].find((e) => e.querySelector('.max-h-72'))?.textContent.includes('共 3 条') ?? false`);
  check("统计条显示总量与磁盘占用", statsBar === true);

  // 确认弹窗：人读文案 + 原始指令展开 + 拒绝收场
  await evalJs(ws, sessionId, `(() => {
    const pinia = document.querySelector('#app').__vue_app__._context.config.globalProperties.$pinia;
    pinia._s.get('mcpGate').push({
      id: 99901,
      summary: '递归删除 /var/www/build（目录及其全部内容，不可恢复）',
      raw: '{ "path": "/var/www/build", "recursive": true }',
    });
  })()`);
  await sleep(300);
  const dlg1 = await evalJs(ws, sessionId, `(() => {
    const dialog = document.querySelector('[role="dialog"]');
    return {
      open: !!dialog,
      readable: dialog?.textContent.includes('递归删除 /var/www/build'),
      hasExpand: [...(dialog?.querySelectorAll('button') ?? [])].some((b) => b.textContent.includes('查看原始指令')),
      rawVisible: !!dialog?.querySelector('pre'),
    };
  })()`);
  check("弹窗显示人读文案", dlg1.open && dlg1.readable, JSON.stringify(dlg1));
  check("原始指令默认折叠", dlg1.hasExpand && !dlg1.rawVisible);
  await evalJs(ws, sessionId, `[...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.includes('查看原始指令'))?.click()`);
  await sleep(200);
  const dlg2 = await evalJs(ws, sessionId, `document.querySelector('[role="dialog"] pre')?.textContent ?? ''`);
  check("展开显示原始指令（参数 JSON）", dlg2.includes("recursive") && dlg2.includes("/var/www/build"), dlg2.slice(0, 60));
  await evalJs(ws, sessionId, `[...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.trim() === '拒绝')?.click()`);
  await sleep(200);
  const dlg3 = await evalJs(ws, sessionId, `!document.querySelector('[role="dialog"]')`);
  check("拒绝后弹窗关闭", dlg3 === true);

  // 截图目检：折叠态 + 全展开态各一张
  const shot = await send(ws, "Page.captureScreenshot", { format: "png" }, sessionId);
  writeFileSync(join(SHOTS, "mcp-settings.png"), Buffer.from(shot.data, "base64"));
  // 只展开未展开的（测试阶段已展开的直接跳过——再点会收起）
  await evalJs(ws, sessionId, `[...document.querySelectorAll('.settings-expander-header')].filter((h) => h.getAttribute('aria-expanded') !== 'true').forEach((h) => h.click())`);
  await sleep(600);
  // 审计分组滚入视口（展开后内容超一屏）
  await evalJs(ws, sessionId, `document.querySelector('.max-h-72')?.scrollIntoView({ block: 'center' })`);
  await sleep(300);
  const expStates = await evalJs(ws, sessionId, `[...document.querySelectorAll('.settings-expander-header')].map((h) => h.getAttribute('aria-expanded'))`);
  console.log("  [debug] expander aria-expanded:", JSON.stringify(expStates));
  if (!expStates.every((v) => v === "true")) throw new Error("截图前分组未全部展开: " + JSON.stringify(expStates));
  const shotOpen = await send(ws, "Page.captureScreenshot", { format: "png" }, sessionId);
  writeFileSync(join(SHOTS, "mcp-settings-open.png"), Buffer.from(shotOpen.data, "base64"));
  console.log(`  截图：${join(SHOTS, "mcp-settings.png")} / mcp-settings-open.png`);

  console.log(failures === 0 ? "\nMCP 设置分区自查全部通过" : `\n${failures} 项失败`);
} finally {
  spawnSync("taskkill", ["/PID", String(edge.pid), "/T", "/F"], { stdio: "ignore" });
  spawnSync("taskkill", ["/PID", String(vite.pid), "/T", "/F"], { stdio: "ignore" });
  // 保险：按 CDP 端口匹配清杀本次脚本的全部 Edge 真身（launcher 退出后 /T 可能漏杀）
  spawnSync(
    "powershell",
    ["-NoProfile", "-Command",
     `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -match 'remote-debugging-port=${CDP}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`],
    { stdio: "ignore" },
  );
}
process.exit(failures === 0 ? 0 : 1);
