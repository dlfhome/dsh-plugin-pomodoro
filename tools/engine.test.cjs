/**
 * State-machine tests.
 *
 * The engine is extracted from the GENERATED bundle (`lib/client.js`) rather than
 * imported from `src/engine.js`, so these tests exercise the exact text the browser
 * runs. `tools/check-build.cjs` separately proves that bundle is current with its
 * sources, which together close the loop: the tested code is the shipped code.
 *
 * Usage: node tools/test-runner.cjs
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createSuite } = require("./test-runner.cjs");

const ROOT = path.resolve(__dirname, "..");
const BUNDLE = path.join(ROOT, "lib", "client.js");

/* ------------------------------------------------------------- engine lift -- */

/**
 * Slice the inlined engine out of the generated bundle: everything from the phase
 * table through the end of `createEngine`, which is exactly what the bundler pasted.
 * Evaluating that slice runs the shipped state machine with no module wrapper.
 * @returns the engine API.
 */
function loadEngine() {
  const text = fs.readFileSync(BUNDLE, "utf8");
  // The bundler strips the engine's `export` keywords, so the declarations read
  // `const PHASES` / `const STORAGE_SETTINGS` in the artifact.
  const start = text.indexOf("const PHASES = [");
  const end = text.indexOf("var TAG_ID = ");
  assert.ok(start >= 0, "the bundle must inline the engine (no PHASES table found)");
  assert.ok(end > start, "the bundle must inline the engine before the stylesheet");
  const slice = text.slice(start, end);
  return new Function(`${slice}\nreturn { createEngine: createEngine, normalizeSettings: normalizeSettings, clampNumber: clampNumber, DEFAULT_SETTINGS: DEFAULT_SETTINGS, LIMITS: LIMITS, PHASES: PHASES };`)();
}

const engineApi = loadEngine();

/* ---------------------------------------------------------------- fixtures -- */

const SETTINGS_KEY = "dsh.pomodoro.settings.v1";
const STATE_KEY = "dsh.pomodoro.state.v1";

/**
 * Run a real engine over a controllable clock and in-memory documents.
 * @param options.settings - settings document to seed.
 * @param options.state - timer-state document to seed.
 * @param options.now - fake-clock seed, so a "restart" can continue the same timeline.
 */
function makeEngine(options = {}) {
  const documents = new Map();
  if (options.settings !== undefined) documents.set(SETTINGS_KEY, JSON.stringify(options.settings));
  if (options.state !== undefined) documents.set(STATE_KEY, JSON.stringify(options.state));

  const clock = { value: options.now ?? 1_700_000_000_000 };
  const intervals = new Set();
  const completions = [];

  const engine = engineApi.createEngine(
    {
      now: () => clock.value,
      setInterval: (fn, ms) => {
        const handle = setInterval(fn, ms);
        intervals.add(handle);
        return handle;
      },
      clearInterval: (handle) => {
        intervals.delete(handle);
        clearInterval(handle);
      },
      persistSettings: (settings) => documents.set(SETTINGS_KEY, JSON.stringify(settings)),
      persistState: (state) => documents.set(STATE_KEY, JSON.stringify(state)),
      onComplete: (phase, finished) => completions.push({ phase, finished }),
    },
    {
      settings: documents.has(SETTINGS_KEY) ? JSON.parse(documents.get(SETTINGS_KEY)) : undefined,
      state: documents.has(STATE_KEY) ? JSON.parse(documents.get(STATE_KEY)) : undefined,
    }
  );

  const fixture = {
    engine,
    clock,
    documents,
    completions,
    advance: (ms) => void (clock.value += ms),
    /** Run the active phase out and let the engine settle it. */
    elapsePhase() {
      clock.value += engine.getSnapshot().durationMs + 1;
      engine.refresh();
    },
    /** Start the active phase and run it out; returns the phase now active. */
    step() {
      engine.start();
      fixture.elapsePhase();
      return engine.getSnapshot().phase;
    },
    state: () => JSON.parse(documents.get(STATE_KEY)),
    settings: () => JSON.parse(documents.get(SETTINGS_KEY)),
    dispose: () => {
      engine.dispose();
      for (const handle of intervals) clearInterval(handle);
    },
  };
  return fixture;
}

/** Always tear an engine down, including when an assertion throws. */
function withEngine(options, body) {
  const fixture = makeEngine(options);
  try {
    body(fixture);
  } finally {
    fixture.dispose();
  }
}

/* ------------------------------------------------------------------- cases -- */

const suite = createSuite();
const test = suite.test;

test("settings clamp into range and unknown documents fall back to defaults", () => {
  const settings = engineApi.normalizeSettings({ focusMinutes: 999, shortMinutes: 0, rounds: -3, autoAdvance: "yes" });
  assert.equal(settings.focusMinutes, 180);
  assert.equal(settings.shortMinutes, 1);
  assert.equal(settings.rounds, 1);
  assert.equal(settings.autoAdvance, engineApi.DEFAULT_SETTINGS.autoAdvance, "a non-boolean falls back");
  assert.equal(settings.notify, false, "notifications start off");
  assert.deepEqual(engineApi.normalizeSettings(undefined), engineApi.DEFAULT_SETTINGS);
});

test("a long break lands after `rounds` completed focus phases", () => {
  withEngine({}, (fixture) => {
    const phases = [];
    for (let index = 0; index < 8; index += 1) phases.push(fixture.step());
    assert.deepEqual(phases, ["short", "focus", "short", "focus", "short", "focus", "long", "focus"]);
    assert.equal(fixture.engine.getSnapshot().completedFocus, 4);
  });
});

test("editing `rounds` mid-cycle does not skip an earned long break", () => {
  withEngine({}, (fixture) => {
    for (let index = 0; index < 6; index += 1) fixture.step();
    assert.equal(fixture.engine.getSnapshot().focusSinceLong, 3);
    fixture.engine.updateSettings({ rounds: 3 });
    assert.equal(fixture.step(), "long");
  });
});

test("skip() moves on without crediting a pomodoro", () => {
  withEngine({}, ({ engine }) => {
    engine.start();
    engine.skip();
    assert.equal(engine.getSnapshot().completedFocus, 0);
    assert.equal(engine.getSnapshot().focusSinceLong, 0);
    assert.equal(engine.getSnapshot().phase, "short");
    assert.equal(engine.getSnapshot().running, true, "skipping keeps the clock running");
  });
});

test("pause holds elapsed time and resume continues from it", () => {
  withEngine({}, (fixture) => {
    const { engine } = fixture;
    engine.start();
    fixture.advance(10 * 60000);
    engine.pause();
    const paused = engine.getSnapshot().remainingMs;
    assert.ok(Math.abs(paused - 15 * 60000) < 1500, `expected ~15 min left, got ${paused}`);
    fixture.advance(5 * 60000);
    assert.equal(engine.getSnapshot().remainingMs, paused, "a paused clock must not advance");
    engine.start();
    assert.ok(engine.getSnapshot().running);
    assert.ok(engine.getSnapshot().remainingMs <= paused);
  });
});

test("changing another phase's length does not reset a running phase", () => {
  withEngine({}, (fixture) => {
    fixture.engine.start();
    fixture.advance(10 * 60000);
    fixture.engine.updateSettings({ longMinutes: 30 });
    assert.ok(Math.abs(fixture.engine.getSnapshot().remainingMs - 15 * 60000) < 1500);
  });
});

test("settings persist and are readable back", () => {
  withEngine({}, (fixture) => {
    fixture.engine.updateSettings({ focusMinutes: 999, rounds: 0 });
    assert.equal(fixture.settings().focusMinutes, 180);
    assert.equal(fixture.settings().rounds, 1);
  });
});

test("auto-advance off parks at the next phase instead of running", () => {
  withEngine({}, (fixture) => {
    fixture.engine.updateSettings({ autoAdvance: false });
    fixture.step();
    const view = fixture.engine.getSnapshot();
    assert.equal(view.running, false);
    assert.equal(view.phase, "short");
    assert.equal(view.remainingMs, view.durationMs);
  });
});

test("a phase that elapses while nobody is watching is still counted", () => {
  withEngine({}, (fixture) => {
    fixture.engine.start();
    fixture.advance(fixture.engine.getSnapshot().durationMs + 1);
    // No refresh and no interval: the next read must settle it. This is the property
    // that lets a host-owned timer survive a suspended or closed page.
    assert.equal(fixture.engine.getSnapshot().phase, "short");
    assert.equal(fixture.engine.getSnapshot().completedFocus, 1);
  });
});

test("onComplete reports the finished and the following phase", () => {
  withEngine({}, (fixture) => {
    fixture.engine.start();
    fixture.elapsePhase();
    assert.deepEqual(fixture.completions, [{ phase: "short", finished: "focus" }]);
  });
});

test("state survives a restart mid-phase", () => {
  const first = makeEngine();
  first.engine.start();
  first.advance(10 * 60000);
  first.engine.refresh();
  const persisted = first.state();
  const at = first.clock.value;
  first.dispose();
  assert.equal(persisted.running, true);

  withEngine({ state: persisted, now: at }, ({ engine }) => {
    const remaining = engine.getSnapshot().remainingMs;
    assert.ok(Math.abs(remaining - 15 * 60000) < 1500, `a restart must continue the phase, got ${remaining}`);
  });
});

test("an elapsed deadline settles as soon as the engine is built", () => {
  withEngine({ state: { phase: "focus", running: true, deadline: 1, completedFocus: 0, focusSinceLong: 0 } }, ({ engine }) => {
    assert.equal(engine.getSnapshot().phase, "short");
    assert.equal(engine.getSnapshot().completedFocus, 1);
  });
});

test("a stored break phase is armed at the break length, not the focus length", () => {
  withEngine(
    {
      settings: { focusMinutes: 25, shortMinutes: 5, longMinutes: 15, rounds: 4 },
      state: { phase: "short", running: false, pausedRemainingMs: 0, completedFocus: 1 },
    },
    ({ engine }) => {
      assert.equal(engine.getSnapshot().phase, "short");
      assert.equal(engine.getSnapshot().durationMs, 5 * 60000);
      assert.equal(engine.getSnapshot().remainingMs, 5 * 60000, "a restored break must not run 25 minutes");
    }
  );
});

test("a corrupt state document degrades to a fresh clock", () => {
  withEngine({ state: { phase: "nonsense", running: "yes", completedFocus: -4 } }, ({ engine }) => {
    const view = engine.getSnapshot();
    assert.equal(view.phase, "focus");
    assert.equal(view.running, false);
    assert.equal(view.completedFocus, 0);
  });
});

test("the cadence counter resets after a long break", () => {
  withEngine({}, (fixture) => {
    for (let index = 0; index < 7; index += 1) fixture.step();
    assert.equal(fixture.engine.getSnapshot().phase, "long");
    assert.equal(fixture.step(), "focus");
    assert.equal(fixture.engine.getSnapshot().focusSinceLong, 0);
    assert.equal(fixture.engine.getSnapshot().completedFocus, 4);
  });
});

test("reset returns the phase to full length without touching counters", () => {
  withEngine({}, (fixture) => {
    fixture.engine.start();
    fixture.advance(10 * 60000);
    fixture.engine.reset();
    assert.equal(fixture.engine.getSnapshot().remainingMs, 25 * 60000);
    assert.equal(fixture.engine.getSnapshot().running, true);
    assert.equal(fixture.engine.getSnapshot().completedFocus, 0);
  });
});

test("dispose is idempotent and stops further work", () => {
  withEngine({}, (fixture) => {
    fixture.engine.dispose();
    fixture.engine.dispose();
    assert.equal(fixture.engine.isDisposed(), true);
    fixture.engine.start();
    assert.equal(fixture.engine.getSnapshot().running, false, "a disposed engine must ignore commands");
  });
});

module.exports = suite;
