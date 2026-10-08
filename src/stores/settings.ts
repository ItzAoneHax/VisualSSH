import { defineStore } from "pinia";
import { ref } from "vue";

import type { SortKey } from "@/stores/explorer";
import { configureSizeUnit } from "@/utils/format";

export type ThemeMode = "system" | "light" | "dark";
/** 大小格式（Files SizeUnitTypes：二进制 1024 / 十进制 1000） */
export type SizeUnit = "binary" | "decimal";
/** 排序优先级（Files SortPriority：文件夹优先 / 文件优先 / 混合） */
export type SortPriority = "folders" | "files" | "mixed";
/** 背景图契合（WPF Stretch：无 / 填充 / 均匀 / 均匀填充） */
export type ImageFit = "none" | "fill" | "uniform" | "uniformToFill";
/** 背景图对齐（单轴：前 / 中 / 后） */
export type ImageAlign = "start" | "center" | "end";
/** 冲突解决策略（Files ConflictsResolveOption 的 newName/replace/skip；custom 仅对话框内聚合态，不持久化） */
export type ConflictResolveOption = "newName" | "replace" | "skip";
/** 删除确认策略（Files DeleteConfirmationPolicies：总是 / 仅永久删除 / 从不） */
export type DeleteConfirmationPolicy = "always" | "permanentOnly" | "never";
/** 传输中心入口可见性（Files StatusCenterVisibility：始终 / 仅传输进行中） */
export type TransferCenterVisibility = "always" | "activeOnly";

const STORAGE_KEY = "visualssh:settings:v1";

/** 与 localStorage 及后端默认值对应的设置快照 */
export interface AppSettings {
  theme: ThemeMode;
  editorFontSize: number;
  terminalFontSize: number;
  showHidden: boolean;
  defaultSortKey: SortKey;
  /** 默认排序方向（Files SortInDescendingOrder） */
  defaultSortDesc: boolean;
  /** 排序优先级（Files SortPriority；原 dirFirst 硬编码改为可配置） */
  sortPriority: SortPriority;
  /** 删除确认策略（Files DeleteConfirmationPolicies；旧布尔键 confirmDelete 迁移 true→always / false→never） */
  deleteConfirmation: DeleteConfirmationPolicy;
  /** 大小格式（Files SizeUnitTypes） */
  sizeUnit: SizeUnit;
  /** 单击即打开（Files SingleClickToOpen，桌面端简化为开/关） */
  singleClickOpen: boolean;
  /** 双击文件区空白处转到上一级（Files DoubleClickBlankSpaceToGoUp） */
  dblClickBlankGoUp: boolean;
  /** 显示状态栏（Files ShowStatusBar） */
  showStatusBar: boolean;
  /** 应用背景色（Files AppThemeBackgroundColor；CSS #RRGGBBAA，默认全透明） */
  bgColor: string;
  /** 背景图片路径（Files AppThemeBackgroundImageSource；空 = 无） */
  bgImage: string;
  /** 背景图不透明度 0.1–1 */
  bgImageOpacity: number;
  /** 背景图契合方式（Files 默认 UniformToFill） */
  bgImageFit: ImageFit;
  /** 背景图垂直对齐 */
  bgImageVAlign: ImageAlign;
  /** 背景图水平对齐 */
  bgImageHAlign: ImageAlign;
  /** 冲突对话框「应用到所有」记住的上次策略（Files GeneralSettingsService.ConflictsResolveOption，默认生成新名称） */
  conflictsResolveOption: ConflictResolveOption;
  /** 传输中心入口可见性（Files StatusCenterVisibility，默认始终显示） */
  transferCenterVisibility: TransferCenterVisibility;
  /** 显示文件扩展名（Files HideFileExtension 反相，默认显示；仅影响展示层，重命名仍操作完整名） */
  showFileExtensions: boolean;
  /** 详情视图行高密度（Files DetailsViewSizeKind：28/36/40/44/48，默认小 36） */
  detailsRowHeight: number;
  /** 恢复上次浏览目录（每连接记忆 lastDir；Files 会话恢复的每连接简化版） */
  restoreLastDir: boolean;
  /** 编辑器打开时默认只读（true）还是直接进入编辑态（false，默认） */
  editorReadOnlyDefault: boolean;
  /** 传输完成系统通知（第四阶段 C1；默认开） */
  transferNotify: boolean;
  /** 信息窗格开关（Files IsInfoPaneEnabled，默认关） */
  infoPaneEnabled: boolean;
  /** 信息窗格当前 tab（Files InfoPaneTabs，默认详情） */
  infoPaneTab: "details" | "preview";
  /** 信息窗格右侧模式宽度（Files VerticalSizePx，默认 250） */
  infoPaneWidth: number;
  /** 信息窗格底部模式高度（Files HorizontalSizePx，默认 300） */
  infoPaneHeight: number;
  /** 表格图片缩略图（块 B，默认开） */
  showThumbnails: boolean;
}

const DEFAULTS: AppSettings = {
  theme: "dark",
  editorFontSize: 13,
  terminalFontSize: 13,
  showHidden: false,
  defaultSortKey: "name",
  defaultSortDesc: false,
  sortPriority: "folders",
  deleteConfirmation: "always",
  sizeUnit: "binary",
  singleClickOpen: false,
  dblClickBlankGoUp: false,
  showStatusBar: true,
  bgColor: "#00000000",
  bgImage: "",
  bgImageOpacity: 1,
  bgImageFit: "uniformToFill",
  bgImageVAlign: "center",
  bgImageHAlign: "center",
  conflictsResolveOption: "newName",
  transferCenterVisibility: "always",
  showFileExtensions: true,
  detailsRowHeight: 36,
  restoreLastDir: true,
  editorReadOnlyDefault: false,
  transferNotify: true,
  infoPaneEnabled: false,
  infoPaneTab: "details",
  infoPaneWidth: 250,
  infoPaneHeight: 300,
  showThumbnails: true,
};

function load(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      // 迁移旧版 ThemeToggle 的两态主题键
      const legacy = localStorage.getItem("visualssh:theme");
      if (legacy === "light" || legacy === "dark") {
        return { ...DEFAULTS, theme: legacy };
      }
      return { ...DEFAULTS };
    }
    const parsed = { ...(JSON.parse(raw) as Partial<AppSettings>) };
    // 旧版布尔删除确认 → 三档策略（true→总是确认 / false→从不确认）
    if ("confirmDelete" in parsed && !("deleteConfirmation" in parsed)) {
      parsed.deleteConfirmation = (parsed as { confirmDelete?: boolean }).confirmDelete
        ? "always"
        : "never";
    }
    delete (parsed as Partial<AppSettings> & { confirmDelete?: boolean }).confirmDelete;
    // 行高密度只接受五档（LayoutSizeKindHelper.GetDetailsViewRowHeight）
    if (![28, 36, 40, 44, 48].includes(parsed.detailsRowHeight ?? 36)) {
      parsed.detailsRowHeight = 36;
    }
    const merged = { ...DEFAULTS, ...parsed };
    // 信息窗格 tab 只接受两值；宽高下限 100（Files InfoPaneSettingsService Math.Max(100d, …)）
    if (merged.infoPaneTab !== "details" && merged.infoPaneTab !== "preview") {
      merged.infoPaneTab = "details";
    }
    merged.infoPaneWidth = Math.min(1600, Math.max(100, Math.round(merged.infoPaneWidth)));
    merged.infoPaneHeight = Math.min(1600, Math.max(100, Math.round(merged.infoPaneHeight)));
    return merged;
  } catch {
    return { ...DEFAULTS };
  }
}

/**
 * 应用设置（仿 Files 设置页的数据源）：localStorage 持久化。
 * 主题在此统一应用（设置页取代了原右上角切换按钮）：
 * dark/light 直接切 .dark，system 跟随 prefers-color-scheme 并监听变化；
 * 应用背景色写入 --app-bg-tint（html 背景叠在窗口底色上，Files BackgroundBrush）。
 */
export const useSettingsStore = defineStore("settings", () => {
  const settings = ref<AppSettings>(load());
  /** 设置页是否打开（应用级第三视图） */
  const settingsOpen = ref(false);

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings.value));
      // 兼容首帧内联脚本（仍读取旧键）
      localStorage.setItem(
        "visualssh:theme",
        settings.value.theme === "system" ? "system" : settings.value.theme,
      );
    } catch {
      // 隐私模式：仅会话内生效
    }
  }

  let mediaQuery: MediaQueryList | null = null;
  const onSystemChange = () => applyDom();

  /** #RRGGBB / #RRGGBBAA → [r,g,b,a0-1]；解析失败返回 null。
   *  用字符串切片而非位运算：带 alpha 的 8 位 hex 超出 int32 正数范围，移位会得到负数错位值 */
  function parseHex(hex: string): [number, number, number, number] | null {
    const m = /^#([0-9a-f]{6}(?:[0-9a-f]{2})?)$/i.exec(hex.trim());
    if (!m) return null;
    const h = m[1];
    return [
      parseInt(h.slice(0, 2), 16),
      parseInt(h.slice(2, 4), 16),
      parseInt(h.slice(4, 6), 16),
      h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
    ];
  }

  /** 标准 alpha 合成：fg 叠在 bg 上（fg.a = 0 时结果 = bg） */
  function composite(
    fg: [number, number, number, number],
    bg: [number, number, number],
  ): [number, number, number] {
    const [fr, fgc, fb, fa] = fg;
    return [
      Math.round(fr * fa + bg[0] * (1 - fa)),
      Math.round(fgc * fa + bg[1] * (1 - fa)),
      Math.round(fb * fa + bg[2] * (1 - fa)),
    ];
  }

  function applyDom() {
    const preferDark = mediaQuery?.matches ?? false;
    const dark =
      settings.value.theme === "dark" ||
      (settings.value.theme === "system" && preferDark);
    document.documentElement.classList.toggle("dark", dark);
    const rootStyle = document.documentElement.style;
    rootStyle.setProperty("--app-bg-tint", settings.value.bgColor);
    // 重算 --panel-solid = 半透明 panel 叠在（tint 叠 bg）上的预混实体色：
    // sticky 列头保持不透明，且与半透明面板透出 body 的观感一致——
    // 设置应用背景色后列头不再成为异色块（浅色下仍接近白，深色下随 tint）。
    const bg: [number, number, number] = dark ? [0x20, 0x20, 0x20] : [0xf3, 0xf3, 0xf3];
    const panel: [number, number, number, number] = dark
      ? [255, 255, 255, 0x0d / 255]
      : [252, 252, 252, 0xc0 / 255];
    const tint = parseHex(settings.value.bgColor);
    const solid = composite(panel, tint ? composite(tint, bg) : bg);
    rootStyle.setProperty("--panel-solid", `rgb(${solid.join(",")})`);
    configureSizeUnit(settings.value.sizeUnit);
  }

  function watchSystem() {
    if (mediaQuery || typeof matchMedia !== "function") return;
    mediaQuery = matchMedia("(prefers-color-scheme: dark)");
    mediaQuery.addEventListener("change", onSystemChange);
  }

  function update(patch: Partial<AppSettings>) {
    // 原地变更（而非整体替换）：组件里 const s = settings.settings 的别名保持同一对象，
    // 模板绑定不会冻结成旧快照
    Object.assign(settings.value, patch);
    if (patch.theme === "system") watchSystem();
    // 同步应用：watch 批处理会合并同 tick 的连续变更、丢末态
    applyDom();
    persist();
  }

  function openSettings() {
    settingsOpen.value = true;
  }

  function closeSettings() {
    settingsOpen.value = false;
  }

  // 启动即对齐 DOM（首帧脚本已处理过一遍，这里保证 system 模式的监听器就位）
  if (settings.value.theme === "system") watchSystem();
  applyDom();

  return {
    settings,
    settingsOpen,
    update,
    openSettings,
    closeSettings,
  };
});
