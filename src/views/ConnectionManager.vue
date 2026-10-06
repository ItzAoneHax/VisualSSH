<script setup lang="ts">
import { House, LoaderCircle, Plus, Server, TriangleAlert } from "@lucide/vue";
import { computed, ref } from "vue";

import ConnectionCard from "@/components/connection/ConnectionCard.vue";
import ConnectionForm from "@/components/connection/ConnectionForm.vue";
import Modal from "@/components/common/Modal.vue";
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

function handleSave(
  profile: SshProfile,
  secrets: { password?: string; passphrase?: string },
) {
  void connections.upsert(profile, secrets);
  formOpen.value = false;
}

function handleRemove(profile: SshProfile) {
  if (window.confirm(`删除连接「${profile.alias || profile.host}」？`)) {
    connections.remove(profile.id);
  }
}
</script>

<template>
  <div class="flex h-full">
    <!-- 侧栏（与工作区同构）：主页 + 已保存连接 -->
    <aside class="flex w-56 shrink-0 flex-col py-2 pl-1.5">
      <nav aria-label="导航">
        <button type="button" class="nav-item active">
          <House :size="16" class="ml-1 shrink-0" />
          <span class="ml-3 truncate">主页</span>
        </button>

        <template v-if="sortedProfiles.length">
          <p class="mt-4 mb-1 px-2.5 text-xs font-medium text-faint">已保存的连接</p>
          <button
            v-for="profile in sortedProfiles"
            :key="profile.id"
            type="button"
            class="nav-item"
            :title="`${profile.username}@${profile.host}`"
            @click="connections.connect(profile)"
          >
            <LoaderCircle
              v-if="connections.connectingId === profile.id"
              :size="16"
              class="ml-1 shrink-0 animate-spin"
            />
            <Server v-else :size="16" class="ml-1 shrink-0" />
            <span class="ml-3 truncate">{{ profile.alias || profile.host }}</span>
          </button>
        </template>
      </nav>

      <p class="mt-auto px-2.5 pb-2 text-xs text-faint">VisualSSH 0.1.0</p>
    </aside>

    <!-- 主列：工具栏卡（含「新建」主按钮 + 主页地址药丸）+ 快速访问 widget -->
    <div class="flex min-w-0 flex-1 flex-col gap-1 p-2 pl-2.5">
      <div
        class="flex h-12 shrink-0 items-center gap-1 rounded-lg px-1"
        :style="{ background: 'var(--toolbar)', border: '1px solid var(--line)' }"
      >
        <button type="button" class="btn-primary ml-1 gap-1.5" @click="openCreate">
          <Plus :size="15" />
          新建
        </button>

        <div
          class="mx-1.5 flex h-[34px] min-w-0 flex-1 items-center rounded-[4px] px-3 text-sm"
          :style="{ background: 'var(--sidebar)', border: '1px solid var(--line)' }"
        >
          <House :size="14" class="mr-1.5 shrink-0 text-dim" />
          <span class="truncate font-semibold">主页</span>
        </div>

        <ThemeToggle />
      </div>

      <div v-if="connections.lastError" class="flex items-center gap-2.5 rounded-lg px-3.5 py-2.5 text-sm" :style="{ background: 'color-mix(in srgb, var(--danger) 10%, transparent)', color: 'var(--danger)' }">
        <TriangleAlert :size="16" class="shrink-0" />
        <span class="min-w-0 flex-1 truncate font-mono text-xs" :title="connections.lastError">
          {{ connections.lastError }}
        </span>
      </div>

      <!-- 快速访问 widget（Files 主页 Expander 卡） -->
      <div
        class="min-h-0 flex-1 overflow-y-auto rounded-lg"
        :style="{ background: 'var(--panel)', border: '1px solid var(--line)' }"
      >
        <div class="mx-2 mb-2 mt-2.5">
          <!-- widget 标题：caption 12 Semibold 次级色 -->
          <div class="flex h-8 items-center px-2">
            <h2 class="text-xs font-semibold text-dim">快速访问</h2>
            <span class="ml-2 text-xs text-faint">{{ sortedProfiles.length }}</span>
          </div>

          <div v-if="sortedProfiles.length" class="grid gap-0.5 sm:grid-cols-2">
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

          <div v-else class="flex flex-col items-center pt-24 pb-16 text-dim">
            <Server :size="28" class="mb-3 text-faint" />
            <p class="text-sm">还没有保存的连接</p>
            <p class="mt-1 max-w-72 text-center text-xs leading-5">
              新建第一个连接，开始像管理本地文件夹一样管理远程服务器。
            </p>
            <button type="button" class="btn-primary mt-5" @click="openCreate">
              <Plus :size="15" />
              新建连接
            </button>
          </div>
        </div>

        <p class="px-4 pt-1 pb-4 text-center text-xs leading-5 text-faint">
          连接配置仅保存在本机；密码与私钥口令加密存于 Windows 凭据管理器，不会上传到任何服务器。
        </p>
      </div>
    </div>

    <ConnectionForm
      :open="formOpen"
      :profile="editingProfile"
      @close="formOpen = false"
      @save="handleSave"
    />

    <!-- 指纹变更确认（TOFU）：展示新旧指纹，确认即更新记录并重连 -->
    <Modal
      :open="!!connections.hostKeyPrompt"
      title="服务器指纹已变更"
      @close="connections.cancelHostKey()"
    >
      <div v-if="connections.hostKeyPrompt" class="flex flex-col gap-4">
        <div
          class="flex items-start gap-2.5 rounded-lg p-3 text-sm leading-6"
          :style="{
            background: 'color-mix(in srgb, var(--danger) 10%, transparent)',
            color: 'var(--danger)',
          }"
        >
          <TriangleAlert :size="16" class="mt-1 shrink-0" />
          <span>
            <span class="font-mono font-semibold">
              {{ connections.hostKeyPrompt.host }}:{{ connections.hostKeyPrompt.port }}
            </span>
            的主机公钥指纹与上次连接时不同。这可能是服务器重装或更换了密钥，
            也可能是中间人攻击。请确认您了解这一变化后再继续。
          </span>
        </div>

        <dl class="grid grid-cols-[5.5rem_1fr] items-center gap-x-3 gap-y-2 text-sm">
          <dt class="text-dim">原指纹</dt>
          <dd class="truncate rounded-[4px] px-2 py-1 font-mono text-xs"
              :style="{ background: 'var(--fill-control)' }"
              :title="connections.hostKeyPrompt.oldFingerprint">
            {{ connections.hostKeyPrompt.oldFingerprint }}
          </dd>
          <dt class="text-dim">新指纹</dt>
          <dd class="truncate rounded-[4px] px-2 py-1 font-mono text-xs font-semibold"
              :style="{ background: 'var(--fill-control)' }"
              :title="connections.hostKeyPrompt.newFingerprint">
            {{ connections.hostKeyPrompt.newFingerprint }}
          </dd>
          <dt class="text-dim">密钥类型</dt>
          <dd class="font-mono text-xs">{{ connections.hostKeyPrompt.algorithm }}</dd>
        </dl>

        <footer class="mt-1 flex justify-end gap-2">
          <button type="button" class="btn-secondary" @click="connections.cancelHostKey()">
            取消连接
          </button>
          <button type="button" class="btn-danger" @click="connections.confirmHostKey()">
            信任新指纹并连接
          </button>
        </footer>
      </div>
    </Modal>
  </div>
</template>
