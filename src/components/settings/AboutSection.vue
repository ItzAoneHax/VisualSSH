<script setup lang="ts">
import { Check, Code, Info, ShieldCheck } from "@lucide/vue";
import { getVersion } from "@tauri-apps/api/app";
import { onMounted, ref } from "vue";

/** 关于分区；版本号单一来源 getVersion()（tauri.conf.json），点击复制 */
const version = ref("");
const copied = ref(false);

onMounted(async () => {
  try {
    version.value = await getVersion();
  } catch {
    version.value = "";
  }
});

async function copyVersion() {
  if (!version.value) return;
  await navigator.clipboard.writeText(version.value);
  copied.value = true;
  setTimeout(() => (copied.value = false), 1500);
}
</script>

<template>
  <h2 class="text-xl font-semibold">关于</h2>
  <p class="mt-1 mb-4 text-xs text-dim">关于本应用。</p>

  <div class="flex flex-col gap-1">
    <div class="settings-card">
      <Info :size="20" class="shrink-0 text-dim" />
      <div class="min-w-0 flex-1">
        <p class="text-sm font-medium">VisualSSH</p>
        <p class="mt-0.5 text-xs text-dim">远程文件，本地体验。</p>
      </div>
      <button
        v-if="version"
        class="flex shrink-0 cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 font-mono text-xs text-dim transition-colors hover:bg-fill-subtle hover:text-ink"
        :title="`版本 ${version}（点击复制）`"
        @click="copyVersion"
      >
        <Check v-if="copied" :size="12" class="text-accent" />
        <span>{{ version }}</span>
      </button>
    </div>
    <div class="settings-card">
      <ShieldCheck :size="20" class="shrink-0 text-dim" />
      <div class="min-w-0 flex-1">
        <p class="text-sm font-medium">开源许可</p>
        <p class="mt-0.5 text-xs text-dim">MIT License。</p>
      </div>
    </div>
    <div class="settings-card">
      <Code :size="20" class="shrink-0 text-dim" />
      <div class="min-w-0 flex-1">
        <p class="text-sm font-medium">技术栈</p>
        <p class="mt-0.5 text-xs text-dim">Tauri 2 · Vue 3 · Tailwind 4 · russh / russh-sftp · CodeMirror 6 · xterm.js</p>
      </div>
    </div>
  </div>
</template>
