<script setup lang="ts">
import {
  Braces,
  ChevronsDownUp,
  ChevronsUpDown,
  FileX,
  LoaderCircle,
  Pencil,
  X,
} from "@lucide/vue";
import { EditorState, Compartment, type Extension } from "@codemirror/state";
import { basicSetup } from "codemirror";
import { EditorView, keymap } from "@codemirror/view";
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { nextTick, onBeforeUnmount, ref, watch } from "vue";

import Modal from "@/components/common/Modal.vue";
import { useEditorStore } from "@/stores/editor";

/**
 * 悬浮编辑窗：覆盖全页的模糊遮罩（Acrylic 层）+ 居中亚克力窗体
 * （半透明 surface + backdrop blur + 12 圆角 + 深影），从底部升起进场。
 * 右下角可拖拽调整大小，可最大化/还原；默认只读，「编辑」切换可写。
 * CodeMirror 6：行号 + 当前行高亮 + JetBrains Mono，语言包按扩展名懒加载。
 */

const editor = useEditorStore();

/** 窗体尺寸（px）；拖拽期间关闭过渡 */
const size = ref({
  w: Math.min(1080, Math.round(window.innerWidth * 0.86)),
  h: Math.min(720, Math.round(window.innerHeight * 0.76)),
});
const dragging = ref(false);
const confirmClose = ref(false);

/** 语言/只读按需重配 */
const languageComp = new Compartment();
const readOnlyComp = new Compartment();

/** 语法高亮色走 CSS 变量（main.css 定义亮暗两套） */
const cmHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.operator], color: "var(--cm-keyword)" },
  { tag: [t.string, t.special(t.string)], color: "var(--cm-string)" },
  { tag: [t.number, t.bool, t.null], color: "var(--cm-number)" },
  { tag: [t.comment], color: "var(--cm-comment)", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "var(--cm-function)" },
  { tag: [t.propertyName, t.definition(t.propertyName)], color: "var(--cm-property)" },
  { tag: t.typeName, color: "var(--cm-type)" },
]);

const cmTheme = EditorView.theme({
  "&": {
    height: "100%",
    backgroundColor: "transparent",
    color: "var(--ink)",
    fontSize: "13px",
  },
  ".cm-content": { fontFamily: "var(--font-mono)", paddingBottom: "12px" },
  ".cm-scroller": { overflow: "auto", lineHeight: "1.6" },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "var(--faint)",
    border: "none",
    borderRight: "1px solid var(--line)",
    fontFamily: "var(--font-mono)",
    fontSize: "12px",
  },
  ".cm-lineNumbers .cm-gutterElement": {
    minWidth: "44px",
    paddingRight: "12px",
  },
  ".cm-activeLine": { backgroundColor: "var(--fill-subtle)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--ink)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "color-mix(in srgb, var(--accent) 25%, transparent)",
  },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)" },
});

/** 按扩展名懒加载语言包（Vite 自动分包） */
const LANG_LOADERS: Record<string, () => Promise<Extension>> = {
  json: () => import("@codemirror/lang-json").then((m) => m.json()),
  yaml: () => import("@codemirror/lang-yaml").then((m) => m.yaml()),
  yml: () => import("@codemirror/lang-yaml").then((m) => m.yaml()),
  md: () => import("@codemirror/lang-markdown").then((m) => m.markdown()),
  py: () => import("@codemirror/lang-python").then((m) => m.python()),
  sh: () =>
    import("@codemirror/legacy-modes/mode/shell")
      .then((m) => StreamLanguage.define(m.shell))
      .then((sl) => sl),
  toml: () =>
    import("@codemirror/legacy-modes/mode/toml")
      .then((m) => StreamLanguage.define(m.toml))
      .then((sl) => sl),
  conf: () =>
    import("@codemirror/legacy-modes/mode/properties")
      .then((m) => StreamLanguage.define(m.properties))
      .then((sl) => sl),
  ini: () =>
    import("@codemirror/legacy-modes/mode/properties")
      .then((m) => StreamLanguage.define(m.properties))
      .then((sl) => sl),
  env: () =>
    import("@codemirror/legacy-modes/mode/properties")
      .then((m) => StreamLanguage.define(m.properties))
      .then((sl) => sl),
};

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
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
    languageComp.of([]),
    EditorView.updateListener.of((v) => {
      if (v.docChanged) editor.setContent(v.state.doc.toString());
    }),
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
  void loadLanguage();
}

async function loadLanguage() {
  if (!view) return;
  const epoch = ++langEpoch;
  const loader = LANG_LOADERS[extOf(editor.fileName)];
  if (!loader) {
    view.dispatch({ effects: languageComp.reconfigure([]) });
    return;
  }
  try {
    const ext = await loader();
    if (epoch !== langEpoch || !view) return;
    view.dispatch({ effects: languageComp.reconfigure(ext) });
  } catch {
    // 语言包加载失败：退回纯文本
  }
}

function destroyEditor() {
  view?.destroy();
  view = null;
}

onBeforeUnmount(destroyEditor);

// 抽屉关闭 → 销毁编辑器；重新打开 → 重建
watch(
  () => editor.open,
  (open) => {
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

/** 右下角拖拽调整窗体大小（宽 480–92vw / 高 280–90vh） */
function onResizeDown(e: PointerEvent) {
  if (editor.maximized) return;
  dragging.value = true;
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
            position: editor.maximized ? 'absolute' : undefined,
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

      <!-- 编辑/只读切换：可写或未保存时高亮 -->
      <button
        type="button"
        class="h-7 gap-1.5 px-2.5 text-xs"
        :class="editor.editable || editor.dirty ? 'btn-primary' : 'btn-secondary'"
        :title="editor.editable ? '当前可编辑' : '切换为可编辑'"
        :disabled="editor.unsupported"
        @click="editor.toggleEditable()"
      >
        <Pencil :size="13" />
        编辑
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

      <!-- CodeMirror 挂载点 -->
      <div v-show="!editor.loading && !editor.unsupported" ref="host" class="h-full" />

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
