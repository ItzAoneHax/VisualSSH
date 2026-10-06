<script setup lang="ts">
import { reactive, watch } from "vue";

import Modal from "@/components/common/Modal.vue";
import type { AuthMethod, SshProfile } from "@/types";

const props = defineProps<{
  open: boolean;
  /** 传入则为编辑模式，否则为新建 */
  profile: SshProfile | null;
}>();

const emit = defineEmits<{
  close: [];
  save: [profile: SshProfile];
}>();

interface FormState {
  alias: string;
  host: string;
  port: number;
  username: string;
  authMethod: AuthMethod;
  password: string;
  privateKeyPath: string;
  passphrase: string;
}

const blank = (): FormState => ({
  alias: "",
  host: "",
  port: 22,
  username: "root",
  authMethod: "password",
  password: "",
  privateKeyPath: "",
  passphrase: "",
});

const form = reactive<FormState>(blank());
const errors = reactive<{ host: string; username: string; port: string }>({
  host: "",
  username: "",
  port: "",
});

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    const source = props.profile;
    Object.assign(form, blank(), {
      alias: source?.alias ?? source?.host ?? "",
      host: source?.host ?? "",
      port: source?.port ?? 22,
      username: source?.username ?? "root",
      authMethod: source?.authMethod ?? "password",
      password: source?.password ?? "",
      privateKeyPath: source?.privateKeyPath ?? "",
      passphrase: source?.passphrase ?? "",
    });
    errors.host = errors.username = errors.port = "";
  },
);

function save() {
  errors.host = form.host.trim() ? "" : "请填写主机名或 IP";
  errors.username = form.username.trim() ? "" : "请填写用户名";
  errors.port = form.port >= 1 && form.port <= 65535 ? "" : "端口范围 1–65535";
  if (errors.host || errors.username || errors.port) return;

  const base: SshProfile = {
    id: props.profile?.id ?? crypto.randomUUID(),
    alias: form.alias.trim() || form.host.trim(),
    host: form.host.trim(),
    port: form.port,
    username: form.username.trim(),
    authMethod: form.authMethod,
    createdAt: props.profile?.createdAt ?? Date.now(),
  };
  if (form.authMethod === "password") {
    base.password = form.password || undefined;
  } else {
    base.privateKeyPath = form.privateKeyPath.trim() || undefined;
    base.passphrase = form.passphrase || undefined;
  }
  emit("save", base);
}
</script>

<template>
  <Modal :open="open" :title="profile ? '编辑连接' : '新建连接'" @close="emit('close')">
    <form class="flex flex-col gap-4" @submit.prevent="save">
      <div>
        <label class="field-label" for="f-alias">名称</label>
        <input id="f-alias" v-model="form.alias" class="field-input" placeholder="生产服务器" autocomplete="off" />
      </div>

      <div class="grid grid-cols-[1fr_96px] gap-3">
        <div>
          <label class="field-label" for="f-host">主机</label>
          <input
            id="f-host"
            v-model="form.host"
            class="field-input font-mono"
            :class="errors.host && 'border-danger'"
            placeholder="192.168.1.10"
            autocomplete="off"
          />
          <p v-if="errors.host" class="mt-1 text-xs text-danger">{{ errors.host }}</p>
        </div>
        <div>
          <label class="field-label" for="f-port">端口</label>
          <input
            id="f-port"
            v-model.number="form.port"
            class="field-input font-mono"
            :class="errors.port && 'border-danger'"
            type="number"
            min="1"
            max="65535"
          />
          <p v-if="errors.port" class="mt-1 text-xs text-danger">{{ errors.port }}</p>
        </div>
      </div>

      <div>
        <label class="field-label" for="f-user">用户名</label>
        <input
          id="f-user"
          v-model="form.username"
          class="field-input font-mono"
          :class="errors.username && 'border-danger'"
          placeholder="root"
          autocomplete="off"
        />
        <p v-if="errors.username" class="mt-1 text-xs text-danger">{{ errors.username }}</p>
      </div>

      <div>
        <span class="field-label">认证方式</span>
        <div class="grid grid-cols-2 gap-2 rounded-lg border border-line bg-panel-2 p-1">
          <button
            v-for="method in [{ key: 'password', label: '密码' }, { key: 'privateKey', label: '私钥' }] as const"
            :key="method.key"
            type="button"
            class="rounded-md px-3 py-1.5 text-xs font-semibold transition-colors"
            :class="form.authMethod === method.key ? 'bg-panel text-ink shadow-sm' : 'text-dim hover:text-ink'"
            @click="form.authMethod = method.key"
          >
            {{ method.label }}
          </button>
        </div>
      </div>

      <div v-if="form.authMethod === 'password'">
        <label class="field-label" for="f-pass">密码</label>
        <input
          id="f-pass"
          v-model="form.password"
          class="field-input font-mono"
          type="password"
          placeholder="••••••••"
          autocomplete="new-password"
        />
      </div>

      <template v-else>
        <div>
          <label class="field-label" for="f-key">私钥文件路径</label>
          <input
            id="f-key"
            v-model="form.privateKeyPath"
            class="field-input font-mono"
            placeholder="C:\Users\you\.ssh\id_ed25519"
            autocomplete="off"
          />
        </div>
        <div>
          <label class="field-label" for="f-passphrase">私钥口令（可选）</label>
          <input
            id="f-passphrase"
            v-model="form.passphrase"
            class="field-input font-mono"
            type="password"
            autocomplete="new-password"
          />
        </div>
      </template>

      <footer class="mt-1 flex justify-end gap-2">
        <button type="button" class="btn-secondary" @click="emit('close')">取消</button>
        <button type="submit" class="btn-primary">保存连接</button>
      </footer>
    </form>
  </Modal>
</template>
