/**
 * Browser-half tests: seat registration, host↔local arbitration, commands, and the
 * desktop-notification path.
 *
 * The real `lib/client.js` runs against stubs for the browser surfaces it touches
 * (`window`, `document`, `fetch`, `Notification`, `AudioContext`), so the code under
 * test is the shipped bundle rather than a re-implementation.
 *
 * Usage: node tools/test-runner.cjs
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createSuite } = require("./test-runner.cjs");

const ROOT = path.resolve(__dirname, "..");
const BUNDLE = path.join(ROOT, "lib", "client.js");
const DECLARED_TOKENS = path.join(ROOT, ".reference", "declared-tokens.txt");
const SOURCE = fs.readFileSync(BUNDLE, "utf8");

const suite = createSuite();
const test = suite.test;

/* ---------------------------------------------------------------- open files */

const openTimers = new Set();
const liveEnvironments = new Set();

// Repaint queue. A store notification during a component's own render must not recurse,
// so a repaint is queued and the suites drain it (`flushRepaints()`) before asserting —
// which is what a real renderer's scheduled repaint amounts to here.
const pendingRepaints = new Set();

/**
 * Queue one component for repainting.
 * @param component - the seat component to re-run.
 */
function repaint(component) {
  if (component !== null && component !== undefined) pendingRepaints.add(component);
}

/**
 * Re-render every queued component through the environment that owns it.
 * @returns the number of components repainted.
 */
function flushRepaints() {
  let repainted = 0;
  while (pendingRepaints.size > 0) {
    const batch = [...pendingRepaints];
    pendingRepaints.clear();
    for (const environment of liveEnvironments) repainted += environment.repaintComponents(batch);
    if (repainted > 200) break; // a runaway re-render loop must fail the case, not hang it
  }
  return repainted;
}

/** Settle until a predicate holds, or fail after a bounded number of turns. */
async function until(predicate, label = "condition") {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    flushRepaints();
    if (predicate()) return;
    // A real macrotask, not just a microtask: the controller's poll has to run its
    // fetch, parse the body and notify subscribers before an assertion is valid.
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  flushRepaints();
  throw new Error(`timed out waiting for ${label}`);
}

/**
 * Wait until the controller has adopted the fake Host.
 *
 * A request appearing in the log only proves it was sent; the controller flips to host
 * mode after the response has been parsed, which takes further turns.
 * @param env - a mounted environment.
 */
async function waitForHost(env) {
  await until(() => env.isHost(), "the controller to adopt the host");
}

/* -------------------------------------------------------------------- stubs -- */

/**
 * A React stub with the surface the bundle uses.
 *
 * Stateful on purpose. `useSyncExternalStore` records a forceUpdate for the component
 * currently rendering, and `useState` stores values per component instance slot, so a
 * component that re-renders observes the new store state instead of its first frame.
 *
 * Slots are keyed by component function, which mirrors how the seats actually render:
 * at most a few instances, each stable.
 */
function makeReact() {
  const slots = new Map();
  let rendering = null;

  /** Slot store for the component currently rendering. */
  function slotFor(type) {
    if (!slots.has(type)) slots.set(type, { values: [], cursor: 0, forceUpdate: null, effects: [] });
    return slots.get(type);
  }

  /** Whether a dependency array changed since the last run at this slot index. */
  function depsChanged(slot, index, deps) {
    if (deps === undefined) return true;
    const previous = slot.effects[index];
    const changed = previous === undefined || previous.length !== deps.length || deps.some((value, position) => !Object.is(value, previous[position]));
    slot.effects[index] = deps;
    return changed;
  }

  return {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat() };
    },
    useCallback: (fn) => fn,
    /** A stable mutable box, like React's ref. */
    useRef(initial) {
      const slot = slotFor(rendering);
      const index = slot.cursor;
      slot.cursor += 1;
      if (slot.values.length <= index) slot.values[index] = { current: initial };
      return slot.values[index];
    },
    // Honor the dependency array: a re-render with unchanged deps must NOT re-run the
    // effect, or a controlled input would be reset out from under the user.
    useEffect(effect, deps) {
      const slot = slotFor(rendering);
      const index = slot.cursor;
      slot.cursor += 1;
      if (depsChanged(slot, index, deps)) effect();
    },
    useState(initial) {
      const slot = slotFor(rendering);
      const index = slot.cursor;
      slot.cursor += 1;
      if (slot.values.length <= index) slot.values[index] = typeof initial === "function" ? initial() : initial;
      return [
        slot.values[index],
        (next) => {
          slot.values[index] = typeof next === "function" ? next(slot.values[index]) : next;
          if (typeof slot.forceUpdate === "function") slot.forceUpdate();
        },
      ];
    },
    useSyncExternalStore(subscribe, getSnapshot) {
      const slot = slotFor(rendering);
      slot.forceUpdate = () => {
        if (typeof repaint === "function") repaint(rendering);
      };
      subscribe(() => slot.forceUpdate());
      return getSnapshot();
    },
    /**
     * Render a component, recording which instance is on the stack so its hooks bind
     * to the right slot.
     */
    renderComponent(component, props) {
      const previous = rendering;
      rendering = component;
      try {
        slotFor(component).cursor = 0;
        return component(props);
      } finally {
        rendering = previous;
      }
    },
  };
}

/**
 * Load the bundle with browser stubs and apply its plugin body.
 *
 * @param options.locale - active locale id the fake locale service reports.
 * @param options.host - fake Host: `{ state, seen, commands, settingsWrites }` or null
 *   for an unreachable Host.
 * @param options.notificationPermission - value the fake `Notification.permission` reports.
 * @param options.autoGrantNotification - what `requestPermission()` resolves to.
 */
function mountBundle(options = {}) {
  const captured = { factory: null };
  const storage = new Map();
  // `settings` seeds the browser's own mirror, which is what a seat reads before the
  // Host's copy lands and what the local engine uses when there is no Host at all.
  if (options.settings !== undefined) {
    storage.set("dsh.pomodoro.settings.v1", JSON.stringify(options.settings));
  }
  if (options.state !== undefined) {
    storage.set("dsh.pomodoro.state.v1", JSON.stringify(options.state));
  }
  const styleTags = [];
  const notifications = [];
  const chimes = [];
  const intervals = new Set();
  const fetchLog = [];
  const host = options.host ?? null;

  const document = {
    documentElement: { style: { setProperty: () => {} } },
    head: { appendChild: (tag) => styleTags.push(tag) },
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: "" }),
  };

  class FakeNotification {
    constructor(title, init) {
      this.title = title;
      this.body = init?.body;
      this.tag = init?.tag;
      notifications.push({ title, body: init?.body, tag: init?.tag });
    }
    close() {}
    static permission = options.notificationPermission ?? "granted";
    static requestPermission() {
      return Promise.resolve(options.autoGrantNotification ?? "granted");
    }
  }

  const window = {
    __ModuleLoader__: { load: (registration) => void (captured.factory = registration.factory) },
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => void storage.set(key, String(value)),
      removeItem: (key) => void storage.delete(key),
    },
    setInterval: (fn, ms) => {
      const handle = setInterval(fn, ms);
      intervals.add(handle);
      return handle;
    },
    clearInterval: (handle) => {
      intervals.delete(handle);
      clearInterval(handle);
    },
    setTimeout: (fn, ms) => {
      const handle = setTimeout(fn, ms);
      openTimers.add(handle);
      return handle;
    },
    clearTimeout: (handle) => {
      openTimers.delete(handle);
      clearTimeout(handle);
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    AudioContext: function AudioContextStub() {
      chimes.push(Date.now());
      return {
        currentTime: 0,
        destination: {},
        close: () => {},
        createOscillator: () => ({ type: "", frequency: { value: 0 }, connect: () => ({ connect: () => {} }), start: () => {}, stop: () => {} }),
        createGain: () => ({
          gain: { setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} },
          connect: () => ({ connect: () => {} }),
        }),
      };
    },
  };

  /** Answer `/pomodoro/*` from the fake Host, or fail like an unreachable server. */
  const fetchStub = async (url, init) => {
    fetchLog.push({ url, method: init?.method ?? "GET", body: init?.body });
    if (host === null) throw new Error("ECONNREFUSED");
    const path = String(url);
    if (path.endsWith("/ping")) {
      return { ok: true, json: async () => ({ ok: true, pid: 1 }) };
    }
    if (path.endsWith("/state")) {
      return { ok: true, json: async () => ({ ...host.state }) };
    }
    if (path.endsWith("/command")) {
      const body = JSON.parse(init.body);
      host.commands.push(body.command);
      if (body.command === "toggle") host.state.running = !host.state.running;
      if (body.command === "start") host.state.running = true;
      if (body.command === "pause") host.state.running = false;
      if (body.command === "resetStats") host.state.completedFocus = 0;
      host.state.now = Date.now();
      return { ok: true, json: async () => ({ ...host.state }) };
    }
    if (path.endsWith("/settings")) {
      const body = JSON.parse(init.body);
      host.settingsWrites.push(body.settings);
      Object.assign(host.state.settings, body.settings);
      return { ok: true, json: async () => ({ ...host.state }) };
    }
    return { ok: false, status: 404, json: async () => ({ error: "unknown route" }) };
  };

  const dictionaries = new Map();
  const locale = {
    active: options.locale ?? "zh",
    getLocale: () => ({ active: locale.active, locales: [], revision: 1 }),
    getSnapshot: () => ({ active: locale.active, locales: [], revision: 1 }),
    subscribe: () => () => {},
    register(ns, dicts) {
      dictionaries.set(ns, dicts);
      return () => dictionaries.delete(ns);
    },
    bind(ns) {
      return (key, params) => {
        const dicts = dictionaries.get(ns);
        const dict = dicts === undefined ? undefined : dicts[locale.active] ?? dicts.en ?? dicts.zh;
        const template = dict !== undefined && dict[key] !== undefined ? dict[key] : key;
        if (params === undefined) return template;
        return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
      };
    },
  };

  const scope = new Function(
    "window",
    "document",
    "require",
    "fetch",
    "Notification",
    "AbortController",
    "console",
    SOURCE
  );
  // One React instance for the whole environment: the seats' subscriptions and hook
  // state must survive across renders for the harness to behave like a renderer.
  const React = makeReact();
  const resolve = (specifier) => (specifier === "react" ? React : require(specifier));
  scope(window, document, resolve, fetchStub, FakeNotification, AbortController, console);

  const plugin = captured.factory(resolve);

  const registrations = [];
  const teardown = [];
  const ctx = {
    effect(fn) {
      const dispose = fn();
      teardown.push(() => {
        if (typeof dispose === "function") dispose();
      });
    },
    get: (name) => (name === "locale" ? locale : undefined),
    slots: {
      inject(_slot, callback) {
        const dispose = callback();
        if (typeof dispose === "function") teardown.push(dispose);
        return dispose;
      },
      register(registerOptions, component) {
        registrations.push({ options: registerOptions, component });
        return () => {};
      },
    },
    locale,
  };

  plugin.apply(ctx);

  const seat = (slotName) => registrations.find((entry) => entry.options.name === slotName);
  const renderProps = new Map();
  const extraControllers = new Set();
  const environment = {
    registrations,
    storage,
    styleTags,
    notifications,
    chimes,
    intervals,
    fetchLog,
    seat,
    document,
    /**
     * Whether the controller has adopted the fake Host.
     *
     * Read from the rendered badge rather than from internals: the badge is exactly how
     * a person tells "host timer" from "this page", so waiting on it waits on the real
     * observable.
     */
    isHost() {
      try {
        const { tree, t } = environment.render("shell.overlay");
        const nodes = allNodes(tree);
        // Expanded renders the badge; collapsed carries only the pill's tooltip.
        const badge = nodes.find((node) => node.props.className === "dshPomodoro_badge");
        if (badge !== undefined) return badge.children.join("") === t("hostBadge");
        const pill = nodes.find((node) => node.props.className === "dshPomodoro_pill");
        return pill !== undefined && pill.props.title === t("hostHint");
      } catch (error) {
        return false;
      }
    },
    /** Render one seat and return the tree plus its injected translator. */
    render(slotName) {
      const entry = seat(slotName);
      assert.ok(entry, `seat ${slotName} must be registered`);
      const injected = entry.options.inject();
      renderProps.set(entry.component, injected);
      return { tree: React.renderComponent(entry.component, injected), t: injected.t };
    },
    /**
     * Repaint the named components with the props they last rendered with. Called by
     * `flushRepaints()` after a store notification.
     * @param components - components to repaint.
     * @returns how many were repainted.
     */
    repaintComponents(components) {
      let count = 0;
      for (const component of components) {
        const props = renderProps.get(component);
        if (props === undefined) continue;
        React.renderComponent(component, props);
        count += 1;
      }
      return count;
    },
    /** Run every registered effect disposer in reverse, as the runtime does. */
    teardownAll() {
      for (const extra of extraControllers) {
        try {
          extra.dispose();
        } catch (error) {
          /* already gone */
        }
      }
      extraControllers.clear();
      for (const dispose of [...teardown].reverse()) dispose();
      for (const handle of intervals) clearInterval(handle);
      intervals.clear();
    },
    /**
     * Build a second controller from the shipped factory, outside the seats.
     *
     * Needed for the one assertion a rendered tree cannot make — that `snapshot()`
     * returns a stable object — without reaching into the plugin's private state.
     */
    newController() {
      const extra = plugin.PomodoroCreateController({
        chime: () => {},
        translate: (key) => key,
      });
      extraControllers.add(extra);
      return extra;
    },
  };

  // Tracked so a failing case cannot leave a polling interval behind.
  liveEnvironments.add(environment);
  return environment;
}

/** A fake Host whose clock is owned by the "server". */
function makeHost(overrides = {}) {
  return {
    seen: 0,
    commands: [],
    settingsWrites: [],
    state: {
      now: Date.now(),
      phase: "focus",
      running: false,
      completedFocus: 0,
      focusSinceLong: 0,
      remainingMs: 25 * 60000,
      durationMs: 25 * 60000,
      settings: {
        focusMinutes: 25,
        shortMinutes: 5,
        longMinutes: 15,
        rounds: 4,
        autoAdvance: true,
        sound: true,
        notify: false,
        collapsed: false,
      },
      ...overrides,
    },
  };
}

/* ------------------------------------------------------------------- helpers */

/**
 * Expand every component in a rendered tree, breadth-first.
 *
 * The harness renders by calling components as plain functions, so a child whose
 * `type` is a function is an unrendered component. This walks the tree and replaces
 * each with its output, which is what a real renderer would have done — the only way
 * to assert on markup that lives inside the number field or the toggle switch.
 *
 * @param tree - the element a seat returned.
 * @returns a tree of host elements only.
 */
function expand(tree) {
  if (tree === null || typeof tree !== "object") return tree;
  if (Array.isArray(tree)) return tree.map(expand);
  if (typeof tree.type === "function") return expand(tree.type(tree.props));
  const children = (tree.children ?? []).map(expand).filter((child) => child !== undefined && child !== null);
  return { ...tree, children };
}

/** Every host element in an expanded tree. */
function allNodes(tree) {
  const out = [];
  const walk = (node) => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(walk);
    out.push(node);
    (node.children ?? []).forEach(walk);
  };
  walk(expand(tree));
  return out;
}

/** Depth-first search for the first expanded node matching a predicate. */
function findNode(tree, predicate) {
  return allNodes(tree).find(predicate) ?? null;
}

/** Text of the first rendered node carrying a class. */
function textOfClass(tree, className) {
  const node = allNodes(tree).find((candidate) => candidate.props.className === className);
  assert.ok(node, `the render must contain .${className}`);
  return node.children.join("");
}

/* -------------------------------------------------------------------- cases */

test("mounts both seats into the right slots with the right ids", () => {
  const env = mountBundle();
  assert.deepEqual(
    env.registrations.map((entry) => entry.options.name).sort(),
    ["settings.general.item", "shell.overlay"]
  );
  assert.equal(env.seat("shell.overlay").options.id, "pomodoro");
  assert.equal(env.seat("shell.overlay").options.order, 30);
  assert.equal(env.seat("settings.general.item").options.order, 40);
  assert.equal(typeof env.seat("shell.overlay").options.inject, "function");
  env.teardownAll();
});

test("English locale produces English copy", () => {
  const env = mountBundle({ locale: "en" });
  const { t } = env.render("shell.overlay");
  assert.equal(t("phaseFocus"), "Focus");
  assert.equal(t("cycle", { n: 2, total: 4 }), "Round 2/4");
  assert.equal(t("hostBadge"), "host timer");
  env.teardownAll();
});

test("Chinese locale produces Chinese copy", () => {
  const env = mountBundle({ locale: "zh" });
  const { t } = env.render("shell.overlay");
  assert.equal(t("phaseFocus"), "专注");
  assert.equal(t("cycle", { n: 3, total: 4 }), "本轮 3/4");
  env.teardownAll();
});

test("the widget renders the pill collapsed and the card once expanded", () => {
  // The collapsed preference lives in the settings document, which in host mode is the
  // Host's copy — that is what makes the choice follow the user across windows.
  const collapsed = mountBundle({ settings: { collapsed: true } });
  const pillTree = collapsed.render("shell.overlay").tree;
  assert.ok(
    allNodes(pillTree).some((node) => node.props.className === "dshPomodoro_pill"),
    "collapsed renders the pill"
  );
  collapsed.teardownAll();

  const expanded = mountBundle();
  const cardTree = expanded.render("shell.overlay").tree;
  assert.ok(
    allNodes(cardTree).some((node) => node.props.className === "dshPomodoro_card"),
    "expanded renders the card"
  );
  expanded.teardownAll();
});

test("the expanded card shows the phase, the clock, the cycle and the controls", () => {
  const env = mountBundle({ locale: "en" });
  const { tree } = env.render("shell.overlay");
  assert.equal(textOfClass(tree, "dshPomodoro_phase"), "Focus");
  assert.equal(textOfClass(tree, "dshPomodoro_time"), "25:00");
  assert.equal(textOfClass(tree, "dshPomodoro_rounds"), "Round 0/4");
  const controls = findNode(tree, (node) => node.props.className === "dshPomodoro_controls");
  assert.equal(controls.children.length, 3);
  env.teardownAll();
});

test("the primary button offers Start, Pause and Resume", async () => {
  const primary = (env) => {
    const { tree } = env.render("shell.overlay");
    const controls = allNodes(tree).find((node) => node.props.className === "dshPomodoro_controls");
    assert.ok(controls, "the card must render its control row");
    const button = controls.children.find((child) => String(child.props.className).includes("btnPrimary"));
    return button.children.join("");
  };

  const fresh = mountBundle({ locale: "en" });
  assert.equal(primary(fresh), "Start");
  fresh.teardownAll();

  // The clock's state comes from the Host, so the seat has to have adopted it before
  // the label can reflect it.
  const running = mountBundle({ locale: "en", host: makeHost({ running: true }) });
  running.render("shell.overlay");
  await waitForHost(running);
  assert.equal(primary(running), "Pause");
  running.teardownAll();

  const paused = mountBundle({ locale: "en", host: makeHost({ running: false, remainingMs: 15 * 60000 }) });
  paused.render("shell.overlay");
  await waitForHost(paused);
  assert.equal(primary(paused), "Resume");
  paused.teardownAll();
});

test("with a reachable host the widget reports the host as the timer's owner", async () => {
  const host = makeHost({ running: true, remainingMs: 20 * 60000 });
  const env = mountBundle({ locale: "en", host });
  // Subscribing starts the first probe; wait for it to land.
  env.render("shell.overlay");
  await waitForHost(env);
  const { tree, t } = env.render("shell.overlay");
  assert.equal(textOfClass(tree, "dshPomodoro_badge"), t("hostBadge"));
  assert.equal(textOfClass(tree, "dshPomodoro_time"), "20:00");
  env.teardownAll();
});

test("with no reachable host the widget falls back to a local timer", async () => {
  const env = mountBundle({ locale: "en", host: null });
  env.render("shell.overlay");
  await until(() => env.fetchLog.length > 0, "the first failed probe");
  const { tree, t } = env.render("shell.overlay");
  assert.equal(textOfClass(tree, "dshPomodoro_badge"), t("localBadge"));
  // The local engine is armed at the default focus length.
  assert.equal(textOfClass(tree, "dshPomodoro_time"), "25:00");
  env.teardownAll();
});

test("a command goes to the host when it is reachable", async () => {
  const host = makeHost();
  const env = mountBundle({ locale: "en", host });
  env.render("shell.overlay");
  await waitForHost(env);

  const tree = env.render("shell.overlay").tree;
  const controls = findNode(tree, (node) => node.props.className === "dshPomodoro_controls");
  const skip = controls.children.find((child) => child.children.join("") === "Skip");
  skip.props.onClick();
  await until(() => host.commands.includes("skip"), "the skip command");
  assert.deepEqual(host.commands, ["skip"]);
  env.teardownAll();
});

test("a settings write goes to the host when it is reachable", async () => {
  const host = makeHost();
  const env = mountBundle({ locale: "en", host });
  env.render("settings.general.item");
  await waitForHost(env);

  const { tree } = env.render("settings.general.item");
  const inputs = allNodes(tree).filter((node) => node.props.className === "dshPomodoro_input");
  assert.equal(inputs.length, 4, "four numeric settings");

  inputs[0].props.onChange({ target: { value: "50" } });
  inputs[0].props.onBlur();
  await until(() => host.settingsWrites.length > 0, "the settings write");
  assert.deepEqual(host.settingsWrites[0], { focusMinutes: 50 });
  env.teardownAll();
});

test("a phase change detected on the host raises a desktop notification", async () => {
  const host = makeHost();
  host.state.settings.notify = true;
  const env = mountBundle({ locale: "en", host, notificationPermission: "granted" });
  env.render("shell.overlay");
  await waitForHost(env);

  // The host owns the transition; the page notices it on its next poll.
  Object.assign(host.state, { phase: "short", completedFocus: 1, focusSinceLong: 1, remainingMs: 5 * 60000, durationMs: 5 * 60000 });
  await until(() => env.notifications.length > 0, "the notification");
  assert.equal(env.notifications[0].title, "Focus finished");
  assert.equal(env.notifications[0].tag, "dsh-pomodoro");
  assert.ok(env.chimes.length > 0, "the chime accompanies it");
  env.teardownAll();
});

test("notifications stay silent when the setting is off", async () => {
  const host = makeHost();
  const env = mountBundle({ locale: "en", host, notificationPermission: "granted" });
  env.render("shell.overlay");
  await waitForHost(env);

  Object.assign(host.state, { phase: "short", remainingMs: 5 * 60000, durationMs: 5 * 60000 });
  await until(() => env.chimes.length > 0, "the chime");
  assert.equal(env.notifications.length, 0, "notify defaults to off");
  env.teardownAll();
});

test("enabling notifications asks for permission and stores the verdict", async () => {
  const host = makeHost();
  host.state.settings.notify = false;
  const env = mountBundle({ locale: "en", host, notificationPermission: "default", autoGrantNotification: "granted" });
  env.render("settings.general.item");
  await waitForHost(env);

  const { tree } = env.render("settings.general.item");
  const notifySwitch = allNodes(tree).find((node) => node.props.role === "switch" && node.props["aria-label"] === "Desktop notification");
  assert.ok(notifySwitch, "the notification switch must render");
  notifySwitch.props.onClick();
  await until(() => host.settingsWrites.some((patch) => patch.notify === true), "the notify write");
  env.teardownAll();
});

test("a denied notification permission is not stored as enabled", async () => {
  const host = makeHost();
  const env = mountBundle({ locale: "en", host, notificationPermission: "denied" });
  env.render("settings.general.item");
  await waitForHost(env);

  const { tree, t } = env.render("settings.general.item");
  const notifySwitch = allNodes(tree).find((node) => node.props.role === "switch" && node.props["aria-label"] === "Desktop notification");
  assert.ok(notifySwitch, "the notification switch must render");
  notifySwitch.props.onClick();
  await until(() => host.settingsWrites.length > 0, "the notify write");
  assert.equal(host.settingsWrites[0].notify, false, "a denied permission must not be persisted as on");
  const hints = allNodes(env.render("settings.general.item").tree)
    .filter((node) => node.props.className === "dshPomodoro_rowHint")
    .map((node) => node.children.join(""));
  assert.ok(hints.some((hint) => hint.includes("Blocked")), `the denied hint must render, got: ${hints.join(" | ")}`);
  void t;
  env.teardownAll();
});

test("teardown stops polling and releases the timers", async () => {
  const host = makeHost();
  const env = mountBundle({ locale: "en", host });
  env.render("shell.overlay");
  await until(() => env.fetchLog.length > 0, "the first poll");
  env.teardownAll();
  const seen = env.fetchLog.length;
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(env.fetchLog.length, seen, "no request may follow teardown");
  assert.equal(env.intervals.size, 0, "every polling interval must be cleared");
});

test("the snapshot is referentially stable, as useSyncExternalStore requires", async () => {
  // This is the one contract a rendered tree cannot show. Returning a fresh object per
  // call reads to React as "the store changed", so it re-renders, reads, sees a new
  // object again and loops until it throws — which marks the seat inactive. That
  // regression shipped once precisely because the harness only read the snapshot once.
  const host = makeHost({ running: true, remainingMs: 20 * 60000 });
  const env = mountBundle({ locale: "en", host });
  env.render("shell.overlay");
  await waitForHost(env);

  const controller = env.newController();
  controller.subscribe(() => {});
  // A second controller polls independently, so it has to reach host mode on its own.
  await until(() => controller.isHost(), "the second controller to adopt the host");

  const first = controller.snapshot();
  const second = controller.snapshot();
  assert.equal(first, second, "an unchanged host state must yield the identical object");
  assert.equal(first.source, "host");

  // Across a second boundary the view must change, or the clock would freeze.
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const later = controller.snapshot();
  assert.notEqual(later, first, "a new second must produce a new view");
  assert.ok(later.remainingMs <= first.remainingMs, "and the countdown must not go backwards");

  controller.dispose();
  env.teardownAll();
});

test("the local fallback snapshot is referentially stable too", async () => {
  const env = mountBundle({ locale: "en", host: null });
  env.render("shell.overlay");
  await until(() => env.fetchLog.length > 0, "the first failed probe");

  const controller = env.newController();
  controller.subscribe(() => {});
  const first = controller.snapshot();
  const second = controller.snapshot();
  assert.equal(first, second, "the local path must be stable as well");
  assert.equal(first.source, "local");
  controller.dispose();
  env.teardownAll();
});

test("the stylesheet only references declared tokens or supplies a fallback", () => {
  const env = mountBundle();
  const css = env.styleTags[0].textContent;
  const declared = new Set(
    fs
      .readFileSync(DECLARED_TOKENS, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
  );
  const problems = [];
  const pattern = /var\((--[a-z0-9-]+)\s*(,)?/g;
  let match;
  while ((match = pattern.exec(css)) !== null) {
    if (declared.has(match[1])) continue;
    if (match[2] === ",") continue; // a fallback makes an undocumented name safe
    if (match[1].startsWith("--dsh-pomodoro")) continue; // our own override hook
    problems.push(match[1]);
  }
  assert.deepEqual(problems, [], `undeclared tokens without fallback: ${problems.join(", ")}`);
  env.teardownAll();
});

test("the widget opts back into pointer events and escapes the overlay box", () => {
  const env = mountBundle();
  const css = env.styleTags[0].textContent;
  const start = css.indexOf(".dshPomodoro_root{");
  const root = css.slice(start, css.indexOf("}", start));
  assert.ok(root.includes("pointer-events:auto"));
  assert.ok(root.includes("position:fixed"));
  assert.ok(root.includes("--dsh-composer-height"), "the widget clears the composer band");
  env.teardownAll();
});

/**
 * Release every environment a case mounted, including after a failure. Without this a
 * failing assertion would leave the controller's poll interval running and the test
 * process would never exit.
 */
suite.afterEach = () => {
  flushRepaints();
  for (const environment of liveEnvironments) {
    try {
      environment.teardownAll();
    } catch (error) {
      /* a disposer failing must not mask the assertion that came before it */
    }
  }
  liveEnvironments.clear();
  pendingRepaints.clear();
};

/** Release anything else a suite left behind, so the process can exit. */
suite.after = () => {
  for (const handle of openTimers) clearTimeout(handle);
};

module.exports = suite;
