import { defineStore } from "pinia";
import { ref } from "vue";

import { execSsh } from "@/api/ssh";
import { PROBE_SCRIPT, parseProbe } from "@/utils/archive";

/**
 * 服务器压缩工具能力（第五阶段块 C1）：连接建立后惰性探测一次
 * `command -v tar zip unzip gzip xz bzip2`，结果缓存于连接标识；
 * 重连产生新标识自然重探。菜单项按可用性显隐/置灰（C6）。
 */
export const useArchivesStore = defineStore("archives", () => {
  /** connectionId → 可用工具名列表（空数组 = 已探测且全缺） */
  const byConnection = ref<Record<string, string[]>>({});
  const probing = ref<Record<string, boolean>>({});

  async function ensureProbe(connectionId: string): Promise<void> {
    if (!connectionId || byConnection.value[connectionId] || probing.value[connectionId]) {
      return;
    }
    probing.value[connectionId] = true;
    try {
      const out = await execSsh(connectionId, "sh", ["-c", PROBE_SCRIPT]);
      byConnection.value[connectionId] = [...parseProbe(out.stdout)];
    } catch {
      // 探测失败按全缺处理（菜单置灰；重连新标识会重探）
      byConnection.value[connectionId] = [];
    } finally {
      delete probing.value[connectionId];
    }
  }

  function has(connectionId: string, tool: string): boolean {
    return byConnection.value[connectionId]?.includes(tool) ?? false;
  }

  function probed(connectionId: string): boolean {
    return !!byConnection.value[connectionId];
  }

  return { byConnection, ensureProbe, has, probed };
});
