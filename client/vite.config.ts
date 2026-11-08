import { defineConfig } from "vite";
import { randomUUID } from "node:crypto";

// Served under /play/ (https://the-last-meridian.com/play/). The domain root
// is the franchise homepage, a separate static site; Caddy strips /play
// and serves this bundle from /var/www/meridian-play (docs/DEPLOY.md).
// Every runtime asset URL must go through import.meta.env.BASE_URL.
export default defineConfig(({ command }) => {
  // Unique even when rebuilding the same commit with different environment settings.
  const buildId = command === "build" ? randomUUID() : "dev";
  return {
    base: "/play/",
    define: {
      __BUILD_ID__: JSON.stringify(buildId),
    },
    plugins: [{
      name: "release-version",
      generateBundle() {
        this.emitFile({
          type: "asset",
          fileName: "version.json",
          source: JSON.stringify({ buildId }),
        });
      },
    }],
    server: {
      host: true,
    },
  };
});
