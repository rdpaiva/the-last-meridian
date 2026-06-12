import { defineConfig } from "vitest/config";

/**
 * Vitest setup (docs/MULTIPLAYER.md → Verification: vitest is the runner;
 * `npm test` is part of the green-pipeline definition next to typecheck).
 *
 * Tests run in plain Node — the sim is headless by design (NullEngine), so no
 * DOM emulation is wanted: anything that errors without a browser here is a
 * sim/view layering violation we WANT to hear about.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // The smoke harness plays a whole fleet battle to a carrier kill at a
    // fixed 60Hz dt — give it room. Individual fast tests still fail fast.
    testTimeout: 180_000,
  },
});
