/**
 * The Beta cutover, worked out from source text.
 *
 * Phase 8 ends with `beta_ui` on by default and the Workshop screens the Beta
 * replaced deleted (docs/design-sync/beta-cutover.md has the order). Two
 * questions decide whether that day is mechanical, and both are answered here:
 *
 *   1. COVERAGE — does every surface in the registry have a Beta page, either
 *      as its own loader or as an override in App.tsx? A surface that lands
 *      without one would quietly keep a Workshop screen alive after the flag
 *      goes. `src/betaCutover.test.ts` turns this into a guard.
 *   2. INVENTORY — once the replaced Workshop pages are gone, which modules
 *      does nothing reach any more, and which of the things they used must
 *      stay because a Beta screen uses them too? `scripts/beta-cutover-
 *      inventory.ts` prints the answer.
 *
 * ── WHY SOURCE TEXT, AND WHY THE TYPESCRIPT PARSER ─────────────────────────
 *
 * Importing the pages to ask them would pull React DOM, three canvas engines
 * and every stylesheet into a test with no DOM, which is the argument
 * `surfaces.test.ts` already makes. Regexes are not enough for an import
 * graph, though: App.tsx and AppRoutes.tsx both carry `lazy(() => import(…))`
 * inside comments, and a comment that names a page is not an edge. The
 * compiler's own parser knows the difference, costs nothing to ship (it is
 * already a dev dependency for `tsc`) and is never reached by the app, since
 * nothing on the app's import graph imports this module.
 *
 * Everything below is pure: callers hand in file text keyed by repo-relative
 * path (`src/pages/atlas/AtlasMail.tsx`), and nothing here reads the disk.
 */
import ts from 'typescript';

// ── paths ──────────────────────────────────────────────────────────────────

/** `src/a/../b/./c` → `src/b/c`. Repo-relative, forward slashes, no leading `./`. */
export function normalizePath(p: string): string {
  const out: string[] = [];
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

const dirOf = (p: string): string => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const baseOf = (p: string): string => p.slice(p.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');

export const isCodeFile = (p: string): boolean => /\.(tsx?|jsx?)$/.test(p) && !p.endsWith('.d.ts');
export const isTestFile = (p: string): boolean => /\.(test|spec)\.[jt]sx?$/.test(p);

/** A page module is a Beta page by name: every Beta screen so far is `Beta<Name>.tsx`. */
export const isBetaModule = (specOrPath: string): boolean => /^Beta[A-Z]/.test(baseOf(specOrPath));

// ── parsing one module ─────────────────────────────────────────────────────

export interface ImportBinding {
  /** The name on the far side: `default`, `*`, or the exported name. */
  readonly imported: string;
  /** The name in this file (for a re-export, the name it is exported under). */
  readonly local: string;
  readonly typeOnly: boolean;
}

export interface ModuleImport {
  readonly spec: string;
  /** 1-based line of the import, for the report. */
  readonly line: number;
  /** `import('…')` rather than a declaration. */
  readonly dynamic: boolean;
  /** `export … from '…'`. */
  readonly reexport: boolean;
  /** `import '…'` with no bindings: a stylesheet, or a module run for its effect. */
  readonly sideEffect: boolean;
  /**
   * Erased by the build: `import type`, `export type`, or every binding marked
   * `type`. Still an edge for the cutover, because deleting the target breaks
   * the typecheck even though it never broke the bundle.
   */
  readonly typeOnly: boolean;
  readonly bindings: readonly ImportBinding[];
  /**
   * Every use of this import sits in a branch that only runs while the
   * `beta_ui` flag is OFF (`isBetaUi() ? beta : workshop`, `if (!isBetaUi())`,
   * …). With the flag assumed on, the edge goes away with the flag check.
   */
  readonly flagOffOnly: boolean;
}

/** A use of something `src/lib/betaFlag.ts` exports: one line of the "remove the flag checks" step. */
export interface FlagSite {
  readonly line: number;
  readonly name: string;
  readonly text: string;
}

export interface ParsedModule {
  readonly imports: readonly ModuleImport[];
  readonly flagSites: readonly FlagSite[];
  /** Lines with an `import(…)` whose argument is not a literal (never resolvable statically). */
  readonly opaqueDynamic: readonly number[];
}

function scriptKind(file: string): ts.ScriptKind {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (file.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (/\.m?js$/.test(file)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

const sourceOf = (file: string, text: string): ts.SourceFile =>
  ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));

const FLAG_MODULE = /(^|\/)betaFlag(\.ts)?$/;
const FLAG_READERS = new Set(['isBetaUi', 'useBetaUi']);

/**
 * What a flag check looks like in this file: the local names `isBetaUi` and
 * `useBetaUi` were imported under, plus any `const beta = useBetaUi()` that
 * holds the answer (AppRoutes and BetaSchool both do that).
 */
interface FlagReading {
  readonly locals: ReadonlySet<string>;
  /** `'on'` when the expression is truthy exactly while the flag is on, `'off'` for the negation. */
  readonly valueOf: (e: ts.Expression) => 'on' | 'off' | null;
}

function flagReading(sf: ts.SourceFile): FlagReading {
  const readers = new Set<string>();
  const locals = new Set<string>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    if (!FLAG_MODULE.test(st.moduleSpecifier.text)) continue;
    const nb = st.importClause?.namedBindings;
    if (!nb || !ts.isNamedImports(nb)) continue;
    for (const el of nb.elements) {
      locals.add(el.name.text);
      if (FLAG_READERS.has((el.propertyName ?? el.name).text)) readers.add(el.name.text);
    }
  }
  const aliases = new Set<string>();
  const isReaderCall = (e: ts.Expression | undefined): boolean =>
    !!e && ts.isCallExpression(e) && ts.isIdentifier(e.expression) && readers.has(e.expression.text);
  if (readers.size) {
    const visit = (n: ts.Node): void => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && isReaderCall(n.initializer)) aliases.add(n.name.text);
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  const valueOf = (e: ts.Expression): 'on' | 'off' | null => {
    let x = e;
    while (ts.isParenthesizedExpression(x)) x = x.expression;
    if (ts.isPrefixUnaryExpression(x) && x.operator === ts.SyntaxKind.ExclamationToken) {
      const inner = valueOf(x.operand);
      return inner === 'on' ? 'off' : inner === 'off' ? 'on' : null;
    }
    if (isReaderCall(x)) return 'on';
    if (ts.isIdentifier(x) && aliases.has(x.text)) return 'on';
    return null;
  };
  return { locals, valueOf };
}

/** Source ranges that only run while the flag is off. */
function flagOffRanges(sf: ts.SourceFile, flag: FlagReading): Array<readonly [number, number]> {
  const ranges: Array<readonly [number, number]> = [];
  const off = (n: ts.Node | undefined): void => {
    if (n) ranges.push([n.getStart(sf), n.getEnd()]);
  };
  const visit = (n: ts.Node): void => {
    if (ts.isConditionalExpression(n)) {
      const v = flag.valueOf(n.condition);
      if (v === 'on') off(n.whenFalse);
      else if (v === 'off') off(n.whenTrue);
    } else if (ts.isIfStatement(n)) {
      const v = flag.valueOf(n.expression);
      if (v === 'on') off(n.elseStatement);
      else if (v === 'off') off(n.thenStatement);
    } else if (ts.isBinaryExpression(n)) {
      const v = flag.valueOf(n.left);
      // `!isBetaUi() && x` and `isBetaUi() || x` both evaluate x only with the flag off.
      if (n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && v === 'off') off(n.right);
      if (n.operatorToken.kind === ts.SyntaxKind.BarBarToken && v === 'on') off(n.right);
    }
    ts.forEachChild(n, visit);
  };
  if (flag.locals.size) visit(sf);
  return ranges;
}

/**
 * True when this identifier USES a binding rather than naming a property or
 * declaring something of the same name. Errs towards "uses": a false use only
 * keeps an edge alive, which keeps a module off the deletion list. A false
 * "not used" would put a live module on it.
 */
function isUse(id: ts.Identifier): boolean {
  const p = id.parent;
  if (ts.isPropertyAccessExpression(p) && p.name === id) return false;
  if (ts.isQualifiedName(p) && p.right === id) return false;
  if (ts.isJsxAttribute(p) && p.name === id) return false;
  if (ts.isBindingElement(p) && p.propertyName === id) return false;
  if (
    (ts.isPropertyAssignment(p) || ts.isPropertySignature(p) || ts.isPropertyDeclaration(p) ||
      ts.isMethodDeclaration(p) || ts.isMethodSignature(p) || ts.isEnumMember(p) ||
      ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p)) &&
    p.name === id
  ) return false;
  if (
    (ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isFunctionDeclaration(p) ||
      ts.isClassDeclaration(p) || ts.isBindingElement(p) || ts.isTypeAliasDeclaration(p) ||
      ts.isInterfaceDeclaration(p)) &&
    p.name === id
  ) return false;
  return true;
}

/** Imports, re-exports and literal `import()` calls of one TS/TSX module, plus its flag checks. */
export function parseModule(file: string, text: string): ParsedModule {
  if (file.endsWith('.css')) return parseCss(text);
  const sf = sourceOf(file, text);
  const lineOf = (n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const flag = flagReading(sf);
  const offRanges = flagOffRanges(sf, flag);
  const inOff = (n: ts.Node): boolean => {
    const at = n.getStart(sf);
    return offRanges.some(([s, e]) => at >= s && at < e);
  };

  interface Draft extends Omit<ModuleImport, 'flagOffOnly'> { node: ts.Node }
  const drafts: Draft[] = [];
  const clauses = new Set<ts.Node>();

  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      clauses.add(st);
      const clause = st.importClause;
      const bindings: ImportBinding[] = [];
      if (clause?.name) bindings.push({ imported: 'default', local: clause.name.text, typeOnly: clause.isTypeOnly });
      const nb = clause?.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) bindings.push({ imported: '*', local: nb.name.text, typeOnly: !!clause?.isTypeOnly });
      if (nb && ts.isNamedImports(nb)) {
        for (const el of nb.elements) {
          bindings.push({ imported: (el.propertyName ?? el.name).text, local: el.name.text, typeOnly: !!clause?.isTypeOnly || el.isTypeOnly });
        }
      }
      drafts.push({
        spec: st.moduleSpecifier.text, line: lineOf(st), dynamic: false, reexport: false,
        sideEffect: !clause, typeOnly: bindings.length > 0 && bindings.every((b) => b.typeOnly), bindings, node: st,
      });
    } else if (ts.isExportDeclaration(st) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
      clauses.add(st);
      const ec = st.exportClause;
      const bindings: ImportBinding[] = !ec
        ? [{ imported: '*', local: '*', typeOnly: st.isTypeOnly }]
        : ts.isNamespaceExport(ec)
          ? [{ imported: '*', local: ec.name.text, typeOnly: st.isTypeOnly }]
          : ec.elements.map((el) => ({ imported: (el.propertyName ?? el.name).text, local: el.name.text, typeOnly: st.isTypeOnly || el.isTypeOnly }));
      drafts.push({
        spec: st.moduleSpecifier.text, line: lineOf(st), dynamic: false, reexport: true,
        sideEffect: false, typeOnly: bindings.every((b) => b.typeOnly), bindings, node: st,
      });
    }
  }

  const opaqueDynamic: number[] = [];
  const uses = new Map<string, { all: number; off: number }>();
  const flagSites: FlagSite[] = [];
  const lines = text.split('\n');
  const importedLocals = new Set(drafts.filter((d) => !d.reexport).flatMap((d) => d.bindings.map((b) => b.local)));

  const visit = (n: ts.Node): void => {
    if (clauses.has(n)) return;
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = n.arguments[0];
      if (arg && ts.isStringLiteralLike(arg)) {
        drafts.push({ spec: arg.text, line: lineOf(n), dynamic: true, reexport: false, sideEffect: false, typeOnly: false, bindings: [], node: n });
      } else {
        opaqueDynamic.push(lineOf(n));
      }
    }
    if (ts.isIdentifier(n) && isUse(n)) {
      if (importedLocals.has(n.text)) {
        const u = uses.get(n.text) ?? { all: 0, off: 0 };
        u.all += 1;
        if (inOff(n)) u.off += 1;
        uses.set(n.text, u);
      }
      if (flag.locals.has(n.text)) {
        const line = lineOf(n);
        flagSites.push({ line, name: n.text, text: (lines[line - 1] ?? '').trim().slice(0, 160) });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);

  const imports: ModuleImport[] = drafts.map(({ node, ...d }) => {
    let flagOffOnly = false;
    if (d.dynamic) flagOffOnly = inOff(node);
    else if (!d.reexport && d.bindings.length) {
      const counts = d.bindings.map((b) => uses.get(b.local) ?? { all: 0, off: 0 });
      const all = counts.reduce((s, c) => s + c.all, 0);
      flagOffOnly = all > 0 && counts.every((c) => c.all === c.off);
    }
    return { ...d, flagOffOnly };
  });

  return { imports, flagSites, opaqueDynamic };
}

/** `@import` in a stylesheet. No Atlas stylesheet uses one today; this keeps it that way honestly. */
function parseCss(text: string): ParsedModule {
  const imports: ModuleImport[] = [];
  const re = /@import\s+(?:url\()?\s*['"]([^'"]+)['"]/g;
  for (const m of text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' ')).matchAll(re)) {
    const line = text.slice(0, m.index).split('\n').length;
    imports.push({ spec: m[1], line, dynamic: false, reexport: false, sideEffect: true, typeOnly: false, bindings: [], flagOffOnly: false });
  }
  return { imports, flagSites: [], opaqueDynamic: [] };
}

/** Class names a stylesheet defines, read from selectors only (never from declaration values). */
export function cssClasses(text: string): string[] {
  const bare = text.replace(/\/\*[\s\S]*?\*\//g, ' ');
  const out = new Set<string>();
  for (const m of bare.matchAll(/([^{}]+)\{/g)) {
    const prelude = m[1];
    if (prelude.trim().startsWith('@')) continue;
    for (const c of prelude.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)) out.add(c[1]);
  }
  return [...out].sort();
}

/** Every word-ish token in a source file, so a class lookup is a set probe instead of a scan. */
export const sourceTokens = (text: string): Set<string> => new Set(text.match(/[A-Za-z_][\w-]*/g) ?? []);

// ── what moves with an export ──────────────────────────────────────────────

export interface ExportClosure {
  /** Import specifiers the named exports need, directly or through local helpers. */
  readonly specs: readonly string[];
  /** The page itself (`default` or `*`) is wanted, so nothing can be moved out: the file stays. */
  readonly whole: boolean;
  /** Names asked for that this file does not declare at top level. */
  readonly unknown: readonly string[];
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((el) => (ts.isOmittedExpression(el) ? [] : bindingNames(el.name)));
}

/**
 * What a Beta screen drags along when it imports `names` from a Workshop page.
 *
 * BetaHealth imports three panels from AtlasHealth; deleting AtlasHealth means
 * moving those panels first, and the panels bring whatever they reference —
 * local helpers, constants, and through them other imports. This follows the
 * top-level declarations each name reaches and returns the imports at the end
 * of that walk. It over-approximates (a local variable that shadows a top-level
 * name counts as a use), which errs towards keeping a module, never towards
 * listing a live one for deletion.
 */
export function exportClosure(file: string, text: string, names: readonly string[]): ExportClosure {
  const sf = sourceOf(file, text);
  const importLocals = new Map<string, string>();
  const decls = new Map<string, ts.Node[]>();
  const exportAs = new Map<string, string>();
  const allSpecs: string[] = [];
  const add = (name: string, node: ts.Node): void => {
    decls.set(name, [...(decls.get(name) ?? []), node]);
  };

  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      const spec = st.moduleSpecifier.text;
      allSpecs.push(spec);
      const clause = st.importClause;
      if (clause?.name) importLocals.set(clause.name.text, spec);
      const nb = clause?.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) importLocals.set(nb.name.text, spec);
      if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) importLocals.set(el.name.text, spec);
    } else if (
      (ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isTypeAliasDeclaration(st) ||
        ts.isInterfaceDeclaration(st) || ts.isEnumDeclaration(st)) && st.name
    ) {
      add(st.name.text, st);
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) for (const n of bindingNames(d.name)) add(n, d);
    } else if (ts.isExportDeclaration(st) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
      allSpecs.push(st.moduleSpecifier.text);
      const ec = st.exportClause;
      if (ec && ts.isNamedExports(ec)) for (const el of ec.elements) importLocals.set(el.name.text, st.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(st) && st.exportClause && ts.isNamedExports(st.exportClause)) {
      for (const el of st.exportClause.elements) if (el.propertyName) exportAs.set(el.name.text, el.propertyName.text);
    }
  }

  if (names.some((n) => n === 'default' || n === '*')) {
    return { specs: [...new Set(allSpecs)].sort(), whole: true, unknown: [] };
  }

  const specs = new Set<string>();
  const unknown: string[] = [];
  const seen = new Set<string>();
  const queue = names.map((n) => exportAs.get(n) ?? n);
  while (queue.length) {
    const name = queue.shift() as string;
    if (seen.has(name)) continue;
    seen.add(name);
    const fromImport = importLocals.get(name);
    if (fromImport !== undefined) { specs.add(fromImport); continue; }
    const nodes = decls.get(name);
    if (!nodes) { unknown.push(name); continue; }
    const walk = (n: ts.Node): void => {
      if (ts.isIdentifier(n) && isUse(n)) {
        const spec = importLocals.get(n.text);
        if (spec !== undefined) specs.add(spec);
        else if (decls.has(n.text) && !seen.has(n.text)) queue.push(n.text);
      }
      ts.forEachChild(n, walk);
    };
    for (const node of nodes) walk(node);
  }
  return { specs: [...specs].sort(), whole: false, unknown };
}

// ── resolution and the graph ───────────────────────────────────────────────

export type Resolved =
  | { readonly kind: 'module'; readonly path: string }
  | { readonly kind: 'package'; readonly name: string }
  | { readonly kind: 'asset' }
  | { readonly kind: 'unresolved' };

const TRY_SUFFIXES = ['', '.ts', '.tsx', '.js', '.jsx', '.css', '/index.ts', '/index.tsx', '/index.js'];

/** `@scope/pkg/sub` → `@scope/pkg`, `pkg/sub` → `pkg`, `node:fs` stays. */
export function packageName(spec: string): string {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** Resolve a specifier the way Vite and tsconfig.app.json do for this repo (`@/` is `src/`). */
export function resolveSpec(spec: string, from: string, has: (path: string) => boolean): Resolved {
  const bare = spec.split('?')[0];
  let base: string;
  if (bare.startsWith('@/')) base = `src/${bare.slice(2)}`;
  else if (bare === '.' || bare === '..' || bare.startsWith('./') || bare.startsWith('../')) base = `${dirOf(from)}/${bare}`;
  else if (bare.startsWith('/')) return { kind: 'asset' };
  else return { kind: 'package', name: packageName(bare) };
  const path = normalizePath(base);
  for (const s of TRY_SUFFIXES) if (has(path + s)) return { kind: 'module', path: path + s };
  return { kind: 'unresolved' };
}

export interface Edge {
  readonly from: string;
  readonly to: string;
  readonly line: number;
  readonly dynamic: boolean;
  readonly typeOnly: boolean;
  readonly flagOffOnly: boolean;
  /** The imported names (`default`, `*`, or exports); empty for side-effect and dynamic imports. */
  readonly names: readonly string[];
}

export interface ModuleGraph {
  /** Every code or stylesheet file handed in. */
  readonly files: readonly string[];
  readonly edges: readonly Edge[];
  /** file → npm packages it imports. */
  readonly packages: ReadonlyMap<string, ReadonlySet<string>>;
  readonly unresolved: readonly { from: string; spec: string; line: number }[];
  readonly parsed: ReadonlyMap<string, ParsedModule>;
}

export function buildGraph(sources: ReadonlyMap<string, string>): ModuleGraph {
  const has = (p: string): boolean => sources.has(p);
  const files: string[] = [];
  const edges: Edge[] = [];
  const packages = new Map<string, Set<string>>();
  const unresolved: { from: string; spec: string; line: number }[] = [];
  const parsed = new Map<string, ParsedModule>();
  for (const [file, text] of sources) {
    if (!isCodeFile(file) && !file.endsWith('.css')) continue;
    files.push(file);
    const mod = parseModule(file, text);
    parsed.set(file, mod);
    for (const imp of mod.imports) {
      const r = resolveSpec(imp.spec, file, has);
      if (r.kind === 'module') {
        edges.push({
          from: file, to: r.path, line: imp.line, dynamic: imp.dynamic, typeOnly: imp.typeOnly,
          flagOffOnly: imp.flagOffOnly, names: imp.bindings.map((b) => b.imported),
        });
      } else if (r.kind === 'package') {
        const set = packages.get(file) ?? new Set<string>();
        set.add(r.name);
        packages.set(file, set);
      } else if (r.kind === 'unresolved') {
        unresolved.push({ from: file, spec: imp.spec, line: imp.line });
      }
    }
  }
  return { files: files.sort(), edges, packages, unresolved, parsed };
}

export interface ReachOptions {
  /** Modules treated as deleted: never entered, so nothing reaches past them. */
  readonly removed?: ReadonlySet<string>;
  /** Edges to ignore (the flag-off imports, once the flag is assumed on). */
  readonly drop?: (e: Edge) => boolean;
  /** Edges that do not exist yet (code the cutover moves out of a page). */
  readonly extra?: readonly Edge[];
}

export function reach(roots: readonly string[], edges: readonly Edge[], opts: ReachOptions = {}): Set<string> {
  const out = new Map<string, Edge[]>();
  for (const e of [...edges, ...(opts.extra ?? [])]) {
    if (opts.drop?.(e)) continue;
    out.set(e.from, [...(out.get(e.from) ?? []), e]);
  }
  const seen = new Set<string>();
  const stack = roots.filter((r) => !opts.removed?.has(r));
  while (stack.length) {
    const m = stack.pop() as string;
    if (seen.has(m)) continue;
    seen.add(m);
    for (const e of out.get(m) ?? []) if (!opts.removed?.has(e.to) && !seen.has(e.to)) stack.push(e.to);
  }
  return seen;
}

// ── the registry and App.tsx, read as text ─────────────────────────────────

/**
 * `'/money' → './pages/atlas/AtlasBanking'`, from both loader tables in
 * src/surfaces.ts. Read through the parser, so the one-line shape
 * `surfaces.test.ts` needs is not something this depends on as well.
 */
export function parseLoaderTable(registryText: string): Map<string, string> {
  const sf = sourceOf('surfaces.ts', registryText);
  const out = new Map<string, string>();
  const visit = (n: ts.Node): void => {
    if (ts.isPropertyAssignment(n) && ts.isStringLiteral(n.name) && n.name.text.startsWith('/') && ts.isArrowFunction(n.initializer)) {
      const body = n.initializer.body;
      if (ts.isCallExpression(body) && body.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const arg = body.arguments[0];
        if (arg && ts.isStringLiteralLike(arg)) out.set(n.name.text, arg.text);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

export type OverrideSource = 'BETA_CONSUMER' | 'BETA_ADMIN' | 'flag ternary';

export interface BetaOverride {
  readonly path: string;
  /** As written in App.tsx, relative to it. */
  readonly spec: string;
  readonly via: OverrideSource;
}

/** The two maps App.tsx spreads over the routes while the flag is on. */
export const OVERRIDE_MAPS = ['BETA_CONSUMER', 'BETA_ADMIN'] as const;

/**
 * Every path App.tsx hands to a Beta page while the flag is on: the entries of
 * BETA_CONSUMER and BETA_ADMIN, and any `Component: isBetaUi() ? Beta : Workshop`
 * (today only "/"). A Component is resolved through a `lazy(() => import(…))`
 * written in place, a `const X = lazy(() => import(…))`, or a static default
 * import, which are the three shapes the file uses.
 */
export function parseBetaOverrides(appText: string): BetaOverride[] {
  const sf = sourceOf('App.tsx', appText);
  const flag = flagReading(sf);
  const bound = new Map<string, string>();

  const lazySpec = (e: ts.Expression | undefined): string | null => {
    if (!e || !ts.isCallExpression(e) || !ts.isIdentifier(e.expression) || e.expression.text !== 'lazy') return null;
    const fn = e.arguments[0];
    if (!fn || !ts.isArrowFunction(fn)) return null;
    let body: ts.Node = fn.body;
    if (ts.isBlock(body)) {
      const ret = body.statements.find(ts.isReturnStatement);
      if (!ret?.expression) return null;
      body = ret.expression;
    }
    if (!ts.isCallExpression(body) || body.expression.kind !== ts.SyntaxKind.ImportKeyword) return null;
    const arg = body.arguments[0];
    return arg && ts.isStringLiteralLike(arg) ? arg.text : null;
  };
  const componentSpec = (e: ts.Expression): string | null =>
    lazySpec(e) ?? (ts.isIdentifier(e) ? bound.get(e.text) ?? null : null);

  const collect = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && n.importClause?.name) {
      bound.set(n.importClause.name.text, n.moduleSpecifier.text);
    }
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) {
      const spec = lazySpec(n.initializer);
      if (spec) bound.set(n.name.text, spec);
    }
    ts.forEachChild(n, collect);
  };
  collect(sf);

  const out: BetaOverride[] = [];
  const routeKey = (prop: ts.Node): string | null => {
    // Component → { … } → '"/path": { … }'
    const obj = prop.parent;
    const entry = obj?.parent;
    return entry && ts.isPropertyAssignment(entry) && ts.isStringLiteral(entry.name) && entry.name.text.startsWith('/')
      ? entry.name.text
      : null;
  };
  const visit = (n: ts.Node, map: OverrideSource | null): void => {
    let inMap = map;
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && (OVERRIDE_MAPS as readonly string[]).includes(n.name.text)) {
      inMap = n.name.text as OverrideSource;
    }
    if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && n.name.text === 'Component') {
      const path = routeKey(n);
      if (path) {
        let init: ts.Expression = n.initializer;
        while (ts.isParenthesizedExpression(init)) init = init.expression;
        if (inMap) {
          const spec = componentSpec(init);
          if (spec) out.push({ path, spec, via: inMap });
        } else if (ts.isConditionalExpression(init)) {
          const v = flag.valueOf(init.condition);
          const beta = v === 'on' ? init.whenTrue : v === 'off' ? init.whenFalse : null;
          const spec = beta ? componentSpec(beta) : null;
          if (spec) out.push({ path, spec, via: 'flag ternary' });
        }
      }
    }
    ts.forEachChild(n, (c) => visit(c, inMap));
  };
  visit(sf, null);
  return out;
}

// ── coverage ───────────────────────────────────────────────────────────────

export type KeepReason =
  /** The Workshop page stays and draws a Beta hero above its body (phase 3). */
  | { readonly kind: 'hero'; readonly why: string }
  /** The Beta design for this screen was built at another path. */
  | { readonly kind: 'superseded'; readonly by: string; readonly why: string }
  /** The handoff has no Beta design for this screen. */
  | { readonly kind: 'no-design'; readonly why: string };

/**
 * Surfaces that deliberately keep their Workshop page after the cutover.
 *
 * Every other surface must be a Beta page or have a Beta override, and the
 * guard in src/betaCutover.test.ts fails on the first one that is neither. An
 * entry here is a decision, so each says why, and the guard re-checks the
 * claim (a hero page must still import its hero, a superseding path must
 * still be a Beta page, a "no design" screen must still be absent from the
 * handoff's screen map). Remove an entry the day its screen gets a Beta page;
 * the guard fails while a stale one is left behind.
 */
export const KEEP_WORKSHOP: Readonly<Record<string, KeepReason>> = {
  // Phase 3 put a tailored hero over each of these and kept the Workshop body
  // under it (handoff: "the tailored heroes plus the existing bodies"). The
  // body restyle is phase 8 work (P8a), inside the same page module, so the
  // module stays and so does whatever its body imports.
  '/atlas-core': { kind: 'hero', why: 'Core hero (ink orbit lab) over the Workshop body' },
  '/atlas-teach': { kind: 'hero', why: 'Teach hero (the sphere as microphone) over the Workshop body' },
  '/atlas-architecture': { kind: 'hero', why: 'Architecture hero (isometric layer stack) over the Workshop body' },
  // The handoff maps "Atlas Answer Views Beta" onto AtlasAnswerViews.tsx; phase 3
  // built it as the consumer surface /answer instead, which the Talk panel
  // opens with its last answer. /answer-views is the Workshop gallery of the
  // same shapes over sample data (admin, mock). Whether it is deleted with the
  // others or kept as an admin gallery is the user's call at the cutover.
  '/answer-views': { kind: 'superseded', by: '/answer', why: 'the Answer design shipped as /answer (BetaAnswer)' },
  // No Beta design exists for either, and the handoff says so for the first:
  // "HomeKit Lab stays a separate dev tool". The sphere gallery is a DEV-only
  // slider board for the old sphere engine.
  '/homekit-lab': { kind: 'no-design', why: 'a Lighthouse-only dev tool; the handoff keeps it as is' },
  '/atlas-sphere': { kind: 'no-design', why: 'the DEV-only gallery of the Workshop sphere engine' },
};

export type SurfaceCoverage =
  | { readonly path: string; readonly kind: 'beta-page'; readonly module: string }
  | { readonly path: string; readonly kind: 'override'; readonly workshop: string; readonly beta: string; readonly via: OverrideSource }
  | { readonly path: string; readonly kind: 'kept'; readonly workshop: string; readonly reason: KeepReason }
  | { readonly path: string; readonly kind: 'missing'; readonly workshop: string };

/**
 * One verdict per surface path. `loaders` and `overrides` hold specifiers as
 * written (only their file names matter here); the order of the checks is the
 * order of precedence at runtime: a loader that is already a Beta page, then
 * an App.tsx override, then the allow-list.
 */
export function classifySurfaces(
  paths: readonly string[],
  loaders: ReadonlyMap<string, string>,
  overrides: readonly BetaOverride[],
  keep: Readonly<Record<string, KeepReason>> = KEEP_WORKSHOP,
): SurfaceCoverage[] {
  return paths.map((path): SurfaceCoverage => {
    const workshop = loaders.get(path) ?? '(no loader)';
    if (isBetaModule(workshop)) return { path, kind: 'beta-page', module: workshop };
    const o = overrides.find((x) => x.path === path);
    if (o) return { path, kind: 'override', workshop, beta: o.spec, via: o.via };
    const reason = keep[path];
    if (reason) return { path, kind: 'kept', workshop, reason };
    return { path, kind: 'missing', workshop };
  });
}

// ── the inventory ──────────────────────────────────────────────────────────

export interface Blocker {
  /** The module that stays and imports from a page the cutover deletes. */
  readonly from: string;
  readonly line: number;
  readonly page: string;
  readonly names: readonly string[];
  readonly typeOnly: boolean;
  /** Modules the imported names need, which move with them. */
  readonly carries: readonly string[];
  /** The page itself is imported, so it cannot be deleted at all. */
  readonly whole: boolean;
}

export type RemovalReason =
  /** A Workshop page a Beta page replaced. */
  | 'replaced page'
  /** Imported only by modules that go. */
  | 'old UI only'
  /** Imported only from a flag-off branch of a module that stays. */
  | 'flag branch';

export interface RemovableModule {
  readonly path: string;
  readonly why: RemovalReason;
  readonly importers: readonly string[];
}

export interface SharedModule {
  readonly path: string;
  /** Modules that go and import it. */
  readonly oldImporters: readonly string[];
  /** How many modules that stay import it. */
  readonly keptImporters: number;
}

export interface Inventory {
  readonly root: string;
  readonly coverage: readonly SurfaceCoverage[];
  readonly replaced: readonly {
    readonly page: string;
    readonly paths: readonly string[];
    readonly beta: readonly string[];
    /** Something that stays imports the whole page, so it cannot be deleted yet (see `blockers`). */
    readonly blocked: boolean;
  }[];
  readonly kept: readonly { readonly page: string; readonly path: string; readonly reason: KeepReason }[];
  readonly blockers: readonly Blocker[];
  readonly removable: readonly RemovableModule[];
  readonly shared: readonly SharedModule[];
  readonly flagOffEdges: readonly Edge[];
  readonly flagSites: readonly (FlagSite & { readonly file: string })[];
  readonly oldOnlyPackages: readonly { readonly name: string; readonly usedBy: readonly string[] }[];
  readonly tests: readonly { readonly file: string; readonly imports: readonly string[] }[];
  readonly deadToday: readonly { readonly path: string; readonly importedBy: readonly string[] }[];
  readonly workshopCss: readonly { readonly sheet: string; readonly classes: number; readonly usedAfter: number; readonly byModule: readonly { readonly path: string; readonly classes: readonly string[] }[] }[];
  readonly unresolved: readonly { readonly from: string; readonly spec: string; readonly line: number }[];
  readonly counts: { readonly now: number; readonly after: number };
}

export interface InventoryOptions {
  readonly root?: string;
  readonly registry?: string;
  readonly app?: string;
  /** Stylesheets main.tsx loads for every screen; the graph cannot drop them, so their classes are counted instead. */
  readonly workshopSheets?: readonly string[];
  readonly keep?: Readonly<Record<string, KeepReason>>;
}

const inSrc = (p: string): boolean => p.startsWith('src/');

/**
 * The cutover, simulated: the flag on for good, the replaced Workshop pages
 * deleted, and whatever a Beta module imports from them moved out first.
 * `sources` is every file the app and its tests are made of, by repo path.
 */
export function buildInventory(sources: ReadonlyMap<string, string>, opts: InventoryOptions = {}): Inventory {
  const root = opts.root ?? 'src/main.tsx';
  const registry = opts.registry ?? 'src/surfaces.ts';
  const app = opts.app ?? 'src/App.tsx';
  const sheets = opts.workshopSheets ?? ['src/styles/workshop.css'];
  const keep = opts.keep ?? KEEP_WORKSHOP;
  const has = (p: string): boolean => sources.has(p);
  const graph = buildGraph(sources);
  const moduleOf = (spec: string, from: string): string | null => {
    const r = resolveSpec(spec, from, has);
    return r.kind === 'module' ? r.path : null;
  };

  // Coverage, and from it the pages the cutover deletes.
  const loaders = parseLoaderTable(sources.get(registry) ?? '');
  const overrides = parseBetaOverrides(sources.get(app) ?? '');
  const coverage = classifySurfaces([...loaders.keys()], loaders, overrides, keep);
  const replacedBy = new Map<string, { paths: string[]; beta: Set<string> }>();
  const kept: { page: string; path: string; reason: KeepReason }[] = [];
  for (const c of coverage) {
    const page = c.kind === 'beta-page' ? null : moduleOf(c.workshop, registry);
    if (c.kind === 'override' && page) {
      const r = replacedBy.get(page) ?? { paths: [], beta: new Set<string>() };
      r.paths.push(c.path);
      const beta = moduleOf(c.beta, app);
      if (beta) r.beta.add(beta);
      replacedBy.set(page, r);
    } else if (c.kind === 'kept' && page) {
      kept.push({ page, path: c.path, reason: c.reason });
    }
  }
  // A Workshop module that also backs a kept surface is not deleted.
  for (const k of kept) replacedBy.delete(k.page);

  const isTestish = (f: string): boolean => isTestFile(f) || !inSrc(f);
  const appEdges = graph.edges.filter((e) => !isTestish(e.from));
  const now = reach([root], appEdges);
  // The route wiring itself: the registry's loader and App.tsx's static
  // import of a replaced page. The cutover rewrites these to the Beta page
  // (step 4 of docs/design-sync/beta-cutover.md), so they are not blockers.
  const isRouteEdge = (e: Edge): boolean => (e.from === registry || e.from === app) && replacedBy.has(e.to);
  const dropFlagOff = (e: Edge): boolean => e.flagOffOnly || isRouteEdge(e);

  // Blockers: modules that stay but import a page that goes. Moving the
  // imported names out brings their own imports along (`carries`), which can
  // keep more alive, so this runs to a fixed point.
  const removed = new Set(replacedBy.keys());
  const candidates: ReadonlySet<string> = new Set(removed);
  let extra: Edge[] = [];
  let after = new Set<string>();
  let blockers: Blocker[] = [];
  for (let round = 0; round < 10; round++) {
    after = reach([root], appEdges, { removed, drop: dropFlagOff, extra });
    const next: Blocker[] = [];
    const nextExtra: Edge[] = [];
    let changed = false;
    for (const e of appEdges) {
      if (!candidates.has(e.to) || !after.has(e.from) || dropFlagOff(e)) continue;
      const closure = exportClosure(e.to, sources.get(e.to) ?? '', e.names.length ? e.names : ['*']);
      if (closure.whole && removed.has(e.to)) {
        // The page itself is wanted: it cannot go until that import changes.
        removed.delete(e.to);
        changed = true;
      }
      const carries = closure.specs.map((s) => moduleOf(s, e.to)).filter((m): m is string => m !== null);
      next.push({ from: e.from, line: e.line, page: e.to, names: e.names, typeOnly: e.typeOnly, carries, whole: closure.whole });
      for (const m of carries) nextExtra.push({ from: e.from, to: m, line: e.line, dynamic: false, typeOnly: e.typeOnly, flagOffOnly: false, names: [] });
    }
    blockers = next;
    if (!changed && nextExtra.length === extra.length) break;
    extra = nextExtra;
  }

  // What goes, and why.
  const importers = new Map<string, Edge[]>();
  for (const e of graph.edges) importers.set(e.to, [...(importers.get(e.to) ?? []), e]);
  const gone = new Set([...now].filter((m) => !after.has(m)));
  const removable: RemovableModule[] = [...gone].sort().map((path) => {
    const from = (importers.get(path) ?? []).filter((e) => now.has(e.from) && !isTestish(e.from));
    const why: RemovalReason = removed.has(path)
      ? 'replaced page'
      : from.some((e) => gone.has(e.from)) ? 'old UI only' : 'flag branch';
    return { path, why, importers: [...new Set(from.map((e) => e.from))].sort() };
  });

  // What the old UI uses that stays: the boundary, one hop out of what goes.
  // A module kept only because a moved panel needs it counts its new home
  // (the `extra` edge) as the importer that keeps it.
  const sharedMap = new Map<string, Set<string>>();
  for (const e of appEdges) {
    if (gone.has(e.from) && after.has(e.to)) sharedMap.set(e.to, (sharedMap.get(e.to) ?? new Set()).add(e.from));
  }
  const keptEdges = [...appEdges.filter((e) => !dropFlagOff(e)), ...extra];
  const shared: SharedModule[] = [...sharedMap.entries()]
    .map(([path, olds]) => ({
      path,
      oldImporters: [...olds].sort(),
      keptImporters: new Set(keptEdges.filter((e) => e.to === path && after.has(e.from)).map((e) => e.from)).size,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));

  const flagOffEdges = appEdges.filter((e) => e.flagOffOnly && now.has(e.from)).sort((a, b) => a.from.localeCompare(b.from) || a.line - b.line);
  const flagSites = [...graph.parsed.entries()]
    .filter(([file]) => inSrc(file) && !isTestFile(file))
    .flatMap(([file, p]) => p.flagSites.map((s) => ({ ...s, file })))
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

  const pkgUsers = (mods: Iterable<string>): Map<string, Set<string>> => {
    const out = new Map<string, Set<string>>();
    for (const m of mods) for (const p of graph.packages.get(m) ?? []) out.set(p, (out.get(p) ?? new Set()).add(m));
    return out;
  };
  const afterPkgs = pkgUsers(after);
  const oldOnlyPackages = [...pkgUsers(gone).entries()]
    .filter(([name]) => !afterPkgs.has(name))
    .map(([name, users]) => ({ name, usedBy: [...users].sort() }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const testMap = new Map<string, Set<string>>();
  for (const e of graph.edges) {
    if (isTestish(e.from) && gone.has(e.to)) testMap.set(e.from, (testMap.get(e.from) ?? new Set()).add(e.to));
  }
  const tests = [...testMap.entries()].map(([file, mods]) => ({ file, imports: [...mods].sort() })).sort((a, b) => a.file.localeCompare(b.file));

  const deadToday = graph.files
    .filter((f) => inSrc(f) && !isTestFile(f) && !now.has(f))
    .map((path) => ({ path, importedBy: [...new Set((importers.get(path) ?? []).map((e) => e.from))].sort() }));

  const workshopCss = sheets.filter(has).map((sheet) => {
    const classes = cssClasses(sources.get(sheet) ?? '');
    const byModule: { path: string; classes: string[] }[] = [];
    const used = new Set<string>();
    for (const m of [...after].sort()) {
      if (!isCodeFile(m)) continue;
      const tokens = sourceTokens(sources.get(m) ?? '');
      const hit = classes.filter((c) => tokens.has(c));
      if (hit.length) {
        byModule.push({ path: m, classes: hit });
        for (const c of hit) used.add(c);
      }
    }
    byModule.sort((a, b) => b.classes.length - a.classes.length || a.path.localeCompare(b.path));
    return { sheet, classes: classes.length, usedAfter: used.size, byModule };
  });

  return {
    root,
    coverage,
    replaced: [...replacedBy.entries()]
      .map(([page, r]) => ({ page, paths: r.paths, beta: [...r.beta].sort(), blocked: !removed.has(page) }))
      .sort((a, b) => a.page.localeCompare(b.page)),
    kept,
    blockers,
    removable,
    shared,
    flagOffEdges,
    flagSites,
    oldOnlyPackages,
    tests,
    deadToday,
    workshopCss,
    unresolved: graph.unresolved.filter((u) => inSrc(u.from)),
    counts: { now: now.size, after: after.size },
  };
}
