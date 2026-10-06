<script setup lang="ts">
import { KeyRound, LoaderCircle, MoreHorizontal, Pencil, Server, Trash2, Zap } from "@lucide/vue";
import { computed, ref } from "vue";

import DropdownMenu, { type MenuItem } from "@/components/common/DropdownMenu.vue";
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

const menuOpen = ref(false);

const menuItems: MenuItem[] = [
  { key: "test", label: "测试连接", icon: Zap },
  { key: "edit", label: "编辑", icon: Pencil },
  { key: "sep", label: "", separator: true },
  { key: "remove", label: "删除", icon: Trash2, danger: true },
];

function onMenuSelect(key: string) {
  menuOpen.value = false;
  if (key === "test") emit("test", props.profile);
  else if (key === "edit") emit("edit", props.profile);
  else if (key === "remove") emit("remove", props.profile);
}

/** 测试状态 → chip 文案与配色 */
const testChip = computed(() => {
  const state = props.testState;
  if (!state || state.status === "idle") return null;
  switch (state.status) {
    case "testing":
      return { text: "测试中", cls: "text-accent" };
    case "ok":
      return { text: `${state.latencyMs} ms`, cls: "text-live" };
    case "fail":
      return { text: "失败", cls: "text-danger" };
  }
  return null;
});
</script>

<template>
  <!-- Files 快速访问磁贴：悬停 Subtle 填充 + 4 圆角，整卡点击即连接 -->
  <div
    role="button"
    tabindex="0"
    class="group relative flex cursor-default items-center gap-3 rounded-[4px] p-3 transition-colors hover:bg-fill-subtle"
    :title="testState?.status === 'fail' ? testState.message : `${profile.username}@${profile.host}:${profile.port}`"
    @click="emit('connect', profile)"
    @keydown.enter="emit('connect', profile)"
  >
    <!-- 图标块 40×40 -->
    <span
      class="flex h-10 w-10 shrink-0 items-center justify-center rounded-[4px]"
      :style="{ background: 'color-mix(in srgb, var(--accent) 12%, transparent)', color: 'var(--accent)' }"
    >
      <LoaderCircle v-if="connecting" :size="18" class="animate-spin" />
      <Server v-else :size="18" />
    </span>

    <span class="min-w-0 flex-1">
      <span class="block truncate text-sm font-semibold">{{ profile.alias || profile.host }}</span>
      <span class="mt-0.5 block truncate text-xs text-dim">
        <span class="mr-1.5 inline-flex items-center gap-0.5 align-middle text-faint">
          <KeyRound :size="10" />
          {{ profile.authMethod === "privateKey" ? "私钥" : "密码" }}
        </span>
        <span class="font-mono">{{ profile.username }}@{{ profile.host }}</span>
      </span>
      <span
        v-if="testChip"
        class="chip mt-1"
        :class="testChip.cls"
        :style="{ background: 'var(--fill-subtle)' }"
      >
        {{ testChip.text }}
      </span>
    </span>

    <!-- 悬停浮现的「更多」菜单（Files 磁贴右上角 E712） -->
    <span class="relative opacity-0 transition-opacity group-hover:opacity-100" @click.stop>
      <button
        type="button"
        class="btn-icon h-7 w-7"
        title="更多选项"
        aria-label="更多选项"
        @click="menuOpen = !menuOpen"
      >
        <MoreHorizontal :size="14" />
      </button>
      <DropdownMenu :open="menuOpen" :items="menuItems" @select="onMenuSelect" @close="menuOpen = false" />
    </span>
  </div>
</template>
