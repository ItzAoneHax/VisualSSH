<script setup lang="ts">
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
  <Transition name="view" mode="out-in">
    <Workspace v-if="connections.active" :key="connections.active.connectionId" @disconnect="handleDisconnect" />
    <ConnectionManager v-else key="manager" />
  </Transition>
</template>
