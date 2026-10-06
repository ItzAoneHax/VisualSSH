import { defineStore } from "pinia";
import { ref } from "vue";

import type { SortKey } from "@/stores/explorer";

export type ThemeMode = "system" | "light" | "dark";

const STORAGE_KEY = "visualssh:settings:v1";

/** 与 localStorage 及后端默认值对应的设置快照 */
export interface AppSettings {
  theme: ThemeMode;
  editorFontSize: number;
  terminalFontSize: number;
  showHidden: boolean;
  defaultSortKey: SortKey;
}

const DEFAULTS: AppSettings = {
  theme: "dark",
  editorFontSize: 13,
  terminalFontSize: 13,
  showHidden: false,
  defaultSortKey: "name",
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
 * dark/light 直接切 .dark，system 跟随 prefers-color-scheme 并监听变化。
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
  }

  function watchSystem() {
    if (mediaQuery || typeof matchMedia !== "function") return;
    mediaQuery = matchMedia("(prefers-color-scheme: dark)");
    mediaQuery.addEventListener("change", onSystemChange);
  }

  function update(patch: Partial<AppSettings>) {
    settings.value = { ...settings.value, ...patch };
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
