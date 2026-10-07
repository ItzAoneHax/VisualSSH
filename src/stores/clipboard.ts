import { defineStore } from "pinia";
import { computed, ref } from "vue";

/**
 * 远端内部剪贴板（资源管理器惯例）：Ctrl+C / Ctrl+X 写入，Ctrl+V 远端粘贴。
 * 与系统虚拟文件剪贴板并存——Ctrl+C 双写，Ctrl+V 内部优先、为空回落 HDROP 上传。
 */
export interface InternalClipboard {
  mode: "copy" | "cut";
  connectionId: string;
  sourceDir: string;
  names: string[];
}

export const useClipboardStore = defineStore("clipboard", () => {
  const clip = ref<InternalClipboard | null>(null);

  const count = computed(() => clip.value?.names.length ?? 0);

  /** 再次 Ctrl+C/X 覆盖；names 为空时清空 */
  function write(
    mode: "copy" | "cut",
    connectionId: string,
    sourceDir: string,
    names: string[],
  ) {
    clip.value = names.length ? { mode, connectionId, sourceDir, names } : null;
  }

  /** 断开连接 / 粘贴完成后清空 */
  function clear() {
    clip.value = null;
  }

  /** 剪切行视觉标记（Files DimItemOpacity 0.4，TransferHelpers.cs:125-132） */
  function isCut(connectionId: string, dir: string, name: string): boolean {
    const c = clip.value;
    return (
      c?.mode === "cut" &&
      c.connectionId === connectionId &&
      c.sourceDir === dir &&
      c.names.includes(name)
    );
  }

  return { clip, count, write, clear, isCut };
});
