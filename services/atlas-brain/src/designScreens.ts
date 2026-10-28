/**
 * Design ⇄ code — which screen of the current design handoff has code, and
 * whether the design has moved since that code last did.
 *
 * The Beta dev tools (`Atlas Dev Tools Beta.dc.html`, "design ⇄ code") show
 * one row per screen with a state. Nothing recorded that: the manifest
 * (design/.sync-manifest.json) knows the bundle and its surfaces, not which
 * file implements which screen. The repo does, so the table is read from it:
 *
 *   - the screens are the `.dc.html` files in the manifest's `mirrorPath`;
 *   - each maps to the code that implements it: the Beta page by the naming
 *     convention (`Atlas Mail Beta.dc.html` → `BetaMail.tsx`) or one of the
 *     exceptions in SCREEN_CODE, else the Workshop page the handoff README's
 *     screen map says the Beta screen replaces;
 *   - the state compares the last change to each side (the newest commit, or
 *     now when the working tree has uncommitted edits): Beta code that moved
 *     after its design is "in sync"; a design that moved after its code is
 *     "design ahead"; a screen that still only has its Workshop page is
 *     "design ahead" too; one with no code at all is "new".
 *
 * "In sync" therefore means "the code moved after the design did", not that
 * anyone compared the two — the table says where to look, and nothing it
 * cannot read from the repo. Like every repo-reading admin route it needs a
 * source checkout (projectRoot.ts).
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve, sep } from "node:path";

export type ScreenState = "in-sync" | "design-ahead" | "new" | "reference";

export interface DesignScreen {
  /** "Mail", "Smart Home", "Guidelines". */
  name: string;
  /** Repo-relative path of the design file. */
  design: string;
  /** Repo-relative path of the code that implements the screen today, if any. */
  code: string | null;
  codeKind: "beta" | "workshop" | null;
  /** ISO time of the last change to each side; null when git does not know it. */
  designChangedAt: string | null;
  codeChangedAt: string | null;
  state: ScreenState;
}

export interface DesignScreensResult {
  /** The checkout the paths are relative to, so the app can reveal a file. */
  root: string;
  mirrorPath: string | null;
  bundle: string | null;
  checkedAt: string;
  screens: DesignScreen[];
  /** Why the table is empty or the dates are missing; null when all is well. */
  error: string | null;
}

interface ScreenCode {
  /** Tried before the naming convention. */
  beta?: string[];
  /** The Workshop page this screen replaces (README "Screen map"). */
  workshop?: string[];
  /** A reference sheet, not a screen: it shows its code but takes no state. */
  reference?: boolean;
}

const PAGES = "src/pages/atlas";
const HERO = "src/components/atlas/BetaScreenHero.tsx";

/**
 * Keyed by screen name. Only what the convention cannot say: where a Beta
 * screen's code is not `Beta<Name>.tsx`, and which Workshop page each one
 * replaces. A screen missing here still gets the convention.
 */
export const SCREEN_CODE: Readonly<Record<string, ScreenCode>> = {
  Guidelines: { beta: ["src/styles/beta.css"] },
  "Dock Explorations": { reference: true, beta: ["src/components/atlas/BetaDock.tsx"] },
  Dashboard: { beta: [`${PAGES}/BetaHome.tsx`], workshop: [`${PAGES}/AtlasDashboard.tsx`] },
  Widgets: { workshop: [`${PAGES}/AtlasWidgetCatalog.tsx`] },
  "Widget Screens": { beta: [`${PAGES}/widgets`] },
  Mail: { workshop: [`${PAGES}/AtlasMail.tsx`] },
  "Answer Views": { beta: [`${PAGES}/BetaAnswer.tsx`], workshop: [`${PAGES}/AtlasAnswerViews.tsx`] },
  Core: { beta: [HERO], workshop: [`${PAGES}/AtlasCoreScreen.tsx`] },
  Teach: { beta: [HERO], workshop: ["src/pages/AtlasTeach.tsx"] },
  Architecture: { beta: [HERO], workshop: ["src/pages/AtlasArchitecture.tsx"] },
  Money: { workshop: [`${PAGES}/AtlasBanking.tsx`] },
  Health: { workshop: [`${PAGES}/AtlasHealth.tsx`] },
  "Smart Home": { workshop: [`${PAGES}/AtlasSmartHome.tsx`] },
  Browser: { workshop: [`${PAGES}/AtlasBrowser.tsx`] },
  "Model Lab": { workshop: [`${PAGES}/AtlasModelLab.tsx`] },
  Settings: { workshop: [`${PAGES}/AtlasSettings.tsx`] },
  "Agent View": { workshop: [`${PAGES}/AtlasAgentView.tsx`] },
  "System Status": { workshop: [`${PAGES}/AtlasSystemStatus.tsx`] },
  "Dev Tools": { workshop: [`${PAGES}/AtlasTests.tsx`] },
  Entry: { workshop: ["src/pages/Auth.tsx"] },
};

/** "Atlas Mail Beta.dc.html" → "Mail"; "Atlas Beta Guidelines.dc.html" → "Guidelines". */
export function screenName(file: string): string {
  return file
    .replace(/\.dc\.html$/i, "")
    .replace(/^Atlas\s+/, "")
    .replace(/^Beta\s+/, "")
    .replace(/\s+Beta$/, "")
    .trim();
}

/** Where the code for a screen may be, in the order it is looked for. */
export function codeCandidates(name: string): { beta: string[]; workshop: string[]; reference: boolean } {
  const known = SCREEN_CODE[name] ?? {};
  const compact = name.replace(/[^A-Za-z0-9]/g, "");
  return {
    beta: [...(known.beta ?? []), `${PAGES}/Beta${compact}.tsx`, `src/pages/Beta${compact}.tsx`],
    workshop: known.workshop ?? [],
    reference: !!known.reference,
  };
}

const after = (a: string | null, b: string | null): boolean => {
  if (!a || !b) return false;
  return Date.parse(a) > Date.parse(b);
};

export function screenState(s: { reference: boolean; codeKind: DesignScreen["codeKind"]; designChangedAt: string | null; codeChangedAt: string | null }): ScreenState {
  if (s.reference) return "reference";
  if (!s.codeKind) return "new";
  if (s.codeKind === "workshop") return "design-ahead";
  return after(s.designChangedAt, s.codeChangedAt) ? "design-ahead" : "in-sync";
}

const RS = "\x1e";

/**
 * `git log --format=%x1e%cI --name-only` → the newest commit time per path.
 * Records come newest first, so the first time a path appears is its last
 * change.
 */
export function parseNameOnlyLog(raw: string): Map<string, string> {
  const dates = new Map<string, string>();
  for (const record of raw.split(RS)) {
    const lines = record.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2) continue;
    const [date, ...paths] = lines;
    for (const p of paths) if (!dates.has(p)) dates.set(p, date);
  }
  return dates;
}

/** `git status --porcelain=v1 -z` → the paths with uncommitted changes (rename sources skipped). */
export function parsePorcelain(raw: string): Set<string> {
  const dirty = new Set<string>();
  const entries = raw.split("\0");
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.length < 4) continue;
    dirty.add(e.slice(3));
    // A rename or copy is followed by its source path as its own entry.
    if (e[0] === "R" || e[0] === "C") i++;
  }
  return dirty;
}

/** A path's last change: its own, or the newest under it for a directory. */
export function lastChange(path: string, dates: ReadonlyMap<string, string>, dirty: ReadonlySet<string>, now: string): string | null {
  const prefix = `${path}/`;
  for (const d of dirty) if (d === path || d.startsWith(prefix)) return now;
  let best: string | null = dates.get(path) ?? null;
  for (const [p, d] of dates) if (p.startsWith(prefix) && (!best || Date.parse(d) > Date.parse(best))) best = d;
  return best;
}

function git(root: string, args: string[]): { ok: true; out: string } | { ok: false; error: string } {
  try {
    const proc = Bun.spawnSync(["git", "-C", root, "-c", "core.quotePath=false", ...args], { stdout: "pipe", stderr: "pipe" });
    if (proc.exitCode !== 0) return { ok: false, error: proc.stderr.toString().trim().slice(0, 200) || `git exited ${proc.exitCode}` };
    return { ok: true, out: proc.stdout.toString() };
  } catch (err) {
    return { ok: false, error: String(err).slice(0, 200) };
  }
}

// Enough history for any screen of a live handoff; a path untouched for
// longer simply has no date, which reads as "not known" rather than wrong.
const MAX_COMMITS = 3000;

export function readDesignScreens(root: string, now = new Date()): DesignScreensResult {
  const checkedAt = now.toISOString();
  const empty = (error: string, mirrorPath: string | null = null, bundle: string | null = null): DesignScreensResult =>
    ({ root, mirrorPath, bundle, checkedAt, screens: [], error });

  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(readFileSync(resolve(root, "design/.sync-manifest.json"), "utf8"));
  } catch (err) {
    return empty(`design/.sync-manifest.json unreadable: ${String(err).slice(0, 160)}`);
  }
  const bundle = typeof manifest.name === "string" ? manifest.name : typeof manifest.bundle === "string" ? manifest.bundle : null;
  const mirrorPath = typeof manifest.mirrorPath === "string" ? manifest.mirrorPath.replace(/\/+$/, "") : null;
  if (!mirrorPath) return empty("The manifest names no mirrorPath for the current bundle.", null, bundle);

  // The manifest is a repo file, but a path in it still must not reach
  // outside design/: it decides which directory this route lists.
  const designRoot = resolve(root, "design") + sep;
  const mirror = resolve(root, mirrorPath);
  if (!(mirror + sep).startsWith(designRoot)) return empty(`mirrorPath "${mirrorPath}" is outside design/.`, mirrorPath, bundle);
  if (!existsSync(mirror)) return empty(`${mirrorPath} is not in this checkout.`, mirrorPath, bundle);

  const files = readdirSync(mirror).filter((f) => f.endsWith(".dc.html")).sort((a, b) => a.localeCompare(b));
  const picked = files.map((file) => {
    const name = screenName(file);
    const c = codeCandidates(name);
    const beta = c.beta.find((p) => existsSync(resolve(root, p))) ?? null;
    const workshop = beta ? null : c.workshop.find((p) => existsSync(resolve(root, p))) ?? null;
    return { name, design: `${mirrorPath}/${file}`, code: beta ?? workshop, codeKind: beta ? "beta" as const : workshop ? "workshop" as const : null, reference: c.reference };
  });

  const paths = [...new Set(picked.flatMap((p) => (p.code ? [p.design, p.code] : [p.design])))];
  const log = git(root, ["log", `--max-count=${MAX_COMMITS}`, `--format=${RS}%cI`, "--name-only", "--", ...paths]);
  const status = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...paths]);
  const dates = log.ok ? parseNameOnlyLog(log.out) : new Map<string, string>();
  const dirty = status.ok ? parsePorcelain(status.out) : new Set<string>();

  const screens: DesignScreen[] = picked.map((p) => {
    const designChangedAt = lastChange(p.design, dates, dirty, checkedAt);
    const codeChangedAt = p.code ? lastChange(p.code, dates, dirty, checkedAt) : null;
    return {
      name: p.name,
      design: p.design,
      code: p.code,
      codeKind: p.codeKind,
      designChangedAt,
      codeChangedAt,
      state: screenState({ reference: p.reference, codeKind: p.codeKind, designChangedAt, codeChangedAt }),
    };
  });

  const error = !log.ok ? `git log failed, so no dates: ${log.error}` : null;
  return { root, mirrorPath, bundle, checkedAt, screens, error };
}
