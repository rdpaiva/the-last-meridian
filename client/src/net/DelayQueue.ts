/**
 * Ordered release queue for the dev network-condition simulator
 * (GameConfig.net.sim): items go in with a per-item delay and come out, in
 * push order, once their release time passes. The release clock is MONOTONIC
 * — an item's release time is clamped to never precede the previous item's —
 * because the transport being simulated is a WebSocket (TCP): jitter delays
 * messages, it never reorders them. Pure (callers pass `nowMs`), so it tests
 * deterministically and stays free of browser globals.
 */
export class DelayQueue<T> {
  /** Pending items; `at` is non-decreasing by construction, so it's sorted. */
  private readonly items: Array<{ at: number; item: T }> = [];
  private lastAt = 0;

  get length(): number {
    return this.items.length;
  }

  push(item: T, nowMs: number, delayMs: number): void {
    const at = Math.max(nowMs + delayMs, this.lastAt);
    this.lastAt = at;
    this.items.push({ at, item });
  }

  /** Hand every item whose release time has passed to `consume`, in order. */
  drain(nowMs: number, consume: (item: T) => void): void {
    while (this.items.length > 0 && this.items[0].at <= nowMs) {
      consume(this.items.shift()!.item);
    }
  }
}
