/**
 * Verify the generated browser bundle and the Node half before installing anything.
 *
 * Checks that the bundle is up to date with its sources, parses, inlines the shared
 * engine exactly once, and that both files name the same route prefix and storage
 * keys. Wired into `npm test`, so a stale `lib/client.js` fails the suite rather than
 * shipping silently.
 *
 * Usage: node tools/check-build.cjs
 */

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const failures = [];

/** Record one check's outcome. */
function check(label, condition, detail) {
  if (condition) {
    console.log(`ok    ${label}`);
  } else {
    console.log(`FAIL  ${label}${detail === undefined ? "" : ` — ${detail}`}`);
    failures.push(label);
  }
}

const bundle = fs.readFileSync(path.join(ROOT, "lib", "client.js"), "utf8");
const engine = fs.readFileSync(path.join(ROOT, "src", "engine.js"), "utf8");
const host = fs.readFileSync(path.join(ROOT, "lib", "index.js"), "utf8");

// 1. Generated file freshness. Regenerating in memory must reproduce the file byte for
// byte; anything else means someone edited the artifact instead of its source.
let regenerated = null;
try {
  execFileSync(process.execPath, [path.join(ROOT, "tools", "build-client.cjs"), "--check"], { stdio: "pipe" });
  regenerated = "up to date";
} catch (error) {
  regenerated = error.stdout?.toString().trim() || error.message;
}
check("lib/client.js matches its sources", regenerated === "up to date", regenerated);

// 2. The bundle is valid JavaScript as a classic script.
try {
  new Function(bundle);
  check("lib/client.js parses", true);
} catch (error) {
  check("lib/client.js parses", false, error.message);
}

// 3. The engine is inlined exactly once, with no leftover marker or ESM syntax.
check("no placeholder marker remains", !bundle.includes("__ENGINE__"));
check("engine inlined exactly once", (bundle.match(/function createEngine\(/g) ?? []).length === 1);
check("no ESM export left in the bundle", !/^export /m.test(bundle));

// 4. Both halves agree on the contract values they must share.
check("engine exports the storage keys", /export const STORAGE_SETTINGS = "dsh\.pomodoro\.settings\.v1"/.test(engine));
check("bundle uses the shared storage keys", bundle.includes("STORAGE_SETTINGS") && bundle.includes("STORAGE_STATE"));

const routeMatch = host.match(/ROUTE_PREFIX = "([^"]+)"/);
check("host declares a route prefix", routeMatch !== null);
if (routeMatch !== null) {
  check("bundle polls the host route", bundle.includes(`"/pomodoro"`) || bundle.includes(`ROUTE = "${routeMatch[1]}"`), routeMatch[1]);
}

// 5. The host half's dependency declaration and route shape.
//
// `inject` must use the array form. An object form has to spell out the whole service
// map (`{ required: [], optional: [] }`); declaring only `{ optional: [...] }` makes the
// framework look for a service named "optional", and the plugin then never activates —
// invisible until you notice the Loader row sitting at `status: "inactive"`.
check("host route is a prefix route", host.includes('kind: "prefix"'));
check("host injects webServer in the array form", /export const inject = \["webServer"\]/.test(host));

// 6. Every relative import the host half makes must survive packaging. A `file:`
// dependency is installed as a physical copy filtered by `files`, so an import of a
// source file that `files` omits resolves fine in the repository and fails only in the
// installed copy — where the Loader row goes inactive with a bare resolution error.
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const allowlist = new Set(manifest.files ?? []);
const relativeImports = [...host.matchAll(/from\s+"(\.[^"]+)"/g)].map((match) => match[1]);
check("host half declares relative imports", relativeImports.length > 0, "expected at least one");
for (const specifier of relativeImports) {
  // Resolve against lib/, where the importing file lives, then describe it the way the
  // `files` list does (repository-relative, forward slashes).
  const resolved = path.relative(ROOT, path.resolve(ROOT, "lib", specifier)).split(path.sep).join("/");
  check(`packaging ships ${resolved}`, allowlist.has(resolved), "add it to package.json's files list");
}

console.log(failures.length === 0 ? "\nbuild checks passed" : `\n${failures.length} build check(s) failed`);
process.exitCode = failures.length === 0 ? 0 : 1;
