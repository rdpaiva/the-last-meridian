/**
 * Phase 0 headless smoke test (docs/MULTIPLAYER.md → Verification — the
 * backbone of the sim/view split).
 *
 * Plays a full two-AI-fleet battle headless at a fixed 60Hz dt with the sim
 * RNG seeded, and asserts the battle actually plays out: ships launch and
 * move, fire lasers and missiles, take damage, die, respawn — and a carrier
 * eventually falls, ending the match.
 *
 * It then diffs sampled positions/HP against the committed BASELINE TRACE
 * (tests/sim/baseline.json). Because the sim is deterministic under fixed
 * dt + seed, every Phase 0 split task must leave this diff EMPTY — "the
 * refactor changed nothing" is a mechanical check, not a visual one.
 *
 * If a change is SUPPOSED to alter gameplay (a balance tweak, an AI fix),
 * recapture the baseline and commit it with the change, explaining why:
 *
 *     npm run baseline
 *
 * Notes for future sessions:
 * - The trace rounds to 3 decimals. That is NOT slack for "small" behavior
 *   changes: the battle is chaotic, so any real divergence explodes past
 *   1e-3 within a tick or two. It only keeps the JSON compact.
 * - The determinism test re-runs a short battle twice in-process. If it
 *   fails, some sim code path still draws from Math.random() (or wall
 *   clock) — find it and route it through src/game/sim/SimRng.ts.
 */

import { describe, it, expect, afterEach } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  HeadlessBattle,
  type BattleStats,
  type TraceSample,
} from "./HeadlessBattle";

const BASELINE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "baseline.json",
);

/** Everything pinned: same seed + dt + sampling = same battle, forever. */
const SEED = 0xc0ffee;
const DT = 1 / 60;
const SAMPLE_EVERY = 30; // every half second of sim time
const MAX_TICKS = 60 * 60 * 12; // 12 sim-minutes — far beyond a normal match

interface Baseline {
  meta: {
    seed: number;
    dt: number;
    sampleEvery: number;
    description: string;
  };
  summary: {
    ticksToEnd: number;
    outcome: "victory" | "defeat";
    deaths: number;
    respawns: number;
  };
  samples: TraceSample[];
}

/** Play the pinned battle to its end, sampling the trace as it goes. */
function runPinnedBattle(): { stats: BattleStats; samples: TraceSample[] } {
  const battle = new HeadlessBattle({ seed: SEED });
  try {
    const samples: TraceSample[] = [];
    for (let t = 0; t < MAX_TICKS && !battle.ended; t++) {
      battle.tick(DT);
      if (battle.stats.ticks % SAMPLE_EVERY === 0) {
        samples.push(battle.sample());
      }
    }
    // Always include the final state so the kill itself is in the trace.
    samples.push(battle.sample());
    return { stats: { ...battle.stats }, samples };
  } finally {
    battle.dispose();
  }
}

/**
 * First divergence between two traces as a readable message, or null when
 * identical. (A raw deep-equal diff on thousands of samples is unreadable —
 * report exactly where the battle forked instead.)
 */
function diffTraces(
  actual: TraceSample[],
  expected: TraceSample[],
): string | null {
  const n = Math.min(actual.length, expected.length);
  for (let i = 0; i < n; i++) {
    const a = actual[i];
    const e = expected[i];
    if (a.tick !== e.tick) {
      return `sample ${i}: tick ${a.tick} ≠ baseline tick ${e.tick}`;
    }
    if (
      a.mothershipHp.humans !== e.mothershipHp.humans ||
      a.mothershipHp.machines !== e.mothershipHp.machines
    ) {
      return (
        `tick ${a.tick}: mothership HP diverged — ` +
        `humans ${a.mothershipHp.humans} vs ${e.mothershipHp.humans}, ` +
        `machines ${a.mothershipHp.machines} vs ${e.mothershipHp.machines}`
      );
    }
    if (a.ships.length !== e.ships.length) {
      return `tick ${a.tick}: combatant count ${a.ships.length} ≠ ${e.ships.length}`;
    }
    for (let s = 0; s < a.ships.length; s++) {
      const as = a.ships[s];
      const es = e.ships[s];
      if (as.x !== es.x || as.z !== es.z || as.hp !== es.hp) {
        return (
          `tick ${a.tick}, ship ${s}: ` +
          `(${as.x}, ${as.z}, hp ${as.hp}) ≠ baseline ` +
          `(${es.x}, ${es.z}, hp ${es.hp})`
        );
      }
    }
  }
  if (actual.length !== expected.length) {
    return (
      `trace length ${actual.length} ≠ baseline ${expected.length} ` +
      `(battle ended at a different tick)`
    );
  }
  return null;
}

describe("headless sim smoke battle", () => {
  // Each HeadlessBattle redirects performance.now to its sim clock and
  // restores it on dispose; the try/finally in runPinnedBattle covers the
  // happy path, this covers a test aborting mid-construction.
  afterEach(() => {
    // dispose() in runPinnedBattle restores; nothing to do here — kept as a
    // documented seam in case future tests construct battles directly.
  });

  it("plays a full battle: move, fire, damage, die, respawn, carrier kill", () => {
    const { stats, samples } = runPinnedBattle();

    // Lifecycle assertions — the doc's checklist, verbatim.
    expect(stats.anyShipMoved, "no ship ever moved").toBe(true);
    expect(stats.anyLaserFired, "no laser was ever fired").toBe(true);
    expect(stats.anyMissileFired, "no missile was ever fired").toBe(true);
    expect(stats.anyShipDamaged, "no ship ever took damage").toBe(true);
    expect(stats.deaths, "no ship ever died").toBeGreaterThan(0);
    expect(stats.respawns, "no ship ever respawned").toBeGreaterThan(0);
    expect(stats.anyMothershipDamaged, "no carrier ever took damage").toBe(true);
    expect(
      stats.outcome,
      `no carrier fell within ${MAX_TICKS} ticks — battle stalled`,
    ).not.toBeNull();

    if (process.env.CAPTURE_BASELINE) {
      const baseline: Baseline = {
        meta: {
          seed: SEED,
          dt: DT,
          sampleEvery: SAMPLE_EVERY,
          description:
            "Headless two-AI-fleet battle trace. Regenerate ONLY for an " +
            "intended gameplay change (npm run baseline) and explain the " +
            "change in the commit. Refactors must leave it untouched.",
        },
        summary: {
          ticksToEnd: stats.ticks,
          outcome: stats.outcome!,
          deaths: stats.deaths,
          respawns: stats.respawns,
        },
        samples,
      };
      writeFileSync(BASELINE_PATH, JSON.stringify(baseline) + "\n");
      console.log(
        `[baseline] captured ${samples.length} samples over ` +
          `${stats.ticks} ticks → ${BASELINE_PATH}`,
      );
      return;
    }

    expect(
      existsSync(BASELINE_PATH),
      "tests/sim/baseline.json is missing — run `npm run baseline` on a " +
        "known-good tree and commit it",
    ).toBe(true);
    const baseline: Baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));

    // Same pinned run config, or the comparison is meaningless.
    expect(baseline.meta.seed).toBe(SEED);
    expect(baseline.meta.dt).toBe(DT);
    expect(baseline.meta.sampleEvery).toBe(SAMPLE_EVERY);

    const divergence = diffTraces(samples, baseline.samples);
    expect(
      divergence,
      `sim diverged from the committed baseline — if this change is a ` +
        `refactor, it altered behavior; if the change is INTENDED to alter ` +
        `gameplay, recapture with \`npm run baseline\` and say why in the ` +
        `commit.\nFirst divergence: ${divergence}`,
    ).toBeNull();
    expect(stats.outcome).toBe(baseline.summary.outcome);
    expect(stats.ticks).toBe(baseline.summary.ticksToEnd);
  });

  it("is deterministic: same seed twice → identical short trace", () => {
    const SHORT = 3000; // 50 sim-seconds — through launch + first engagements
    const run = () => {
      const battle = new HeadlessBattle({ seed: 42 });
      try {
        const samples: TraceSample[] = [];
        for (let t = 0; t < SHORT; t++) {
          battle.tick(DT);
          if (battle.stats.ticks % SAMPLE_EVERY === 0) {
            samples.push(battle.sample());
          }
        }
        return samples;
      } finally {
        battle.dispose();
      }
    };
    const first = run();
    const second = run();
    const divergence = diffTraces(second, first);
    expect(
      divergence,
      `same-seed runs diverged — some sim path still draws Math.random()/` +
        `wall clock instead of SimRng.\nFirst divergence: ${divergence}`,
    ).toBeNull();
  });

  it("seed actually matters: different seeds → different battles", () => {
    const SHORT = 1200; // past the launch holds, into AI flying
    const run = (seed: number) => {
      const battle = new HeadlessBattle({ seed });
      try {
        for (let t = 0; t < SHORT; t++) battle.tick(DT);
        return battle.sample();
      } finally {
        battle.dispose();
      }
    };
    const a = run(1);
    const b = run(2);
    expect(
      JSON.stringify(a.ships),
      "two different seeds produced an identical battle state — the sim " +
        "RNG is not being consulted",
    ).not.toBe(JSON.stringify(b.ships));
  });
});
