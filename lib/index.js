/**
 * Node half of the Pomodoro clock: it OWNS the timer.
 *
 * The timer used to live entirely in the browser, which meant closing the page
 * stopped it. Now this half runs the engine on a real interval, persists to disk
 * under the Harness home, and answers a small HTTP surface the browser half polls.
 * Everything the user sees still comes from `lib/client.js`; this half is the
 * authority it reads.
 *
 * Why HTTP and not client→host RPC: a hand-authored plugin package cannot reach the
 * Host's Remote services. Those need generated Typert artifacts (`typert.host.js` /
 * `./remote`) produced by the repository build, which a plugin authored outside the
 * monorepo cannot emit. `ctx.webServer.register()` is the documented, first-party
 * surface for a plugin-owned route, and the page is served from that same origin, so
 * a route is both simpler and fully supported. If the route is unreachable, the
 * browser half falls back to running the identical engine locally, so the widget never
 * breaks — it only loses cross-window durability.
 *
 * Both halves run the same state machine: `src/engine.js` is imported here and inlined
 * into the browser bundle by `tools/build-client.cjs`.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEngine, LIMITS } from "../src/engine.js";

/** Path prefix this plugin claims on the Host's HTTP server. */
export const ROUTE_PREFIX = "/pomodoro";

/** Loader row name used in diagnostics and on the Plugins page. */
export const name = "pomodoro";

/**
 * The web server is a hard dependency of this half: the timer only reaches the browser
 * through it, and every shipped composition mounts `dsh-host-webserver`.
 *
 * The array form is the contract every shipped plugin uses. An object form has to spell
 * out the service map (`{ required: [], optional: [] }`); declaring ONLY
 * `{ optional: ["webServer"] }` makes the framework look for a service literally named
 * "optional", so the plugin never activates at all — which is the failure this line was
 * changed to fix.
 */
export const inject = ["webServer"];

/** Largest accepted command or settings body. */
const MAX_BODY_BYTES = 16 * 1024;

/** Commands the browser half may send. */
const COMMANDS = new Set(["start", "pause", "toggle", "skip", "reset", "resetStats", "refresh"]);

/** Settings keys the browser half may write. */
const SETTING_KEYS = new Set([...Object.keys(LIMITS), "autoAdvance", "sound", "notify", "collapsed"]);

/**
 * Where this plugin keeps its documents. `DSH_HOME` is the managed Harness home; the
 * fallback mirrors the documented default so a bare `node` run still works.
 * @returns the storage directory.
 */
function storageDirectory() {
  const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== "" ? process.env.DSH_HOME : path.join(os.homedir(), ".dsh");
  return path.join(home, "storages", "pomodoro");
}

/**
 * Read one JSON document, treating a missing or damaged file as absent rather than
 * failing the plugin: a corrupt timer state must never stop the Host from booting.
 * @param file - absolute path.
 * @param label - name used in the warning.
 * @param logger - Host logger, when available.
 * @returns the parsed value, or undefined.
 */
function readDocument(file, label, logger) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") logger?.warn("pomodoro: ignoring unreadable %s (%s)", label, error.message);
    return undefined;
  }
}

/**
 * Write one JSON document atomically (temp file plus rename) so a crash mid-write
 * cannot leave a half-written document behind.
 * @param file - absolute path.
 * @param value - value to serialize.
 */
function writeDocument(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(temporary, JSON.stringify(value), "utf8");
  fs.renameSync(temporary, file);
}

/**
 * Answer a request with JSON.
 * @param res - the response to own.
 * @param status - HTTP status code.
 * @param payload - JSON-serializable body.
 */
function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.length),
    // The clock changes every tick; a cached copy would render stale.
    "cache-control": "no-store",
  });
  res.end(body);
}

/**
 * Read and parse a JSON request body, refusing anything oversized or malformed.
 * @param req - the incoming request.
 * @returns the parsed value, or undefined when the body is unusable.
 */
async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return undefined;
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  } catch (error) {
    return undefined;
  }
}

/**
 * Decide whether a request comes from the page this Host serves.
 *
 * The route carries no authentication of its own — the webserver delegates request
 * policy to route owners — so this refuses a request whose `Host` names a different
 * server, which is what stops a random web page from driving the clock. Loopback
 * literals only, matching the webserver's own default bind.
 * @param req - the incoming request.
 * @returns true when the request may proceed.
 */
function isLocalRequest(req) {
  const host = req.headers.host;
  if (typeof host !== "string" || host === "") return false;
  const name = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
  return name === "127.0.0.1" || name === "localhost" || name === "[::1]";
}

/**
 * The view shape both GET /state and every POST answer with.
 * @param engine - the timer.
 * @returns the JSON payload.
 */
function statePayload(engine) {
  engine.refresh();
  const view = engine.getSnapshot();
  return {
    now: Date.now(),
    phase: view.phase,
    running: view.running,
    completedFocus: view.completedFocus,
    focusSinceLong: view.focusSinceLong,
    remainingMs: view.remainingMs,
    durationMs: view.durationMs,
    settings: view.settings,
  };
}

/**
 * Mount the timer and its HTTP surface.
 * @param ctx - Host root context.
 */
export function apply(ctx) {
  const logger = ctx.logger;
  const directory = storageDirectory();
  const stateFile = path.join(directory, "state.json");
  const settingsFile = path.join(directory, "settings.json");

  // Throttle disk writes. A running clock only changes its deadline on start, pause,
  // skip or a phase rollover, but those can arrive in bursts; at most one write per
  // second keeps the document current without turning a timer into a disk-bound loop.
  let lastWriteMs = 0;
  let lastState = null;

  const engine = createEngine(
    {
      now: () => Date.now(),
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (handle) => clearInterval(handle),
      persistSettings(settings) {
        try {
          writeDocument(settingsFile, settings);
        } catch (error) {
          logger?.warn("pomodoro: could not persist settings (%s)", error.message);
        }
      },
      persistState(state) {
        lastState = state;
        const now = Date.now();
        if (now - lastWriteMs < 1000) return;
        lastWriteMs = now;
        try {
          writeDocument(stateFile, state);
        } catch (error) {
          logger?.warn("pomodoro: could not persist timer state (%s)", error.message);
        }
      },
      onComplete(phase, finished) {
        logger?.info("pomodoro: %s finished, %s starts", finished, phase);
      },
    },
    {
      settings: readDocument(settingsFile, "settings", logger),
      state: readDocument(stateFile, "state", logger),
    },
  );

  // The Host keeps the clock honest with no browser attached: this is what makes a
  // closed page keep counting. It only settles deadlines; the browser ticks its own
  // display for smoothness.
  ctx.effect(() => {
    const handle = setInterval(() => engine.refresh(), 1000);
    return () => clearInterval(handle);
  }, "pomodoro: host tick");

  ctx.effect(
    () => () => {
      // Flush the exact state on unload, bypassing the write throttle.
      if (lastState !== null) {
        try {
          writeDocument(stateFile, lastState);
        } catch (error) {
          logger?.warn("pomodoro: could not flush timer state (%s)", error.message);
        }
      }
      engine.dispose();
    },
    "pomodoro: engine",
  );

  logger?.info("pomodoro: host owns the timer; documents in %s", directory);

  // The timer documents are the observable proof that this half is live: their
  // timestamps show when the Host last touched the clock. Writing an initial pair also
  // means a fresh install has a readable starting point instead of nothing.
  try {
    writeDocument(settingsFile, engine.getSnapshot().settings);
    writeDocument(stateFile, {
      phase: "focus",
      running: false,
      deadline: null,
      pausedRemainingMs: engine.getSnapshot().remainingMs,
      completedFocus: 0,
      focusSinceLong: 0,
    });
  } catch (error) {
    logger?.warn("pomodoro: could not seed documents (%s)", error.message);
  }

  // The route is optional: a composition without a web server (headless) still runs
  // the timer and simply has nothing to serve it to.
  ctx.inject(["webServer"], (webCtx) => {
    /**
     * One request against the plugin's surface. Every method funnels through here so
     * the request policy and the answer shape stay in one place.
     * @param req - incoming request.
     * @param res - response to own.
     */
    const handle = async (req, res) => {
      if (!isLocalRequest(req)) {
        sendJson(res, 403, { error: "pomodoro: route is loopback-only" });
        return;
      }

      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;

      try {
        if (req.method === "GET" && pathname === `${ROUTE_PREFIX}/ping`) {
          // Reachability probe: the browser half uses this to decide whether the host
          // owns the timer on this page.
          sendJson(res, 200, { ok: true, pid: process.pid });
          return;
        }

        if (req.method === "GET" && pathname === `${ROUTE_PREFIX}/state`) {
          sendJson(res, 200, statePayload(engine));
          return;
        }

        if (req.method === "POST" && pathname === `${ROUTE_PREFIX}/command`) {
          const body = await readJsonBody(req);
          if (body === undefined) {
            sendJson(res, 400, { error: "pomodoro: body must be a JSON object under 16 KiB" });
            return;
          }
          const command = body.command;
          if (typeof command !== "string" || !COMMANDS.has(command)) {
            sendJson(res, 400, { error: `pomodoro: unknown command ${JSON.stringify(command)}` });
            return;
          }
          engine[command]();
          sendJson(res, 200, statePayload(engine));
          return;
        }

        if (req.method === "POST" && pathname === `${ROUTE_PREFIX}/settings`) {
          const body = await readJsonBody(req);
          if (body === undefined || body.settings === null || typeof body.settings !== "object" || Array.isArray(body.settings)) {
            sendJson(res, 400, { error: "pomodoro: settings must be a JSON object" });
            return;
          }
          // Unknown names are refused rather than ignored, so a typo cannot look like
          // it worked; ranges are the engine's business.
          for (const key of Object.keys(body.settings)) {
            if (!SETTING_KEYS.has(key)) {
              sendJson(res, 400, { error: `pomodoro: unknown setting ${JSON.stringify(key)}` });
              return;
            }
          }
          engine.updateSettings(body.settings);
          sendJson(res, 200, statePayload(engine));
          return;
        }

        sendJson(res, 404, { error: "pomodoro: unknown route" });
      } catch (error) {
        logger?.warn("pomodoro: request failed (%s)", error.message);
        if (!res.headersSent) sendJson(res, 500, { error: "pomodoro: request failed" });
        else res.end();
      }
    };

    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: "prefix",
          path: ROUTE_PREFIX,
          handler: (req, res) => {
            void handle(req, res);
          },
        }),
      "pomodoro: http route",
    );
    logger?.info("pomodoro: serving %s", ROUTE_PREFIX);
  });
}
