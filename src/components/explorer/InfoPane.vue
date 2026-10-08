<script setup lang="ts">
import {
  File,
  FileQuestion,
  Folder,
  Info,
  LoaderCircle,
  TriangleAlert,
  X,
} from "@lucide/vue";
import { EditorState, Compartment } from "@codemirror/state";
import { basicSetup } from "codemirror";
import { EditorView } from "@codemirror/view";
import { syntaxHighlighting } from "@codemirror/language";
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";

import ChmodDialog from "@/components/explorer/ChmodDialog.vue";
import PropertiesDialog from "@/components/explorer/PropertiesDialog.vue";
import { useExplorer } from "@/stores/explorer";
import { useSettingsStore } from "@/stores/settings";
import { useWorkspaceStore } from "@/stores/workspace";
import { readFileBase64, readFileSsh } from "@/api/ssh";
import type { FileEntry } from "@/types";
import {
  cmHighlight,
  cmTheme,
  loadLanguageExt,
} from "@/utils/editorLanguage";
import { renderMarkdown } from "@/utils/markdown";
import {
  base64ToBytes,
  IMAGE_PREVIEW_MAX,
  imageMimeOf,
  permissionsOctal,
  previewCache,
  previewKindOf,
  type PreviewKind,
} from "@/utils/preview";
import { formatMtime, formatSize, joinPath, kindLabel } from "@/utils/format";

/**
 * 信息窗格（第五阶段块 A，仿 files-community/Files InfoPane）：
 * 详情 / 预览两 tab（记忆上次选择）；未选中显示当前目录摘要，多选显示计数与合计。
 * 预览判别链：图片（≤10MB base64 直读）/ Markdown / 文本（≤2MB，UTF-8 无效转兜底）
 * / Basic 兜底；读取走内存直读，绝不进传输中心卡片。
 * 位置（右/底）由父组件按容器宽度切换；本组件只负责内容与宽度/高度值（记忆于设置）。
 */

const workspace = useWorkspaceStore();
const settings = useSettingsStore();

/** 活动窗格的浏览器状态（选中/目录变化即重算） */
const ex = computed(() =>
  workspace.activePaneId ? useExplorer(workspace.activePaneId) : null,
);

/** 单选条目（搜索结果视图不参与：键为 relPath，预览仅服务主视图） */
const singleEntry = computed<FileEntry | null>(() => {
  const e = ex.value;
  if (!e || e.searchSession || e.selectedNames.size !== 1) return null;
  const name = [...e.selectedNames][0];
  return e.entryByName(name);
});

const kind = computed<PreviewKind | null>(() =>
  singleEntry.value ? previewKindOf(singleEntry.value) : null,
);

/** 详情行（全部取自 FileEntry，不额外请求） */
const detailRows = computed(() => {
  const entry = singleEntry.value;
  const e = ex.value;
  if (!entry || !e) return [];
  return [
    { label: "类型", value: kindLabel(entry.kind) },
    { label: "大小", value: entry.kind === "dir" ? "—" : formatSize(entry.size) },
    { label: "修改时间", value: formatMtime(entry.mtime) },
    { label: "属主", value: entry.owner ?? "—" },
    { label: "组", value: entry.group ?? "—" },
    { label: "权限", value: permissionsOctal(entry.permissions) },
    { label: "位置", value: joinPath(e.cwd, entry.name) },
  ];
});

/** 多选合计（仅文件计入，与状态栏口径一致） */
const multiSummary = computed(() => {
  const e = ex.value;
  if (!e || e.selectedNames.size < 2) return null;
  let bytes = 0;
  for (const name of e.selectedNames) {
    const entry = e.entryByName(name);
    if (entry?.kind === "file") bytes += entry.size;
  }
  return { count: e.selectedNames.size, bytes };
});

function switchTab(tab: "details" | "preview") {
  if (settings.settings.infoPaneTab !== tab) {
    settings.update({ infoPaneTab: tab });
  }
}

/** —— 预览状态机：选中变化 → 判别链取内容（缓存优先） → ready/basic/error —— */
interface PreviewState {
  status: "loading" | "ready" | "error";
  /** image = blob URL；markdown = 渲染后 html；text = 源码（交 CodeMirror） */
  content?: string;
  binary?: boolean;
  error?: string;
}
const preview = ref<PreviewState>({ status: "loading" });
/** 图片适配：contain / 原尺寸（双击切换） */
const imageNatural = ref(false);
let previewEpoch = 0;

function cacheKey(entry: FileEntry, cwd: string, cid: string): string {
  return `${cid}:${joinPath(cwd, entry.name)}:${entry.mtime ?? 0}`;
}

async function loadPreview(entry: FileEntry, k: PreviewKind) {
  const e = ex.value;
  if (!e) return;
  const cid = e.connectionId;
  const path = joinPath(e.cwd, entry.name);
  const epoch = ++previewEpoch;
  const key = cacheKey(entry, e.cwd, cid);
  imageNatural.value = false;
  preview.value = { status: "loading" };

  try {
    if (k === "image") {
      const cached = previewCache.get(key);
      if (cached) {
        preview.value = { status: "ready", content: cached };
        return;
      }
      const b64 = await readFileBase64(cid, path, IMAGE_PREVIEW_MAX);
      if (epoch !== previewEpoch) return;
      const bytes = base64ToBytes(b64);
      const url = URL.createObjectURL(new Blob([bytes], { type: imageMimeOf(entry.name) }));
      if (previewCache.fits(bytes.length)) {
        previewCache.put(key, url, bytes.length, true);
      }
      preview.value = { status: "ready", content: url };
      return;
    }
    // markdown / text 共用文本直读（后端 UTF-8 校验：无效即二进制转兜底）
    const cached = previewCache.get(key);
    if (cached) {
      preview.value = { status: "ready", content: cached };
      return;
    }
    const text = await readFileSsh(cid, path);
    if (epoch !== previewEpoch) return;
    if (previewCache.fits(text.length)) {
      previewCache.put(key, text, text.length, false);
    }
    preview.value = { status: "ready", content: text };
  } catch (err) {
    if (epoch !== previewEpoch) return;
    const message = err instanceof Error ? err.message : String(err);
    // 后端 read_file 对非 UTF-8 的固定报错：二进制文件转 Basic 兜底
    if (message.includes("UTF-8")) {
      preview.value = { status: "ready", binary: true };
    } else {
      preview.value = { status: "error", error: message };
    }
  }
}

watch(
  () => {
    const entry = singleEntry.value;
    if (!entry || !ex.value) return null;
    return {
      entry,
      kind: kind.value,
      cwd: ex.value.cwd,
      cid: ex.value.connectionId,
    };
  },
  (ctx) => {
    if (!ctx || ctx.kind === "folder" || ctx.kind === "basic") {
      previewEpoch++;
      preview.value = { status: "ready" };
      return;
    }
    void loadPreview(ctx.entry, ctx.kind as "image" | "markdown" | "text");
  },
  { immediate: true },
);

/** —— 文本预览：CodeMirror 只读 + 语言高亮（复用编辑器语言配置） —— */
const codeHost = ref<HTMLElement | null>(null);
const languageComp = new Compartment();
let codeView: EditorView | null = null;

watch(
  () => ({
    text: preview.value.status === "ready" && kind.value === "text" ? preview.value.content : null,
    name: singleEntry.value?.name ?? "",
  }),
  async (ctx) => {
    if (ctx.text == null) {
      codeView?.destroy();
      codeView = null;
      return;
    }
    await nextTick();
    if (!codeHost.value) return;
    codeView?.destroy();
    codeView = new EditorView({
      state: EditorState.create({
        doc: ctx.text,
        extensions: [
          basicSetup,
          cmTheme,
          syntaxHighlighting(cmHighlight),
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          languageComp.of([]),
        ],
      }),
      parent: codeHost.value,
    });
    const ext = await loadLanguageExt(ctx.name);
    if (codeView) {
      codeView.dispatch({ effects: languageComp.reconfigure(ext ? [ext] : []) });
    }
  },
);

onBeforeUnmount(() => {
  previewEpoch++;
  codeView?.destroy();
  codeView = null;
});

/** 兜底态文案（basic / 二进制） */
const basicHint = computed(() =>
  preview.value.binary ? "二进制文件，无法预览" : "该类型暂不支持预览",
);

/** 兜底态的大小提示（仅文件） */
const basicSize = computed(() => {
  const entry = singleEntry.value;
  if (!entry || entry.kind === "dir") return "";
  return formatSize(entry.size);
});

/** 属性…（信息窗格自持对话框实例；chmod 转手同款对话框） */
const propertiesTargets = ref<FileEntry[] | null>(null);
const chmodEntry = ref<FileEntry | null>(null);
const paneEx = computed(() => ex.value);

function openProperties() {
  if (singleEntry.value) propertiesTargets.value = [singleEntry.value];
}
</script>

<template>
  <div
    class="flex h-full min-w-0 flex-col overflow-hidden rounded-lg"
    role="complementary"
    aria-label="信息窗格"
    :style="{ background: 'var(--panel)', border: '1px solid var(--line)' }"
  >
    <!-- 头部：详情/预览 segmented（记忆上次选择）+ 关闭 -->
    <header class="flex h-10 shrink-0 items-center gap-1 px-2">
      <div
        class="flex rounded-md p-0.5"
        :style="{ background: 'var(--fill-control)', border: '1px solid var(--line)' }"
        role="tablist"
        aria-label="信息窗格视图"
      >
        <button
          v-for="tab in [
            { key: 'details', label: '详情' },
            { key: 'preview', label: '预览' },
          ] as const"
          :key="tab.key"
          type="button"
          role="tab"
          class="rounded-[4px] px-2.5 py-1 text-xs font-medium transition-colors"
          :class="settings.settings.infoPaneTab === tab.key ? 'text-ink' : 'text-dim hover:text-ink'"
          :style="settings.settings.infoPaneTab === tab.key
            ? { background: 'var(--surface-solid)', boxShadow: '0 1px 2px rgba(0, 0, 0, 0.16)' }
            : undefined"
          :aria-selected="settings.settings.infoPaneTab === tab.key"
          @click="switchTab(tab.key)"
        >
          {{ tab.label }}
        </button>
      </div>
      <span class="min-w-0 flex-1" />
      <button
        type="button"
        class="btn-icon h-7 w-7"
        title="关闭信息窗格"
        aria-label="关闭信息窗格"
        @click="settings.update({ infoPaneEnabled: false })"
      >
        <X :size="14" />
      </button>
    </header>

    <div class="min-h-0 flex-1 overflow-y-auto">
      <!-- ======== 未选中：当前目录摘要（用已加载数据，不额外请求） ======== -->
      <template v-if="!singleEntry">
        <div class="flex flex-col items-center gap-2 px-4 pt-10 text-dim">
          <Folder :size="34" class="text-folder" fill="currentColor" />
          <p class="max-w-full truncate text-sm font-medium text-ink" :title="ex?.cwd">
            {{ ex ? (ex.cwd === "/" ? "/" : ex.cwd.split("/").filter(Boolean).pop()) : "" }}
          </p>
          <p class="text-xs">{{ ex?.visibleEntries.length ?? 0 }} 个项目</p>
        </div>
      </template>

      <!-- ======== 多选：已选 N 项 + 合计大小 ======== -->
      <template v-else-if="multiSummary">
        <div class="flex flex-col items-center gap-2 px-4 pt-10 text-dim">
          <Info :size="30" class="text-accent" />
          <p class="text-sm font-medium text-ink">已选 {{ multiSummary.count }} 项</p>
          <p class="text-xs">共 {{ formatSize(multiSummary.bytes) }}</p>
        </div>
      </template>

      <!-- ======== 单选 ======== -->
      <template v-else-if="singleEntry">
        <!-- 详情 tab -->
        <div v-if="settings.settings.infoPaneTab === 'details'" class="flex flex-col gap-3 px-4 py-3">
          <div class="flex flex-col items-center gap-2 pt-2 pb-1">
            <Folder
              v-if="singleEntry.kind === 'dir'"
              :size="34"
              class="text-folder"
              fill="currentColor"
            />
            <File v-else :size="34" class="text-dim" />
            <p class="max-w-full truncate text-sm font-medium text-ink" :title="singleEntry.name">
              {{ singleEntry.name }}
            </p>
          </div>
          <dl class="flex flex-col gap-1.5 text-xs">
            <div
              v-for="row in detailRows"
              :key="row.label"
              class="flex items-baseline gap-2"
            >
              <dt class="w-14 shrink-0 text-dim">{{ row.label }}</dt>
              <dd class="min-w-0 flex-1 break-all text-ink" :title="row.value">{{ row.value }}</dd>
            </div>
          </dl>
          <button
            type="button"
            class="btn-secondary mt-1 inline-flex h-7 items-center gap-1.5 self-start px-2.5 text-xs"
            @click="openProperties"
          >
            <Info :size="13" />
            属性…
          </button>
        </div>

        <!-- 预览 tab -->
        <div v-else class="flex h-full flex-col">
          <!-- ① 文件夹：提示选择文件以预览 -->
          <div
            v-if="kind === 'folder'"
            class="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-dim"
          >
            <Folder :size="30" class="text-faint" />
            <span class="text-xs">选择文件以预览</span>
          </div>

          <!-- ②③④ 加载中 -->
          <div
            v-else-if="preview.status === 'loading'"
            class="flex flex-1 items-center justify-center gap-2 text-sm text-dim"
          >
            <LoaderCircle :size="16" class="animate-spin" />
            正在加载…
          </div>

          <!-- 读取失败 -->
          <div
            v-else-if="preview.status === 'error'"
            class="flex flex-1 flex-col items-center justify-center gap-2 px-4"
          >
            <TriangleAlert :size="26" style="color: var(--danger)" />
            <span class="text-center text-xs text-dim">{{ preview.error }}</span>
          </div>

          <!-- ⑤ Basic 兜底（不支持类型 / 二进制 / 超限） -->
          <div
            v-else-if="kind === 'basic' || preview.binary"
            class="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-dim"
          >
            <FileQuestion :size="30" class="text-faint" />
            <span class="text-xs">{{ basicHint }}</span>
            <span v-if="basicSize" class="text-xs text-faint">{{ basicSize }}</span>
          </div>

          <!-- ② 图片：contain 适配，双击切换原尺寸 -->
          <template v-else-if="kind === 'image'">
            <div
              class="flex min-h-0 flex-1 items-center justify-center p-2"
              :class="imageNatural && 'overflow-auto'"
              @dblclick="imageNatural = !imageNatural"
              :title="imageNatural ? '双击恢复适配' : '双击查看原尺寸'"
            >
              <img
                :src="preview.content"
                :style="imageNatural
                  ? { maxWidth: 'none', maxHeight: 'none' }
                  : { maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }"
                class="rounded-[2px]"
                :alt="singleEntry.name"
              />
            </div>
            <p class="px-3 pb-2 text-center text-[11px] text-faint">
              {{ singleEntry.name }} · {{ basicSize }}
            </p>
          </template>

          <!-- ③ Markdown -->
          <div
            v-else-if="kind === 'markdown'"
            class="md-preview min-h-0 flex-1 overflow-y-auto"
            v-html="renderMarkdown(preview.content ?? '')"
          />

          <!-- ④ 文本/代码：CodeMirror 只读 -->
          <div v-else-if="kind === 'text'" ref="codeHost" class="min-h-0 flex-1" />
        </div>
      </template>
    </div>

    <!-- 属性 / 权限对话框（窗格自持实例，操作落在活动窗格 explorer） -->
    <PropertiesDialog
      :targets="propertiesTargets"
      :parent-dir="paneEx?.cwd ?? '/'"
      @close="propertiesTargets = null"
      @rename="(oldName, newName) => {
        propertiesTargets = null;
        paneEx?.renameEntry(oldName, newName);
      }"
      @chmod="(entry) => {
        propertiesTargets = null;
        chmodEntry = entry;
      }"
    />
    <ChmodDialog
      :open="!!chmodEntry"
      :entry="chmodEntry"
      @close="chmodEntry = null"
      @apply="(mode) => {
        const target = chmodEntry;
        chmodEntry = null;
        if (target) paneEx?.chmodEntry(target.name, mode);
      }"
    />
  </div>
</template>
