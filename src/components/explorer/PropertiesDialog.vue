<script setup lang="ts">
import { File, Files, Folder, Layers, Link2 } from "@lucide/vue";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import Modal from "@/components/common/Modal.vue";
import { dirStats, dirStatsCancel, readLinkSsh, type DirStatsProgress } from "@/api/ssh";
import { useConnectionsStore } from "@/stores/connections";
import type { FileEntry } from "@/types";
import { formatMtime, formatSize } from "@/utils/format";

/**
 * 属性对话框（Files GeneralPage 的远端单页版）：
 * 头部 kind 图标 + 名称（单选可编辑，回车提交走现有 rename 流程）；
 * 字段区 类型/位置/时间/属主组/权限/链接目标；文件夹与多选走递归统计块
 * （跳过符号链接目录防环，进度经 props://stats 事件，关闭对话框即取消）。
 */
const props = defineProps<{
  targets: FileEntry[] | null;
  parentDir: string;
}>();

const emit = defineEmits<{
  close: [];
  rename: [oldName: string, newName: string];
  chmod: [entry: FileEntry];
}>();

const connections = useConnectionsStore();

const single = computed(() =>
  props.targets?.length === 1 ? props.targets[0] : null,
);

/** 多选头部图标按选择构成：全文件夹 / 全文件 / 混合 */
const multiIcon = computed(() => {
  const targets = props.targets ?? [];
  if (!targets.length) return Folder;
  if (targets.every((t) => t.kind === "dir")) return Folder;
  if (targets.every((t) => t.kind === "file")) return Files;
  return Layers;
});

/** 统计状态 */
const stats = ref<{ files: number; dirs: number; bytes: number } | null>(null);
const statsRunning = ref(false);
const statsStopped = ref(false);
const statsError = ref<string | null>(null);
let statsId = "";
let unlistenStats: UnlistenFn | null = null;

/** 单选名称编辑与符号链接目标 */
const nameEdit = ref("");
const linkTarget = ref<string | null>(null);

const isTauri = () => "__TAURI_INTERNALS__" in window;

function stopStats() {
  if (statsRunning.value && statsId) {
    void dirStatsCancel(statsId).catch(() => {});
  }
  statsRunning.value = false;
  unlistenStats?.();
  unlistenStats = null;
}

watch(
  () => props.targets,
  (targets) => {
    stopStats();
    stats.value = null;
    statsStopped.value = false;
    statsError.value = null;
    linkTarget.value = null;
    if (!targets?.length) return;
    const one = targets.length === 1 ? targets[0] : null;
    if (one) nameEdit.value = one.name;

    const connectionId = connections.active?.connectionId;
    if (!connectionId) return;

    // 符号链接目标（读取失败时隐藏行）
    if (one?.kind === "symlink") {
      readLinkSsh(connectionId, joinRemote(one.name))
        .then((t) => {
          if (props.targets?.length === 1 && props.targets[0].name === one.name) {
            linkTarget.value = t;
          }
        })
        .catch(() => {});
    }

    // 递归统计：文件夹或多选（单文件直接显示大小，Files 同款分流）
    if (targets.length > 1 || one?.kind === "dir") {
      void startStats(connectionId, one ? undefined : targets.map((t) => t.name));
    }
  },
);

async function startStats(connectionId: string, subpaths?: string[]) {
  statsId = crypto.randomUUID();
  statsRunning.value = true;
  if (isTauri()) {
    try {
      unlistenStats = await listen<DirStatsProgress>(
        `props://stats:${statsId}`,
        (event) => {
          const p = event.payload;
          if (p.statsId !== statsId) return;
          stats.value = { files: p.files, dirs: p.dirs, bytes: p.bytes };
          if (p.done) {
            statsRunning.value = false;
            unlistenStats?.();
            unlistenStats = null;
          }
        },
      );
    } catch {
      // 事件桥不可用：仅丢一次命令，UI 停在等待态直到取消
    }
  }
  try {
    await dirStats(connectionId, props.parentDir, statsId, subpaths);
  } catch (e) {
    statsError.value = e instanceof Error ? e.message : String(e);
    statsRunning.value = false;
    unlistenStats?.();
    unlistenStats = null;
  }
}

function cancelStats() {
  stopStats();
  statsStopped.value = true;
}

onBeforeUnmount(stopStats);

function joinRemote(name: string): string {
  if (props.parentDir === "/") return `/${name}`;
  return `${props.parentDir}/${name}`;
}

const typeText = computed(() => {
  const one = single.value;
  if (!one) return `${props.targets?.length ?? 0} 个项目`;
  switch (one.kind) {
    case "dir":
      return "文件夹";
    case "symlink":
      return "符号链接";
    case "other":
      return "其他";
    default: {
      const dot = one.name.lastIndexOf(".");
      return dot > 0 ? `文件（${one.name.slice(dot + 1).toLowerCase()}）` : "文件";
    }
  }
});

/** 八进制权限（与 ChmodDialog 的位还原规则一致） */
const octalText = computed(() => {
  const p = single.value?.permissions ?? "";
  let mode = 0;
  for (let i = 0; i < 9; i++) {
    if (p[1 + i] !== undefined && p[1 + i] !== "-") mode |= 1 << (8 - i);
  }
  return "0" + mode.toString(8).padStart(3, "0");
});

function commitRename() {
  const one = single.value;
  const name = nameEdit.value.trim();
  if (!one || !name || name === one.name) return;
  emit("rename", one.name, name);
}
</script>

<template>
  <Modal :open="!!targets" title="属性" :max-width="480" @close="emit('close')">
    <div v-if="targets?.length" class="flex flex-col gap-4">
      <!-- 头部：kind 图标 + 名称（单选可编辑）/ 项目数 -->
      <header class="flex items-center gap-3.5">
        <span
          class="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg"
          :style="{ background: 'var(--fill-control)', border: '1px solid var(--line)' }"
        >
          <template v-if="single">
            <Folder
              v-if="single.kind === 'dir'"
              :size="32"
              class="text-folder"
              fill="currentColor"
            />
            <Link2 v-else-if="single.kind === 'symlink'" :size="32" class="text-accent" />
            <File v-else :size="32" class="text-dim" />
          </template>
          <Folder v-else-if="multiIcon === Folder" :size="32" class="text-folder" fill="currentColor" />
          <Files v-else-if="multiIcon === Files" :size="32" class="text-dim" />
          <Layers v-else :size="32" class="text-dim" />
        </span>
        <div class="min-w-0 flex-1">
          <input
            v-if="single"
            v-model="nameEdit"
            class="field-input h-9"
            aria-label="名称"
            spellcheck="false"
            @keydown.enter.prevent="commitRename"
          />
          <p v-else class="text-lg font-semibold">
            {{ targets.length }} 个项目
          </p>
          <p v-if="single" class="mt-1 truncate text-xs text-faint">
            重命名后回车提交
          </p>
        </div>
      </header>

      <!-- 字段区（Files GeneralPage：标签列 MinWidth 100 + 8 间距） -->
      <div
        class="grid grid-cols-[6.5rem_minmax(0,1fr)] items-baseline gap-x-2 gap-y-2.5 text-sm"
      >
        <span class="text-dim">类型</span>
        <span class="min-w-0 truncate" :title="typeText">{{ typeText }}</span>

        <span class="text-dim">位置</span>
        <span class="truncate font-mono text-xs" :title="parentDir">{{ parentDir }}</span>

        <template v-if="single">
          <!-- 单文件直接显示大小；文件夹由统计块给出 -->
          <template v-if="single.kind !== 'dir'">
            <span class="text-dim">大小</span>
            <span class="tabular-nums">{{ formatSize(single.size) }}</span>
          </template>

          <span class="text-dim">修改时间</span>
          <span class="tabular-nums">{{ formatMtime(single.mtime) }}</span>

          <template v-if="single.atime != null">
            <span class="text-dim">访问时间</span>
            <span class="tabular-nums">{{ formatMtime(single.atime) }}</span>
          </template>

          <template v-if="single.owner">
            <span class="text-dim">属主</span>
            <span class="truncate">{{ single.owner }}</span>
          </template>

          <template v-if="single.group">
            <span class="text-dim">组</span>
            <span class="truncate">{{ single.group }}</span>
          </template>

          <span class="text-dim">权限</span>
          <span class="flex min-w-0 items-baseline gap-2">
            <span class="font-mono text-xs">{{ single.permissions }}</span>
            <span class="font-mono text-xs">{{ octalText }}</span>
            <button
              type="button"
              class="btn-secondary h-7 shrink-0 px-2 text-xs"
              @click="single && emit('chmod', single)"
            >
              修改权限…
            </button>
          </span>

          <template v-if="single.kind === 'symlink' && linkTarget != null">
            <span class="text-dim">链接目标</span>
            <span class="break-all font-mono text-xs" :title="linkTarget">{{ linkTarget }}</span>
          </template>
        </template>
      </div>

      <!-- 递归统计块（文件夹/多选）：计算中可取消，完成后显示最终大小与计数 -->
      <div
        v-if="statsRunning || stats || statsError"
        class="flex flex-col gap-2 rounded-[4px] px-3 py-2.5"
        :style="{ background: 'var(--fill-control)' }"
      >
        <template v-if="statsRunning">
          <p class="text-xs text-dim">
            计算中…已统计 {{ stats?.files ?? 0 }} 文件 · {{ stats?.dirs ?? 0 }} 文件夹 ·
            {{ formatSize(stats?.bytes ?? 0) }}
          </p>
          <div class="flex items-center gap-3">
            <div
              class="progress-indeterminate h-1 min-w-0 flex-1 rounded-full"
              :style="{ background: 'var(--fill-subtle)' }"
            />
            <button type="button" class="btn-secondary h-7 shrink-0 px-2 text-xs" @click="cancelStats">
              取消
            </button>
          </div>
        </template>
        <template v-else-if="stats">
          <p class="text-sm">
            {{ formatSize(stats.bytes) }}
            <span v-if="statsStopped" class="text-xs text-faint">（已停止）</span>
          </p>
          <p class="text-xs text-dim">
            包含 {{ stats.files }} 个文件，{{ stats.dirs }} 个文件夹
          </p>
        </template>
        <p v-else-if="statsError" class="text-xs" :style="{ color: 'var(--danger)' }">
          无法统计：{{ statsError }}
        </p>
      </div>

      <footer class="flex justify-end gap-2">
        <button type="button" class="btn-secondary" @click="emit('close')">关闭</button>
      </footer>
    </div>
  </Modal>
</template>
