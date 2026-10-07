import { defineStore } from "pinia";
import { ref } from "vue";

/**
 * 侧栏收藏固定化（Files QuickAccess / PinFolderToSidebarAction 语义）：
 * 按 profile 的 pinned 列表，localStorage visualssh:pinned:v1 map profileId → [{name,path,icon}]。
 * 初始默认 = 旧版写死的四项（根目录/主目录/系统配置/日志）。
 * 不做：拖拽排序、拖文件到侧栏移动（依赖行内拖拽，M7）。
 */

export type PinIcon = "hardDrive" | "house" | "folderTree" | "scrollText" | "folder";

export interface PinnedFolder {
  name: string;
  path: string;
  /** 展示图标键（lucide 映射在 Workspace 侧）；新固定的默认 folder */
  icon: PinIcon;
}

const STORAGE_KEY = "visualssh:pinned:v1";

/** 旧版 quickLinks 原样作为初始默认 */
const DEFAULT_PINS: PinnedFolder[] = [
  { name: "根目录", path: "/", icon: "hardDrive" },
  { name: "主目录", path: "/home", icon: "house" },
  { name: "系统配置", path: "/etc", icon: "folderTree" },
  { name: "日志", path: "/var", icon: "scrollText" },
];

function loadMap(): Record<string, PinnedFolder[]> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, PinnedFolder[]>) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export const usePinnedStore = defineStore("pinned", () => {
  const pinsMap = ref<Record<string, PinnedFolder[]>>(loadMap());

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(pinsMap.value));
    } catch {
      // 隐私模式：仅会话内生效
    }
  }

  /** 某 profile 的收藏列表（无记录给默认四项；不写入，保持惰性） */
  function pinsFor(profileId: string): PinnedFolder[] {
    return pinsMap.value[profileId] ?? DEFAULT_PINS;
  }

  /** 固定文件夹（去重；已存在则不动） */
  function pin(profileId: string, folder: { name: string; path: string }) {
    if (!profileId) return;
    const pins = pinsMap.value[profileId] ?? DEFAULT_PINS.map((p) => ({ ...p }));
    if (pins.some((p) => p.path === folder.path)) return;
    pins.push({ ...folder, icon: "folder" });
    pinsMap.value = { ...pinsMap.value, [profileId]: pins };
    persist();
  }

  /** 取消固定 */
  function unpin(profileId: string, path: string) {
    if (!profileId) return;
    const pins = (pinsMap.value[profileId] ?? DEFAULT_PINS.map((p) => ({ ...p }))).filter(
      (p) => p.path !== path,
    );
    pinsMap.value = { ...pinsMap.value, [profileId]: pins };
    persist();
  }

  function isPinned(profileId: string, path: string): boolean {
    return pinsFor(profileId).some((p) => p.path === path);
  }

  return {
    pinsMap,
    pinsFor,
    pin,
    unpin,
    isPinned,
  };
});
