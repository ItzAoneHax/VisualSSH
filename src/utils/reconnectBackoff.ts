/**
 * 自动重连退避（第四阶段块 D）：指数序列 1/2/4/8/16 秒，最多 5 次。
 * 独立纯函数供单测断言序列。
 */

export const MAX_RECONNECT_ATTEMPTS = 5;

/** 第 attempt 次重试前的等待秒数（1 起步指数翻倍，封顶 16） */
export function backoffDelaySec(attempt: number): number {
  const clamped = Math.min(Math.max(attempt, 1), MAX_RECONNECT_ATTEMPTS);
  return 2 ** (clamped - 1);
}

export const BACKOFF_SEQUENCE: number[] = Array.from(
  { length: MAX_RECONNECT_ATTEMPTS },
  (_, i) => backoffDelaySec(i + 1),
);
