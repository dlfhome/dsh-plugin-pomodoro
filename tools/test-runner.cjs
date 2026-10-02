/**
 * The tiny test runner both suites use.
 *
 * `node --test` is not used here because `engine.test.cjs` lifts source text out of a
 * generated bundle before evaluating it, and this runner keeps each suite a plain
 * script with a short, readable report.
 *
 * Usage: node tools/test-runner.cjs [suiteFile...]
 */

const path = require("node:path");

/**
 * Run one suite module and report its cases.
 *
 * `afterEach` runs even when a case throws, so one failing test cannot leave a timer
 * or a subscription behind and keep the process alive — the failure mode that once
 * left an orphaned test process running.
 *
 * @param modulePath - absolute path to a suite exporting `cases`.
 * @returns the number of failures.
 */
async function runSuite(modulePath) {
  const suite = require(modulePath);
  const name = path.basename(modulePath);
  let failures = 0;

  for (const { name: caseName, fn } of suite.cases) {
    try {
      await fn();
      console.log(`PASS  ${name} :: ${caseName}`);
    } catch (error) {
      failures += 1;
      console.log(`FAIL  ${name} :: ${caseName}`);
      console.log(`      ${(error && error.message ? error.message : String(error)).split("\n").join("\n      ")}`);
    } finally {
      if (typeof suite.afterEach === "function") {
        try {
          await suite.afterEach();
        } catch (error) {
          failures += 1;
          console.log(`      afterEach failed: ${error.message}`);
        }
      }
    }
  }

  if (typeof suite.after === "function") await suite.after();
  console.log(`      ${suite.cases.length - failures}/${suite.cases.length} in ${name}`);
  return failures;
}

/**
 * Run every named suite, or every suite in this directory.
 * @param files - suite paths; defaults to the sibling `*.test.cjs` files.
 * @returns the total failure count.
 */
async function runAll(files) {
  const suites =
    files !== undefined && files.length > 0
      ? files.map((file) => path.resolve(file))
      : [path.join(__dirname, "engine.test.cjs"), path.join(__dirname, "browser.test.cjs")];

  let failures = 0;
  for (const suite of suites) failures += await runSuite(suite);

  console.log(failures === 0 ? "\nall tests passed" : `\n${failures} test(s) failed`);
  return failures;
}

/**
 * Collect cases in a suite module.
 * @returns the case list builder.
 */
function createSuite() {
  const cases = [];
  return {
    cases,
    /** Register one test case. */
    test(name, fn) {
      cases.push({ name, fn });
    },
  };
}

module.exports = { createSuite, runAll };

if (require.main === module) {
  runAll(process.argv.slice(2))
    .then((failures) => {
      process.exitCode = failures === 0 ? 0 : 1;
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
