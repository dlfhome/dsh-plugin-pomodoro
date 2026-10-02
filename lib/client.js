// GENERATED FILE — do not edit.
// Source: src/client.template.js + src/engine.js
// Build:  node tools/build-client.cjs
/**
 * Browser half of the Pomodoro clock.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ GENERATED FILE — do not edit.                                             │
 * │ Source: src/client.template.js · Build: node tools/build-client.cjs      │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * Hand-authored in the built client-bundle format the DSH module system loads: a
 * single `window.__ModuleLoader__.load({ id, factory })` registration whose factory
 * is lazy CJS. No JSX (the platform seed exposes the React runtime, not a transform),
 * no ESM imports, and every module side effect — including the stylesheet — lives
 * inside the factory closure so unloading reclaims it.
 *
 * The timer itself lives in the Host half (see lib/index.js). This half polls the
 * Host's `/pomodoro` route, renders what it reports, and sends commands back. If that
 * route is unreachable it falls back to running the identical engine locally, so the
 * widget keeps working — it just loses cross-window durability and keeps its own
 * countdown only while the page is open.
 *
 * `src/engine.js` is inlined below at the engine marker, minus its `export` keywords,
 * so both halves execute one state machine rather than two copies.
 */

window.__ModuleLoader__.load({
  id: "@deepseek-ai/dsh-plugin-pomodoro",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var React = require("react");

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
const PHASES = ["focus", "short", "long"];

/**
 * Where the browser half mirrors its documents when it has to run the timer itself.
 * Kept here rather than in the browser template because the two halves must agree on
 * the shape of a persisted document even though only one of them writes to
 * `localStorage`.
 */
const STORAGE_SETTINGS = "dsh.pomodoro.settings.v1";
const STORAGE_STATE = "dsh.pomodoro.state.v1";

/** Ranges every numeric setting is clamped into. */
const LIMITS = {
  focusMinutes: [1, 180],
  shortMinutes: [1, 60],
  longMinutes: [1, 120],
  rounds: [1, 12],
};

/** Settings a fresh install starts from. */
const DEFAULT_SETTINGS = {
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
function clampNumber(key, value) {
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
function normalizeSettings(raw) {
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
function durationForPhase(phase, settings) {
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
function normalizeState(raw, settings) {
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
function createEngine(platform, initial) {
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

    /* ------------------------------------------------------------------ *
     * Stylesheet
     *
     * Only tokens the shipped frontend actually declares are referenced. An
     * undefined `var()` with no fallback is invalid at computed-value time, so a
     * token that merely appears inside another package's stylesheet (notably
     * `--dsw-alias-fill-l1/l2`, which nothing declares) would silently drop the
     * whole declaration.
     * ------------------------------------------------------------------ */

    var CSS = [
      ".dshPomodoro_root{position:fixed;right:18px;bottom:var(--dsh-pomodoro-bottom,calc(var(--dsh-composer-height,152px) + 12px));z-index:40;pointer-events:auto;display:flex;flex-direction:column;align-items:flex-end;gap:6px}",
      ".dshPomodoro_pill{display:flex;align-items:center;gap:8px;box-sizing:border-box;height:34px;padding:0 10px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-overlay);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-primary);cursor:pointer;font-family:inherit;font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}",
      ".dshPomodoro_pill:hover{border-color:var(--dsw-alias-border-l2)}",
      ".dshPomodoro_pill:focus-visible{outline:none;border-color:var(--dsw-alias-brand-primary)}",
      ".dshPomodoro_dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-idle-primary)}",
      ".dshPomodoro_dotRunning{background:var(--dsw-alias-state-success-primary)}",
      ".dshPomodoro_dotPaused{background:var(--dsw-alias-state-warn-primary)}",
      ".dshPomodoro_dotLocal{background:var(--dsw-alias-state-idle-primary)}",
      ".dshPomodoro_pillTime{font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,monospace);font-size:13px;min-width:44px;text-align:right}",
      ".dshPomodoro_pillPhase{color:var(--dsw-alias-label-tertiary);font-size:11px}",
      ".dshPomodoro_card{box-sizing:border-box;width:236px;padding:12px;border-radius:var(--dsw-radius-lg);border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-overlay);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:10px}",
      ".dshPomodoro_head{display:flex;align-items:center;justify-content:space-between;gap:8px}",
      ".dshPomodoro_phase{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);letter-spacing:.02em}",
      ".dshPomodoro_rounds{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}",
      ".dshPomodoro_time{font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,monospace);font-size:38px;line-height:44px;font-variant-numeric:tabular-nums;text-align:center;letter-spacing:.01em}",
      ".dshPomodoro_bar{height:4px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}",
      ".dshPomodoro_barFill{height:100%;border-radius:999px;background:var(--dsw-alias-brand-primary);transition:width .25s linear}",
      ".dshPomodoro_barBreath{background:var(--dsw-alias-state-success-primary)}",
      ".dshPomodoro_barLong{background:var(--dsw-alias-state-warn-primary)}",
      ".dshPomodoro_controls{display:flex;align-items:center;justify-content:center;gap:6px}",
      ".dshPomodoro_btn{box-sizing:border-box;min-width:32px;height:28px;padding:0 8px;border-radius:var(--dsw-radius-sm);border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);cursor:pointer;font-family:inherit;font-size:12px;line-height:18px;display:inline-flex;align-items:center;justify-content:center;gap:4px}",
      ".dshPomodoro_btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary)}",
      ".dshPomodoro_btn:focus-visible{outline:none;border-color:var(--dsw-alias-brand-primary)}",
      ".dshPomodoro_btn:disabled{opacity:.45;cursor:default}",
      ".dshPomodoro_btnPrimary{background:var(--dsw-alias-label-primary);border-color:transparent;color:var(--dsw-alias-label-primary-inverted);min-width:78px;font-weight:500}",
      ".dshPomodoro_btnPrimary:hover:not(:disabled){background:var(--dsw-alias-label-primary);color:var(--dsw-alias-label-primary-inverted);opacity:.88}",
      ".dshPomodoro_footer{display:flex;align-items:center;justify-content:space-between;border-top:.5px solid var(--dsw-alias-border-l1);padding-top:8px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}",
      ".dshPomodoro_link{border:0;background:0 0;padding:0;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-family:inherit;font-size:11px;line-height:16px;text-decoration:underline;text-underline-offset:2px}",
      ".dshPomodoro_link:hover{color:var(--dsw-alias-label-primary)}",
      ".dshPomodoro_note{display:flex;align-items:center;gap:4px}",
      ".dshPomodoro_badge{flex:none;padding:0 4px;border-radius:var(--dsw-radius-xs);font-size:10px;line-height:14px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary)}",
      ".dshPomodoro_settings{display:flex;flex-direction:column;gap:4px}",
      ".dshPomodoro_row{display:flex;align-items:center;justify-content:space-between;gap:12px;box-sizing:border-box;min-height:44px;padding:4px 0}",
      ".dshPomodoro_rowMain{display:flex;flex-direction:column;gap:2px;min-width:0}",
      ".dshPomodoro_rowLabel{font-size:13px;line-height:18px;color:var(--dsw-alias-label-primary)}",
      ".dshPomodoro_rowHint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}",
      ".dshPomodoro_rowControl{display:flex;align-items:center;gap:6px;flex:none}",
      ".dshPomodoro_input{box-sizing:border-box;width:64px;height:28px;padding:0 8px;border-radius:var(--dsw-radius-sm);border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px;font-variant-numeric:tabular-nums;text-align:right}",
      ".dshPomodoro_input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}",
      ".dshPomodoro_unit{font-size:11px;color:var(--dsw-alias-label-tertiary)}",
      ".dshPomodoro_toggle{box-sizing:border-box;width:34px;height:20px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-interactive-bg-hover);cursor:pointer;position:relative;padding:0}",
      ".dshPomodoro_toggleOn{background:var(--dsw-alias-brand-primary);border-color:transparent}",
      ".dshPomodoro_toggle:focus-visible{outline:none;border-color:var(--dsw-alias-brand-primary)}",
      ".dshPomodoro_knob{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-soft);transition:transform .12s ease}",
      ".dshPomodoro_toggleOn .dshPomodoro_knob{transform:translateX(14px)}",
      ".dshPomodoro_reset{display:flex;align-items:center;justify-content:space-between;gap:8px}",
    ].join("");

    var TAG_ID = "@deepseek-ai/dsh-plugin-pomodoro/pomodoro.css";
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(TAG_ID) + "]") === null) {
      var tag = document.createElement("style");
      tag.dataset.plugin = "@deepseek-ai/dsh-plugin-pomodoro";
      tag.dataset.pluginCss = TAG_ID;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    /* ------------------------------------------------------------------ *
     * Copy
     *
     * Registered into the `pomodoro` locale namespace, then read through
     * `ctx.locale.bind("pomodoro")`. That bound translator resolves the active
     * locale at call time and memoizes only the binding, so a runtime language
     * switch is reflected without re-registering anything.
     * ------------------------------------------------------------------ */

    var DICT = {
      zh: {
        phaseFocus: "专注",
        phaseShort: "短休",
        phaseLong: "长休",
        start: "开始",
        pause: "暂停",
        resume: "继续",
        skip: "跳过",
        reset: "重置",
        expand: "展开番茄时钟",
        collapse: "收起",
        cycle: "本轮 {n}/{total}",
        focusDone: "已完成 {n} 个番茄",
        resetStats: "重置计数",
        title: "番茄时钟",
        desc: "专注 {focus} 分钟，短休 {short} 分钟，每 {rounds} 轮后长休 {long} 分钟。",
        rowFocus: "专注时长",
        rowShort: "短休时长",
        rowLong: "长休时长",
        rowRounds: "长休前轮数",
        rowAuto: "自动进入下一阶段",
        rowSound: "阶段结束提示音",
        rowNotify: "桌面通知",
        rowNotifyHint: "需要浏览器授权；关闭时只保留提示音",
        rowNotifyDenied: "已被浏览器拒绝，请在站点权限里恢复",
        rowRoundsHint: "每完成这么多轮专注后进入长休",
        minutes: "分钟",
        on: "已开启",
        off: "已关闭",
        hostBadge: "宿主计时",
        localBadge: "本页计时",
        hostHint: "计时由宿主进程维护：关掉页面也会继续",
        localHint: "未连上宿主，计时只在本页有效",
        notifyFocus: "专注结束",
        notifyShort: "短休结束",
        notifyLong: "长休结束",
        notifyBodyFocus: "休息一下，接下来是{next}。",
        notifyBodyBreak: "回到专注，开始第 {n} 轮。",
        nextShort: "短休",
        nextLong: "长休",
        nextFocus: "专注",
      },
      en: {
        phaseFocus: "Focus",
        phaseShort: "Short break",
        phaseLong: "Long break",
        start: "Start",
        pause: "Pause",
        resume: "Resume",
        skip: "Skip",
        reset: "Reset",
        expand: "Expand the Pomodoro clock",
        collapse: "Collapse",
        cycle: "Round {n}/{total}",
        focusDone: "{n} pomodoros done",
        resetStats: "Reset count",
        title: "Pomodoro clock",
        desc: "Focus {focus} min, short break {short} min, long break {long} min every {rounds} rounds.",
        rowFocus: "Focus length",
        rowShort: "Short break",
        rowLong: "Long break",
        rowRounds: "Rounds before a long break",
        rowAuto: "Advance automatically",
        rowSound: "Chime at phase end",
        rowNotify: "Desktop notification",
        rowNotifyHint: "Needs browser permission; the chime stays as the fallback",
        rowNotifyDenied: "Blocked by the browser — restore it in site permissions",
        rowRoundsHint: "A long break follows this many focus rounds",
        minutes: "min",
        on: "On",
        off: "Off",
        hostBadge: "host timer",
        localBadge: "this page",
        hostHint: "The host process owns the timer, so it keeps running with the page closed",
        localHint: "No host reachable; the timer only runs while this page is open",
        notifyFocus: "Focus finished",
        notifyShort: "Short break finished",
        notifyLong: "Long break finished",
        notifyBodyFocus: "Take a break — {next} is next.",
        notifyBodyBreak: "Back to focus, round {n}.",
        nextShort: "a short break",
        nextLong: "a long break",
        nextFocus: "focus",
      },
    };

    /* ------------------------------------------------------------------ *
     * Copy resolution
     * ------------------------------------------------------------------ */

    /**
     * Interpolate `{name}` placeholders, matching the framework translator's own
     * substitution rule so both produce identical text.
     */
    function format(phrase, values) {
      if (values === undefined) return phrase;
      return phrase.replace(/\{(\w+)\}/g, function (match, key) {
        return key in values ? String(values[key]) : match;
      });
    }

    /* ------------------------------------------------------------------ *
     * Host bridge
     *
     * The Host owns the timer; this is the only code that talks to it. Every call is
     * bounded and failure-tolerant: a page that cannot reach `/pomodoro` must keep
     * working, just locally.
     * ------------------------------------------------------------------ */

    var ROUTE = "/pomodoro";
    var POLL_MS = 2000;
    var REQUEST_TIMEOUT_MS = 4000;

    /**
     * One JSON request against the Host route.
     * @param path - route suffix, e.g. "/state".
     * @param body - request body for POST, omitted for GET.
     * @returns the parsed payload, or null when the Host is unreachable.
     */
    async function hostRequest(path, body) {
      if (typeof fetch !== "function") return null;
      var controller = typeof AbortController === "function" ? new AbortController() : null;
      var timer = window.setTimeout(function () {
        if (controller !== null) controller.abort();
      }, REQUEST_TIMEOUT_MS);
      try {
        var response = await fetch(ROUTE + path, {
          method: body === undefined ? "GET" : "POST",
          headers: body === undefined ? undefined : { "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
          cache: "no-store",
          signal: controller === null ? undefined : controller.signal,
        });
        if (!response.ok) return null;
        var payload = await response.json();
        return payload !== null && typeof payload === "object" ? payload : null;
      } catch (error) {
        return null;
      } finally {
        window.clearTimeout(timer);
      }
    }

    /* ------------------------------------------------------------------ *
     * The seat-facing controller
     *
     * One object that both seats subscribe to. It hides whether the numbers came from
     * the Host or from a local engine, so the components never branch on that.
     * ------------------------------------------------------------------ */

    /**
     * @typedef {object} ControllerView
     * @property {string} phase
     * @property {boolean} running
     * @property {number} completedFocus
     * @property {number} focusSinceLong
     * @property {number} remainingMs
     * @property {number} durationMs
     * @property {object} settings
     * @property {"host"|"local"} source
     * @property {boolean} reachable
     */

    function createController(platform) {
      var listeners = new Set();
      var host = {
        reachable: false,
        checked: false,
        state: null,
        receivedAt: 0,
        /** Bumped on every accepted host state, so the snapshot cache can key on it. */
        version: 0,
        timer: null,
        started: false,
      };
      var local = {
        engine: null,
      };
      var lastNotifiedPhase = null;
      var notificationState = "unknown";

      /** Notify subscribers and invalidate nothing else — views are derived. */
      function notify() {
        listeners.forEach(function (listener) {
          try {
            listener();
          } catch (error) {
            /* one seat's render error must not stop the others */
          }
        });
      }

      /**
       * Build the local engine, used only when the Host is unreachable. It shares
       * the state machine with the Host, so behavior is identical apart from
       * durability.
       */
      function localEngine() {
        if (local.engine === null || local.engine.isDisposed()) {
          local.engine = createEngine(
            {
              now: function () {
                return Date.now();
              },
              setInterval: function (fn, ms) {
                return window.setInterval(fn, ms);
              },
              clearInterval: function (handle) {
                window.clearInterval(handle);
              },
              persistSettings: function (settings) {
                writeJson(STORAGE_SETTINGS, settings);
              },
              persistState: function (state) {
                writeJson(STORAGE_STATE, state);
              },
              onComplete: function (phase, finished) {
                announce(phase, finished);
              },
            },
            { settings: readJson(STORAGE_SETTINGS), state: readJson(STORAGE_STATE) }
          );        }
        return local.engine;
      }

      /** Read one locally persisted document, never throwing. */
      function readJson(key) {
        try {
          var text = window.localStorage.getItem(key);
          return text === null ? undefined : JSON.parse(text);
        } catch (error) {
          return undefined;
        }
      }

      /** Persist one document, ignoring quota and privacy-mode failures. */
      function writeJson(key, value) {
        try {
          window.localStorage.setItem(key, JSON.stringify(value));
        } catch (error) {
          /* the timer still works for this page; only cross-refresh memory is lost */
        }
      }

      /**
       * Best-effort desktop notification. The permission prompt is only ever raised
       * from an explicit settings toggle, never from this path, so a phase change
       * cannot produce an unsolicited browser prompt.
       */
      function announce(nextPhase, finishedPhase) {
        var view = snapshot();
        if (view.settings.sound) platform.chime();
        if (!view.settings.notify) return;
        try {
          if (typeof Notification !== "function" || Notification.permission !== "granted") return;
          var t = platform.translate;
          var title = finishedPhase === "focus" ? t("notifyFocus") : finishedPhase === "short" ? t("notifyShort") : t("notifyLong");
          var nextLabel = nextPhase === "short" ? t("nextShort") : nextPhase === "long" ? t("nextLong") : t("nextFocus");
          var body =
            finishedPhase === "focus"
              ? format(t("notifyBodyFocus"), { next: nextLabel })
              : format(t("notifyBodyBreak"), { n: view.focusSinceLong + 1 });
          var notification = new Notification(title, { body: body, tag: "dsh-pomodoro", silent: true });
          window.setTimeout(function () {
            notification.close();
          }, 12000);
        } catch (error) {
          /* notifications are best-effort */
        }
      }

      /**
       * Detect a phase change coming from the Host, which cannot notify on this page's
       * behalf, and announce it here.
       * @param state - the payload GET /state answered with.
       */
      function observeHostState(state) {
        if (lastNotifiedPhase === null) {
          lastNotifiedPhase = state.phase;
          return;
        }
        if (state.phase !== lastNotifiedPhase) {
          var finished = lastNotifiedPhase;
          lastNotifiedPhase = state.phase;
          announce(state.phase, finished);
        }
      }

      /** Adopt a host state document and refresh the derived view. */
      function adoptHostState(state) {
        host.reachable = true;
        host.checked = true;
        host.state = state;
        host.receivedAt = Date.now();
        host.version += 1;
      }

      /** Poll the Host once and fold the answer into the controller. */
      async function poll() {
        var state = await hostRequest("/state");
        if (disposed) return;
        if (state === null) {
          host.reachable = false;
          host.checked = true;
          notify();
          return;
        }
        adoptHostState(state);
        observeHostState(state);
        notify();
      }

      var disposed = false;

      /**
       * Memoized view, plus the key it was built for.
       *
       * `useSyncExternalStore` requires `getSnapshot()` to return the SAME object while
       * the underlying data is unchanged; a fresh object each call reads as "the store
       * just changed", so React re-renders, reads again, sees a new object again, and
       * loops until it throws. That is why the host path has to memoize exactly like the
       * engine already does — and why returning a new object here broke the seat only
       * once the Host became reachable.
       */
      var cached = null;
      var cachedKey = null;

      /** Whether a phase is due or done, for the given state. */
      function isParked(state) {
        return state.running !== true && state.remainingMs <= 0;
      }

      /** The remaining-time bucket a host state should be cached under. */
      function secondBucket(state) {
        return state.running === true ? Math.ceil(state.remainingMs / 1000) : -1;
      }

      /**
       * An immutable view for the seats. Host numbers are projected onto this page's
       * clock, so the countdown moves smoothly between polls and a suspended tab
       * catches up on its next read.
       */
      function snapshot() {
        if (host.reachable && host.state !== null) {
          var state = host.state;
          var elapsed = Date.now() - host.receivedAt;
          var remaining = state.running ? Math.max(0, state.remainingMs - elapsed) : state.remainingMs;
          // `running` flips when a poll shows the phase already rolled over, so the
          // parked reading must not be cached under the running bucket it followed.
          var key = `host:${host.version}:${state.running ? Math.ceil(remaining / 1000) : -1}:${isParked(state) ? "parked" : "live"}`;
          if (cachedKey === key && cached !== null) return cached;
          cached = {
            phase: state.phase,
            running: state.running,
            completedFocus: state.completedFocus,
            focusSinceLong: state.focusSinceLong,
            remainingMs: remaining,
            durationMs: state.durationMs,
            settings: state.settings,
            source: "host",
            reachable: true,
          };
          cachedKey = key;
          return cached;
        }

        var engine = localEngine();
        var view = engine.getSnapshot();
        if (cachedKey !== "local" || cached === null) {
          cached = {
            phase: view.phase,
            running: view.running,
            completedFocus: view.completedFocus,
            focusSinceLong: view.focusSinceLong,
            remainingMs: view.remainingMs,
            durationMs: view.durationMs,
            settings: view.settings,
            source: "local",
            reachable: false,
          };
          cachedKey = "local";
        }
        return cached;
      }

      /** Send one command, applying it locally when the Host is not there. */
      async function command(name) {
        if (host.reachable) {
          var answer = await hostRequest("/command", { command: name });
          if (answer !== null) {
            adoptHostState(answer);
            notify();
            return;
          }
          host.reachable = false;
        }
        var engine = localEngine();
        if (typeof engine[name] === "function") engine[name]();
        notify();
      }

      /** Write a settings patch to whichever side currently owns the clock. */
      async function saveSettings(patch) {
        if (host.reachable) {
          var answer = await hostRequest("/settings", { settings: patch });
          if (answer !== null) {
            adoptHostState(answer);
            notify();
            return;
          }
          host.reachable = false;
        }
        localEngine().updateSettings(patch);
        notify();
      }

      /**
       * Turn desktop notifications on or off. Reads the browser's verdict first so the
       * toggle reflects reality, and writes the resulting preference to whichever side
       * owns the clock.
       */
      async function setNotify(enabled) {
        var granted = false;
        if (enabled) {
          try {
            if (typeof Notification !== "function") {
              notificationState = "unsupported";
            } else if (Notification.permission === "granted") {
              granted = true;
              notificationState = "granted";
            } else if (Notification.permission === "denied") {
              notificationState = "denied";
            } else {
              granted = (await Notification.requestPermission()) === "granted";
              notificationState = granted ? "granted" : "denied";
            }
          } catch (error) {
            notificationState = "unsupported";
          }
        }
        await saveSettings({ notify: enabled && granted });
        notify();
        return enabled && granted;
      }

      /** Current state of the desktop-notification permission. */
      function notifyPermission() {
        if (notificationState !== "unknown") return notificationState;
        try {
          if (typeof Notification !== "function") return "unsupported";
          return Notification.permission === "default" ? "prompt" : Notification.permission;
        } catch (error) {
          return "unsupported";
        }
      }

      /**
       * Start polling. The first probe decides whether the Host or the local engine
       * owns this page; afterwards every poll keeps the two in step.
       */
      function start() {
        if (host.started || disposed) return;
        host.started = true;
        void poll();
        host.timer = window.setInterval(function () {
          void poll();
        }, POLL_MS);
      }

      return {
        snapshot: snapshot,
        subscribe: function (listener) {
          listeners.add(listener);
          start();
          return function () {
            listeners.delete(listener);
          };
        },
        command: command,
        saveSettings: saveSettings,
        setNotify: setNotify,
        notifyPermission: notifyPermission,
        isHost: function () {
          return host.reachable;
        },
        /** Release timers. The Host keeps running; only this page stops watching. */
        dispose: function () {
          disposed = true;
          if (host.timer !== null) window.clearInterval(host.timer);
          host.timer = null;
          if (local.engine !== null) local.engine.dispose();
          local.engine = null;
          listeners.clear();
        },
      };
    }

    /* ------------------------------------------------------------------ *
     * Presentation helpers
     * ------------------------------------------------------------------ */

    /** Render milliseconds as `mm:ss` (or `h:mm:ss` past an hour). */
    function clockText(ms) {
      var total = Math.max(0, Math.ceil(ms / 1000));
      var hours = Math.floor(total / 3600);
      var minutes = Math.floor((total % 3600) / 60);
      var seconds = total % 60;
      var pad = function (value) {
        return value < 10 ? "0" + value : String(value);
      };
      if (hours > 0) return hours + ":" + pad(minutes) + ":" + pad(seconds);
      return pad(minutes) + ":" + pad(seconds);
    }

    var PHASE_BAR = {
      focus: "dshPomodoro_barFill",
      short: "dshPomodoro_barFill dshPomodoro_barBreath",
      long: "dshPomodoro_barFill dshPomodoro_barLong",
    };

    function h(type, props) {
      var children = Array.prototype.slice.call(arguments, 2);
      return React.createElement.apply(React, [type, props].concat(children));
    }

    /* ------------------------------------------------------------------ *
     * Seats
     * ------------------------------------------------------------------ */

    /** The shared controller; the plugin body installs it before registering seats. */
    var CONTROLLER = null;

    /**
     * Subscribe one React component to the controller.
     * @returns the current view, or null before the plugin body has run.
     */
    function useTimer() {
      var engine = CONTROLLER;
      var subscribe = React.useCallback(
        function (listener) {
          return engine === null ? function () {} : engine.subscribe(listener);
        },
        [engine]
      );
      var read = React.useCallback(
        function () {
          return engine === null ? null : engine.snapshot();
        },
        [engine]
      );
      return React.useSyncExternalStore(subscribe, read, read);
    }

    /** Repaint on the displayed-second boundary so the clock looks live between polls. */
    function useTicker(active) {
      var state = React.useState(0);
      var bump = state[1];
      React.useEffect(
        function () {
          if (!active) return undefined;
          var handle = window.setInterval(function () {
            bump(function (value) {
              return value + 1;
            });
          }, 500);
          return function () {
            window.clearInterval(handle);
          };
        },
        [active]
      );
    }

    /**
     * The frame-wide floating clock. Collapsed it is a status pill; expanded it is the
     * full card with controls and a reminder of where the durations live.
     */
    function PomodoroWidget(props) {
      var t = props.t;
      var view = useTimer();
      var expandedState = React.useState(function () {
        return view !== null && view.settings.collapsed !== true;
      });
      var expanded = expandedState[0];
      var setExpanded = expandedState[1];

      // The collapsed flag arrives twice: synchronously from the local mirror, then
      // again once the Host's copy lands. Follow the setting so the seat converges on
      // what the user chose instead of keeping the pre-Host first render.
      React.useEffect(
        function () {
          if (view !== null) setExpanded(view.settings.collapsed !== true);
        },
        [view === null ? null : view.settings.collapsed]
      );

      useTicker(view !== null && view.running);

      if (view === null || CONTROLLER === null) return null;

      var running = view.running;
      var remaining = view.remainingMs;
      var duration = view.durationMs > 0 ? view.durationMs : 1;
      var ratio = Math.max(0, Math.min(1, remaining / duration));
      var label = view.phase === "short" ? t("phaseShort") : view.phase === "long" ? t("phaseLong") : t("phaseFocus");
      var parked = remaining <= 0 && !running;

      var onToggle = function () {
        void CONTROLLER.command("toggle");
      };

      var onPillClick = function () {
        setExpanded(true);
        if (view.settings.collapsed) void CONTROLLER.saveSettings({ collapsed: false });
      };

      var onCollapse = function () {
        setExpanded(false);
        void CONTROLLER.saveSettings({ collapsed: true });
      };

      var actions = [
        {
          id: "toggle",
          text: running ? t("pause") : remaining < duration ? t("resume") : t("start"),
          className: "dshPomodoro_btn dshPomodoro_btnPrimary",
          onClick: onToggle,
        },
        { id: "skip", text: t("skip"), className: "dshPomodoro_btn", onClick: function () { void CONTROLLER.command("skip"); } },
        { id: "reset", text: t("reset"), className: "dshPomodoro_btn", onClick: function () { void CONTROLLER.command("reset"); } },
      ];

      var card = h(
        "div",
        { className: "dshPomodoro_card", role: "group", "aria-label": t("title") },
        h(
          "div",
          { className: "dshPomodoro_head" },
          h("span", { className: "dshPomodoro_phase" }, label),
          h(
            "span",
            { className: "dshPomodoro_rounds" },
            format(t("cycle"), { n: Math.min(view.focusSinceLong, view.settings.rounds), total: view.settings.rounds })
          )
        ),
        h("div", { className: "dshPomodoro_time" }, clockText(remaining)),
        h(
          "div",
          { className: "dshPomodoro_bar" },
          h("div", { className: PHASE_BAR[view.phase], style: { width: Math.round(ratio * 100) + "%" } })
        ),
        h(
          "div",
          { className: "dshPomodoro_controls" },
          actions.map(function (action) {
            return h(
              "button",
              { key: action.id, type: "button", className: action.className, onClick: action.onClick, title: action.text },
              action.text
            );
          })
        ),
        h(
          "div",
          { className: "dshPomodoro_footer" },
          h("span", null, format(t("focusDone"), { n: view.completedFocus })),
          h(
            "span",
            { className: "dshPomodoro_note" },
            h("span", { className: "dshPomodoro_badge" }, view.reachable ? t("hostBadge") : t("localBadge")),
            h("button", { type: "button", className: "dshPomodoro_link", onClick: onCollapse }, t("collapse"))
          )
        )
      );

      var dotClass = "dshPomodoro_dot" + (running ? " dshPomodoro_dotRunning" : parked ? "" : " dshPomodoro_dotPaused");

      var pill = h(
        "button",
        {
          type: "button",
          className: "dshPomodoro_pill",
          onClick: onPillClick,
          title: view.reachable ? t("hostHint") : t("localHint"),
          "aria-label": t("expand"),
        },
        h("span", { className: dotClass }),
        h("span", { className: "dshPomodoro_pillTime" }, clockText(remaining)),
        h("span", { className: "dshPomodoro_pillPhase" }, label)
      );

      return h("div", { className: "dshPomodoro_root" }, expanded ? card : pill);
    }

    /**
     * One number field for a duration-like setting. The draft is local so typing is
     * never fought by a re-render; the controller is written on blur or Enter.
     */
    function NumberField(props) {
      var draftState = React.useState(String(props.value));
      var draft = draftState[0];
      var setDraftState = draftState[1];
      // The freshest draft also lives in a mutable box. The commit reads that box rather
      // than the closed-over value, so a blur or Enter arriving with a render in flight
      // can never write a stale number back over what the user just typed.
      var box = React.useRef !== undefined ? React.useRef(String(props.value)) : { current: String(props.value) };
      var setDraft = function (next) {
        box.current = next;
        setDraftState(next);
      };
      React.useEffect(
        function () {
          box.current = String(props.value);
          setDraftState(String(props.value));
        },
        [props.value]
      );

      var commit = function () {
        var typed = box.current;
        var parsed = Number(typed);
        if (typed.trim() === "" || !isFinite(parsed)) {
          setDraft(String(props.value));
          return;
        }
        var next = clampNumber(props.field, parsed);
        setDraft(String(next));
        if (next !== props.value) props.onChange(next);
      };

      return h(
        "div",
        { className: "dshPomodoro_rowControl" },
        h("input", {
          className: "dshPomodoro_input",
          type: "number",
          min: LIMITS[props.field][0],
          max: LIMITS[props.field][1],
          value: draft,
          "aria-label": props.label,
          onChange: function (event) {
            setDraft(event.target.value);
          },
          onBlur: commit,
          onKeyDown: function (event) {
            if (event.key === "Enter") commit();
          },
        }),
        h("span", { className: "dshPomodoro_unit" }, props.unit)
      );
    }

    /** Toggle switch for one boolean setting. */
    function SwitchField(props) {
      return h(
        "button",
        {
          type: "button",
          className: "dshPomodoro_toggle" + (props.value ? " dshPomodoro_toggleOn" : ""),
          role: "switch",
          "aria-checked": props.value ? "true" : "false",
          "aria-label": props.label,
          onClick: function () {
            props.onChange(!props.value);
          },
        },
        h("span", { className: "dshPomodoro_knob" })
      );
    }

    /** The General-settings row: durations, cadence, chime and desktop notifications. */
    function PomodoroSettingsRow(props) {
      var t = props.t;
      var view = useTimer();
      if (view === null || CONTROLLER === null) return null;

      var settings = view.settings;

      var number = function (field, label, hint) {
        return h(
          "div",
          { className: "dshPomodoro_row", key: field },
          h(
            "div",
            { className: "dshPomodoro_rowMain" },
            h("span", { className: "dshPomodoro_rowLabel" }, label),
            hint === undefined ? null : h("span", { className: "dshPomodoro_rowHint" }, hint)
          ),
          h(NumberField, {
            field: field,
            value: settings[field],
            label: label,
            unit: t("minutes"),
            onChange: function (next) {
              var patch = {};
              patch[field] = next;
              void CONTROLLER.saveSettings(patch);
            },
          })
        );
      };

      var toggle = function (field, label, hint) {
        return h(
          "div",
          { className: "dshPomodoro_row", key: field },
          h(
            "div",
            { className: "dshPomodoro_rowMain" },
            h("span", { className: "dshPomodoro_rowLabel" }, label),
            h("span", { className: "dshPomodoro_rowHint" }, hint === undefined ? (settings[field] ? t("on") : t("off")) : hint)
          ),
          h(SwitchField, {
            value: settings[field],
            label: label,
            onChange: function (next) {
              var patch = {};
              patch[field] = next;
              void CONTROLLER.saveSettings(patch);
            },
          })
        );
      };

      // Desktop notifications own their own switch: enabling one has to ask the browser
      // for permission first, and the stored preference must reflect what it answered.
      var notifyPermission = CONTROLLER.notifyPermission();
      var notifyHint =
        notifyPermission === "denied" ? t("rowNotifyDenied") : notifyPermission === "unsupported" ? t("localHint") : t("rowNotifyHint");

      return h(
        "div",
        { className: "dshPomodoro_settings" },
        h(
          "div",
          { className: "dshPomodoro_rowMain" },
          h("span", { className: "dshPomodoro_rowLabel" }, t("title")),
          h(
            "span",
            { className: "dshPomodoro_rowHint" },
            format(t("desc"), {
              focus: settings.focusMinutes,
              short: settings.shortMinutes,
              long: settings.longMinutes,
              rounds: settings.rounds,
            })
          )
        ),
        number("focusMinutes", t("rowFocus")),
        number("shortMinutes", t("rowShort")),
        number("longMinutes", t("rowLong")),
        number("rounds", t("rowRounds"), t("rowRoundsHint")),
        toggle("autoAdvance", t("rowAuto")),
        toggle("sound", t("rowSound"), settings.sound ? t("on") : t("off")),
        h(
          "div",
          { className: "dshPomodoro_row", key: "notify" },
          h(
            "div",
            { className: "dshPomodoro_rowMain" },
            h("span", { className: "dshPomodoro_rowLabel" }, t("rowNotify")),
            h("span", { className: "dshPomodoro_rowHint" }, notifyHint)
          ),
          h(SwitchField, {
            value: settings.notify,
            label: t("rowNotify"),
            onChange: function (next) {
              void CONTROLLER.setNotify(next);
            },
          })
        ),
        h(
          "div",
          { className: "dshPomodoro_reset" },
          h("button", { type: "button", className: "dshPomodoro_link", onClick: function () { void CONTROLLER.command("resetStats"); } }, t("resetStats")),
          h("span", { className: "dshPomodoro_rowHint" }, view.reachable ? t("hostHint") : t("localHint"))
        )
      );
    }

    /* ------------------------------------------------------------------ *
     * Plugin body
     * ------------------------------------------------------------------ */

    /** Required services: the slot registry and the locale registry. */
    var inject = ["slots", "locale"];

    /**
     * Client plugin body: install the dictionaries, the shared controller, and the two
     * seats.
     * @param ctx - client root context.
     */
    function apply(ctx) {
      var locale = ctx.get("locale");

      // Register before the seats so the bound translator can resolve keys on the very
      // first render rather than briefly showing raw key names.
      var unregister = locale.register("pomodoro", { zh: DICT.zh, en: DICT.en });
      var bound = typeof locale.bind === "function" ? locale.bind("pomodoro") : undefined;

      /** Translate one key, preferring the framework registry. */
      var translate = function (key, values) {
        if (bound !== undefined) return values === undefined ? bound(key) : bound(key, values);
        var snapshot;
        try {
          snapshot = locale.getSnapshot();
        } catch (error) {
          snapshot = undefined;
        }
        var active = snapshot !== null && snapshot !== undefined && typeof snapshot.active === "string" ? snapshot.active : "zh";
        var dict = active.toLowerCase().indexOf("en") === 0 ? DICT.en : DICT.zh;
        return format(dict[key] === undefined ? key : dict[key], values);
      };

      ctx.effect(
        function () {
          return unregister;
        },
        "pomodoro: dictionaries"
      );

      /** The chime, synthesised so the package ships no audio asset. */
      var chime = function () {
        try {
          var Ctor = window.AudioContext || window.webkitAudioContext;
          if (Ctor === undefined) return;
          var audio = new Ctor();
          [0, 0.18].forEach(function (offset, index) {
            var start = audio.currentTime + offset;
            var oscillator = audio.createOscillator();
            var gain = audio.createGain();
            oscillator.type = "sine";
            oscillator.frequency.value = index === 0 ? 880 : 1180;
            gain.gain.setValueAtTime(0.0001, start);
            gain.gain.exponentialRampToValueAtTime(0.22, start + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.16);
            oscillator.connect(gain).connect(audio.destination);
            oscillator.start(start);
            oscillator.stop(start + 0.18);
          });
          window.setTimeout(function () {
            audio.close();
          }, 700);
        } catch (error) {
          /* audio is best-effort */
        }
      };

      var previous = CONTROLLER;
      CONTROLLER = createController({ chime: chime, translate: translate });

      ctx.effect(
        function () {
          return function () {
            if (CONTROLLER !== null) CONTROLLER.dispose();
            CONTROLLER = null;
          };
        },
        "pomodoro: controller"
      );
      if (previous !== null) previous.dispose();

      ctx.slots.inject("shell.overlay", function () {
        return ctx.slots.register(
          {
            name: "shell.overlay",
            id: "pomodoro",
            order: 30,
            label: translate("title"),
            inject: function () {
              return { t: translate };
            },
          },
          PomodoroWidget
        );
      });

      ctx.slots.inject("settings.general.item", function () {
        return ctx.slots.register(
          {
            name: "settings.general.item",
            id: "pomodoro",
            order: 40,
            label: translate("title"),
            inject: function () {
              return { t: translate };
            },
          },
          PomodoroSettingsRow
        );
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.PomodoroWidget = PomodoroWidget;
    exports.PomodoroSettingsRow = PomodoroSettingsRow;
    // Exported for the test suite, which asserts the one `useSyncExternalStore`
    // contract a rendered tree cannot show: `snapshot()` must return the SAME object
    // while the data is unchanged.
    exports.PomodoroCreateController = createController;
    return module.exports;
  },
});
