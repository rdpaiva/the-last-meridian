/** Check for deployments without interrupting a match, intro, or editor. */
export function watchBuildUpdates(buildId: string, canReload: () => boolean): () => void {
  let checking = false;
  let stopped = false;
  let reloading = false;

  const check = async (): Promise<void> => {
    if (stopped || checking || reloading || document.visibilityState !== "visible") return;
    checking = true;
    try {
      // The query also bypasses older intermediary caches before the new
      // no-store server policy has been installed.
      const response = await fetch(`/version.json?check=${Date.now()}`, {
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return;
      const version: unknown = await response.json();
      if (!version || typeof version !== "object" || !("buildId" in version)) return;
      const next = version.buildId;
      if (typeof next !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(next)) return;
      if (next === buildId || stopped || document.visibilityState !== "visible" || !canReload()) return;

      // A fresh navigation URL bypasses a previously cached index.html.
      // Preserve invite hashes and other parameters. If that URL somehow
      // still serves an old bundle, don't trap the player in a reload loop.
      const url = new URL(window.location.href);
      if (url.searchParams.get("release") === next) return;
      url.searchParams.set("release", next);
      reloading = true;
      window.location.replace(url.href);
    } catch {
      // Offline, a deploy in progress, or an older server without a manifest:
      // keep playing and try again later.
    } finally {
      checking = false;
    }
  };

  const onVisible = (): void => { void check(); };
  const timer = window.setInterval(onVisible, 60_000);
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("pageshow", onVisible);
  void check();
  return () => {
    stopped = true;
    window.clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("pageshow", onVisible);
  };
}
