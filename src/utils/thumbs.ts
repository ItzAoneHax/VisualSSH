import { ref } from "vue";

import { readFileBase64 } from "@/api/ssh";
import { base64ToBytes, imageMimeOf, thumbnailCache } from "@/utils/preview";

/**
 * 表格缩略图调度（第五阶段块 B）：视口内行才拉取（IntersectionObserver）、
 * 并发上限 4、requestIdleCallback 空闲调度；视口不稳定（快速滚动）不追发，
 * 稳定 150ms 后才发起请求。失败静默回退普通图标（负面记录不重试，
 * mtime 变化换键自然重试）。缓存 = thumbnailCache（LRU 256 条，URL 随逐出回收）。
 */

/** 缩略图请求描述（FileTable 注册时携带） */
export interface ThumbRequest {
  /** 缓存键 connectionId:path:mtime */
  key: string;
  connectionId: string;
  path: string;
  maxBytes: number;
}

/** 完成版本号：FileTable 渲染取缓存前 void 一把，建立响应式依赖 */
export const thumbVersion = ref(0);

const CONCURRENCY = 4;
/** 视口稳定窗口：IO/滚动停止 150ms 后才发起请求（快速滚动不追发） */
const SETTLE_MS = 150;

let observer: IntersectionObserver | null = null;
/** 注册的元素 → 请求描述（键含 mtime，目录刷新后行重建自动换键） */
const observed = new WeakMap<Element, ThumbRequest>();
/** 视口内待拉取（key → request） */
const visible = new Map<string, ThumbRequest>();
/** 各键当前相交状态（仅在状态翻转时刷新稳定窗口：重挂/重渲染不误判为滚动） */
const intersectState = new Map<string, boolean>();
const inFlight = new Set<string>();
/** 失败负面记录：本会话不再尝试（静默回退图标） */
const failed = new Set<string>();
let lastViewportChange = 0;
let scheduled = false;

function ensureObserver(): IntersectionObserver {
  if (observer) return observer;
  observer = new IntersectionObserver((entries) => {
    let changed = false;
    for (const entry of entries) {
      const req = observed.get(entry.target);
      if (!req) continue;
      const was = intersectState.get(req.key);
      if (was !== entry.isIntersecting) {
        changed = true;
        intersectState.set(req.key, entry.isIntersecting);
      }
      if (entry.isIntersecting) visible.set(req.key, req);
      else visible.delete(req.key);
    }
    if (changed) {
      lastViewportChange = Date.now();
      schedule();
    }
  });
  return observer;
}

/** 行渲染 ref 回调注册（Vue 3.5：返回清理函数在卸载时解除观察） */
export function registerThumb(el: unknown, request: ThumbRequest): (() => void) | undefined {
  if (!(el instanceof Element)) return undefined;
  observed.set(el, request);
  ensureObserver().observe(el);
  return () => {
    observer?.unobserve(el);
    observed.delete(el);
    visible.delete(request.key);
  };
}

function schedule(): void {
  if (scheduled) return;
  scheduled = true;
  const idle = (cb: () => void) =>
    typeof requestIdleCallback === "function"
      ? requestIdleCallback(() => cb())
      : setTimeout(cb, 32);
  idle(() => {
    scheduled = false;
    pump();
  });
}

function pump(): void {
  // 视口未稳定：稍后再试（快速滚动时不追发）
  if (Date.now() - lastViewportChange < SETTLE_MS) {
    setTimeout(schedule, 80);
    return;
  }
  for (const [key, req] of visible) {
    if (inFlight.size >= CONCURRENCY) break;
    if (inFlight.has(key) || failed.has(key) || thumbnailCache.has(key)) {
      visible.delete(key);
      continue;
    }
    inFlight.add(key);
    void load(req).finally(() => {
      inFlight.delete(key);
      thumbVersion.value++;
      // 该行还在视口就继续补位下一张
      schedule();
    });
  }
}

async function load(req: ThumbRequest): Promise<void> {
  try {
    const b64 = await readFileBase64(req.connectionId, req.path, req.maxBytes);
    const bytes = base64ToBytes(b64);
    const url = URL.createObjectURL(
      new Blob([bytes], { type: imageMimeOf(req.path) }),
    );
    thumbnailCache.put(req.key, url, bytes.length, true);
  } catch {
    // 静默失败：负面记录，行回退普通图标
    failed.add(req.key);
  }
}
