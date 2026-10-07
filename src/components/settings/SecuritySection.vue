<script setup lang="ts">
import { ShieldCheck, Trash2 } from "@lucide/vue";
import { invoke } from "@tauri-apps/api/core";
import { onMounted, ref } from "vue";

/** SSH 安全分区：known_hosts（TOFU 信任记录）管理 */
interface KnownHostRow {
  host: string;
  port: number;
  algorithm: string;
  fingerprint: string;
}

const knownHosts = ref<KnownHostRow[] | null>(null);

async function loadKnownHosts() {
  try {
    knownHosts.value = await invoke<KnownHostRow[]>("ssh_known_hosts_list");
  } catch {
    knownHosts.value = [];
  }
}

async function removeKnownHost(row: KnownHostRow) {
  try {
    await invoke("ssh_known_hosts_remove", { host: row.host, port: row.port });
  } catch {
    // 删除失败保留原列表
  }
  await loadKnownHosts();
}

onMounted(() => {
  void loadKnownHosts();
});
</script>

<template>
  <h2 class="text-xl font-semibold">SSH 安全</h2>
  <p class="mt-1 mb-4 text-xs text-dim">
    管理已信任的主机公钥指纹（TOFU）。删除后再次连接将重新触发首次信任确认。
  </p>

  <div v-if="!knownHosts?.length" class="py-10 text-center text-xs text-dim">
    暂无已信任主机
  </div>

  <div v-else class="flex flex-col gap-1">
    <div
      v-for="row in knownHosts"
      :key="`${row.host}:${row.port}`"
      class="settings-card"
    >
      <ShieldCheck :size="20" class="shrink-0 text-live" />
      <div class="min-w-0 flex-1">
        <p class="truncate text-sm font-medium">
          <span class="font-mono">{{ row.host }}</span>:{{ row.port }}
        </p>
        <p class="mt-0.5 truncate font-mono text-xs text-dim" :title="`${row.algorithm} · ${row.fingerprint}`">
          {{ row.algorithm }} · {{ row.fingerprint }}
        </p>
      </div>
      <button
        type="button"
        class="btn-icon h-8 w-8 shrink-0"
        title="删除信任记录"
        :aria-label="`删除 ${row.host} 的信任记录`"
        @click="removeKnownHost(row)"
      >
        <Trash2 :size="15" />
      </button>
    </div>
  </div>
</template>
