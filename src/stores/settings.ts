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
  /** 删除前弹确认框（Files ShowConfirmationWhenDeletingItems） */
  confirmDelete: boolean;
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
}

const DEFAULTS: AppSettings = {
  theme: "dark",
  editorFontSize: 13,
  terminalFontSize: 13,
  showHidden: false,
  defaultSortKey: "name",
  defaultSortDesc: false,
  sortPriority: "folders",
  confirmDelete: true,
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
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<AppSettings>) };
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

  function applyDom() {
    const preferDark = mediaQuery?.matches ?? false;
    const dark =
      settings.value.theme === "dark" ||
      (settings.value.theme === "system" && preferDark);
    document.documentElement.classList.toggle("dark", dark);
    document.documentElement.style.setProperty(
      "--app-bg-tint",
      settings.value.bgColor,
    );
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
