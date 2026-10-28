// Design ⇄ code (Beta dev tools): which screen of the handoff has code, and
// whether the design moved after it. Pure parts against plain data, then one
// read of this checkout's real handoff.
import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  codeCandidates, lastChange, parseNameOnlyLog, parsePorcelain, readDesignScreens, screenName, screenState,
} from "./designScreens.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("names and candidates", () => {
  test("the file name is the screen", () => {
    expect(screenName("Atlas Mail Beta.dc.html")).toBe("Mail");
    expect(screenName("Atlas Smart Home Beta.dc.html")).toBe("Smart Home");
    expect(screenName("Atlas Beta Guidelines.dc.html")).toBe("Guidelines");
    expect(screenName("Atlas Dock Explorations.dc.html")).toBe("Dock Explorations");
  });

  test("the convention, after the known exceptions", () => {
    expect(codeCandidates("Smart Home").beta).toEqual(["src/pages/atlas/BetaSmartHome.tsx", "src/pages/BetaSmartHome.tsx"]);
    expect(codeCandidates("Dashboard").beta[0]).toBe("src/pages/atlas/BetaHome.tsx");
    expect(codeCandidates("Dashboard").workshop).toEqual(["src/pages/atlas/AtlasDashboard.tsx"]);
    expect(codeCandidates("Dock Explorations").reference).toBe(true);
    expect(codeCandidates("Something New").workshop).toEqual([]);
  });
});

describe("screenState", () => {
  const at = (iso: string) => iso;
  test("Beta code that moved after its design is in sync; a design that moved after it is ahead", () => {
    expect(screenState({ reference: false, codeKind: "beta", designChangedAt: at("2026-10-27T10:00:00Z"), codeChangedAt: at("2026-10-27T12:00:00Z") })).toBe("in-sync");
    expect(screenState({ reference: false, codeKind: "beta", designChangedAt: at("2026-10-28T10:00:00Z"), codeChangedAt: at("2026-10-27T12:00:00Z") })).toBe("design-ahead");
  });
  test("only a Workshop page is design ahead; no code is new; a reference sheet takes no state", () => {
    expect(screenState({ reference: false, codeKind: "workshop", designChangedAt: null, codeChangedAt: null })).toBe("design-ahead");
    expect(screenState({ reference: false, codeKind: null, designChangedAt: null, codeChangedAt: null })).toBe("new");
    expect(screenState({ reference: true, codeKind: "beta", designChangedAt: null, codeChangedAt: null })).toBe("reference");
  });
});

describe("git output", () => {
  test("the newest commit per path wins", () => {
    const raw = "\x1e2026-10-28T09:00:00+01:00\n\nsrc/a.tsx\n\x1e2026-10-27T09:00:00+01:00\n\nsrc/a.tsx\ndesign/x/Atlas A Beta.dc.html\n";
    const dates = parseNameOnlyLog(raw);
    expect(dates.get("src/a.tsx")).toBe("2026-10-28T09:00:00+01:00");
    expect(dates.get("design/x/Atlas A Beta.dc.html")).toBe("2026-10-27T09:00:00+01:00");
  });

  test("porcelain paths, renames reported once", () => {
    const dirty = parsePorcelain(" M src/a.tsx\0?? src/pages/atlas/widgets/Weather.tsx\0R  src/new.tsx\0src/old.tsx\0");
    expect([...dirty]).toEqual(["src/a.tsx", "src/pages/atlas/widgets/Weather.tsx", "src/new.tsx"]);
  });

  test("a directory changes when anything under it does; uncommitted edits are now", () => {
    const dates = new Map([["src/pages/atlas/widgets/Weather.tsx", "2026-10-26T00:00:00Z"], ["src/pages/atlas/widgets/Focus.tsx", "2026-10-27T00:00:00Z"]]);
    expect(lastChange("src/pages/atlas/widgets", dates, new Set(), "NOW")).toBe("2026-10-27T00:00:00Z");
    expect(lastChange("src/pages/atlas/widgets", dates, new Set(["src/pages/atlas/widgets/New.tsx"]), "NOW")).toBe("NOW");
    expect(lastChange("src/missing.tsx", dates, new Set(), "NOW")).toBeNull();
  });
});

describe("readDesignScreens on this checkout", () => {
  test("every design file in the current handoff is a row, and the dev tools have their Beta page", () => {
    const r = readDesignScreens(ROOT);
    expect(r.mirrorPath).toBe("design/current/design_handoff_atlas_beta");
    expect(r.screens.length).toBeGreaterThan(20);
    const dev = r.screens.find((s) => s.name === "Dev Tools");
    expect(dev?.code).toBe("src/pages/atlas/BetaDevTools.tsx");
    expect(dev?.codeKind).toBe("beta");
    const mail = r.screens.find((s) => s.name === "Mail");
    expect(mail?.code).toBe("src/pages/atlas/BetaMail.tsx");
    for (const s of r.screens) expect(["in-sync", "design-ahead", "new", "reference"]).toContain(s.state);
  });
});
