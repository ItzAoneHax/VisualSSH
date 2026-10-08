import { HighlightStyle, StreamLanguage } from "@codemirror/language";
import { type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

/**
 * CodeMirror 语言配置与主题（编辑抽屉与预览窗格共用）：
 * 语言包按扩展名懒加载（Vite 自动分包），高亮色走 main.css 的 CSS 变量。
 */

/** 按扩展名懒加载语言包（Vite 自动分包） */
export const LANG_LOADERS: Record<string, () => Promise<Extension>> = {
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

export function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/** 语法高亮色走 CSS 变量（main.css 定义亮暗两套） */
export const cmHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.operator], color: "var(--cm-keyword)" },
  { tag: [t.string, t.special(t.string)], color: "var(--cm-string)" },
  { tag: [t.number, t.bool, t.null], color: "var(--cm-number)" },
  { tag: [t.comment], color: "var(--cm-comment)", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "var(--cm-function)" },
  { tag: [t.propertyName, t.definition(t.propertyName)], color: "var(--cm-property)" },
  { tag: t.typeName, color: "var(--cm-type)" },
]);

/** 透明底主题：嵌在亚克力面板（编辑抽屉/预览窗格）里不自带背景 */
export const cmTheme = EditorView.theme({
  "&": {
    height: "100%",
    backgroundColor: "transparent",
    color: "var(--ink)",
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
  ".cm-searchMatch": {
    backgroundColor: "color-mix(in srgb, var(--accent) 20%, transparent)",
    borderRadius: "2px",
  },
  ".cm-searchMatch-selected": {
    backgroundColor: "color-mix(in srgb, var(--accent) 45%, transparent)",
  },
});

/** 异步加载语言扩展；失败退回纯文本（调用方按 epoch 竞态守卫） */
export async function loadLanguageExt(fileName: string): Promise<Extension | null> {
  const loader = LANG_LOADERS[extOf(fileName)];
  if (!loader) return null;
  try {
    return await loader();
  } catch {
    return null;
  }
}
