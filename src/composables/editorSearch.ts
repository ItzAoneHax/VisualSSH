import { reactive } from "vue";
import { Prec, RangeSetBuilder, type Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  keymap,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import {
  SearchQuery,
  findNext as cmFindNext,
  findPrevious as cmFindPrevious,
  getSearchQuery,
  replaceAll as cmReplaceAll,
  replaceNext as cmReplaceNext,
  search,
  setSearchQuery,
} from "@codemirror/search";

/**
 * 编辑器自绘查找/替换（G2）：UI 为编辑器视口右上角的悬浮卡（EditorSearchWidget.vue），
 * 底层完全复用 @codemirror/search 的状态与命令——SearchQuery 持有查询/替换文本与三态，
 * setSearchQuery effect 更新查询状态，findNext/findPrevious/replaceNext/replaceAll
 * 官方命令负责跳转、选中与替换（含滚动定位与环绕）。
 *
 * 与官方面板的差异只有两点：
 * 1. 高亮：官方 searchHighlighter 以 panel != null 为前提（dist/index.js:816），
 *    自绘卡不开官方面板，故此处的 ViewPlugin 以「自绘卡打开」为开关，其余逻辑同官方
 *    （视口范围迭代 + 当前匹配叠加 cm-searchMatch-selected）。
 * 2. 键位：basicSetup 的 searchKeymap（Mod-f → openSearchPanel 等）用 Prec.highest
 *    覆盖为打开自绘卡；Escape 仅在卡打开时拦截，其余透传（不干扰补全提示等）。
 */

/** 计数安全上限（防「空串可匹配」类正则全文档爆量） */
const COUNT_CAP = 10000;

export interface EditorSearchController {
  /** 悬浮卡状态（reactive，UI 直接绑定） */
  open: boolean;
  replaceOpen: boolean;
  text: string;
  replacement: string;
  caseSensitive: boolean;
  regexp: boolean;
  wholeWord: boolean;
  /** 当前匹配序号（1 起；0 = 无）与匹配总数 */
  current: number;
  total: number;
  /** 正则语法无效（输入框红描边提示） */
  invalid: boolean;
  /** 外部聚焦请求序号（openSearch 自增；组件 watch 后聚焦并全选查找框） */
  focusSeq: number;

  /** 编辑器扩展：search() 状态初始化 + 键位覆盖 + 实时高亮 */
  buildExtensions(): Extension[];
  /** view 生命周期挂钩（关闭时复位状态） */
  attach(view: EditorView | null): void;

  openSearch(withReplace?: boolean): void;
  close(): void;
  /** 查询文本/三态变化后同步进编辑器状态（输入框 @input 与三态切换调用） */
  applyQuery(): void;
  findNext(): void;
  findPrevious(): void;
  replaceOne(): void;
  replaceAll(): void;
}

/** getCursor 返回裸 Iterator（d.ts 无 [Symbol.iterator]），包成可迭代 */
function iterMatches(cursor: Iterator<{ from: number; to: number }>): IterableIterator<{ from: number; to: number }> {
  return {
    [Symbol.iterator]() {
      return this;
    },
    next() {
      return cursor.next();
    },
  };
}

export function createEditorSearch(): EditorSearchController {
  const state = reactive({
    open: false,
    replaceOpen: false,
    text: "",
    replacement: "",
    caseSensitive: false,
    regexp: false,
    wholeWord: false,
    current: 0,
    total: 0,
    invalid: false,
    focusSeq: 0,
  });

  let view: EditorView | null = null;

  function buildQuery(): SearchQuery {
    return new SearchQuery({
      search: state.text,
      replace: state.replacement,
      caseSensitive: state.caseSensitive,
      regexp: state.regexp,
      wholeWord: state.wholeWord,
    });
  }

  function queryUsable(): boolean {
    const q = buildQuery();
    return state.text.length > 0 && q.valid;
  }

  /** 全文计数：total = 匹配总数；current = 与当前主选区对齐的匹配序号（官方 findNext
   *  会把匹配设为主选区，故按 from/to 精确比对） */
  function recount() {
    if (!view || !state.open || !queryUsable()) {
      state.current = 0;
      state.total = 0;
      return;
    }
    const q = buildQuery();
    const sel = view.state.selection.main;
    let total = 0;
    let current = 0;
    for (const m of iterMatches(q.getCursor(view.state))) {
      total += 1;
      if (m.from === sel.from && m.to === sel.to) current = total;
      if (total >= COUNT_CAP) break;
    }
    state.current = current;
    state.total = total;
  }

  /** 查询/替换文本或三态变化 → 同步进编辑器搜索状态（高亮由 effect 驱动重建） */
  function applyQuery() {
    state.invalid = state.regexp && state.text.length > 0 && !buildQuery().valid;
    if (!view) return;
    view.dispatch({ effects: setSearchQuery.of(buildQuery()) });
    recount();
  }

  function openSearch(withReplace = false) {
    // VSCode 语义：打开时以当前选中词预填（单行、非空、≤200 字符）
    if (view) {
      const sel = view.state.selection.main;
      const selected =
        !sel.empty && sel.to - sel.from <= 200
          ? view.state.sliceDoc(sel.from, sel.to)
          : "";
      if (selected && !/[\n\r]/.test(selected)) state.text = selected;
    }
    state.open = true;
    if (withReplace) state.replaceOpen = true;
    state.focusSeq += 1;
    applyQuery();
  }

  function close() {
    state.open = false;
    state.current = 0;
    state.total = 0;
    // 清空查询状态：高亮随 effect 重建为空
    view?.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "" })) });
    view?.focus();
  }

  function findNext() {
    if (view && queryUsable()) {
      cmFindNext(view);
      recount();
    }
  }

  function findPrevious() {
    if (view && queryUsable()) {
      cmFindPrevious(view);
      recount();
    }
  }

  function replaceOne() {
    if (view && queryUsable()) {
      cmReplaceNext(view);
      recount();
    }
  }

  function replaceAllFn() {
    if (view && queryUsable()) {
      cmReplaceAll(view);
      recount();
    }
  }

  /** 实时高亮（官方 searchHighlighter 的去面板依赖版：可见范围迭代，
   *  当前匹配 = 与选区对齐的项叠加 selected 类） */
  const highlighter = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = this.build(view);
      }
      update(update: ViewUpdate) {
        const q0 = getSearchQuery(update.startState);
        const q1 = getSearchQuery(update.state);
        if (update.docChanged || update.selectionSet || update.viewportChanged || !q0.eq(q1)) {
          this.decorations = this.build(update.view);
        }
      }
      build(view: EditorView) {
        if (!state.open) return Decoration.none;
        const q = getSearchQuery(view.state);
        if (!q.valid) return Decoration.none;
        const matchMark = Decoration.mark({ class: "cm-searchMatch" });
        const selectedMark = Decoration.mark({ class: "cm-searchMatch cm-searchMatch-selected" });
        const builder = new RangeSetBuilder<Decoration>();
        const ranges = view.visibleRanges;
        for (let i = 0; i < ranges.length; i++) {
          let { from, to } = ranges[i];
          // 合并被折叠区隔开的相邻可见段（官方同款 HighlightMargin=250）
          while (i < ranges.length - 1 && to > ranges[i + 1].from - 500) {
            to = ranges[++i].to;
          }
          for (const m of iterMatches(q.getCursor(view.state, from, to))) {
            if (m.from === m.to) continue; // 零宽匹配（如 a*）不可标记
            const selected = view.state.selection.ranges.some(
              (r) => r.from === m.from && r.to === m.to,
            );
            builder.add(m.from, m.to, selected ? selectedMark : matchMark);
          }
        }
        return builder.finish();
      }
    },
    { decorations: (v) => v.decorations },
  );

  const extensions: Extension[] = [
    // 初始化搜索状态（setSearchQuery/官方命令的前置条件）
    search(),
    highlighter,
    // 编辑器内容/选区变化时刷新计数（findNext 设置选区后同样触发）
    EditorView.updateListener.of((v) => {
      if (!state.open) return;
      if (v.docChanged || v.selectionSet) recount();
    }),
    // 覆盖 basicSetup searchKeymap 的官方面板键位
    Prec.highest(
      keymap.of([
        { key: "Mod-f", run: () => (openSearch(), true) },
        { key: "Mod-h", run: () => (openSearch(true), true) },
        {
          key: "Escape",
          run: () => {
            if (!state.open) return false; // 透传：补全提示等仍可关闭
            close();
            return true;
          },
        },
        {
          key: "F3",
          run: () => {
            if (!state.open) {
              openSearch();
              return true;
            }
            findNext();
            return true;
          },
        },
        {
          key: "Shift-F3",
          run: () => {
            if (!state.open) {
              openSearch();
              return true;
            }
            findPrevious();
            return true;
          },
        },
      ]),
    ),
  ];

  // 挂方法到同一 reactive 对象上返回（展开 state 会失去响应性）
  return Object.assign(state, {
    buildExtensions: () => extensions,
    attach(next: EditorView | null) {
      view = next;
      if (!next) {
        state.open = false;
        state.replaceOpen = false;
        state.current = 0;
        state.total = 0;
      }
    },
    openSearch,
    close,
    applyQuery,
    findNext,
    findPrevious,
    replaceOne,
    replaceAll: replaceAllFn,
  });
}
