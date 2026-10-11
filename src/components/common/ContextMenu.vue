<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from "vue";

import type { MenuItem } from "@/components/common/DropdownMenu.vue";

const props = defineProps<{
  open: boolean;
  /** 视口坐标 */
  x: number;
  y: number;
  items: MenuItem[];
}>();

const emit = defineEmits<{
  select: [key: string];
  close: [];
}>();

/** Files FastContextFlyout.ApplyEstimatedWidth：min 220 */
const MENU_WIDTH = 220;
const MENU_ITEM_HEIGHT = 36;
/** 一级行高：38 按钮 + 上下 Margin 2 = 42，行后分隔线 ~9（MenuFlyoutSeparator） */
const PRIMARY_ROW_HEIGHT = 51;

/** 折叠连续分隔线并去首尾（Files FastContextFlyout.TrimSeparators 同款防御：
 *  primary 项抽进一级行后原分组可能整组消失，留下相邻/悬挂分隔线） */
function trimSeparators(items: MenuItem[]): MenuItem[] {
  const out: MenuItem[] = [];
  for (const item of items) {
    if (item.separator && (out.length === 0 || out[out.length - 1].separator)) continue;
    out.push(item);
  }
  while (out.length && out[out.length - 1].separator) out.pop();
  return out;
}

/** 一级图标命令行与列表项分离渲染（FastContextFlyout.Build：IsPrimary 过滤） */
const primaryItems = computed(() => props.items.filter((i) => i.primary && !i.separator));
const listItems = computed(() => trimSeparators(props.items.filter((i) => !i.primary)));

/** 靠近屏幕右/下边缘时向内收（MenuFlyout 定位策略的简化版）。
 *  向上开（放不下时）一级行沉到菜单底部贴近指针（FastContextFlyout.FinalizePrimaryRowPosition：
 *  openedUp ? 列表后 : 列表前） */
const position = computed(() => {
  const margin = 8;
  const estHeight =
    listItems.value.length * MENU_ITEM_HEIGHT + 16 + (primaryItems.value.length ? PRIMARY_ROW_HEIGHT : 0);
  const top = Math.min(props.y, Math.max(window.innerHeight - estHeight - margin, margin));
  return {
    left: Math.min(props.x, window.innerWidth - MENU_WIDTH - margin),
    top,
    maxHeight: `calc(100vh - 2 * ${margin}px)`,
    opensUp: top < props.y,
  };
});

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") emit("close");
}

onMounted(() => window.addEventListener("keydown", onKeydown));
onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown));
</script>

<template>
  <div v-if="open">
    <!-- 点击外部关闭 -->
    <div class="fixed inset-0 z-40" @click="emit('close')" @contextmenu.prevent="emit('close')" />

    <!-- MenuFlyout：亚克力表面（menu-surface 按窗口材质分级不透明度）+ 8 圆角 + 描边 + 阴影 -->
    <Transition name="popup">
      <div
        role="menu"
        class="menu-surface fixed z-50 overflow-y-auto rounded-lg p-1 shadow-xl"
        :style="{
          left: `${position.left}px`,
          top: `${position.top}px`,
          maxHeight: position.maxHeight,
          minWidth: `${MENU_WIDTH}px`,
          backdropFilter: 'blur(20px) saturate(1.15)',
          WebkitBackdropFilter: 'blur(20px) saturate(1.15)',
          border: '1px solid var(--stroke-flyout)',
        }"
      >
        <!-- 顶部一级图标命令行（向下开时在顶、贴近指针；向上开时沉底）：
             38×38 圆角 4 透明底、hover/按下借菜单项填充、禁用 Opacity 0.4，
             行容器 Margin 4,2、按钮间距 2（App.xaml:37-86 PrimaryCommandButtonStyle +
             PrimaryCommandMenuFlyoutItemTemplate；FastContextFlyout.cs BuildPrimaryCommandRow） -->
        <template v-if="primaryItems.length && !position.opensUp">
          <div class="flex gap-0.5 px-1 py-0.5">
            <button
              v-for="item in primaryItems"
              :key="item.key"
              type="button"
              class="flex h-[38px] w-[38px] items-center justify-center rounded-[4px]"
              :class="item.disabled ? 'cursor-not-allowed opacity-40' : 'hover:bg-fill-subtle active:bg-fill-pressed'"
              :title="item.label"
              :aria-label="item.label"
              :disabled="item.disabled"
              @click="!item.disabled && emit('select', item.key)"
            >
              <component
                :is="item.icon"
                v-if="item.icon"
                :size="16"
                :class="item.danger ? 'text-danger' : 'text-ink'"
              />
            </button>
          </div>
          <div class="mx-2 my-1 h-px" :style="{ background: 'var(--line)' }" />
        </template>

        <template v-for="item in listItems" :key="item.key">
          <div v-if="item.separator" class="mx-2 my-1 h-px" :style="{ background: 'var(--line)' }" />
          <button
            v-else
            type="button"
            role="menuitem"
            class="flex h-8 w-full items-center gap-2.5 rounded-[2px] px-2.5 text-left text-sm transition-colors"
            :class="item.disabled ? 'cursor-not-allowed opacity-40' : 'hover:bg-fill-subtle'"
            :style="{ color: item.danger ? 'var(--danger)' : 'var(--ink)' }"
            :disabled="item.disabled"
            :aria-disabled="item.disabled"
            :title="item.title"
            @click="!item.disabled && emit('select', item.key)"
          >
            <span class="flex w-4 shrink-0 justify-center">
              <component :is="item.icon" v-if="item.icon" :size="16" class="text-dim" />
              <span
                v-else-if="item.checked"
                class="h-[7px] w-[7px] rounded-full"
                :style="{ background: 'var(--accent)' }"
              />
            </span>
            <span class="min-w-0 flex-1 truncate">{{ item.label }}</span>
            <!-- 快捷键提示列：Caption(12px) 右对齐、左 Margin 24、Secondary 前景
                 （MenuFlyoutItemWithImage.xaml:67-79） -->
            <span v-if="item.accelerator" class="ml-6 shrink-0 text-xs text-dim">
              {{ item.accelerator }}
            </span>
          </button>
        </template>

        <!-- 向上开：一级行沉底（贴近指针） -->
        <template v-if="primaryItems.length && position.opensUp">
          <div class="mx-2 my-1 h-px" :style="{ background: 'var(--line)' }" />
          <div class="flex gap-0.5 px-1 py-0.5">
            <button
              v-for="item in primaryItems"
              :key="item.key"
              type="button"
              class="flex h-[38px] w-[38px] items-center justify-center rounded-[4px]"
              :class="item.disabled ? 'cursor-not-allowed opacity-40' : 'hover:bg-fill-subtle active:bg-fill-pressed'"
              :title="item.label"
              :aria-label="item.label"
              :disabled="item.disabled"
              @click="!item.disabled && emit('select', item.key)"
            >
              <component
                :is="item.icon"
                v-if="item.icon"
                :size="16"
                :class="item.danger ? 'text-danger' : 'text-ink'"
              />
            </button>
          </div>
        </template>
      </div>
    </Transition>
  </div>
</template>
