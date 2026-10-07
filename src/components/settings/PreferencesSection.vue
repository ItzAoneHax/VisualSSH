<script setup lang="ts">
import {
  ArrowDownUp,
  ArrowUpFromLine,
  Binary,
  Eye,
  FileText,
  MousePointerClick,
  TriangleAlert,
} from "@lucide/vue";

import { storeToRefs } from "pinia";

import SettingsExpander from "@/components/settings/SettingsExpander.vue";
import SettingsSelect from "@/components/settings/SettingsSelect.vue";
import { useExplorerStore, SORT_KEYS, type SortKey } from "@/stores/explorer";
import { useSettingsStore } from "@/stores/settings";

/**
 * 首选项分区（仿 Files FoldersPage/LayoutPage 的「显示 / 行为」两节）：
 * 显示 = 隐藏项目、默认排序（列/方向/优先级）、大小格式；
 * 行为 = 删除确认、单击打开、双击空白处上一级。
 */
const settings = useSettingsStore();
const explorer = useExplorerStore();
// storeToRefs：update() 整体替换 settings.value，直接取 settings.settings 会拿到冻结快照
const { settings: s } = storeToRefs(settings);

const SORT_LABELS: Record<SortKey, string> = {
  name: "名称",
  mtime: "修改时间",
  kind: "类型",
  size: "大小",
  permissions: "权限",
  owner: "所有者",
  group: "组",
  path: "位置",
};

/** 默认排序列下拉（path 排序键专用于搜索结果页，不入全局默认与目录记忆） */
const SORT_OPTIONS: { key: SortKey; label: string }[] = SORT_KEYS.map((key) => ({
  key,
  label: SORT_LABELS[key],
}));

const PRIORITY_OPTIONS = [
  { key: "folders", label: "先排序文件夹" },
  { key: "files", label: "先排序文件" },
  { key: "mixed", label: "将文件和文件夹一同排序" },
];

const SIZE_UNIT_OPTIONS = [
  { key: "binary", label: "二进制" },
  { key: "decimal", label: "十进制" },
];

/** 删除确认三档（Files DeleteConfirmationPolicies；远端删除皆为永久删除，仅永久删除档行为同「总是」） */
const DELETE_CONFIRM_OPTIONS = [
  { key: "always", label: "始终显示确认对话框" },
  { key: "permanentOnly", label: "仅永久删除时确认" },
  { key: "never", label: "不显示确认对话框" },
];

/** 显示隐藏项：立即作用于当前浏览 */
function setShowHidden(value: boolean) {
  settings.update({ showHidden: value });
  explorer.showHidden = value;
}
</script>

<template>
  <h2 class="text-xl font-semibold">首选项</h2>
  <p class="mt-1 mb-4 text-xs text-dim">配置文件浏览的行为。</p>

  <!-- 显示 -->
  <p class="settings-group-title">显示</p>
  <div class="flex flex-col gap-1">
    <div class="settings-card">
      <Eye :size="20" class="shrink-0 text-dim" />
      <div class="min-w-0 flex-1">
        <p class="text-sm font-medium">显示隐藏项目</p>
        <p class="mt-0.5 text-xs text-dim">显示以点（.）开头的文件与文件夹。</p>
      </div>
      <button
        type="button"
        role="switch"
        :aria-checked="s.showHidden"
        class="toggle-switch"
        :class="s.showHidden && 'on'"
        @click="setShowHidden(!s.showHidden)"
      >
        <span class="toggle-knob" />
      </button>
    </div>

    <!-- 显示扩展名（Files HideFileExtension 反相；仅影响展示层，重命名仍操作完整文件名） -->
    <div class="settings-card">
      <FileText :size="20" class="shrink-0 text-dim" />
      <div class="min-w-0 flex-1">
        <p class="text-sm font-medium">显示文件扩展名</p>
        <p class="mt-0.5 text-xs text-dim">关闭后文件名隐藏扩展名显示，重命名仍包含完整名称。</p>
      </div>
      <button
        type="button"
        role="switch"
        :aria-checked="s.showFileExtensions"
        class="toggle-switch"
        :class="s.showFileExtensions && 'on'"
        @click="settings.update({ showFileExtensions: !s.showFileExtensions })"
      >
        <span class="toggle-knob" />
      </button>
    </div>

    <!-- 默认排序：列 + 方向 + 优先级（Files LayoutPage 排序折叠组结构） -->
    <SettingsExpander :icon="ArrowDownUp" title="默认排序" description="连接服务器时文件列表的初始排序。">
      <template #control>
        <SettingsSelect
          :model-value="s.defaultSortKey"
          :options="SORT_OPTIONS"
          label="默认排序列"
          @update:model-value="(key) => settings.update({ defaultSortKey: key as SortKey })"
        />
      </template>
      <template #items>
        <div class="settings-expander-item">
          <div class="min-w-0 flex-1">
            <p class="text-sm font-medium">降序排序</p>
          </div>
          <button
            type="button"
            role="switch"
            :aria-checked="s.defaultSortDesc"
            class="toggle-switch"
            :class="s.defaultSortDesc && 'on'"
            @click="settings.update({ defaultSortDesc: !s.defaultSortDesc })"
          >
            <span class="toggle-knob" />
          </button>
        </div>
        <div class="settings-expander-item">
          <div class="min-w-0 flex-1">
            <p class="text-sm font-medium">排序优先级</p>
          </div>
          <SettingsSelect
            :model-value="s.sortPriority"
            :options="PRIORITY_OPTIONS"
            label="排序优先级"
            @update:model-value="(key) => settings.update({ sortPriority: key as typeof s.sortPriority })"
          />
        </div>
      </template>
    </SettingsExpander>

    <!-- 大小格式 -->
    <div class="settings-card">
      <Binary :size="20" class="shrink-0 text-dim" />
      <div class="min-w-0 flex-1">
        <p class="text-sm font-medium">大小格式</p>
        <p class="mt-0.5 text-xs text-dim">二进制 KB = 1024 B；十进制 KB = 1000 B。</p>
      </div>
      <SettingsSelect
        :model-value="s.sizeUnit"
        :options="SIZE_UNIT_OPTIONS"
        label="大小格式"
        @update:model-value="(key) => settings.update({ sizeUnit: key as typeof s.sizeUnit })"
      />
    </div>
  </div>

  <!-- 行为 -->
  <p class="settings-group-title">行为</p>
  <div class="flex flex-col gap-1">
    <!-- 删除确认三档（Files FoldersSettingsService.DeleteConfirmationPolicy 下拉） -->
    <div class="settings-card">
      <TriangleAlert :size="20" class="shrink-0 text-dim" />
      <div class="min-w-0 flex-1">
        <p class="text-sm font-medium">删除项目时显示确认对话框</p>
        <p class="mt-0.5 text-xs text-dim">远端删除无法撤销，关闭确认后删除立即执行。</p>
      </div>
      <SettingsSelect
        :model-value="s.deleteConfirmation"
        :options="DELETE_CONFIRM_OPTIONS"
        label="删除确认策略"
        @update:model-value="(key) => settings.update({ deleteConfirmation: key as typeof s.deleteConfirmation })"
      />
    </div>

    <div class="settings-card">
      <MousePointerClick :size="20" class="shrink-0 text-dim" />
      <div class="min-w-0 flex-1">
        <p class="text-sm font-medium">单击打开项目</p>
        <p class="mt-0.5 text-xs text-dim">单击即进入文件夹或打开文件（Ctrl/Shift 单击仍为多选）。</p>
      </div>
      <button
        type="button"
        role="switch"
        :aria-checked="s.singleClickOpen"
        class="toggle-switch"
        :class="s.singleClickOpen && 'on'"
        @click="settings.update({ singleClickOpen: !s.singleClickOpen })"
      >
        <span class="toggle-knob" />
      </button>
    </div>

    <div class="settings-card">
      <ArrowUpFromLine :size="20" class="shrink-0 text-dim" />
      <div class="min-w-0 flex-1">
        <p class="text-sm font-medium">双击空白处转到上一级</p>
        <p class="mt-0.5 text-xs text-dim">在文件列表空白区域双击即可返回上级目录。</p>
      </div>
      <button
        type="button"
        role="switch"
        :aria-checked="s.dblClickBlankGoUp"
        class="toggle-switch"
        :class="s.dblClickBlankGoUp && 'on'"
        @click="settings.update({ dblClickBlankGoUp: !s.dblClickBlankGoUp })"
      >
        <span class="toggle-knob" />
      </button>
    </div>
  </div>
</template>
