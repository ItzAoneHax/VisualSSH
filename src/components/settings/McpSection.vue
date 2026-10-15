<script setup lang="ts">
/**
 * MCP 分区：Agent 接入（ZCode / DeepSeek Harness / OpenCode 等 harness 经
 * MCP 使用 VisualSSH 的远端文件系统与命令）。配置实体在 Rust 侧 mcp.json。
 * 布局规范同其余分区：flex flex-col gap-1 卡片容器 + settings-group-title 分节 +
 * SettingsExpander 承载多行分组（危险操作拦截 / 配置片段 / 审计）。
 */

import {
  Bot,
  Check,
  Copy,
  Download,
  Eye,
  EyeOff,
  KeyRound,
  RefreshCw,
  ScrollText,
  ShieldAlert,
  ShieldCheck,
  Terminal,
} from "@lucide/vue";
import { computed, onMounted, ref } from "vue";

import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";

import {
  mcpAuditClear,
  mcpAuditExport,
  mcpAuditList,
  mcpAuditStats,
  mcpGetConfig,
  mcpResetApproval,
  mcpResetToken,
  mcpSetConfig,
  mcpSnippets,
  mcpStatus,
  type McpAuditEntry,
  type McpAuditStats,
  type McpConfig,
  type McpSnippets,
  type McpStatus,
} from "@/api/mcp";
import SettingsExpander from "@/components/settings/SettingsExpander.vue";
import SettingsSelect from "@/components/settings/SettingsSelect.vue";
import SettingsNumberBox from "@/components/settings/SettingsNumberBox.vue";
import { useToastStore } from "@/stores/toast";

const config = ref<McpConfig | null>(null);
const status = ref<McpStatus | null>(null);
const snippets = ref<McpSnippets | null>(null);
const audit = ref<McpAuditEntry[]>([]);
const auditStats = ref<McpAuditStats | null>(null);
const toast = useToastStore();
const showToken = ref(false);
const copiedWhat = ref<string | null>(null);
const guideKey = ref("zcode");

const guideOptions = computed(() =>
  (snippets.value?.guides ?? []).map((g) => ({ key: g.key, label: g.name })),
);
const currentGuide = computed(
  () => snippets.value?.guides.find((g) => g.key === guideKey.value) ?? null,
);

async function refresh(withAudit = true) {
  const jobs: Promise<void>[] = [
    mcpGetConfig()
      .then((v) => void (config.value = v))
      .catch(() => {}),
    mcpStatus()
      .then((v) => void (status.value = v))
      .catch(() => {}),
    mcpSnippets()
      .then((v) => void (snippets.value = v))
      .catch(() => {}),
  ];
  if (withAudit) {
    jobs.push(
      mcpAuditList(0, 100)
        .then((v) => void (audit.value = v))
        .catch(() => {}),
      mcpAuditStats()
        .then((v) => void (auditStats.value = v))
        .catch(() => {}),
    );
  }
  await Promise.all(jobs);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 导出全量审计（解压 JSONL）；保存位置由对话框选择 */
async function exportAudit() {
  const dest = await saveDialog({
    title: "导出 MCP 调用审计",
    defaultPath: "visualssh-mcp-audit.jsonl",
    filters: [{ name: "JSONL", extensions: ["jsonl", "txt"] }],
  });
  if (!dest) return;
  try {
    const count = await mcpAuditExport(dest);
    toast.show(`已导出 ${count} 条调用记录`, {
      label: "打开所在文件夹",
      run: () => void revealItemInDir(dest).catch(() => {}),
    });
  } catch (e) {
    toast.show(`导出失败：${e}`);
  }
  await refresh();
}

async function clearAudit() {
  await mcpAuditClear().catch(() => {});
  await refresh();
}

async function patch(patchObj: Parameters<typeof mcpSetConfig>[0]) {
  status.value = await mcpSetConfig(patchObj).catch(() => null);
  await refresh(false);
}

async function resetToken() {
  config.value = await mcpResetToken().catch(() => config.value);
  await refresh(false);
}

async function resetApproval() {
  await mcpResetApproval().catch(() => {});
  await refresh(false);
}

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    copiedWhat.value = what;
    setTimeout(() => {
      if (copiedWhat.value === what) copiedWhat.value = null;
    }, 1600);
  } catch {
    // 剪贴板不可用（权限）：无操作
  }
}


const outcomeLabel: Record<McpAuditEntry["outcome"], string> = {
  ok: "成功",
  error: "失败",
  denied: "拒绝",
  timeout: "超时",
  trimmed: "清理",
};

function formatTime(ms: number) {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

onMounted(() => {
  if ("__TAURI_INTERNALS__" in window) void refresh();
});
</script>

<template>
  <h2 class="text-xl font-semibold">MCP（Agent 接入）</h2>
  <p class="mt-1 mb-4 text-xs text-dim">
    允许 AI 编程助手（ZCode、OpenCode、DeepSeek Harness 等）借助 MCP 使用你的服务器连接：
    查看、编辑远端文件，执行命令，收发文件。密码等凭据只保存在系统加密存储中，不会提供给对方。
  </p>

  <p class="settings-group-title">服务</p>
  <div class="flex flex-col gap-1">
    <!-- 服务总开关 -->
    <div class="settings-card">
      <Bot :size="20" class="shrink-0 text-dim" />
      <div class="min-w-0 flex-1">
        <p class="text-sm font-medium">MCP 服务</p>
        <p class="mt-0.5 text-xs text-dim">
          <template v-if="status?.running">运行中 · 端口 {{ status.port }}</template>
          <template v-else-if="config?.enabled">
            未正常运行{{ status?.error ? `：${status.error}` : "（端口可能被占用）" }}
          </template>
          <template v-else>已关闭，AI 编程助手将无法连接</template>
        </p>
      </div>
      <button
        type="button"
        role="switch"
        :aria-checked="!!config?.enabled"
        class="toggle-switch"
        :class="config?.enabled && 'on'"
        @click="patch({ enabled: !config?.enabled })"
      >
        <span class="toggle-knob" />
      </button>
    </div>

    <!-- HTTP 端口 -->
    <div class="settings-card">
      <Terminal :size="20" class="shrink-0 text-dim" />
      <div class="min-w-0 flex-1">
        <p class="text-sm font-medium">HTTP 端口</p>
        <p class="mt-0.5 text-xs text-dim">仅限本机访问，外部设备无法连接；修改后立即生效。</p>
      </div>
      <SettingsNumberBox
        v-if="config"
        :model-value="config.port"
        :min="1024"
        :max="65535"
        label="MCP HTTP 端口"
        @update:model-value="(port) => patch({ port })"
      />
    </div>

    <!-- 访问令牌 -->
    <div class="settings-card">
      <KeyRound :size="20" class="shrink-0 text-dim" />
      <div class="min-w-0 flex-1">
        <p class="text-sm font-medium">访问令牌</p>
        <p class="mt-0.5 truncate font-mono text-xs text-dim" :title="config?.token">
          {{ showToken ? config?.token : "•".repeat(48) }}
        </p>
      </div>
      <div class="flex shrink-0 items-center gap-1">
        <button
          type="button"
          class="btn-icon"
          :aria-label="showToken ? '隐藏令牌' : '显示令牌'"
          @click="showToken = !showToken"
        >
          <Eye v-if="!showToken" :size="16" />
          <EyeOff v-else :size="16" />
        </button>
        <button
          type="button"
          class="btn-icon"
          aria-label="复制令牌"
          title="复制令牌"
          @click="config && copy(config.token, 'token')"
        >
          <Check v-if="copiedWhat === 'token'" :size="16" class="text-live" />
          <Copy v-else :size="16" />
        </button>
        <button type="button" class="btn-secondary" @click="resetToken">重置</button>
      </div>
    </div>
  </div>

  <p class="settings-group-title">安全</p>
  <div class="flex flex-col gap-1">
    <!-- 首次接入批准 -->
    <div class="settings-card">
      <ShieldCheck :size="20" class="shrink-0 text-dim" />
      <div class="min-w-0 flex-1">
        <p class="text-sm font-medium">接入批准</p>
        <p class="mt-0.5 text-xs text-dim">
          {{
            config?.approved
              ? "已批准过至少一次接入，之后连接不再逐一询问。"
              : "下一次接入时会先弹出确认窗口，经你同意后才能使用。"
          }}
        </p>
      </div>
      <button v-if="config?.approved" type="button" class="btn-secondary shrink-0" @click="resetApproval">
        撤销批准
      </button>
    </div>

    <!-- 危险操作拦截（多行分组 = SettingsExpander） -->
    <SettingsExpander
      :icon="ShieldAlert"
      title="危险操作拦截"
      description="开启后，AI 执行对应操作前会弹出确认窗口（25 秒内未确认视为拒绝）。默认全部直接执行，适合无人值守的任务。"
    >
      <template #items>
        <div class="settings-expander-item">
          <div class="min-w-0 flex-1">
            <p class="text-sm font-medium">删除文件/目录前确认</p>
          </div>
          <button
            type="button"
            role="switch"
            :aria-checked="!!config?.confirmDelete"
            class="toggle-switch"
            :class="config?.confirmDelete && 'on'"
            @click="patch({ confirmDelete: !config?.confirmDelete })"
          >
            <span class="toggle-knob" />
          </button>
        </div>
        <div class="settings-expander-item">
          <div class="min-w-0 flex-1">
            <p class="text-sm font-medium">执行命令（exec）前确认</p>
          </div>
          <button
            type="button"
            role="switch"
            :aria-checked="!!config?.confirmExec"
            class="toggle-switch"
            :class="config?.confirmExec && 'on'"
            @click="patch({ confirmExec: !config?.confirmExec })"
          >
            <span class="toggle-knob" />
          </button>
        </div>
        <div class="settings-expander-item">
          <div class="min-w-0 flex-1">
            <p class="text-sm font-medium">覆盖已存在文件前确认</p>
          </div>
          <button
            type="button"
            role="switch"
            :aria-checked="!!config?.confirmOverwrite"
            class="toggle-switch"
            :class="config?.confirmOverwrite && 'on'"
            @click="patch({ confirmOverwrite: !config?.confirmOverwrite })"
          >
            <span class="toggle-knob" />
          </button>
        </div>
      </template>
    </SettingsExpander>
  </div>

  <p class="settings-group-title">Agent 接入</p>
  <div class="flex flex-col gap-1">
    <SettingsExpander
      :icon="Bot"
      title="接入方法"
      description="选择你使用的工具，按步骤完成接入；接入时若本程序尚未运行会自动启动。"
    >
      <template #items>
        <div class="flex flex-col gap-3 p-4">
          <!-- 通用连接信息：任何支持 MCP 的工具都按这两条接入 -->
          <p class="text-xs text-dim">
            任何支持 MCP 的工具都能接入——本地命令填
            <code class="font-mono text-ink">"{{ snippets?.exePath ?? "" }}" mcp</code>；
            或服务器地址填 <code class="font-mono text-ink">{{ snippets?.httpUrl ?? "" }}</code>，
            验证使用上方访问令牌。下面是常见工具的具体步骤：
          </p>
          <div class="flex items-center justify-between gap-2">
            <SettingsSelect
              :model-value="guideKey"
              :options="guideOptions"
              label="接入工具"
              @update:model-value="(k) => (guideKey = k)"
            />
            <button
              v-if="currentGuide?.code"
              type="button"
              class="btn-secondary shrink-0"
              @click="copy(currentGuide.code, 'guide')"
            >
              <Check v-if="copiedWhat === 'guide'" :size="12" class="text-live" />
              <Copy v-else :size="12" />
              复制
            </button>
          </div>
          <ol v-if="currentGuide" class="flex flex-col gap-1.5">
            <li
              v-for="(line, i) in currentGuide.steps"
              :key="i"
              class="flex gap-2 text-xs leading-5"
              :class="line.startsWith('·') ? 'text-dim' : 'text-ink'"
            >
              <span v-if="!line.startsWith('·')" class="mt-px shrink-0 font-mono text-dim">{{ i + 1 }}.</span>
              <span v-else class="shrink-0"></span>
              <span class="min-w-0 flex-1 break-words">{{ line }}</span>
            </li>
          </ol>
          <pre
            v-if="currentGuide?.code"
            class="overflow-x-auto rounded-[4px] p-2.5 font-mono text-xs leading-5"
            :style="{ background: 'var(--row-hover)' }"
            >{{ currentGuide.code }}</pre
          >
        </div>
      </template>
    </SettingsExpander>
  </div>

  <p class="settings-group-title">审计</p>
  <div class="flex flex-col gap-1">
    <SettingsExpander
      :icon="ScrollText"
      title="调用审计"
      description="完整记录每一次调用及其参数，压缩保存、占用极小，重启后仍可查看，也可导出留存。"
    >
      <template #control>
        <button
          type="button"
          class="btn-icon"
          aria-label="刷新审计"
          title="刷新"
          @click="refresh()"
        >
          <RefreshCw :size="16" />
        </button>
      </template>
      <template #items>
        <!-- 统计条 + 导出/清空 -->
        <div class="flex items-center justify-between gap-2 px-4 py-2">
          <p
            class="min-w-0 flex-1 truncate text-xs text-dim"
            :title="auditStats?.degraded ?? '完整的调用记录，含每次调用的参数'"
          >
            <template v-if="auditStats">
              共 {{ auditStats.total }} 条记录 · 占用 {{ formatBytes(auditStats.diskBytes) }}
              <template v-if="auditStats.buffered > 0"> · {{ auditStats.buffered }} 条正在保存</template>
              <template v-if="auditStats.degraded"> · ⚠ 新记录暂时只保存在内存中</template>
            </template>
            <template v-else>统计不可用</template>
          </p>
          <div class="flex shrink-0 items-center gap-1.5">
            <button type="button" class="btn-secondary" @click="exportAudit">
              <Download :size="12" />
              导出
            </button>
            <button type="button" class="btn-secondary" @click="clearAudit">清空</button>
          </div>
        </div>
        <div v-if="!audit.length" class="px-4 py-6 text-center text-xs text-dim">
          暂无调用记录
        </div>
        <div v-else class="max-h-72 overflow-y-auto">
          <div
            v-for="entry in [...audit].reverse()"
            :key="entry.id"
            class="flex items-baseline gap-2 px-4 py-1.5 font-mono text-xs"
          >
            <span class="shrink-0 text-dim">{{ formatTime(entry.atMs) }}</span>
            <span class="shrink-0" :class="entry.outcome === 'ok' ? 'text-live' : 'text-danger'">
              {{ outcomeLabel[entry.outcome] }}
            </span>
            <span class="shrink-0 text-dim">{{ entry.via }}</span>
            <span class="shrink-0 font-medium">{{ entry.tool }}</span>
            <span class="min-w-0 flex-1 truncate text-dim" :title="entry.detail">{{ entry.detail }}</span>
          </div>
        </div>
      </template>
    </SettingsExpander>
  </div>
</template>
