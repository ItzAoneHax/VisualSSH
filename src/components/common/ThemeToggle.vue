<script setup lang="ts">
import { Moon, Sun } from "@lucide/vue";
import { ref } from "vue";

const isDark = ref(document.documentElement.classList.contains("dark"));

function toggle() {
  isDark.value = !isDark.value;
  document.documentElement.classList.toggle("dark", isDark.value);
  try {
    localStorage.setItem(
      "visualssh:theme",
      isDark.value ? "dark" : "light",
    );
  } catch {
    // 隐私模式下 localStorage 不可用，仅本次会话生效
  }
}
</script>

<template>
  <button
    type="button"
    class="btn-icon"
    :title="isDark ? '切换到明亮主题' : '切换到暗黑主题'"
    :aria-label="isDark ? '切换到明亮主题' : '切换到暗黑主题'"
    @click="toggle"
  >
    <Sun v-if="isDark" :size="16" />
    <Moon v-else :size="16" />
  </button>
</template>
