import { defineStore } from "pinia";
import { computed, ref } from "vue";

import { readFileSsh, writeFileSsh } from "@/api/ssh";
import type { FileEntry } from "@/types";
import { joinPath } from "@/utils/format";
import { useSettingsStore } from "@/stores/settings";

/** 文本预览白名单（提示词 M4 清单） */
const TEXT_EXTS = new Set([
  "txt", "json", "yaml", "yml", "log", "md", "conf", "ini", "toml", "env", "sh", "py",
]);

/** 预览大小上限（与后端 read_file 一致） */
const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/** Markdown 预览态（仅 .md：双击默认预览，可切源码） */
export type PreviewMode = "preview" | "source";

/** 是否可进编辑抽屉（白名单 + ≤2MB 的文件/符号链接） */
export function isPreviewable(entry: FileEntry): boolean {
  if (entry.kind !== "file" && entry.kind !== "symlink") return false;
  if (!TEXT_EXTS.has(extOf(entry.name))) return false;
  return entry.size <= MAX_PREVIEW_BYTES;
}

/**
 * 编辑抽屉状态：单文件会话（doc = 当前内容，savedDoc = 上次保存快照）。
 * 抽屉不可用原因也走本 store（unsupported 时抽屉显示空态文案）。
 */
export const useEditorStore = defineStore("editor", () => {
  const connectionId = ref("");
  const path = ref("");
  const fileName = ref("");
  const open = ref(false);
  const loading = ref(false);
  /** 空态：不可预览（白名单外 / 超大 / 二进制） */
  const unsupported = ref(false);
  /** 加载/保存失败的横幅文案（显示在抽屉内） */
  const error = ref<string | null>(null);
  const editable = ref(false);
  const saving = ref(false);
  const maximized = ref(false);

  const doc = ref("");
  const savedDoc = ref("");

  /** 预览/源码切换（仅 isMarkdown 时有意义） */
  const previewMode = ref<PreviewMode>("source");

  const dirty = computed(() => doc.value !== savedDoc.value);
  const isJson = computed(() => extOf(fileName.value) === "json");
  const isMarkdown = computed(() => extOf(fileName.value) === "md");

  /** 双击入口：先做白名单/大小判定，再异步加载内容 */
  async function openEntry(entry: FileEntry, cwd: string, connId: string) {
    connectionId.value = connId;
    path.value = joinPath(cwd, entry.name);
    fileName.value = entry.name;
    // 默认模式按设置（editorReadOnlyDefault：true = 进只读，false = 进编辑态）
    editable.value = !useSettingsStore().settings.editorReadOnlyDefault;
    error.value = null;
    savedDoc.value = "";
    doc.value = "";
    // .md 默认预览态，其余源码态
    previewMode.value = extOf(entry.name) === "md" ? "preview" : "source";
    open.value = true;

    if (!isPreviewable(entry)) {
      unsupported.value = true;
      return;
    }
    unsupported.value = false;
    loading.value = true;
    try {
      const content = await readFileSsh(connId, path.value);
      // 等待期间用户可能已切换到别的文件
      if (path.value === joinPath(cwd, entry.name)) {
        doc.value = content;
        savedDoc.value = content;
      }
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
    } finally {
      loading.value = false;
    }
  }

  /** 编辑器内容变化（CodeMirror updateListener 回调） */
  function setContent(text: string) {
    doc.value = text;
  }

  function toggleEditable() {
    if (unsupported.value) return;
    editable.value = !editable.value;
  }

  /** 预览/源码切换：进源码时不需要额外动作，预览内容由组件实时渲染 */
  function setPreviewMode(mode: PreviewMode) {
    previewMode.value = mode;
  }

  function toggleMaximized() {
    maximized.value = !maximized.value;
  }

  /** 关闭请求：脏状态由组件层拦截确认 */
  function closeNow() {
    open.value = false;
    unsupported.value = false;
    editable.value = false;
    maximized.value = false;
    previewMode.value = "source";
    error.value = null;
    doc.value = "";
    savedDoc.value = "";
    path.value = "";
    fileName.value = "";
  }

  async function save() {
    if (!dirty.value || saving.value || !connectionId.value) return;
    saving.value = true;
    error.value = null;
    try {
      await writeFileSsh(connectionId.value, path.value, doc.value);
      savedDoc.value = doc.value;
    } catch (e) {
      // 保留脏状态，横幅提示
      error.value = e instanceof Error ? e.message : String(e);
    } finally {
      saving.value = false;
    }
  }

  /** JSON 格式化：前端解析重排后整体替换并标记脏 */
  function formatJson() {
    try {
      const parsed = JSON.parse(doc.value) as unknown;
      doc.value = JSON.stringify(parsed, null, 2);
      error.value = null;
    } catch (e) {
      error.value = `JSON 解析失败: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  function dismissError() {
    error.value = null;
  }

  return {
    connectionId,
    path,
    fileName,
    open,
    loading,
    unsupported,
    error,
    editable,
    saving,
    maximized,
    doc,
    savedDoc,
    dirty,
    isJson,
    isMarkdown,
    previewMode,
    openEntry,
    setContent,
    toggleEditable,
    setPreviewMode,
    toggleMaximized,
    closeNow,
    save,
    formatJson,
    dismissError,
  };
});
