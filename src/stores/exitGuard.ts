import { defineStore } from "pinia";
import { ref } from "vue";

import { useTransferStore } from "@/stores/transfer";

/**
 * 退出/断开保护（第四阶段 C3）：活动传输 > 0 时，
 * 关闭主窗口 / 主页断开连接 / 关闭最后一个标签即将断开等路径
 * 先弹确认（复用 Modal，danger 按钮），确认后才放行。
 */
export const useExitGuardStore = defineStore("exitGuard", () => {
  const pending = ref<{ count: number; resolve: (ok: boolean) => void } | null>(null);

  /** 请求放行：无活动传输直接通过；有则挂起等用户决策 */
  function request(): Promise<boolean> {
    const active = useTransferStore().activeCount;
    if (active === 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      // 已有弹窗在挂起时后来者并入（取最新计数），仅保留最新 resolve
      pending.value?.resolve(false);
      pending.value = { count: active, resolve };
    });
  }

  function settle(ok: boolean) {
    const p = pending.value;
    pending.value = null;
    p?.resolve(ok);
  }

  return { pending, request, settle };
});
