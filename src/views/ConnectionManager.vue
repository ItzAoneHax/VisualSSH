<script setup lang="ts">
import { Plus, Server, TriangleAlert } from "@lucide/vue";
import { computed, ref } from "vue";

import ConnectionCard from "@/components/connection/ConnectionCard.vue";
import ConnectionForm from "@/components/connection/ConnectionForm.vue";
import ThemeToggle from "@/components/common/ThemeToggle.vue";
import { useConnectionsStore } from "@/stores/connections";
import type { SshProfile } from "@/types";

const connections = useConnectionsStore();

const formOpen = ref(false);
const editingProfile = ref<SshProfile | null>(null);

const sortedProfiles = computed(() =>
  [...connections.profiles].sort((a, b) => a.createdAt - b.createdAt),
);

function openCreate() {
  editingProfile.value = null;
  formOpen.value = true;
}

function openEdit(profile: SshProfile) {
  editingProfile.value = profile;
  formOpen.value = true;
}

function handleSave(profile: SshProfile) {
  connections.upsert(profile);
  formOpen.value = false;
}

function handleRemove(profile: SshProfile) {
  if (window.confirm(`删除连接「${profile.alias || profile.host}」？`)) {
    connections.remove(profile.id);
  }
}
</script>

<template>
  <div class="h-full overflow-y-auto">
    <main class="mx-auto flex min-h-full w-full max-w-4xl flex-col px-6 py-10">
      <header class="flex items-start justify-between">
        <div class="flex items-center gap-3.5">
          <img src="/favicon.svg" alt="" class="h-11 w-11" draggable="false" />
          <div>
            <h1 class="text-2xl font-bold tracking-tight">VisualSSH</h1>
            <p class="mt-0.5 text-sm text-dim">远程文件，本地体验</p>
          </div>
        </div>
        <ThemeToggle />
      </header>

      <div
        v-if="connections.lastError"
        class="mt-6 flex items-start gap-2.5 rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger"
      >
        <TriangleAlert :size="16" class="mt-0.5 shrink-0" />
        <span class="font-mono text-xs leading-5">{{ connections.lastError }}</span>
      </div>

      <section class="mt-9">
        <div class="mb-3 flex items-center justify-between">
          <h2 class="text-[11px] font-bold tracking-[0.14em] text-faint uppercase">
            已保存的连接 · {{ sortedProfiles.length }}
          </h2>
          <button type="button" class="btn-primary h-8 px-3 text-xs" @click="openCreate">
            <Plus :size="14" />
            新建连接
          </button>
        </div>

        <div v-if="sortedProfiles.length" class="grid gap-3 sm:grid-cols-2">
          <ConnectionCard
            v-for="profile in sortedProfiles"
            :key="profile.id"
            :profile="profile"
            :test-state="connections.testStates[profile.id] ?? { status: 'idle' }"
            :connecting="connections.connectingId === profile.id"
            @connect="connections.connect"
            @test="connections.test"
            @edit="openEdit"
            @remove="handleRemove"
          />
        </div>

        <div
          v-else
          class="flex flex-col items-center rounded-xl border border-dashed border-line px-6 py-14 text-center"
        >
          <Server :size="30" class="text-faint" />
          <p class="mt-3 text-sm font-semibold">还没有保存的连接</p>
          <p class="mt-1 max-w-72 text-xs leading-5 text-dim">
            新建第一个连接，开始像管理本地文件夹一样管理远程服务器。
          </p>
          <button type="button" class="btn-primary mt-5" @click="openCreate">
            <Plus :size="15" />
            新建连接
          </button>
        </div>
      </section>

      <footer class="mt-auto pt-10 text-center text-[11px] leading-5 text-faint">
        MVP 阶段连接信息仅保存在本机；私钥与密码不会上传到任何服务器。
      </footer>
    </main>

    <ConnectionForm
      :open="formOpen"
      :profile="editingProfile"
      @close="formOpen = false"
      @save="handleSave"
    />
  </div>
</template>
