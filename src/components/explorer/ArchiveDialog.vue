<script setup lang="ts">
import { ref, watch } from "vue";

import Modal from "@/components/common/Modal.vue";
import { swapArchiveExt, type CompressFormat } from "@/utils/archive";

/**
 * 压缩为…（第五阶段块 C2，范式对照 Files CreateArchiveDialog.xaml）：
 * 只保留 格式 + 文件名 两项（压缩级别/分卷/字典/线程/加密均砍——服务器侧
 * tar/zip 无对应能力），zip 服务器不可用时置灰。
 */
const props = defineProps<{
  open: boolean;
  /** 默认文件名（含扩展名） */
  defaultName: string;
  tarAvailable: boolean;
  zipAvailable: boolean;
}>();

const emit = defineEmits<{
  close: [];
  submit: [{ format: CompressFormat; name: string }];
}>();

const format = ref<CompressFormat>("tar.gz");
const name = ref("");
const nameInvalid = ref(false);

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    // 默认 tar.gz；无 tar 有 zip 时选 zip
    format.value = props.tarAvailable ? "tar.gz" : "zip";
    name.value = props.defaultName;
    nameInvalid.value = false;
  },
);

const FORMATS: { key: CompressFormat; label: string; tool: "tar" | "zip" }[] = [
  { key: "tar.gz", label: "tar.gz", tool: "tar" },
  { key: "zip", label: "zip", tool: "zip" },
];

function pickFormat(key: CompressFormat, tool: "tar" | "zip") {
  const available = tool === "tar" ? props.tarAvailable : props.zipAvailable;
  if (!available) return;
  // 换格式时同步替换扩展名（完整剥档案后缀：a.tar.gz → a.zip，不留冗余 .tar）
  name.value = swapArchiveExt(name.value, key);
  format.value = key;
}

function submit() {
  const trimmed = name.value.trim();
  if (!trimmed || trimmed.includes("/")) {
    nameInvalid.value = true;
    return;
  }
  emit("submit", { format: format.value, name: trimmed });
}
</script>

<template>
  <Modal :open="open" title="压缩为…" @close="emit('close')">
    <form class="flex flex-col gap-4" @submit.prevent="submit">
      <div>
        <p class="field-label">格式</p>
        <div
          class="flex w-fit rounded-md p-0.5"
          :style="{ background: 'var(--fill-control)', border: '1px solid var(--line)' }"
          role="tablist"
          aria-label="压缩格式"
        >
          <button
            v-for="f in FORMATS"
            :key="f.key"
            type="button"
            role="tab"
            class="rounded-[4px] px-3 py-1 text-xs font-medium transition-colors"
            :class="[
              format === f.key ? 'text-ink' : 'text-dim hover:text-ink',
              !(f.tool === 'tar' ? tarAvailable : zipAvailable) && 'cursor-not-allowed opacity-40 hover:text-dim',
            ]"
            :style="format === f.key
              ? { background: 'var(--surface-solid)', boxShadow: '0 1px 2px rgba(0, 0, 0, 0.16)' }
              : undefined"
            :aria-selected="format === f.key"
            :title="!(f.tool === 'tar' ? tarAvailable : zipAvailable)
              ? `服务器缺少 ${f.tool} 命令`
              : undefined"
            @click="pickFormat(f.key, f.tool)"
          >
            {{ f.label }}
          </button>
        </div>
      </div>

      <div>
        <label class="field-label" for="archive-name">文件名</label>
        <input
          id="archive-name"
          v-model="name"
          class="field-input font-mono"
          spellcheck="false"
          :aria-invalid="nameInvalid"
          @input="nameInvalid = false"
        />
        <p v-if="nameInvalid" class="mt-1 text-xs" style="color: var(--danger)">
          请输入不包含斜杠的文件名
        </p>
      </div>

      <footer class="flex justify-end gap-2">
        <button type="button" class="btn-secondary" @click="emit('close')">
          取消
        </button>
        <button type="submit" class="btn-primary">压缩</button>
      </footer>
    </form>
  </Modal>
</template>
