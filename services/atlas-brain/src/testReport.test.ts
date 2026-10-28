// The bun test reader, against output Bun 1.3.9 really printed: the app's
// own suite with --coverage (abridged), a small run with every kind of test
// line, and an error thrown between tests. Fixtures are copied from captured
// runs, not written from memory of the format.
import { describe, expect, test } from "bun:test";
import { compactBunLog, parseBunTest } from "./testReport.ts";

// stderr of `bun test --coverage tests/ ./src ./scripts supabase/functions/_shared`, abridged.
const APP = `tests/auth.spec.ts:
(pass) static — endpoint + payload shape > endpoint builder produces absolute https URLs on the auth origin [0.10ms]
(pass) static — endpoint + payload shape > package.json carries no Supabase dependencies [0.13ms]
(skip) live — rejection paths (no account created) > login with bogus credentials → 401 with a JSON error
(skip) live — rejection paths (no account created) > login with missing fields → 400

src/lib/betaHome.test.ts:
(pass) widgets > every id is unique [0.05ms]
(pass) packStage > packs in order [1.40ms]
(pass) packStage > drops what does not fit
-----------------------------------------------------|---------|---------|-------------------
File                                                 | % Funcs | % Lines | Uncovered Line #s
-----------------------------------------------------|---------|---------|-------------------
All files                                            |   45.67 |   56.08 |
 scripts/beta-cutover-inventory.ts                   |   13.33 |   29.20 | 56,86-91,95-96,100-104,109,112-186,190-193,199-201
 src/components/atlas-health/PersonalityPanel.tsx    |    0.00 |   36.36 | 51-127
 supabase/functions/_shared/providerRouting.ts       |    0.00 |   84.38 | 42-45
-----------------------------------------------------|---------|---------|-------------------

 1145 pass
 7 skip
 0 fail
 8824 expect() calls
Ran 1152 tests across 73 files. [16.85s]`;

// stdout of the same run: the tests' own logging.
const APP_STDOUT = `bun test v1.3.9 (cf6cdbbb)
[orchestrator] Processing chat for user: user-1
[orchestrator] Memories count: 2`;

// Every kind of line, a failure with its source excerpt, and console noise that looks like a header.
const SMALL_STDERR = `
a.test.ts:
(pass) add > adds [0.02ms]
(pass) add > slow [121.36ms]
(skip) add > skipped one
(todo) add > todo one
 9 | });
10 | test('fails', () => { expect(add(1, 1)).toBe(3); });
                                             ^
error: expect(received).toBe(expected)

Expected: 3
Received: 2

      at <anonymous> (/tmp/bunsample/a.test.ts:10:41)
(fail) fails [0.64ms]

sub/b.test.ts:
(pass) b passes
-----------|---------|---------|-------------------
File       | % Funcs | % Lines | Uncovered Line #s
-----------|---------|---------|-------------------
All files  |   50.00 |  100.00 |
 lib.ts    |   50.00 |  100.00 |
-----------|---------|---------|-------------------

 3 pass
 1 skip
 1 todo
 1 fail
 4 expect() calls
Ran 6 tests across 2 files. [129.00ms]`;
const SMALL_STDOUT = `bun test v1.3.9 (cf6cdbbb)
noise.ts:`;

describe("parseBunTest", () => {
  test("the app's own suite: totals from the summary, coverage from the All files row", () => {
    const r = parseBunTest(`${APP}\n${APP_STDOUT}`)!;
    expect(r.totals).toEqual({ pass: 1145, fail: 0, skip: 7, todo: 0, errors: 0, tests: 1152, files: 73, ms: 16_850 });
    expect(r.coverage).toEqual({ lines: 56.08, funcs: 45.67, files: 3 });
    expect(r.files.map((f) => f.path)).toEqual(["tests/auth.spec.ts", "src/lib/betaHome.test.ts"]);
    expect(r.files[0]).toMatchObject({ pass: 2, skip: 2, fail: 0, ms: 0.23 });
    // A test Bun printed no time for adds nothing to its file's time.
    expect(r.files[1]).toMatchObject({ pass: 3, ms: 1.45 });
  });

  test("per file: every kind of test line, the failing names, and the file time as the sum of its tests", () => {
    const r = parseBunTest(`${SMALL_STDERR}\n${SMALL_STDOUT}`)!;
    expect(r.files).toEqual([
      { path: "a.test.ts", pass: 2, fail: 1, skip: 1, todo: 1, ms: 122.02, failed: ["fails"] },
      { path: "sub/b.test.ts", pass: 1, fail: 0, skip: 0, todo: 0, ms: 0, failed: [] },
    ]);
    expect(r.totals).toEqual({ pass: 3, fail: 1, skip: 1, todo: 1, errors: 0, tests: 6, files: 2, ms: 129 });
    expect(r.coverage).toEqual({ lines: 100, funcs: 50, files: 1 });
  });

  test("Bun's closing lists of skipped and failed tests are not counted twice", () => {
    const r = parseBunTest(`a.test.ts:
(pass) one [1.00ms]
(skip) two
(fail) three [2.00ms]

b.test.ts:
(pass) four [1.00ms]

1 tests skipped:
(skip) two

1 tests failed:
(fail) three [2.00ms]

 2 pass
 1 skip
 1 fail
Ran 4 tests across 2 files. [9.00ms]`)!;
    expect(r.files).toEqual([
      { path: "a.test.ts", pass: 1, fail: 1, skip: 1, todo: 0, ms: 3, failed: ["three"] },
      { path: "b.test.ts", pass: 1, fail: 0, skip: 0, todo: 0, ms: 1, failed: [] },
    ]);
    const log = compactBunLog(`a.test.ts:\n(skip) two\n(fail) three [2.00ms]\n\n1 tests skipped:\n(skip) two\n\n1 tests failed:\n(fail) three [2.00ms]`, r);
    expect(log).toBe("1 passing, skipped or todo test is counted in the report, not listed here.\n\na.test.ts:\n(fail) three [2.00ms]\n\n1 tests failed:\n(fail) three [2.00ms]");
  });

  test("console output that ends in a colon is not a file header", () => {
    const r = parseBunTest(`${SMALL_STDOUT}\n${SMALL_STDERR}`)!;
    expect(r.files.map((f) => f.path)).toEqual(["a.test.ts", "sub/b.test.ts"]);
  });

  test("an error between tests is filed as the test Bun blamed it on", () => {
    const r = parseBunTest(`
c.test.ts:
3 | setTimeout(() => { throw new Error('boom between tests'); }, 0);
error: boom between tests
(fail) slow second [2.15ms]
(pass) after [22.05ms]

 1 pass
 1 fail
 1 expect() calls
Ran 2 tests across 1 file. [50.00ms]`)!;
    expect(r.files[0]).toMatchObject({ path: "c.test.ts", pass: 1, fail: 1, failed: ["slow second"] });
    expect(r.totals).toMatchObject({ tests: 2, files: 1, ms: 50 });
  });

  test("singular forms, seconds, and an errors line", () => {
    const r = parseBunTest(`x_test.ts:
(pass) one [1.20s]

 1 pass
 0 fail
 1 error
Ran 1 test across 1 file. [1.42s]`)!;
    expect(r.totals).toEqual({ pass: 1, fail: 0, skip: 0, todo: 0, errors: 1, tests: 1, files: 1, ms: 1420 });
    expect(r.files[0].ms).toBe(1200);
  });

  test("a run cut off before its summary still counts what it printed", () => {
    const r = parseBunTest("a.test.ts:\n(pass) one [1.00ms]\n(fail) two [2.00ms]")!;
    expect(r.totals).toMatchObject({ pass: 1, fail: 1, tests: 2, files: 1, ms: null });
    expect(r.coverage).toBeNull();
  });

  test("no bun test run at all is no report, not a report of zeroes", () => {
    expect(parseBunTest("")).toBeNull();
    expect(parseBunTest("$ eslint . && tsc -b --force\nerror TS2322: Type 'x' is not assignable")).toBeNull();
  });

  test("colour codes are ignored", () => {
    const esc = String.fromCharCode(27);
    const r = parseBunTest(`a.test.ts:\n${esc}[32m(pass)${esc}[0m one [1.00ms]\nRan 1 test across 1 file. [3.00ms]`)!;
    expect(r.files[0].pass).toBe(1);
  });

  test("failing names are capped per file", () => {
    const many = Array.from({ length: 30 }, (_, i) => `(fail) t${i} [1.00ms]`).join("\n");
    const r = parseBunTest(`a.test.ts:\n${many}`)!;
    expect(r.files[0].fail).toBe(30);
    expect(r.files[0].failed).toHaveLength(20);
  });
});

describe("compactBunLog", () => {
  test("keeps a failure whole and drops the passing lines and the coverage table", () => {
    const report = parseBunTest(SMALL_STDERR);
    const log = compactBunLog(SMALL_STDERR, report);
    expect(log).toContain("a.test.ts:");
    expect(log).toContain("error: expect(received).toBe(expected)");
    expect(log).toContain("(fail) fails [0.64ms]");
    expect(log).toContain("Ran 6 tests across 2 files. [129.00ms]");
    expect(log).not.toContain("(pass)");
    expect(log).not.toContain("(skip)");
    expect(log).not.toContain("% Funcs");
    expect(log).not.toContain("lib.ts    |");
    // A file with nothing left under it loses its header too.
    expect(log).not.toContain("sub/b.test.ts:");
    expect(log.startsWith("5 passing, skipped or todo tests are counted in the report, not listed here.\nCoverage, all files: 100% of lines, 50% of functions, across 1 source files.")).toBe(true);
  });

  test("a passing run of the app's suite shrinks to its notes and its summary", () => {
    const log = compactBunLog(APP, parseBunTest(APP));
    expect(log.length).toBeLessThan(APP.length / 3);
    expect(log).toContain("Coverage, all files: 56.08% of lines, 45.67% of functions, across 3 source files.");
    expect(log).toContain(" 1145 pass");
    expect(log).not.toContain("tests/auth.spec.ts:");
  });

  test("output with no bun test in it passes through", () => {
    expect(compactBunLog("$ tsc -b --force\nerror TS1005", null)).toBe("$ tsc -b --force\nerror TS1005");
  });
});
