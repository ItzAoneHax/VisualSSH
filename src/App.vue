<script setup lang="ts">
import { convertFileSrc } from "@tauri-apps/api/core";
import { computed, onBeforeUnmount, onMounted, watch } from "vue";

import Modal from "@/components/common/Modal.vue";
import TitleBar from "@/components/common/TitleBar.vue";
import Toast from "@/components/common/Toast.vue";
import { useConnectionsStore } from "@/stores/connections";
import { useExitGuardStore } from "@/stores/exitGuard";
import { useSettingsStore } from "@/stores/settings";
import { useTransferStore } from "@/stores/transfer";
import ConnectionManager from "@/views/ConnectionManager.vue";
import SettingsView from "@/views/SettingsView.vue";
import Workspace from "@/views/Workspace.vue";

const connections = useConnectionsStore();
const settings = useSettingsStore();
const transfers = useTransferStore();
const exitGuard = useExitGuardStore();

async function handleDisconnect() {
  // C3：主页断开连接前，活动传输 > 0 时先确认
  if (!(await exitGuard.request())) return;
  // explorer 实例回收在工作区组件卸载（workspace.resetAll）中完成
  void connections.disconnect();
}

/** 背景图片（Files AppThemeBackgroundImage）：垫在窗口最底层，
 *  经 asset protocol 读取本地文件；契合方式/对齐对应 WPF Stretch + Alignment */
const bgImageSrc = computed(() => {
  const path = settings.settings.bgImage;
  // 检查放在计算时（真实环境 internals 先于应用存在；预览 mock 后注入也能驱动）
  if (!path || typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
    return "";
  }
  try {
    return convertFileSrc(path);
  } catch {
    return "";
  }
});

const OBJECT_FIT = {
  none: "none",
  fill: "fill",
  uniform: "contain",
  uniformToFill: "cover",
} as const;

const bgImageStyle = computed(() => {
  const v = { start: "top", center: "center", end: "bottom" }[
    settings.settings.bgImageVAlign
  ];
  const h = { start: "left", center: "center", end: "right" }[
    settings.settings.bgImageHAlign
  ];
  return {
    objectFit: OBJECT_FIT[settings.settings.bgImageFit],
    objectPosition: `${h} ${v}`,
  };
});

/** —— C1 传输完成系统通知：队列从非空变空时发，文案含成功/失败计数 —— */
let unlistenClose: (() => void) | null = null;
const counted = new Set<string>();

async function notifyTransferDone(done: number, failed: number) {
  if (!settings.settings.transferNotify) return;
  if (!("__TAURI_INTERNALS__" in window)) return;
  try {
    const plugin = await import("@tauri-apps/plugin-notification");
    let granted = await plugin.isPermissionGranted();
    if (!granted) granted = (await plugin.requestPermission()) === "granted";
    if (!granted) return;
    const parts = [done ? `成功 ${done} 项` : "", failed ? `失败 ${failed} 项` : ""].filter(
      Boolean,
    );
    plugin.sendNotification({
      title: "传输完成",
      body: parts.length ? parts.join("，") : "没有待处理的传输",
    });
  } catch {
    // 权限/环境不支持时静默
  }
}

watch(
  () => transfers.activeCount,
  (now, old) => {
    if (now > 0) return;
    if (!old) return;
    const fresh = transfers.rows.filter(
      (r) => r.status !== "queued" && r.status !== "running" && !counted.has(r.id),
    );
    if (!fresh.length) return;
    for (const r of fresh) counted.add(r.id);
    const done = fresh.filter((r) => r.status === "done").length;
    const failed = fresh.length - done;
    void notifyTransferDone(done, failed);
  },
);

/** —— C3 关闭主窗口保护：Alt+F4 / 标题栏 X 均经 onCloseRequested —— */
onMounted(() => {
  // 挂载前已存在的终态行不计入下一次通知
  for (const r of transfers.rows) {
    if (r.status !== "queued" && r.status !== "running") counted.add(r.id);
  }
  if (!("__TAURI_INTERNALS__" in window)) return;
  void (async () => {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      unlistenClose = await win.onCloseRequested(async (event) => {
        if (transfers.activeCount === 0) return;
        event.preventDefault();
        if (await exitGuard.request()) {
          await win.destroy();
        }
      });
    } catch {
      // 环境不支持时静默
    }
  })();
});

onBeforeUnmount(() => {
  unlistenClose?.();
});
</script>

<template>
  <!-- 背景图（Files：Mica → 背景色 tint → 背景图 → 内容） -->
  <img
    v-if="bgImageSrc"
    :src="bgImageSrc"
    alt=""
    aria-hidden="true"
    class="pointer-events-none fixed inset-0 z-0"
    :style="bgImageStyle"
    draggable="false"
  />
  <div class="relative z-10 flex h-full flex-col">
    <TitleBar />
    <div class="min-h-0 flex-1">
      <Transition name="view" mode="out-in">
        <SettingsView v-if="settings.settingsOpen" key="settings" />
        <!-- 多标签后 Workspace 生命周期独立于单个连接（连接数变化不重建） -->
        <Workspace v-else-if="connections.active" key="workspace" @disconnect="handleDisconnect" />
        <ConnectionManager v-else key="manager" />
      </Transition>
    </div>
  </div>

  <!-- 全局轻提示（C2：下载完成「打开所在文件夹」等动作） -->
  <Toast />

  <!-- C3 退出/断开保护确认（活动传输 > 0 时各退出路径挂起于此） -->
  <Modal
    :open="!!exitGuard.pending"
    title="仍有传输进行中"
    :max-width="420"
    @close="exitGuard.settle(false)"
  >
    <p class="text-sm text-dim">
      仍有 {{ exitGuard.pending?.count ?? 0 }} 项传输进行中，离开将取消这些传输（已完成的文件保留）。
    </p>
    <div class="mt-4 flex justify-end gap-2">
      <button type="button" class="btn-secondary" @click="exitGuard.settle(false)">取消</button>
      <button type="button" class="btn-danger" @click="exitGuard.settle(true)">确定离开</button>
    </div>
  </Modal>
</template>
