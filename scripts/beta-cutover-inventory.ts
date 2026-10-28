#!/usr/bin/env bun
/**
 * What the Beta cutover deletes, and what it must not.
 *
 * Walks the import graph from src/main.tsx twice: as it is today (both sides
 * of every `beta_ui` check reachable), and as it will be after the cutover —
 * the flag on for good, the Workshop pages the Beta replaced deleted, and any
 * panel a Beta screen still imports from one of them moved out first. The
 * difference is the deletion list. The modules the old UI uses that something
 * else still needs are listed apart, as "shared", so nobody deletes them on
 * the strength of a page having gone.
 *
 * The model lives in src/lib/betaCutover.ts (pure, tested); this file only
 * reads the tree and prints. Read-only: it never changes a file.
 *
 * Usage:
 *   bun scripts/beta-cutover-inventory.ts           Markdown report on stdout
 *   bun scripts/beta-cutover-inventory.ts --json    the whole inventory as JSON
 *
 * docs/design-sync/beta-cutover.md carries a copy of the report and the order
 * the cutover runs in. Re-run this after every merge that touches a page: the
 * copy in the doc is only as current as the commit it names.
 */
import { execSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { buildInventory, type Inventory, type KeepReason, type SurfaceCoverage } from '../src/lib/betaCutover';

const ROOT = join(import.meta.dir, '..');
/**
 * The trees the app and its tests are made of. Only `src/` is the app; the
 * others only import from it, so only their code is read.
 */
const TREES: ReadonlyArray<readonly [dir: string, assets: boolean]> = [['src', true], ['scripts', false], ['tests', false]];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-admin']);
/**
 * The wake-word Python trees. Their gitignored work data runs to gigabytes on
 * the Mac and holds whole cloned repositories, JavaScript included, none of
 * which imports the app: walking it would only cost time.
 */
const SKIP_PATHS = new Set(['scripts/train-wakeword', 'scripts/wakeword-backbone']);
const EXT = /\.(tsx?|jsx?|css)$/;

/**
 * Every code file and stylesheet under the trees, by repo path, with its
 * text. Under src/ any other file (an image, a JSON file) is listed too, with
 * no text, so `import logo from './logo.svg'` resolves to a file instead of
 * reading as a broken import.
 */
export function readTree(root: string = ROOT): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string, assets: boolean): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // a tree that does not exist in this checkout (tests/ is optional)
    }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      const full = join(dir, e.name);
      const path = relative(root, full).split(sep).join('/');
      if (SKIP_PATHS.has(path)) continue;
      if (e.isDirectory()) walk(full, assets);
      else if (e.isFile() && EXT.test(e.name)) out.set(path, readFileSync(full, 'utf8'));
      else if (e.isFile() && assets) out.set(path, '');
    }
  };
  for (const [dir, assets] of TREES) walk(join(root, dir), assets);
  return out;
}

// ── formatting ──────────────────────────────────────────────────────────────

const code = (s: string): string => `\`${s}\``;

const GROUPS: Array<[string, (p: string) => boolean]> = [
  ['Styles', (p) => p.endsWith('.css')],
  ['Pages', (p) => p.startsWith('src/pages/')],
  ['Components', (p) => p.startsWith('src/components/')],
  ['Hooks', (p) => p.startsWith('src/hooks/')],
  ['Lib', (p) => p.startsWith('src/lib/')],
  ['Other', () => true],
];

function grouped<T extends { path: string }>(items: readonly T[]): Array<[string, T[]]> {
  const out: Array<[string, T[]]> = GROUPS.map(([name]) => [name, []]);
  for (const it of items) {
    const i = GROUPS.findIndex(([, test]) => test(it.path));
    out[i][1].push(it);
  }
  return out.filter(([, list]) => list.length > 0);
}

function reasonText(r: KeepReason): string {
  if (r.kind === 'superseded') return `superseded by ${code(r.by)}: ${r.why}`;
  return `${r.kind === 'hero' ? 'Beta hero' : 'no Beta design'}: ${r.why}`;
}

function verdict(c: SurfaceCoverage): [string, string, string] {
  switch (c.kind) {
    case 'beta-page': return ['Beta page', '—', code(c.module)];
    case 'override': return [`override (${c.via})`, code(c.workshop), code(c.beta)];
    case 'kept': return ['keeps Workshop', code(c.workshop), reasonText(c.reason)];
    case 'missing': return ['**MISSING**', code(c.workshop), 'no Beta page, no override, not allow-listed'];
  }
}

const short = (list: readonly string[], n = 4): string =>
  list.length <= n ? list.map(code).join(', ') : `${list.slice(0, n).map(code).join(', ')} and ${list.length - n} more`;

export function formatMarkdown(inv: Inventory, commit: string): string {
  const L: string[] = [];
  const gone = inv.removable.length;
  L.push(`Generated by ${code('bun scripts/beta-cutover-inventory.ts')} at ${code(commit)}.`);
  L.push('');
  L.push(`From ${code(inv.root)}: **${inv.counts.now}** modules reachable today, **${inv.counts.after}** after the cutover, **${gone}** to delete.`);

  L.push('', '### Coverage: every surface and its Beta page', '');
  L.push('| Path | Verdict | Workshop page | Beta page, or why it stays |', '|---|---|---|---|');
  for (const c of inv.coverage) {
    const [v, w, b] = verdict(c);
    L.push(`| ${code(c.path)} | ${v} | ${w} | ${b} |`);
  }

  L.push('', '### Workshop pages the cutover deletes', '');
  L.push('| Workshop page | Path(s) | Replaced by |', '|---|---|---|');
  for (const r of inv.replaced) {
    const blocked = r.blocked ? ' **(blocked: something that stays imports the whole page)**' : '';
    L.push(`| ${code(r.page)}${blocked} | ${r.paths.map(code).join(', ')} | ${r.beta.map(code).join(', ')} |`);
  }

  L.push('', '### Workshop pages that stay', '');
  L.push('| Page | Path | Why |', '|---|---|---|');
  for (const k of inv.kept) L.push(`| ${code(k.page)} | ${code(k.path)} | ${reasonText(k.reason)} |`);

  L.push('', '### Blockers: code that stays and imports a page that goes', '');
  if (!inv.blockers.length) L.push('None.');
  for (const b of inv.blockers) {
    const what = b.whole ? 'the page itself' : b.names.map(code).join(', ');
    const kind = b.typeOnly ? ' (type only)' : '';
    const carries = b.carries.length ? `; they bring ${short(b.carries, 6)}` : '; they need no other module';
    L.push(`- ${code(`${b.from}:${b.line}`)} imports ${what}${kind} from ${code(b.page)}${b.whole ? ' — the page cannot be deleted until this changes' : carries}`);
  }

  L.push('', `### Only the old UI uses it: delete (${gone})`, '');
  L.push('"replaced page" is a Workshop page a Beta page took over; "old UI only" is imported only by modules that go; "flag branch" is imported only from the flag-off side of a check in a module that stays, so it goes with that check.');
  for (const [name, list] of grouped(inv.removable)) {
    L.push('', `**${name} (${list.length})**`, '');
    for (const m of list) L.push(`- ${code(m.path)} — ${m.why}${m.importers.length ? ` (from ${short(m.importers, 3)})` : ''}`);
  }

  L.push('', `### Shared: the old UI uses it, and so does code that stays — keep (${inv.shared.length})`, '');
  L.push('Only the boundary is listed: modules a deleted module imports directly. Everything behind them stays for the same reason.');
  for (const [name, list] of grouped(inv.shared)) {
    L.push('', `**${name} (${list.length})**`, '');
    for (const s of list) L.push(`- ${code(s.path)} — kept by ${s.keptImporters} module${s.keptImporters === 1 ? '' : 's'}; old importers ${short(s.oldImporters, 3)}`);
  }

  L.push('', '### Flag checks to remove', '');
  for (const s of inv.flagSites) L.push(`- ${code(`${s.file}:${s.line}`)} ${code(s.name)} — ${code(s.text)}`);
  L.push('', 'Imports that only a flag-off branch uses (they go with the check):', '');
  if (!inv.flagOffEdges.length) L.push('None.');
  for (const e of inv.flagOffEdges) L.push(`- ${code(`${e.from}:${e.line}`)} → ${code(e.to)}`);

  L.push('', '### npm packages only the old UI imports', '');
  L.push('Candidates for package.json once the modules are gone. Check tailwind.config.ts, vite.config.ts and postcss.config.js first: config files are not on this graph.', '');
  if (!inv.oldOnlyPackages.length) L.push('None.');
  for (const p of inv.oldOnlyPackages) L.push(`- ${code(p.name)} — ${short(p.usedBy, 3)}`);

  L.push('', '### Tests that import a module the cutover deletes', '');
  if (!inv.tests.length) L.push('None.');
  for (const t of inv.tests) L.push(`- ${code(t.file)} → ${short(t.imports, 4)}`);

  L.push('', '### Workshop stylesheets', '');
  L.push('main.tsx loads these for every screen, so the graph cannot drop them. A class counts as used when a module that stays contains its name as a word anywhere, so these numbers are an upper bound.', '');
  for (const s of inv.workshopCss) {
    L.push(`${code(s.sheet)}: ${s.classes} classes, ${s.usedAfter} still named by modules that stay.`, '');
    for (const m of s.byModule.slice(0, 25)) L.push(`- ${code(m.path)} — ${m.classes.length}: ${m.classes.slice(0, 10).join(' ')}${m.classes.length > 10 ? ' …' : ''}`);
    if (s.byModule.length > 25) L.push(`- and ${s.byModule.length - 25} more modules`);
  }

  L.push('', '### Unreachable today already (not part of the cutover)', '');
  if (!inv.deadToday.length) L.push('None.');
  for (const d of inv.deadToday) L.push(`- ${code(d.path)}${d.importedBy.length ? ` — imported only by ${short(d.importedBy, 3)}` : ' — imported by nothing'}`);

  if (inv.unresolved.length) {
    L.push('', '### Imports this walk could not resolve', '');
    for (const u of inv.unresolved) L.push(`- ${code(`${u.from}:${u.line}`)} ${code(u.spec)}`);
  }
  return L.join('\n');
}

function headCommit(): string {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return 'unknown commit';
  }
}

if (import.meta.main) {
  const inv = buildInventory(readTree());
  if (process.argv.includes('--json')) console.log(JSON.stringify(inv, null, 2));
  else console.log(formatMarkdown(inv, headCommit()));
}
