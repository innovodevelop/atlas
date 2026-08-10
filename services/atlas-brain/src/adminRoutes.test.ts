// Does the admin route table actually reach the admin handlers?
//
// WHY THIS FILE EXISTS. `createAdminRoutes` returns an object of handlers and
// `index.ts` dispatches to them with a ladder of `url.pathname === "..."`
// checks. Nothing connected the two. `discoverTests` was written, documented,
// given a `requireUser` call and exported — and never routed, so the Discover
// button in AtlasTests.tsx POSTed to /admin/tests/discover and got a 404. Both
// halves looked finished in review, both type-checked, and the whole suite was
// green, because a handler nobody calls is indistinguishable from a handler
// nobody wrote a route for.
//
// This is the SECOND defect of exactly this shape found in one sitting; the
// other was the control-port client sending a header Rust never read. The
// common cause is a contract that lives in two files with nothing asserting
// they agree. So this test asserts the agreement directly: every exported
// handler must appear in index.ts's dispatch ladder.
//
// It reads index.ts as TEXT on purpose. Importing it would boot the server —
// spawn sidecars, open the database, bind a port — and the thing under test is
// the route table, not the runtime.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir);
const indexSource = readFileSync(join(SRC, "index.ts"), "utf8");
const adminSource = readFileSync(join(SRC, "adminRoutes.ts"), "utf8");

/**
 * The names in `createAdminRoutes`'s returned object literal.
 *
 * Parsed from the source rather than by calling the factory, which would need a
 * live database handle. The block is a plain `return { a, b, c };` of bare
 * identifiers, so a shorthand-property scan is exact here — and if that shape
 * ever changes, the guard below fails loudly instead of silently matching zero
 * handlers and passing.
 */
function exportedHandlers(): string[] {
  // Scan EVERY `return { ... };` in the file and keep the one whose body is
  // nothing but shorthand identifiers. Matching the first `return {` was my
  // own first attempt and it silently found zero handlers — adminRoutes.ts is
  // full of `return json({ ... })` — which made the assertions below vacuously
  // true. The parse guard test caught it; this comment is why it stays.
  const blocks = adminSource.matchAll(/return \{([\s\S]*?)\};/g);
  for (const block of blocks) {
    const names = block[1]
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (names.length > 0 && names.every((n) => /^[a-zA-Z][a-zA-Z0-9]*$/.test(n))) {
      return names;
    }
  }
  throw new Error("could not find the handler object in adminRoutes.ts");
}

describe("the admin route table", () => {
  test("the handler list parses (guards the parser itself)", () => {
    const handlers = exportedHandlers();
    // A parser that silently matched nothing would make every assertion below
    // vacuously true — the exact failure mode this file exists to prevent.
    expect(handlers.length).toBeGreaterThan(5);
    expect(handlers).toContain("syncVersionPlan");
    expect(handlers).toContain("discoverTests");
  });

  test("every exported handler is dispatched from index.ts", () => {
    const unrouted = exportedHandlers().filter((h) => !indexSource.includes(`admin.${h}(`));
    expect(unrouted).toEqual([]);
  });

  test("every admin path index.ts dispatches is under /admin/", () => {
    // A stray admin handler mounted on an unprefixed path would sit outside
    // whatever coarse gating the prefix earns it later.
    const lines = indexSource.split("\n").filter((l) => l.includes("admin."));
    for (const line of lines) {
      if (!line.includes("url.pathname")) continue;
      expect(line).toContain("/admin/");
    }
  });

  test("the discover route is registered as POST — the one that shipped missing", () => {
    // Named specifically rather than left to the generic check above: this is
    // the regression, and a test that names it explains itself in the failure.
    expect(indexSource).toContain('url.pathname === "/admin/tests/discover" && req.method === "POST"');
  });
});
