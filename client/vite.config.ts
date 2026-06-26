import { defineConfig } from "vite";

export default defineConfig(({ command }) => ({
  base: command === "build" ? "/the-last-meridian/" : "/",
  server: {
    host: true,
  },
}));
