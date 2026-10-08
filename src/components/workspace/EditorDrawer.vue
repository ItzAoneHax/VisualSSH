<script setup lang="ts">
import {
  Braces,
  ChevronsDownUp,
  ChevronsUpDown,
  FileX,
  LoaderCircle,
  Pencil,
  PencilOff,
  X,
} from "@lucide/vue";
import { EditorState, Compartment, type Extension } from "@codemirror/state";
import { basicSetup } from "codemirror";
import { EditorView, keymap } from "@codemirror/view";
import { syntaxHighlighting } from "@codemirror/language";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

import Modal from "@/components/common/Modal.vue";
import EditorSearchWidget from "@/components/workspace/EditorSearchWidget.vue";
import { createEditorSearch } from "@/composables/editorSearch";
import { useEditorStore } from "@/stores/editor";
import { useSettingsStore } from "@/stores/settings";
import { renderMarkdown } from "@/utils/markdown";
import { cmHighlight, cmTheme, loadLanguageExt } from "@/utils/editorLanguage";

/**
 * 悬浮编辑窗：覆盖全页的模糊遮罩（Acrylic 层）+ 居中亚克力窗体
 * （半透明 surface + backdrop blur + 12 圆角 + 深影），从底部升起进场。
 * 右下角可拖拽调整大小，可最大化/还原；默认只读，「编辑」切换可写。
 * CodeMirror 6：行号 + 当前行高亮 + JetBrains Mono，语言包按扩展名懒加载。
 */

const editor = useEditorStore();

/** 自绘查找/替换（G2）：状态与官方命令桥接，UI 为视口右上角悬浮卡 */
const search = createEditorSearch();

/** 窗体尺寸（px）；拖拽期间关闭过渡 */
const size = ref({
  w: Math.min(1080, Math.round(window.innerWidth * 0.86)),
  h: Math.min(720, Math.round(window.innerHeight * 0.76)),
});
const dragging = ref(false);
const confirmClose = ref(false);
/** resize 锁定的左上角位置（相对遮罩的 absolute 坐标；null = flex 居中常态）。
 *  flex 居中下宽度 +d 会让右缘仅右移 d/2（左缘同时左移 d/2），右下角句柄只走一半——
 *  resize 期间切换为左上角锚定的绝对定位，宽度增量全额作用于右缘，句柄精确跟手 */
const pos = ref<{ x: number; y: number } | null>(null);

/** 语言/只读按需重配 */
const languageComp = new Compartment();
const readOnlyComp = new Compartment();

/** 字号走 compartment（设置页变更即时生效） */
const fontSizeComp = new Compartment();
const fontSizeTheme = (px: number) =>
  EditorView.theme({ "&": { fontSize: `${px}px` } });

/** 预览内容随源码实时联动（源码态编辑后切回预览即为最新） */
const renderedHtml = computed(() => renderMarkdown(editor.doc));

/** 预览态点「编辑」：一步切到源码并进入可写 */
function onEditClick() {
  if (editor.previewMode === "preview") {
    editor.setPreviewMode("source");
    editor.editable = true;
    return;
  }
  editor.toggleEditable();
}

let view: EditorView | null = null;
const host = ref<HTMLElement | null>(null);
/** 语言加载竞态序号：仅应用最新一次 */
let langEpoch = 0;

function buildExtensions(): Extension[] {
  return [
    basicSetup,
    cmTheme,
    syntaxHighlighting(cmHighlight),
    keymap.of([
      {
        key: "Mod-s",
        preventDefault: true,
        run: () => {
          void editor.save();
          return true;
        },
      },
    ]),
    readOnlyComp.of(EditorState.readOnly.of(!editor.editable)),
    fontSizeComp.of(fontSizeTheme(useSettingsStore().settings.editorFontSize)),
    languageComp.of([]),
    EditorView.updateListener.of((v) => {
      if (v.docChanged) editor.setContent(v.state.doc.toString());
    }),
    ...search.buildExtensions(),
  ];
}

/** 打开新文件：整体换 State；语言异步加载后按 epoch 重配 */
async function mountEditor() {
  await nextTick();
  if (!host.value || view) return;
  view = new EditorView({
    state: EditorState.create({ doc: editor.doc, extensions: buildExtensions() }),
    parent: host.value,
  });
  search.attach(view);
  void loadLanguage();
}

async function loadLanguage() {
  if (!view) return;
  const epoch = ++langEpoch;
  const ext = await loadLanguageExt(editor.fileName);
  if (epoch !== langEpoch || !view) return;
  view.dispatch({ effects: languageComp.reconfigure(ext ? [ext] : []) });
}

function destroyEditor() {
  search.attach(null);
  view?.destroy();
  view = null;
}

onBeforeUnmount(destroyEditor);

// 抽屉关闭 → 销毁编辑器；重新打开 → 重建（位置复位为居中）
watch(
  () => editor.open,
  (open) => {
    pos.value = null;
    if (open && !editor.unsupported) {
      void mountEditor();
    } else {
      destroyEditor();
    }
  },
);

// 切换文件（同一抽屉内）：换文档 + 重新加载语言
watch(
  () => editor.path,
  () => {
    if (!view || !editor.open) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: editor.doc },
    });
    void loadLanguage();
  },
);

// 预览态下编辑器容器 display:none，切回源码需重新测量行高
watch(
  () => editor.previewMode,
  (mode) => {
    if (mode === "source") view?.requestMeasure();
  },
);

// 字号设置变更即时生效
watch(
  () => useSettingsStore().settings.editorFontSize,
  (px) => {
    view?.dispatch({ effects: fontSizeComp.reconfigure(fontSizeTheme(px)) });
  },
);

// 只读切换
watch(
  () => editor.editable,
  (editable) => {
    view?.dispatch({
      effects: readOnlyComp.reconfigure(EditorState.readOnly.of(!editable)),
    });
  },
);

// 外部替换内容（格式化）：推入编辑器
watch(
  () => editor.doc,
  (text) => {
    if (view && view.state.doc.toString() !== text) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
      });
    }
  },
);

/** 右下角拖拽调整窗体大小（宽 480–92vw / 高 280–90vh）；
 *  拖拽开始即锁定左上角（absolute 定位），拖多少走多少 */
function onResizeDown(e: PointerEvent) {
  if (editor.maximized) return;
  dragging.value = true;
  const win = (e.currentTarget as HTMLElement).closest('[role="dialog"]');
  if (win) {
    const rect = win.getBoundingClientRect();
    // 遮罩 fixed inset-0 top-9：absolute 子元素相对其 padding box（视口顶部下移 36px）
    pos.value = { x: rect.left, y: rect.top - 36 };
  }
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  const startX = e.clientX;
  const startY = e.clientY;
  const startW = size.value.w;
  const startH = size.value.h;
  const onMove = (ev: PointerEvent) => {
    const maxW = Math.round(window.innerWidth * 0.92);
    const maxH = Math.round(window.innerHeight * 0.9);
    size.value = {
      w: Math.min(maxW, Math.max(480, startW + ev.clientX - startX)),
      h: Math.min(maxH, Math.max(280, startH + ev.clientY - startY)),
    };
  };
  const onUp = () => {
    dragging.value = false;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

/** 关闭请求：脏状态先确认 */
function requestClose() {
  if (editor.dirty) {
    confirmClose.value = true;
    return;
  }
  editor.closeNow();
}

function discardAndClose() {
  confirmClose.value = false;
  editor.closeNow();
}

/** 悬浮窗级 Ctrl+F / Ctrl+H（window 捕获）：md 预览态先切回源码再打开自绘查找卡。
 *  编辑器聚焦时的 Mod-f/Mod-h 走 CodeMirror keymap（editorSearch.ts），此处覆盖
 *  焦点在输入框/预览/标题栏的场景 */
function onGlobalKeydown(e: KeyboardEvent) {
  if (!editor.open) return;
  // Esc 关闭自绘查找卡（兜底：焦点不在 CM 内容区/卡内输入框时）
  if (e.key === "Escape" && search.open) {
    e.preventDefault();
    e.stopPropagation();
    search.close();
    return;
  }
  if (!e.ctrlKey && !e.metaKey) return;
  if (e.shiftKey || e.altKey) return;
  const key = e.key.toLowerCase();
  if (key !== "f" && key !== "h") return;
  e.preventDefault();
  e.stopPropagation();
  if (editor.previewMode === "preview") editor.setPreviewMode("source");
  search.openSearch(key === "h");
}

onMounted(() => window.addEventListener("keydown", onGlobalKeydown, true));
onBeforeUnmount(() => window.removeEventListener("keydown", onGlobalKeydown, true));
</script>

<template>
  <Teleport to="body">
    <!-- 全页模糊遮罩 + 悬浮亚克力编辑窗（从底部升起） -->
    <Transition name="editor-pop" appear>
      <div
        v-if="editor.open"
        class="fixed inset-0 top-9 z-40 flex items-center justify-center p-6"
        :style="{
          background: 'color-mix(in srgb, var(--bg) 30%, rgba(0, 0, 0, 0.32))',
          backdropFilter: 'blur(6px)',
        }"
        @click.self="requestClose"
      >
        <div
          class="flex min-w-0 flex-col overflow-hidden"
          :style="{
            width: editor.maximized ? 'auto' : `${size.w}px`,
            height: editor.maximized ? 'auto' : `${size.h}px`,
            inset: editor.maximized ? '20px' : undefined,
            position: editor.maximized || pos ? 'absolute' : undefined,
            left: !editor.maximized && pos ? `${pos.x}px` : undefined,
            top: !editor.maximized && pos ? `${pos.y}px` : undefined,
            transition: dragging ? 'none' : 'width 0.15s ease, height 0.15s ease',
            background: 'color-mix(in srgb, var(--surface-solid) 84%, transparent)',
            backdropFilter: 'blur(20px) saturate(1.15)',
            border: '1px solid var(--stroke-flyout)',
            borderRadius: '12px',
            boxShadow: '0 32px 64px rgba(0, 0, 0, 0.36)',
          }"
          role="dialog"
          aria-modal="true"
          aria-label="文件编辑器"
        >
          <!-- 标题栏：●脏标记 + 文件名 + 路径 + 动作（双击空白=最大化切换） -->
          <header
            class="flex h-10 shrink-0 items-center gap-2 px-3"
            @dblclick.self="editor.toggleMaximized()"
          >
      <span class="min-w-0 flex-1">
        <span class="truncate text-[13px] font-semibold" :title="editor.path">
          <span v-if="editor.dirty" class="text-accent">● </span>{{ editor.fileName }}
        </span>
        <span class="ml-2 truncate text-xs text-faint" :title="editor.path">
          {{ editor.path }}
        </span>
      </span>

      <!-- Markdown：预览/源码分段切换 -->
      <div
        v-if="editor.isMarkdown"
        class="flex shrink-0 rounded-md p-0.5"
        :style="{ background: 'var(--fill-control)', border: '1px solid var(--line)' }"
        role="tablist"
        aria-label="查看方式"
      >
        <button
          v-for="mode in [{ key: 'preview', label: '预览' }, { key: 'source', label: '源码' }] as const"
          :key="mode.key"
          type="button"
          role="tab"
          class="rounded-[4px] px-2.5 py-1 text-xs font-medium transition-colors"
          :class="editor.previewMode === mode.key ? 'text-ink' : 'text-dim hover:text-ink'"
          :style="editor.previewMode === mode.key ? { background: 'var(--surface-solid)', boxShadow: '0 1px 2px rgba(0, 0, 0, 0.16)' } : undefined"
          :aria-selected="editor.previewMode === mode.key"
          @click="editor.setPreviewMode(mode.key)"
        >
          {{ mode.label }}
        </button>
      </div>

      <!-- JSON 格式化（可写时） -->
      <button
        v-if="editor.isJson && editor.editable"
        type="button"
        class="btn-secondary h-7 gap-1.5 px-2.5 text-xs"
        title="格式化 JSON"
        @click="editor.formatJson()"
      >
        <Braces :size="14" />
        格式化
      </button>

      <!-- 编辑/只读切换：图标随状态切换（G3）；预览态点击=切源码并进入编辑 -->
      <button
        type="button"
        class="h-7 gap-1.5 px-2.5 text-xs"
        :class="editor.editable || editor.dirty ? 'btn-primary' : 'btn-secondary'"
        :title="editor.editable ? '切换为只读' : '进入编辑'"
        :disabled="editor.unsupported"
        @click="onEditClick"
      >
        <PencilOff v-if="editor.editable" :size="13" />
        <Pencil v-else :size="13" />
        {{ editor.editable ? "编辑中" : "编辑" }}
      </button>

      <!-- 最大化/还原 -->
      <button
        type="button"
        class="btn-icon h-7 w-7"
        :title="editor.maximized ? '还原' : '最大化'"
        :aria-label="editor.maximized ? '还原编辑器' : '最大化编辑器'"
        @click="editor.toggleMaximized()"
      >
        <ChevronsDownUp v-if="editor.maximized" :size="14" />
        <ChevronsUpDown v-else :size="14" />
      </button>

      <button
        type="button"
        class="btn-icon h-7 w-7"
        title="关闭"
        aria-label="关闭编辑器"
        @click="requestClose"
      >
        <X :size="15" />
      </button>
    </header>

    <!-- 错误横幅 -->
    <div
      v-if="editor.error"
      class="mx-2.5 mb-1 flex shrink-0 items-center gap-2 rounded-md px-2.5 py-1.5 text-xs"
      :style="{
        background: 'color-mix(in srgb, var(--danger) 10%, transparent)',
        color: 'var(--danger)',
      }"
    >
      <span class="min-w-0 flex-1 truncate" :title="editor.error">{{ editor.error }}</span>
      <button type="button" class="btn-icon h-6 w-6" aria-label="关闭提示" @click="editor.dismissError()">
        <X :size="13" />
      </button>
    </div>

    <!-- 主体 -->
    <div class="relative min-h-0 flex-1">
      <!-- 加载中 -->
      <div
        v-if="editor.loading"
        class="absolute inset-0 flex items-center justify-center gap-2 text-sm text-dim"
      >
        <LoaderCircle :size="16" class="animate-spin" />
        正在加载…
      </div>

      <!-- 空态：白名单外 / 超大 / 二进制 -->
      <div
        v-else-if="editor.unsupported"
        class="absolute inset-0 flex flex-col items-center justify-center gap-2 text-dim"
      >
        <FileX :size="26" class="text-faint" />
        <span class="text-xs">预览不可用 — 仅支持 2MB 内的文本文件</span>
      </div>

      <!-- Markdown 预览（渲染实时联动源码） -->
      <div
        v-if="editor.previewMode === 'preview' && !editor.loading && !editor.unsupported"
        class="md-preview absolute inset-0 overflow-y-auto"
        v-html="renderedHtml"
      />

      <!-- CodeMirror 挂载点 -->
      <div
        v-show="!editor.loading && !editor.unsupported && editor.previewMode === 'source'"
        ref="host"
        class="h-full"
      />

      <!-- 查找/替换悬浮卡（G2）：仅源码态显示 -->
      <EditorSearchWidget
        v-show="!editor.loading && !editor.unsupported && editor.previewMode === 'source'"
        :search="search"
      />

      <!-- 右下角拖拽调整大小 -->
      <div
        v-if="!editor.maximized && !editor.unsupported"
        class="absolute right-0 bottom-0 h-4 w-4 cursor-nwse-resize"
        title="拖拽调整大小"
        @pointerdown="onResizeDown"
      />
    </div>
        </div>
      </div>
    </Transition>

    <!-- 关闭前确认（有未保存更改） -->
    <Modal
      :open="confirmClose"
      title="未保存的更改"
      @close="confirmClose = false"
    >
      <div class="flex flex-col gap-4">
        <p class="text-sm leading-6">
          「<span class="font-semibold">{{ editor.fileName }}</span
          >」已修改但尚未保存，关闭将丢弃这些更改。
        </p>
        <footer class="flex justify-end gap-2">
          <button type="button" class="btn-secondary" @click="confirmClose = false">
            继续编辑
          </button>
          <button type="button" class="btn-danger" @click="discardAndClose">
            放弃更改并关闭
          </button>
        </footer>
      </div>
    </Modal>
  </Teleport>
</template>
