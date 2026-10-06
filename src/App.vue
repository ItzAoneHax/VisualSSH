<script setup lang="ts">
import TitleBar from "@/components/common/TitleBar.vue";
import { useConnectionsStore } from "@/stores/connections";
import { useExplorerStore } from "@/stores/explorer";
import ConnectionManager from "@/views/ConnectionManager.vue";
import SettingsView from "@/views/SettingsView.vue";
import Workspace from "@/views/Workspace.vue";
import { useSettingsStore } from "@/stores/settings";

const connections = useConnectionsStore();
const explorer = useExplorerStore();
const settings = useSettingsStore();

function handleDisconnect() {
  void connections.disconnect().then(() => explorer.clear());
}
</script>

<template>
  <div class="flex h-full flex-col">
    <TitleBar />
    <div class="min-h-0 flex-1">
      <Transition name="view" mode="out-in">
        <SettingsView v-if="settings.settingsOpen" key="settings" />
        <Workspace
          v-else-if="connections.active"
          :key="connections.active.connectionId"
          @disconnect="handleDisconnect"
        />
        <ConnectionManager v-else key="manager" />
      </Transition>
    </div>
  </div>
</template>
