<script setup lang="ts">
import {
  ArrowDownUp,
  ArrowLeft,
  Code,
  Eye,
  Info,
  Palette,
  ShieldCheck,
  SlidersHorizontal,
  SquareTerminal,
  Trash2,
} from "@lucide/vue";
import { invoke } from "@tauri-apps/api/core";
import { onMounted, ref } from "vue";

import { useExplorerStore, SORT_KEYS, type SortKey } from "@/stores/explorer";
import { useSettingsStore, type ThemeMode } from "@/stores/settings";

/**
 * 设置页 —— 布局与卡片仿 files-community/Files（SidebarView 240px 导航 +
 * SettingsCard：图标/标题/说明/右侧控件）。设置取代了右上角的主题切换与
 * 「隐藏点开头的项目」菜单项，全部持久化于 localStorage。
 */

const settings = useSettingsStore();
const explorer = useExplorerStore();

type Section = "appearance" | "preferences" | "security" | "about";

const sections: { key: Section; label: string; icon: typeof Palette }[] = [
  { key: "appearance", label: "外观", icon: Palette },
  { key: "preferences", label: "首选项", icon: SlidersHorizontal },
  { key: "security", label: "SSH 安全", icon: ShieldCheck },
  { key: "about", label: "关于", icon: Info },
];

const section = ref<Section>("appearance");

const sectionTitles: Record<Section, string> = {
  appearance: "外观",
  preferences: "首选项",
  security: "SSH 安全",
  about: "关于",
};

const THEME_MODES: { key: ThemeMode; label: string }[] = [
  { key: "system", label: "跟随系统" },
  { key: "light", label: "浅色" },
  { key: "dark", label: "深色" },
];

const SORT_OPTIONS: { key: SortKey; label: string }[] = SORT_KEYS.map((key) => ({
  key,
  label: { name: "名称", mtime: "修改时间", kind: "类型", size: "大小", permissions: "权限" }[key],
}));

/** —— 控件们 —— */

function setTheme(mode: ThemeMode) {
  settings.update({ theme: mode });
}

/** 显示隐藏项：立即作用于当前浏览 */
function setShowHidden(value: boolean) {
  settings.update({ showHidden: value });
  explorer.showHidden = value;
}

function setDefaultSort(key: SortKey) {
  settings.update({ defaultSortKey: key });
}

function stepFontSize(which: "editorFontSize" | "terminalFontSize", delta: number) {
  const min = which === "editorFontSize" ? 11 : 10;
  const max = 20;
  const next = Math.min(max, Math.max(min, settings.settings[which] + delta));
  settings.update({ [which]: next });
}

/** —— known_hosts 管理 —— */

interface KnownHostRow {
  host: string;
  port: number;
  algorithm: string;
  fingerprint: string;
}

const knownHosts = ref<KnownHostRow[] | null>(null);

async function loadKnownHosts() {
  try {
    knownHosts.value = await invoke<KnownHostRow[]>("ssh_known_hosts_list");
  } catch {
    knownHosts.value = [];
  }
}

async function removeKnownHost(row: KnownHostRow) {
  try {
    await invoke("ssh_known_hosts_remove", { host: row.host, port: row.port });
  } catch {
    // 删除失败保留原列表
  }
  await loadKnownHosts();
}

onMounted(() => {
  void loadKnownHosts();
});
</script>

<template>
  <div class="flex h-full">
    <!-- 设置导航侧栏（Files SidebarView 240px） -->
    <aside class="flex w-60 shrink-0 flex-col py-2 pl-1.5">
      <div class="flex h-12 items-center px-4">
        <h1 class="text-xl font-semibold">设置</h1>
      </div>

      <nav aria-label="设置导航" class="mt-1">
        <button
          v-for="s in sections"
          :key="s.key"
          type="button"
          class="nav-item"
          :class="section === s.key && 'active'"
          @click="section = s.key"
        >
          <component :is="s.icon" :size="16" class="ml-1 shrink-0" />
          <span class="ml-3 truncate">{{ s.label }}</span>
        </button>
      </nav>
    </aside>

    <!-- 主列：标题行 + 内容卡 -->
    <div class="flex min-w-0 flex-1 flex-col gap-1 p-2 pl-2.5">
      <div
        class="flex h-12 shrink-0 items-center gap-1 rounded-lg px-1"
        :style="{ background: 'var(--toolbar)', border: '1px solid var(--line)' }"
      >
        <button
          type="button"
          class="btn-icon"
          title="返回"
          aria-label="返回"
          @click="settings.closeSettings()"
        >
          <ArrowLeft :size="16" />
        </button>
        <span class="ml-1.5 text-sm font-semibold">{{ sectionTitles[section] }}</span>
      </div>

      <div
        class="min-h-0 flex-1 overflow-y-auto rounded-lg"
        :style="{ background: 'var(--panel)', border: '1px solid var(--line)' }"
      >
        <div class="mx-auto max-w-2xl px-6 py-5">
          <!-- ============ 外观 ============ -->
          <template v-if="section === 'appearance'">
            <h2 class="text-xl font-semibold">外观</h2>
            <p class="mt-1 mb-4 text-xs text-dim">配置应用的视觉表现。</p>

            <div class="flex flex-col gap-1">
              <!-- 应用主题 -->
              <div class="settings-card">
                <Palette :size="20" class="shrink-0 text-dim" />
                <div class="min-w-0 flex-1">
                  <p class="text-sm font-medium">应用主题</p>
                  <p class="mt-0.5 text-xs text-dim">选择应用的外观主题。</p>
                </div>
                <div class="flex shrink-0 rounded-md p-0.5" :style="{ background: 'var(--fill-subtle)', border: '1px solid var(--line)' }">
                  <button
                    v-for="mode in THEME_MODES"
                    :key="mode.key"
                    type="button"
                    class="rounded-[4px] px-2.5 py-1 text-xs font-medium transition-colors"
                    :class="settings.settings.theme === mode.key ? 'text-ink' : 'text-dim hover:text-ink'"
                    :style="settings.settings.theme === mode.key ? { background: 'var(--surface-solid)', boxShadow: '0 1px 2px rgba(0,0,0,0.16)' } : undefined"
                    @click="setTheme(mode.key)"
                  >
                    {{ mode.label }}
                  </button>
                </div>
              </div>

              <!-- 编辑器字号 -->
              <div class="settings-card">
                <Code :size="20" class="shrink-0 text-dim" />
                <div class="min-w-0 flex-1">
                  <p class="text-sm font-medium">编辑器字号</p>
                  <p class="mt-0.5 text-xs text-dim">内置编辑器正文字号。</p>
                </div>
                <div class="flex shrink-0 items-center gap-1">
                  <button type="button" class="btn-icon h-7 w-7" aria-label="减小字号" :disabled="settings.settings.editorFontSize <= 11" @click="stepFontSize('editorFontSize', -1)">
                    −
                  </button>
                  <span class="w-10 text-center font-mono text-sm tabular-nums">{{ settings.settings.editorFontSize }} px</span>
                  <button type="button" class="btn-icon h-7 w-7" aria-label="增大字号" :disabled="settings.settings.editorFontSize >= 20" @click="stepFontSize('editorFontSize', 1)">
                    +
                  </button>
                </div>
              </div>

              <!-- 终端字号 -->
              <div class="settings-card">
                <SquareTerminal :size="20" class="shrink-0 text-dim" />
                <div class="min-w-0 flex-1">
                  <p class="text-sm font-medium">终端字号</p>
                  <p class="mt-0.5 text-xs text-dim">内置终端的等宽字号。</p>
                </div>
                <div class="flex shrink-0 items-center gap-1">
                  <button type="button" class="btn-icon h-7 w-7" aria-label="减小字号" :disabled="settings.settings.terminalFontSize <= 10" @click="stepFontSize('terminalFontSize', -1)">
                    −
                  </button>
                  <span class="w-10 text-center font-mono text-sm tabular-nums">{{ settings.settings.terminalFontSize }} px</span>
                  <button type="button" class="btn-icon h-7 w-7" aria-label="增大字号" :disabled="settings.settings.terminalFontSize >= 20" @click="stepFontSize('terminalFontSize', 1)">
                    +
                  </button>
                </div>
              </div>
            </div>
          </template>

          <!-- ============ 首选项 ============ -->
          <template v-else-if="section === 'preferences'">
            <h2 class="text-xl font-semibold">首选项</h2>
            <p class="mt-1 mb-4 text-xs text-dim">配置文件浏览的行为。</p>

            <div class="flex flex-col gap-1">
              <!-- 显示隐藏项目 -->
              <div class="settings-card">
                <Eye :size="20" class="shrink-0 text-dim" />
                <div class="min-w-0 flex-1">
                  <p class="text-sm font-medium">显示隐藏项目</p>
                  <p class="mt-0.5 text-xs text-dim">显示以点（.）开头的文件与文件夹。</p>
                </div>
                <button
                  type="button"
                  role="switch"
                  :aria-checked="settings.settings.showHidden"
                  class="toggle-switch"
                  :class="settings.settings.showHidden && 'on'"
                  @click="setShowHidden(!settings.settings.showHidden)"
                >
                  <span class="toggle-knob" />
                </button>
              </div>

              <!-- 默认排序列 -->
              <div class="settings-card">
                <ArrowDownUp :size="20" class="shrink-0 text-dim" />
                <div class="min-w-0 flex-1">
                  <p class="text-sm font-medium">默认排序列</p>
                  <p class="mt-0.5 text-xs text-dim">连接服务器时文件列表的初始排序（下次连接生效）。</p>
                </div>
                <div class="flex max-w-56 shrink-0 flex-wrap justify-end gap-1" :style="{ background: 'var(--fill-subtle)' }">
                  <button
                    v-for="opt in SORT_OPTIONS"
                    :key="opt.key"
                    type="button"
                    class="rounded-[4px] px-2 py-1 text-xs font-medium transition-colors"
                    :class="settings.settings.defaultSortKey === opt.key ? 'text-ink' : 'text-dim hover:text-ink'"
                    :style="settings.settings.defaultSortKey === opt.key ? { background: 'var(--surface-solid)', boxShadow: '0 1px 2px rgba(0,0,0,0.16)' } : undefined"
                    @click="setDefaultSort(opt.key)"
                  >
                    {{ opt.label }}
                  </button>
                </div>
              </div>
            </div>
          </template>

          <!-- ============ SSH 安全 ============ -->
          <template v-else-if="section === 'security'">
            <h2 class="text-xl font-semibold">SSH 安全</h2>
            <p class="mt-1 mb-4 text-xs text-dim">
              管理已信任的主机公钥指纹（TOFU）。删除后再次连接将重新触发首次信任确认。
            </p>

            <div v-if="!knownHosts?.length" class="py-10 text-center text-xs text-dim">
              暂无已信任主机
            </div>

            <div v-else class="flex flex-col gap-1">
              <div
                v-for="row in knownHosts"
                :key="`${row.host}:${row.port}`"
                class="settings-card"
              >
                <ShieldCheck :size="20" class="shrink-0 text-live" />
                <div class="min-w-0 flex-1">
                  <p class="truncate text-sm font-medium">
                    <span class="font-mono">{{ row.host }}</span>:{{ row.port }}
                  </p>
                  <p class="mt-0.5 truncate font-mono text-xs text-dim" :title="`${row.algorithm} · ${row.fingerprint}`">
                    {{ row.algorithm }} · {{ row.fingerprint }}
                  </p>
                </div>
                <button
                  type="button"
                  class="btn-icon h-8 w-8 shrink-0"
                  title="删除信任记录"
                  :aria-label="`删除 ${row.host} 的信任记录`"
                  @click="removeKnownHost(row)"
                >
                  <Trash2 :size="15" />
                </button>
              </div>
            </div>
          </template>

          <!-- ============ 关于 ============ -->
          <template v-else>
            <h2 class="text-xl font-semibold">关于</h2>
            <p class="mt-1 mb-4 text-xs text-dim">关于本应用。</p>

            <div class="flex flex-col gap-1">
              <div class="settings-card">
                <Info :size="20" class="shrink-0 text-dim" />
                <div class="min-w-0 flex-1">
                  <p class="text-sm font-medium">VisualSSH</p>
                  <p class="mt-0.5 text-xs text-dim">远程文件，本地体验。</p>
                </div>
                <span class="shrink-0 font-mono text-xs text-dim">0.1.0</span>
              </div>
              <div class="settings-card">
                <ShieldCheck :size="20" class="shrink-0 text-dim" />
                <div class="min-w-0 flex-1">
                  <p class="text-sm font-medium">开源许可</p>
                  <p class="mt-0.5 text-xs text-dim">MIT License。</p>
                </div>
              </div>
              <div class="settings-card">
                <Code :size="20" class="shrink-0 text-dim" />
                <div class="min-w-0 flex-1">
                  <p class="text-sm font-medium">技术栈</p>
                  <p class="mt-0.5 text-xs text-dim">Tauri 2 · Vue 3 · Tailwind 4 · russh / russh-sftp · CodeMirror 6 · xterm.js</p>
                </div>
              </div>
            </div>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>
