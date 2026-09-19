import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { watchBuildUpdates } from "../../client/src/BuildUpdates";

describe("deployment refresh", () => {
  let page: EventTarget & { visibilityState: string };
  let browser: EventTarget & { location: { href: string; replace: ReturnType<typeof vi.fn> } };
  let fetchVersion: ReturnType<typeof vi.fn>;
  let stop: (() => void) | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    page = Object.assign(new EventTarget(), { visibilityState: "visible" });
    browser = Object.assign(new EventTarget(), {
      location: { href: "https://example.com/?mode=solo#join=room", replace: vi.fn() },
      setInterval, clearInterval,
    });
    fetchVersion = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ buildId: "new-build" }) });
    vi.stubGlobal("document", page);
    vi.stubGlobal("window", browser);
    vi.stubGlobal("fetch", fetchVersion);
  });

  afterEach(() => {
    stop?.();
    stop = undefined;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("refreshes an idle outdated tab with a fresh URL, preserving invite and parameters", async () => {
    stop = watchBuildUpdates("old-build", () => true);
    await vi.advanceTimersByTimeAsync(0);
    expect(browser.location.replace).toHaveBeenCalledWith("https://example.com/?mode=solo&release=new-build#join=room");
    expect(fetchVersion).toHaveBeenCalledWith(expect.stringContaining("/version.json?check="),
      expect.objectContaining({ cache: "no-store" }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(browser.location.replace).toHaveBeenCalledTimes(1);
  });

  it("waits while gameplay is active and refreshes when safe", async () => {
    let safe = false;
    stop = watchBuildUpdates("old-build", () => safe);
    await vi.advanceTimersByTimeAsync(0);
    expect(browser.location.replace).not.toHaveBeenCalled();
    safe = true;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(browser.location.replace).toHaveBeenCalledTimes(1);
  });

  it("does not refresh the current build or loop on a stale response after navigation", async () => {
    stop = watchBuildUpdates("new-build", () => true);
    await vi.advanceTimersByTimeAsync(0);
    expect(browser.location.replace).not.toHaveBeenCalled();
    stop();
    browser.location.href = "https://example.com/?release=new-build";
    stop = watchBuildUpdates("old-build", () => true);
    await vi.advanceTimersByTimeAsync(0);
    expect(browser.location.replace).not.toHaveBeenCalled();
  });

  it("ignores network failures, missing manifests, and malformed versions", async () => {
    fetchVersion.mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ buildId: "" }) });
    stop = watchBuildUpdates("old-build", () => true);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(browser.location.replace).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(browser.location.replace).toHaveBeenCalledTimes(1);
  });

  it("checks again on return to a visible tab and stops on disposal", async () => {
    page.visibilityState = "hidden";
    stop = watchBuildUpdates("new-build", () => true);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchVersion).not.toHaveBeenCalled();
    page.visibilityState = "visible";
    page.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchVersion).toHaveBeenCalledTimes(1);
    stop();
    page.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchVersion).toHaveBeenCalledTimes(1);
  });

  it("rechecks safety after a request resolves", async () => {
    let resolve!: (value: unknown) => void;
    let safe = true;
    fetchVersion.mockReturnValue(new Promise((done) => { resolve = done; }));
    stop = watchBuildUpdates("old-build", () => safe);
    safe = false;
    resolve({ ok: true, json: async () => ({ buildId: "new-build" }) });
    await vi.advanceTimersByTimeAsync(0);
    expect(browser.location.replace).not.toHaveBeenCalled();
  });
});
