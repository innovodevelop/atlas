import { describe, expect, test } from "bun:test";
import { parseVersionPlan } from "./versionPlan.ts";

describe("parseVersionPlan", () => {
  test("a feature marked in-progress parses as 'in-progress'", () => {
    // Regression test for the dead inner ternary: a feature could never
    // come out of parsing as 'in-progress' even when explicitly marked so.
    const md = `
## v0.3.0 — Admin Suite
Status: in-progress
Target: 2026-09-01

### Features
- [ ] Live agent view {id: feat-011, status: in-progress}
`;
    const versions = parseVersionPlan(md);
    expect(versions[0].features[0].status).toBe("in-progress");
  });

  test("a checked box parses as 'done'", () => {
    const md = `
## v0.2.0 — Foundation
Status: released
Target: 2026-08-04

### Features
- [x] Local-first migration complete {id: feat-001}
`;
    const versions = parseVersionPlan(md);
    expect(versions[0].features[0].status).toBe("done");
  });

  test("an unmarked feature defaults to 'planned'", () => {
    const md = `
## v0.4.0 — Mail & Voice
Status: planned
Target: 2026-10-01

### Features
- [ ] Mail sending (SES production access) {id: feat-021}
`;
    const versions = parseVersionPlan(md);
    expect(versions[0].features[0].status).toBe("planned");
  });

  test("features with no explicit id get stable ids that survive reordering", () => {
    const before = `
## v0.5.0 — Later
Status: planned

### Features
- [ ] First feature
- [ ] Second feature
`;
    const after = `
## v0.5.0 — Later
Status: planned

### Features
- [ ] Inserted feature
- [ ] First feature
- [ ] Second feature
`;
    const beforeIds = parseVersionPlan(before)[0].features.map((f) => f.id);
    const afterIds = parseVersionPlan(after)[0].features.map((f) => f.id);

    // Inserting a feature at the front must not change the ids of the
    // features that were already there — a length-based fallback would
    // renumber them, and since sync upserts by id, that rewrites the
    // wrong rows.
    expect(afterIds).toContain(beforeIds[0]);
    expect(afterIds).toContain(beforeIds[1]);
  });

  test("a malformed file yields an empty array rather than throwing", () => {
    const md = `
# Not a version heading

* [ ] wrong dash style, no id
Some prose with no structure at all.
`;
    expect(() => parseVersionPlan(md)).not.toThrow();
    expect(parseVersionPlan(md)).toEqual([]);
  });
});
