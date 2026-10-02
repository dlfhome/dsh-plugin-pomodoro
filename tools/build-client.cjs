/**
 * Generate `lib/client.js` from `src/client.template.js` + `src/engine.js`.
 *
 * A hand-authored DSH client bundle may not `import` from its own package — the
 * browser resolves the factory's `require` against a frozen platform seed — so the
 * shared state machine cannot be a module the two halves both import at runtime.
 * Instead it has exactly one source file, and this script inlines that text into the
 * bundle. Editing `lib/client.js` by hand is therefore a mistake: the next build
 * overwrites it.
 *
 * Usage: node tools/build-client.cjs [--check]
 *   --check  fail instead of writing when lib/client.js is out of date
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const TEMPLATE = path.join(ROOT, "src", "client.template.js");
const ENGINE = path.join(ROOT, "src", "engine.js");
const OUTPUT = path.join(ROOT, "lib", "client.js");

// The placeholder sits alone on its own line in the template, so the plain token is
// unambiguous: the template's prose refers to it as "the engine marker" instead of
// repeating the literal.
const MARKER = "/*__ENGINE__*/";

/**
 * Strip module syntax so the engine text can live inside a classic function body.
 * Only whole-line `export` prefixes and the leading JSDoc `@typedef` comment syntax
 * are removed; nothing else in the file uses ESM.
 * @param source - engine source text.
 * @returns the inlinable text.
 */
function toInlinable(source) {
  if (/\bimport\b/.test(source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""))) {
    throw new Error("src/engine.js must not import anything: the browser bundle cannot resolve imports");
  }
  return source
    .split("\n")
    .map((line) => (line.startsWith("export ") ? line.slice("export ".length) : line))
    .join("\n");
}

function build() {
  const template = fs.readFileSync(TEMPLATE, "utf8");
  const engine = toInlinable(fs.readFileSync(ENGINE, "utf8"));

  if (!template.includes(MARKER)) throw new Error(`template is missing the engine marker ${MARKER} on its own line`);
  if (!engine.includes("function createEngine(")) throw new Error("engine source does not define createEngine()");

  const banner =
    "// GENERATED FILE — do not edit.\n" +
    "// Source: src/client.template.js + src/engine.js\n" +
    "// Build:  node tools/build-client.cjs\n";

  const generated = banner + template.replace(MARKER, engine.trimEnd());
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  return { generated, output: OUTPUT };
}

const { generated, output } = build();
const checkOnly = process.argv.includes("--check");
const existing = fs.existsSync(output) ? fs.readFileSync(output, "utf8") : null;

if (checkOnly) {
  if (existing === generated) {
    console.log(`lib/client.js is up to date (${generated.length} chars)`);
    process.exit(0);
  }
  console.error("lib/client.js is NOT up to date — run: node tools/build-client.cjs");
  process.exit(1);
}

fs.writeFileSync(output, generated, "utf8");
console.log(`wrote ${path.relative(ROOT, output)} (${generated.length} chars; engine inlined from src/engine.js)`);
