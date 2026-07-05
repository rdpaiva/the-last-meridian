/**
 * Unit proof of the netsim DelayQueue (GameConfig.net.sim): items release
 * only after their delay, always in push order — the monotonic clamp is what
 * makes the simulator TCP-faithful (jitter delays messages, never reorders
 * them). Pure time-passing tests; no browser globals involved.
 */
import { describe, it, expect } from "vitest";

import { DelayQueue } from "../../client/src/net/DelayQueue";

describe("DelayQueue", () => {
  it("holds items until their delay elapses, then releases them", () => {
    const q = new DelayQueue<string>();
    q.push("a", 1000, 50);

    const out: string[] = [];
    q.drain(1049, (s) => out.push(s));
    expect(out).toEqual([]);
    expect(q.length).toBe(1);

    q.drain(1050, (s) => out.push(s));
    expect(out).toEqual(["a"]);
    expect(q.length).toBe(0);
  });

  it("releases multiple due items in one drain, in push order", () => {
    const q = new DelayQueue<number>();
    q.push(1, 1000, 10);
    q.push(2, 1010, 10);
    q.push(3, 1020, 500); // not yet due

    const out: number[] = [];
    q.drain(1100, (n) => out.push(n));
    expect(out).toEqual([1, 2]);
    expect(q.length).toBe(1);
  });

  it("never reorders: a small-delay push after a large-delay push waits its turn", () => {
    const q = new DelayQueue<string>();
    q.push("slow", 1000, 100); // due at 1100
    q.push("fast", 1010, 5); //   would be due at 1015 — clamped to 1100

    const out: string[] = [];
    q.drain(1050, (s) => out.push(s));
    expect(out).toEqual([]); // "fast" may not overtake "slow"

    q.drain(1100, (s) => out.push(s));
    expect(out).toEqual(["slow", "fast"]);
  });
});
