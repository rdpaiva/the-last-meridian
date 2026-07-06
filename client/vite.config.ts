import { defineConfig } from "vite";

// Served from the domain root (https://the-last-meridian.com — Caddy
// file_server on the droplet, docs/DEPLOY.md). The old GitHub Pages
// subpath base ("/the-last-meridian/") went with the Pages channel.
export default defineConfig({
  base: "/",
  server: {
    host: true,
  },
});
