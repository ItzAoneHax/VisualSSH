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
 * 底部编辑抽屉：默认高 40%，顶边可拖拽调高（15%–85%），
 * 可最大化（占满除状态栏外的主列）、可关闭；默认只读，「编辑」切换可写。
 * CodeMirror 6：行号 + 当前行高亮 + JetBrains Mono，语言包按扩展名懒加载。
 */

const editor = useEditorStore();

/** 抽屉高度（flex-basis）；拖拽期间关闭过渡 */
const basis = ref("40%");
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

/** 顶边拖拽调高：按主列高度换算百分比，15%–85% */
function onHandleDown(e: PointerEvent) {
  if (editor.maximized) return;
  const pane = (e.currentTarget as HTMLElement).closest("[data-main-col]") as HTMLElement | null;
  if (!pane) return;
  dragging.value = true;
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  const paneRect = pane.getBoundingClientRect();
  const onMove = (ev: PointerEvent) => {
    const pct = ((paneRect.bottom - ev.clientY) / paneRect.height) * 100;
    basis.value = `${Math.min(85, Math.max(15, pct)).toFixed(1)}%`;
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
  <!-- 底部滑出抽屉（主列 flex 成员，压占文件区高度） -->
  <div
    v-if="editor.open"
    class="flex shrink-0 flex-col overflow-hidden rounded-lg"
    :style="{
      flexBasis: editor.maximized ? 'calc(100% - 2rem)' : basis,
      transition: dragging ? 'none' : 'flex-basis 0.2s ease',
      background: 'var(--toolbar)',
      border: '1px solid var(--line)',
    }"
    role="complementary"
    aria-label="文件编辑器"
  >
    <!-- 顶边拖拽把手 -->
    <div
      class="h-1.5 shrink-0 cursor-row-resize"
      @pointerdown="onHandleDown"
      @dblclick="editor.toggleMaximized()"
    />

    <!-- 标题栏：●脏标记 + 文件名 + 路径 + 动作 -->
    <header class="flex h-9 shrink-0 items-center gap-2 px-2.5">
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
    </div>
  </div>

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
</template>
