/**
 * Host-half tests: the engine as Node actually runs it, over real timers and a real
 * disk document.
 *
 * This is where the durability claim is checked — a timer that keeps counting with no
 * browser attached — as opposed to `tools/engine.test.cjs`, which drives the same state
 * machine over a fake clock lifted from the generated browser bundle.
 *
 * Usage: node tools/host.test.mjs
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createEngine, durationForPhase, normalizeSettings } from "../src/engine.js";

const failures = [];

/**
 * Register and immediately run one case.
 * @param name - case name.
 * @param fn - async body.
 */
async function check(name, fn) {
  try {
    await fn();
    console.log(`PASS  host :: ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`FAIL  host :: ${name}`);
    console.log(`      ${(error && error.message ? error.message : String(error)).split("\n").join("\n      ")}`);
  }
}

/** Wait for real time to pass. */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Build an engine over a temporary directory, the way the Host half does.
 * @param options.settings - settings document to seed.
 * @param options.state - timer-state document to seed.
 */
function makeHostEngine(options = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "pomodoro-test-"));
  const settingsFile = path.join(directory, "settings.json");
  const stateFile = path.join(directory, "state.json");
  if (options.settings !== undefined) writeFileSync(settingsFile, JSON.stringify(options.settings), "utf8");
  if (options.state !== undefined) writeFileSync(stateFile, JSON.stringify(options.state), "utf8");

  const completions = [];
  const read = (file) => {
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return undefined;
    }
  };

  const engine = createEngine(
    {
      now: () => Date.now(),
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (handle) => clearInterval(handle),
      persistSettings: (settings) => writeFileSync(settingsFile, JSON.stringify(settings), "utf8"),
      persistState: (state) => writeFileSync(stateFile, JSON.stringify(state), "utf8"),
      onComplete: (phase, finished) => completions.push({ phase, finished }),
    },
    { settings: read(settingsFile), state: read(stateFile) }
  );

  return {
    engine,
    completions,
    state: () => read(stateFile),
    settings: () => read(settingsFile),
    cleanup() {
      engine.dispose();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

/* --------------------------------------------------------------------- cases */

await check("a running phase advances on its own, with nobody reading it", async () => {
  // The state is restored with a deadline 300 ms out, so the phase rolls over inside the
  // test's lifetime. Nothing reads the engine during the wait: no poll, no refresh, no
  // subscriber. If it advances anyway, the Host's own interval did it — which is the
  // whole point of moving the timer here.
  const host = makeHostEngine({
    settings: { focusMinutes: 25, shortMinutes: 5, longMinutes: 15, rounds: 4 },
    state: { phase: "focus", running: true, deadline: Date.now() + 300, completedFocus: 0, focusSinceLong: 0 },
  });
  try {
    assert.equal(host.engine.getSnapshot().running, true);
    await sleep(900);

    const after = host.engine.getSnapshot();
    assert.equal(after.phase, "short", "the Host must roll the phase over without a browser asking");
    assert.equal(after.completedFocus, 1, "the finished focus phase must be credited");
    assert.deepEqual(host.completions, [{ phase: "short", finished: "focus" }]);
  } finally {
    host.cleanup();
  }
});

await check("the remaining time is derived from the wall clock, not from callbacks", async () => {
  const host = makeHostEngine({ settings: { focusMinutes: 1, shortMinutes: 1, longMinutes: 1, rounds: 4 } });
  try {
    host.engine.start();
    const before = host.engine.getSnapshot().remainingMs;
    await sleep(1200);
    const after = host.engine.getSnapshot().remainingMs;
    assert.ok(after < before, `a minute-long phase must visibly run down, got ${before} -> ${after}`);
    assert.ok(before - after >= 1000, `expected about a second to elapse, got ${before - after}ms`);
  } finally {
    host.cleanup();
  }
});

await check("a deadline that passed while Node was suspended settles on the next read", async () => {
  const host = makeHostEngine({ settings: { focusMinutes: 25, shortMinutes: 5, longMinutes: 15, rounds: 4 } });
  try {
    // A deadline already in the past models a process that was asleep, throttled or
    // restarted: the phase must roll over rather than sit at zero.
    host.engine.start();
    const duration = host.engine.getSnapshot().durationMs;
    host.engine.dispose();
    const revived = makeHostEngine({
      settings: { focusMinutes: 25, shortMinutes: 5, longMinutes: 15, rounds: 4 },
      state: { phase: "focus", running: true, deadline: Date.now() - 1000, completedFocus: 0, focusSinceLong: 0 },
    });
    try {
      const view = revived.engine.getSnapshot();
      assert.equal(view.phase, "short");
      assert.equal(view.completedFocus, 1);
      assert.ok(duration > 0);
    } finally {
      revived.cleanup();
    }
  } finally {
    host.cleanup();
  }
});

await check("the state document is written and readable back", async () => {
  const host = makeHostEngine();
  try {
    host.engine.start();
    await sleep(1100); // the Host half throttles disk writes to one per second
    const persisted = host.state();
    assert.equal(persisted.running, true);
    assert.equal(typeof persisted.deadline, "number");
    assert.equal(persisted.phase, "focus");
  } finally {
    host.cleanup();
  }
});

await check("settings are written as their own document", () => {
  const host = makeHostEngine();
  try {
    host.engine.updateSettings({ focusMinutes: 30, notify: true });
    assert.deepEqual(host.settings().focusMinutes, 30);
    assert.equal(host.settings().notify, true);
    assert.equal(host.settings().shortMinutes, 5, "untouched keys keep their defaults");
  } finally {
    host.cleanup();
  }
});

await check("phase lengths follow the settings document", () => {
  const settings = normalizeSettings({ focusMinutes: 30, shortMinutes: 7, longMinutes: 20 });
  assert.equal(durationForPhase("focus", settings), 30 * 60000);
  assert.equal(durationForPhase("short", settings), 7 * 60000);
  assert.equal(durationForPhase("long", settings), 20 * 60000);
});

await check("onComplete fires for a phase the interval rolls over", async () => {
  const host = makeHostEngine({
    settings: { focusMinutes: 1, shortMinutes: 1, longMinutes: 1, rounds: 4 },
    // One millisecond left of the focus phase.
    state: { phase: "focus", running: true, deadline: Date.now() + 60, completedFocus: 0, focusSinceLong: 0 },
  });
  try {
    await sleep(400);
    assert.deepEqual(host.completions, [{ phase: "short", finished: "focus" }]);
  } finally {
    host.cleanup();
  }
});

console.log(failures.length === 0 ? "\nall host tests passed" : `\n${failures.length} host test(s) failed`);
process.exitCode = failures.length === 0 ? 0 : 1;
