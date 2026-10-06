<script setup lang="ts">
import TitleBar from "@/components/common/TitleBar.vue";
import { useConnectionsStore } from "@/stores/connections";
import { useExplorerStore } from "@/stores/explorer";
import ConnectionManager from "@/views/ConnectionManager.vue";
import Workspace from "@/views/Workspace.vue";

const connections = useConnectionsStore();
const explorer = useExplorerStore();

function handleDisconnect() {
  void connections.disconnect().then(() => explorer.clear());
}
</script>

<template>
  <div class="flex h-full flex-col">
    <TitleBar />
    <div class="min-h-0 flex-1">
      <Transition name="view" mode="out-in">
        <Workspace
          v-if="connections.active"
          :key="connections.active.connectionId"
          @disconnect="handleDisconnect"
        />
        <ConnectionManager v-else key="manager" />
      </Transition>
    </div>
  </div>
</template>
