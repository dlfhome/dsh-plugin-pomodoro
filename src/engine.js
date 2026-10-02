/**
 * The Pomodoro state machine, shared verbatim by both halves of the plugin.
 *
 * This file is the single source of truth for the timer. The Node half imports it
 * directly; `tools/build-client.cjs` inlines the same text into the browser bundle,
 * because a hand-authored client bundle may not import from its own package. Nothing
 * here touches `window`, `document`, `node:*`, or `require`, so both do the same
 * thing by construction rather than by two copies staying in step.
 *
 * Time is deadline-based: the engine stores the wall-clock instant a phase ends
 * rather than a decrementing counter, so a suspended process, a throttled tab, or a
 * page reload never loses time — `remainingMs()` recomputes from `now()` on read.
 *
 * The platform injects everything it cannot know: a clock, an interval timer, and a
 * persistence callback.
 *
 * @typedef {object} EngineSettings
 * @property {number} focusMinutes
 * @property {number} shortMinutes
 * @property {number} longMinutes
 * @property {number} rounds
 * @property {boolean} autoAdvance
 * @property {boolean} sound
 * @property {boolean} notify
 * @property {boolean} collapsed
 *
 * @typedef {object} EnginePlatform
 * @property {() => number} now - wall-clock milliseconds
 * @property {(fn: () => void, ms: number) => unknown} setInterval
 * @property {(handle: unknown) => void} clearInterval
 * @property {(state: object) => void} persistState - called whenever the timer changes
 * @property {(settings: EngineSettings) => void} persistSettings
 * @property {(phase: string, previousPhase: string) => void} [onComplete] - a phase elapsed
 */

/** Phase identifiers, in the order a cycle visits them. */
export const PHASES = ["focus", "short", "long"];

/**
 * Where the browser half mirrors its documents when it has to run the timer itself.
 * Kept here rather than in the browser template because the two halves must agree on
 * the shape of a persisted document even though only one of them writes to
 * `localStorage`.
 */
export const STORAGE_SETTINGS = "dsh.pomodoro.settings.v1";
export const STORAGE_STATE = "dsh.pomodoro.state.v1";

/** Ranges every numeric setting is clamped into. */
export const LIMITS = {
  focusMinutes: [1, 180],
  shortMinutes: [1, 60],
  longMinutes: [1, 120],
  rounds: [1, 12],
};

/** Settings a fresh install starts from. */
export const DEFAULT_SETTINGS = {
  focusMinutes: 25,
  shortMinutes: 5,
  longMinutes: 15,
  rounds: 4,
  autoAdvance: true,
  sound: true,
  notify: false,
  collapsed: false,
};

/** Milliseconds in one minute. */
const MINUTE = 60000;

/**
 * Clamp one numeric setting into its supported range.
 * @param key - settings field name.
 * @param value - candidate value.
 * @returns the accepted, rounded number.
 */
export function clampNumber(key, value) {
  const range = LIMITS[key];
  const number = typeof value === "number" ? value : Number(value);
  if (!isFinite(number)) return DEFAULT_SETTINGS[key];
  const rounded = Math.round(number);
  if (rounded < range[0]) return range[0];
  if (rounded > range[1]) return range[1];
  return rounded;
}

/**
 * Normalize a persisted or hand-edited settings object.
 * @param raw - candidate settings.
 * @returns a complete, in-range settings object.
 */
export function normalizeSettings(raw) {
  const source = raw !== null && typeof raw === "object" ? raw : {};
  const merged = {};
  for (const key of Object.keys(LIMITS)) {
    merged[key] = source[key] === undefined ? DEFAULT_SETTINGS[key] : clampNumber(key, source[key]);
  }
  for (const key of ["autoAdvance", "sound", "notify", "collapsed"]) {
    merged[key] = typeof source[key] === "boolean" ? source[key] : DEFAULT_SETTINGS[key];
  }
  return merged;
}

/**
 * Length of one phase under the given settings.
 * @param phase - phase identifier.
 * @param settings - normalized settings.
 * @returns milliseconds.
 */
export function durationForPhase(phase, settings) {
  if (phase === "short") return settings.shortMinutes * MINUTE;
  if (phase === "long") return settings.longMinutes * MINUTE;
  return settings.focusMinutes * MINUTE;
}

/**
 * Normalize a persisted timer state, discarding anything unusable.
 * @param raw - candidate state.
 * @param settings - the settings the state is restored against.
 * @returns a complete timer state.
 */
export function normalizeState(raw, settings) {
  const source = raw !== null && typeof raw === "object" ? raw : {};
  const phase = PHASES.includes(source.phase) ? source.phase : "focus";
  const fullLength = durationForPhase(phase, settings);
  const remaining = typeof source.pausedRemainingMs === "number" && source.pausedRemainingMs > 0 ? source.pausedRemainingMs : 0;

  const state = {
    phase,
    running: false,
    // With nothing usable stored, the active phase is armed at ITS OWN full length —
    // never at the focus length, so a restored break cannot run 25 minutes.
    pausedRemainingMs: remaining > 0 ? remaining : fullLength,
    deadline: null,
    completedFocus: Number.isInteger(source.completedFocus) && source.completedFocus >= 0 ? source.completedFocus : 0,
    focusSinceLong: Number.isInteger(source.focusSinceLong) && source.focusSinceLong >= 0 ? Math.min(source.focusSinceLong, settings.rounds) : 0,
  };

  if (source.running === true && typeof source.deadline === "number") {
    state.running = true;
    state.deadline = source.deadline;
  }
  return state;
}

/**
 * Build a Pomodoro engine over an injected platform.
 * @param platform - clock, interval timer, and persistence hooks.
 * @param initial - persisted documents to restore from.
 * @returns the engine.
 */
export function createEngine(platform, initial) {
  const settings = normalizeSettings(initial === undefined ? undefined : initial.settings);
  const state = normalizeState(initial === undefined ? undefined : initial.state, settings);

  const listeners = new Set();
  let interval = null;
  let disposed = false;
  let snapshot = null;
  /**
   * Displayed second of the last invalidated view. Seeded from the restored state so
   * the first read is never considered stale.
   */
  let displayedSecond = Math.ceil((state.running && state.deadline !== null ? Math.max(0, state.deadline - platform.now()) : state.pausedRemainingMs) / 1000);

  /** Length of the active phase in milliseconds. */
  function phaseDurationMs() {
    return durationForPhase(state.phase, settings);
  }

  /** Milliseconds left in the active phase, never negative. */
  function remainingMs() {
    if (state.running && state.deadline !== null) {
      const left = state.deadline - platform.now();
      return left > 0 ? left : 0;
    }
    return state.pausedRemainingMs;
  }

  /** Persist the timer fields that must survive a restart. */
  function persist() {
    platform.persistState({
      phase: state.phase,
      running: state.running,
      deadline: state.deadline,
      pausedRemainingMs: state.pausedRemainingMs,
      completedFocus: state.completedFocus,
      focusSinceLong: state.focusSinceLong,
    });
  }

  /** Invalidate the cached snapshot and wake every subscriber. */
  function notify() {
    snapshot = null;
    displayedSecond = Math.ceil(remainingMs() / 1000);
    for (const listener of listeners) {
      try {
        listener();
      } catch (error) {
        /* one subscriber's failure must not stop the others */
      }
    }
  }

  /** The phase that follows the active one under the configured cadence. */
  function nextPhase() {
    if (state.phase !== "focus") return "focus";
    return state.focusSinceLong >= settings.rounds ? "long" : "short";
  }

  /**
   * Enter a phase, armed with that phase's own full duration. The phase is assigned
   * before the duration is read because the duration depends on the phase.
   */
  function enterPhase(phase, autoStart) {
    state.phase = phase;
    state.pausedRemainingMs = phaseDurationMs();
    state.deadline = autoStart === true ? platform.now() + state.pausedRemainingMs : null;
    state.running = autoStart === true;
    syncInterval();
    persist();
    notify();
  }

  /** Credit a focus phase that ran to completion. */
  function creditFocus() {
    state.completedFocus += 1;
    state.focusSinceLong += 1;
  }

  /** Settle an elapsed phase and move on. */
  function complete() {
    const finished = state.phase;
    if (finished === "focus") creditFocus();
    if (finished === "long") state.focusSinceLong = 0;
    const upcoming = nextPhase();
    if (settings.autoAdvance) {
      enterPhase(upcoming, true);
    } else {
      state.phase = upcoming;
      state.running = false;
      state.deadline = null;
      state.pausedRemainingMs = phaseDurationMs();
      syncInterval();
      persist();
      notify();
    }
    if (typeof platform.onComplete === "function") {
      try {
        platform.onComplete(upcoming, finished);
      } catch (error) {
        /* a notification failure must not disturb the timer */
      }
    }
  }

  /** Detect an elapsed deadline or a changed displayed second; safe at any frequency. */
  function tick() {
    if (disposed || !state.running || state.deadline === null) return;
    if (platform.now() >= state.deadline) {
      complete();
      return;
    }
    // The view is memoized, so a running clock has to invalidate it when the displayed
    // second moves — otherwise every read would return the same frozen countdown. One
    // invalidation per second keeps the object identity stable between seconds, which is
    // what lets a `useSyncExternalStore` consumer skip redundant renders.
    if (Math.ceil(remainingMs() / 1000) !== displayedSecond) {
      displayedSecond = Math.ceil(remainingMs() / 1000);
      snapshot = null;
    }
  }

  /** Run the ticking interval exactly while the clock is running. */
  function syncInterval() {
    if (state.running && interval === null && !disposed) {
      interval = platform.setInterval(tick, 250);
    } else if (!state.running && interval !== null) {
      platform.clearInterval(interval);
      interval = null;
    }
  }

  const engine = {
    /**
     * Current immutable view: phase, running flag, remaining and total time.
     *
     * Reading settles an elapsed deadline first. A host timer may be read long after
     * the phase should have rolled over — by a suspended process, a page returning
     * from the background, or a client that polls slower than the tick — and a caller
     * must never observe a phase sitting at zero.
     */
    getSnapshot() {
      tick();
      if (snapshot === null) {
        snapshot = {
          phase: state.phase,
          running: state.running,
          completedFocus: state.completedFocus,
          focusSinceLong: state.focusSinceLong,
          remainingMs: remainingMs(),
          durationMs: phaseDurationMs(),
          settings,
        };
      }
      return snapshot;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    isDisposed: () => disposed,
    start() {
      if (disposed || state.running) return;
      if (state.pausedRemainingMs <= 0) state.pausedRemainingMs = phaseDurationMs();
      state.deadline = platform.now() + state.pausedRemainingMs;
      state.running = true;
      syncInterval();
      persist();
      notify();
    },
    pause() {
      if (!state.running) return;
      state.pausedRemainingMs = remainingMs();
      state.running = false;
      state.deadline = null;
      syncInterval();
      persist();
      notify();
    },
    toggle() {
      if (state.running) engine.pause();
      else engine.start();
    },
    /**
     * Leave the active phase for the next one, keeping the running state. An
     * abandoned focus phase earns no pomodoro.
     */
    skip() {
      if (disposed) return;
      if (state.phase === "long") state.focusSinceLong = 0;
      enterPhase(nextPhase(), state.running);
    },
    /** Return the active phase to full length without touching the counters. */
    reset() {
      if (disposed) return;
      state.pausedRemainingMs = phaseDurationMs();
      state.deadline = state.running ? platform.now() + state.pausedRemainingMs : null;
      persist();
      notify();
    },
    /** Zero the pomodoro and cycle counters. */
    resetStats() {
      if (disposed) return;
      state.completedFocus = 0;
      state.focusSinceLong = 0;
      persist();
      notify();
    },
    /**
     * Merge a settings patch. While stopped, the active phase re-arms at its
     * (possibly new) full length; while running it keeps its deadline so elapsed
     * time is never discarded and the change applies from the next phase on.
     */
    updateSettings(patch) {
      if (disposed) return;
      Object.assign(settings, normalizeSettings(Object.assign({}, settings, patch)));
      platform.persistSettings(settings);
      if (!state.running) state.pausedRemainingMs = phaseDurationMs();
      notify();
    },
    /** Settle an elapsed deadline, then force a fresh reading. */
    refresh() {
      tick();
      notify();
    },
    /** Stop ticking and drop every subscriber. */
    dispose() {
      disposed = true;
      if (interval !== null) platform.clearInterval(interval);
      interval = null;
      listeners.clear();
    },
  };

  // A restore can land on an already-elapsed deadline: settle it immediately so the
  // first reader never sees a phase sitting at zero.
  tick();
  syncInterval();
  return engine;
}
