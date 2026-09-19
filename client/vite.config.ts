import { defineConfig } from "vite";
import { randomUUID } from "node:crypto";

// Served from the domain root (https://the-last-meridian.com — Caddy
// file_server on the droplet, docs/DEPLOY.md). The old GitHub Pages
// subpath base ("/the-last-meridian/") went with the Pages channel.
export default defineConfig(({ command }) => {
  // Unique even when rebuilding the same commit with different environment settings.
  const buildId = command === "build" ? randomUUID() : "dev";
  return {
    base: "/",
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
