<script setup lang="ts">
import { KeyRound, LoaderCircle, Pencil, Trash2, Zap } from "@lucide/vue";

import type { SshProfile, TestState } from "@/types";

const props = defineProps<{
  profile: SshProfile;
  testState?: TestState;
  connecting: boolean;
}>();

const emit = defineEmits<{
  connect: [profile: SshProfile];
  test: [profile: SshProfile];
  edit: [profile: SshProfile];
  remove: [profile: SshProfile];
}>();

function stateClass(state?: TestState): string {
  if (!state) return "hidden";
  switch (state.status) {
    case "ok":
      return "bg-live/10 text-live";
    case "fail":
      return "bg-danger/10 text-danger";
    case "testing":
      return "bg-accent/10 text-accent";
  }
  return "hidden";
}
</script>

<template>
  <article
    class="flex flex-col gap-3 rounded-xl border border-line bg-panel p-4 transition-colors hover:border-accent/40"
  >
    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0">
        <h3 class="truncate text-[15px] font-bold">{{ profile.alias || profile.host }}</h3>
        <p class="mt-1 truncate font-mono text-xs text-dim">
          <span class="mr-1 text-accent">❯</span>{{ profile.username }}@{{ profile.host }}:{{ profile.port }}
        </p>
      </div>
      <span
        v-if="testState && testState.status !== 'idle'"
        class="chip shrink-0 font-mono"
        :class="stateClass(testState)"
        :title="testState.status === 'fail' ? testState.message : undefined"
      >
        <LoaderCircle v-if="testState.status === 'testing'" :size="11" class="animate-spin" />
        <template v-if="testState.status === 'testing'">测试中</template>
        <template v-else-if="testState.status === 'ok'">{{ testState.latencyMs }} ms</template>
        <template v-else>失败</template>
      </span>
    </div>

    <p
      v-if="testState && testState.status === 'fail'"
      class="truncate text-xs text-danger"
      :title="testState.message"
    >
      {{ testState.message }}
    </p>

    <div class="flex items-center gap-1.5 text-xs text-faint">
      <KeyRound :size="12" />
      {{ profile.authMethod === "privateKey" ? "私钥认证" : "密码认证" }}
    </div>

    <div class="mt-auto flex items-center gap-2">
      <button type="button" class="btn-ghost h-8 px-2.5 text-xs" @click="emit('test', profile)">
        <LoaderCircle v-if="testState?.status === 'testing'" :size="13" class="animate-spin" />
        <Zap v-else :size="13" />
        测试连接
      </button>
      <span class="flex-1" />
      <button
        type="button"
        class="btn-icon h-8 w-8"
        title="编辑"
        aria-label="编辑连接"
        @click="emit('edit', profile)"
      >
        <Pencil :size="14" />
      </button>
      <button
        type="button"
        class="btn-icon h-8 w-8 hover:!text-danger"
        title="删除"
        aria-label="删除连接"
        @click="emit('remove', profile)"
      >
        <Trash2 :size="14" />
      </button>
      <button
        type="button"
        class="btn-primary h-8 px-3 text-xs"
        :disabled="connecting"
        @click="emit('connect', profile)"
      >
        <LoaderCircle v-if="connecting" :size="13" class="animate-spin" />
        {{ connecting ? "连接中" : "连接" }}
      </button>
    </div>
  </article>
</template>
