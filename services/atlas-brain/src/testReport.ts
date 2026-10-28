/**
 * What a `bun test` run reported, read from its own output — the coverage
 * figure and the per-file counts and durations the Beta dev tools show
 * (left-out features, rows 81 and 82). Pure, so it is tested against real
 * Bun output without running anything.
 *
 * The shapes this reads, from Bun 1.3.9 (and the same in the 1.4 samples the
 * cloud session took):
 *
 *   src/lib/a.test.ts:                      a file header, on stderr
 *   (pass) group > name [0.42ms]            one line per test; the time is
 *   (fail) name [1.20ms]                    absent on some lines, and Bun
 *   (skip) name                             prints none for a whole file
 *   (todo) name
 *   ----|---------|---------|----           the coverage table (--coverage)
 *   File | % Funcs | % Lines | Uncovered
 *   All files | 75.60 | 72.20 |
 *    259 pass                               the summary, singular and
 *    0 fail                                 plural; skip and todo only when
 *    836 expect() calls                     non-zero
 *   Ran 259 tests across 23 files. [3.55s]  ms below a second, s above
 *
 * Two traps the parser exists to avoid. A test's own console output lands
 * on stdout, so a line such as `noise.ts:` can look like a header — headers
 * therefore count only when they name a test file. And Bun prints only the
 * failures when it believes an AI agent runs it (CLAUDECODE or AI_AGENT in
 * the environment), so the caller drops those from the child's environment;
 * with them set, the per-file counts here would be failures only.
 */

export interface TestFileReport {
  /** As Bun printed it: relative to the directory the run started in. */
  path: string;
  pass: number;
  fail: number;
  skip: number;
  todo: number;
  /** The sum of the file's test times. Bun prints no per-file time; tests it printed no time for count as zero. */
  ms: number;
  /** The names of its failing tests, as Bun printed them (`group > name`). */
  failed: string[];
}

export interface CoverageFigure {
  /** "% Lines" of the All files row. */
  lines: number | null;
  /** "% Funcs" of the All files row. */
  funcs: number | null;
  /** Source files the table listed. */
  files: number;
}

export interface TestReport {
  totals: {
    pass: number;
    fail: number;
    skip: number;
    todo: number;
    /** Errors outside any test, when Bun counted them. */
    errors: number;
    tests: number;
    files: number;
    /** Bun's own wall time for the run, from its last line. */
    ms: number | null;
  };
  files: TestFileReport[];
  coverage: CoverageFigure | null;
}

/** Failing test names kept per file; the log keeps the rest. */
const FAILED_PER_FILE = 20;

// ESC [ … letter — colour codes, in case a run is ever forced to colour.
// Built from the char code so the source carries no control character.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g");

/** A header names a test file, the way Bun finds them: *.test.*, *_test.*, *.spec.*, *_spec.*. */
const HEADER = /^(\S(?:.*\S)?[._](?:test|spec)\.[cm]?[jt]sx?):$/;
const TEST_LINE = /^\((pass|fail|skip|todo)\) (.+?)(?: \[(\d+(?:\.\d+)?)(ms|s)\])?$/;
const COUNT_LINE = /^\s*(\d+) (pass|fail|skip|todo|errors?)$/;
const RAN_LINE = /^Ran (\d+) tests? across (\d+) files?\.(?: \[(\d+(?:\.\d+)?)(ms|s)\])?/;
const EXPECT_LINE = /^\s*\d+ expect\(\) calls?$/;
const RECAP = /^\d+ tests? (skipped|failed|todo)[^:]*:$/;
const TABLE_RULE = /^-+(?:\|-+)+\|?\s*$/;
const TABLE_HEAD = /^\s*File\s*\|/;
const TABLE_ROW = /^\s*\S.*\|\s*\d+(?:\.\d+)?\s*\|/;

const lines = (output: string): string[] => output.replace(ANSI, "").replace(/\r\n?/g, "\n").split("\n");

const toMs = (n: string, unit: string): number => (unit === "s" ? Number(n) * 1000 : Number(n));

const percent = (cell: string | undefined): number | null => {
  const n = cell == null ? NaN : Number.parseFloat(cell.trim());
  return Number.isFinite(n) ? n : null;
};

/**
 * The report in `output` (a bun test step's stderr, then its stdout), or
 * null when it holds no bun test run at all — a step that never got as far
 * as testing has nothing to report rather than a report of zeroes.
 */
export function parseBunTest(output: string): TestReport | null {
  const files: TestFileReport[] = [];
  let current: TestFileReport | null = null;
  const counts: Partial<Record<"pass" | "fail" | "skip" | "todo" | "errors", number>> = {};
  let ran: { tests: number; files: number; ms: number | null } | null = null;
  let columns: string[] | null = null;
  let coverage: CoverageFigure | null = null;
  let inTable = false;
  let recap = false;

  for (const line of lines(output)) {
    const header = HEADER.exec(line);
    if (header) {
      current = files.find((f) => f.path === header[1]) ?? null;
      if (!current) {
        current = { path: header[1], pass: 0, fail: 0, skip: 0, todo: 0, ms: 0, failed: [] };
        files.push(current);
      }
      inTable = false;
      recap = false;
      continue;
    }

    // "7 tests skipped:" — after the last file, Bun lists the skipped,
    // todo and failed tests again. Counted once already, under their files.
    if (RECAP.test(line)) {
      recap = true;
      current = null;
      continue;
    }

    const test = TEST_LINE.exec(line);
    if (test && recap) continue;
    if (test) {
      // A test line before any header still counts; it is filed under no file.
      if (!current) {
        current = { path: "", pass: 0, fail: 0, skip: 0, todo: 0, ms: 0, failed: [] };
        files.push(current);
      }
      const kind = test[1] as "pass" | "fail" | "skip" | "todo";
      current[kind] += 1;
      if (test[3]) current.ms += toMs(test[3], test[4]);
      if (kind === "fail" && current.failed.length < FAILED_PER_FILE) current.failed.push(test[2]);
      continue;
    }

    if (TABLE_HEAD.test(line)) {
      columns = line.split("|").map((c) => c.trim());
      coverage = { lines: null, funcs: null, files: 0 };
      inTable = true;
      continue;
    }
    if (inTable && coverage && columns) {
      if (TABLE_RULE.test(line)) continue;
      if (TABLE_ROW.test(line)) {
        const cells = line.split("|");
        if (cells[0].trim() === "All files") {
          const at = (name: string) => columns!.findIndex((c) => c.toLowerCase().includes(name));
          // Bun 1.3 prints % Funcs then % Lines; read them by name in case a
          // later Bun adds a column, by position when the names are missing.
          const li = at("line");
          const fi = at("func");
          coverage.lines = percent(cells[li > 0 ? li : 2]);
          coverage.funcs = percent(cells[fi > 0 ? fi : 1]);
        } else {
          coverage.files += 1;
        }
        continue;
      }
      inTable = false;
    }

    const count = COUNT_LINE.exec(line);
    if (count) {
      const key = count[2].startsWith("error") ? "errors" : (count[2] as "pass" | "fail" | "skip" | "todo");
      counts[key] = Number(count[1]);
      continue;
    }

    const r = RAN_LINE.exec(line);
    if (r) ran = { tests: Number(r[1]), files: Number(r[2]), ms: r[3] ? toMs(r[3], r[4]) : null };
  }

  if (!ran && files.length === 0) return null;

  // Bun's summary is the authority on the totals; the per-file lines are the
  // fallback when the run died before printing one.
  const sum = (k: "pass" | "fail" | "skip" | "todo") => counts[k] ?? files.reduce((n, f) => n + f[k], 0);
  const totals = {
    pass: sum("pass"),
    fail: sum("fail"),
    skip: sum("skip"),
    todo: sum("todo"),
    errors: counts.errors ?? 0,
    tests: 0,
    files: ran?.files ?? files.filter((f) => f.path).length,
    ms: ran?.ms ?? null,
  };
  totals.tests = ran?.tests ?? totals.pass + totals.fail + totals.skip + totals.todo;
  for (const f of files) f.ms = Math.round(f.ms * 100) / 100;
  return { totals, files, coverage: coverage && (coverage.lines != null || coverage.funcs != null) ? coverage : null };
}

/**
 * A bun test step's log as the dev tools store it: without the passing,
 * skipped and todo lines and without the coverage table. Both are in the
 * report, and the stored log keeps only its last 20 KB — on the app's own
 * suite the coverage table alone is bigger than that, so it would push every
 * failure out of the tail. What stays is what a failure needs: the file it
 * was in, its error and stack, the (fail) line, and the summary. A file
 * header stays only when something under it does.
 */
export function compactBunLog(output: string, report: TestReport | null): string {
  const out: string[] = [];
  let pendingHeader: string | null = null;
  let dropped = 0;
  let inTable = false;
  let recap = false;
  for (const line of lines(output)) {
    if (HEADER.test(line)) {
      pendingHeader = line;
      recap = false;
      continue;
    }
    // Bun's closing lists of skipped, todo and failed tests: the failed one
    // stays (it is every failure in one place, at the end where the tail
    // keeps it); the others repeat lines dropped already.
    const recapOf = RECAP.exec(line);
    if (recapOf) {
      recap = true;
      pendingHeader = null;
      if (recapOf[1] !== "failed") continue;
      out.push("", line);
      continue;
    }
    const test = TEST_LINE.exec(line);
    if (test && test[1] !== "fail") {
      if (!recap) dropped += 1;
      continue;
    }
    // The coverage table and the summary come after the last file, so they
    // end that file's section rather than belong to it.
    if (TABLE_RULE.test(line) || TABLE_HEAD.test(line)) {
      inTable = true;
      pendingHeader = null;
      continue;
    }
    if (inTable && TABLE_ROW.test(line)) continue;
    inTable = false;
    if (COUNT_LINE.test(line) || RAN_LINE.test(line) || EXPECT_LINE.test(line)) pendingHeader = null;
    if (pendingHeader !== null) {
      // A blank line before the next header is only spacing; it does not earn the header a place.
      if (line.trim() === "") continue;
      out.push("", pendingHeader);
      pendingHeader = null;
    }
    out.push(line);
  }
  const notes: string[] = [];
  if (dropped) notes.push(`${dropped} passing, skipped or todo ${dropped === 1 ? "test is" : "tests are"} counted in the report, not listed here.`);
  const cov = report?.coverage;
  if (cov) {
    notes.push(`Coverage, all files: ${cov.lines ?? "—"}% of lines, ${cov.funcs ?? "—"}% of functions, across ${cov.files} source files.`);
  }
  return [...notes, ...out].join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
