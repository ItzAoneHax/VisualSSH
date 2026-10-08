import { defineStore } from "pinia";
import { ref } from "vue";

/**
 * 全局轻提示（第四阶段 C2）：底部右侧浮出，可带一个动作按钮
 * （如下载完成后「打开所在文件夹」）。区别于窗格内 hint（无动作通道）。
 */
export interface ToastAction {
  label: string;
  run: () => void;
}

export interface ToastItem {
  id: number;
  message: string;
  action?: ToastAction;
}

let nextId = 1;
const TOAST_MS = 6000;

export const useToastStore = defineStore("toast", () => {
  const items = ref<ToastItem[]>([]);

  function show(message: string, action?: ToastAction) {
    const id = nextId++;
    items.value.push({ id, message, action });
    setTimeout(() => dismiss(id), action ? TOAST_MS : 3000);
  }

  function dismiss(id: number) {
    items.value = items.value.filter((t) => t.id !== id);
  }

  return { items, show, dismiss };
});
