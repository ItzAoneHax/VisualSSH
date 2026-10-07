<script setup lang="ts">
import { convertFileSrc } from "@tauri-apps/api/core";
import { computed } from "vue";

import TitleBar from "@/components/common/TitleBar.vue";
import { useConnectionsStore } from "@/stores/connections";
import { useSettingsStore } from "@/stores/settings";
import ConnectionManager from "@/views/ConnectionManager.vue";
import SettingsView from "@/views/SettingsView.vue";
import Workspace from "@/views/Workspace.vue";

const connections = useConnectionsStore();
const settings = useSettingsStore();

function handleDisconnect() {
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
    opacity: settings.settings.bgImageOpacity,
  };
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
        <Workspace
          v-else-if="connections.active"
          :key="connections.active.connectionId"
          @disconnect="handleDisconnect"
        />
        <ConnectionManager v-else key="manager" />
      </Transition>
    </div>
  </div>
</template>
