<script setup lang="ts">
import { Code, Info, ShieldCheck } from "@lucide/vue";

/** 关于分区 */
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
      <span class="shrink-0 font-mono text-xs text-dim">0.1.0</span>
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
