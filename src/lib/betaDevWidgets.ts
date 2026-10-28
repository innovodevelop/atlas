/**
 * The admin Home's developer widgets — Pull requests and Deploys from
 * `Atlas Widgets Beta.dc.html` (left-out features, row 18) — as data: what
 * each face says, from what the brain read through the Mac's `gh` login
 * (services/atlas-brain/src/githubWidgets.ts). Pure and tested here; the
 * faces themselves are components/atlas/home/devWidgets.tsx.
 *
 * Admin only: nothing in a consumer build imports this file.
 *
 * The report types are structural copies of the brain's, for the same reason
 * betaDevTools.ts copies its rows: this file sits inside the strict gate,
 * which cannot check the brain client the hook pulls in.
 */
import { ago } from './betaDevTools';

// ── What the brain answers ───────────────────────────────────────────────────

export type GhProblem = 'missing' | 'signed-out' | 'unreachable';

export interface GhFailure { ok: false; repo: string; checkedAt: string; problem: GhProblem; message: string }

export type PullState = 'review' | 'approved' | 'changes' | 'draft';

export interface PullLike {
  number: number;
  title: string;
  url: string;
  state: PullState;
  author: string | null;
  head: string | null;
  base: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  askedYou: boolean;
}

export type PullsReport = { ok: true; repo: string; checkedAt: string; viewer: string | null; pulls: PullLike[] } | GhFailure;

export type GhRunState = 'queued' | 'running' | 'passed' | 'failed' | 'cancelled' | 'skipped';

export interface GhRunLike {
  id: number;
  workflow: string;
  title: string | null;
  branch: string | null;
  event: string | null;
  state: GhRunState;
  url: string;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface ReleaseLike {
  tag: string;
  name: string | null;
  draft: boolean;
  prerelease: boolean;
  publishedAt: string | null;
  createdAt: string | null;
  url: string;
}

export type DeploysReport = { ok: true; repo: string; checkedAt: string; releases: ReleaseLike[]; runs: GhRunLike[] } | GhFailure;

// ── The faces ────────────────────────────────────────────────────────────────

export type RowTone = 'up' | 'down' | 'muted' | 'ink';

export interface DevRow {
  key: string;
  title: string;
  sub: string;
  value: string;
  tone: RowTone;
  /** Where tapping the row goes: the pull request or the run on GitHub. */
  url: string | null;
}

export interface DevAttention { text: string; tone: 'blue' | 'red'; icon: 'info' | 'warning' }

export interface DevFace {
  meta: string;
  value: string;
  delta?: string;
  deltaTone?: 'up' | 'down' | 'muted' | 'blue';
  sub: string;
  rows: DevRow[];
  attention: DevAttention | null;
  /** Where tapping the card goes. */
  openUrl: string | null;
}

/** The face's empty state when gh cannot answer at all: what it needs, and what would leave the Mac. */
export interface DormantCopy { title: string; hint: string }

/**
 * Only GitHub pages of the repo are opened. The URLs come from gh, which
 * reads them from GitHub; checking the prefix keeps a malformed answer from
 * handing the system browser anything else.
 */
export function githubUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname === 'github.com' ? u.toString() : null;
  } catch {
    return null;
  }
}

/** "innovodevelop/atlas" → its GitHub page, or null for anything that is not an owner/name pair. */
export function repoUrl(repo: string, path = ''): string | null {
  return /^[\w-][\w.-]*\/[\w-][\w.-]*$/.test(repo) ? `https://github.com/${repo}${path}` : null;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ── Pull requests ────────────────────────────────────────────────────────────

/** The design's chip words and colours: review orange-ish (ink here, the face has no orange), approved green, draft grey. */
export const PULL_WORD: Readonly<Record<PullState, { word: string; tone: RowTone }>> = {
  review: { word: 'review', tone: 'ink' },
  approved: { word: 'approved', tone: 'up' },
  changes: { word: 'changes', tone: 'down' },
  draft: { word: 'draft', tone: 'muted' },
};

const time = (iso: string | null): number => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? 0 : t;
};

/** "1 waiting · On you to review", as the design draws it; otherwise how many are open. Rows: yours to review first, then the most recently touched. */
export function pullsFace(r: Extract<PullsReport, { ok: true }>, now: number): DevFace {
  const waiting = r.pulls.filter((p) => p.askedYou);
  const ordered = [...r.pulls].sort((a, b) => Number(b.askedYou) - Number(a.askedYou) || time(b.updatedAt) - time(a.updatedAt));
  const open = r.pulls.length;
  const newest = ordered.find((p) => !p.askedYou) ?? ordered[0];
  return {
    meta: r.repo,
    value: waiting.length ? `${waiting.length} waiting` : `${open} open`,
    delta: waiting.length ? `${open} open` : undefined,
    deltaTone: 'muted',
    sub: waiting.length
      ? 'On you to review'
      : open === 0
        ? 'Nothing open'
        : r.viewer
          ? `None waiting on you · newest ${ago(newest?.updatedAt ?? newest?.createdAt, now) || 'recently'}`
          : `Newest updated ${ago(newest?.updatedAt ?? newest?.createdAt, now) || 'recently'}`,
    rows: ordered.map((p) => ({
      key: String(p.number),
      title: p.title,
      sub: [`#${p.number}`, p.author && p.author !== r.viewer ? p.author : null, ago(p.updatedAt ?? p.createdAt, now) || null].filter(Boolean).join(' · '),
      value: PULL_WORD[p.state].word,
      tone: PULL_WORD[p.state].tone,
      url: githubUrl(p.url),
    })),
    attention: waiting.length
      ? { text: `${plural(waiting.length, 'pull request')} waiting on your review`, tone: 'blue', icon: 'info' }
      : null,
    openUrl: repoUrl(r.repo, '/pulls'),
  };
}

// ── Deploys ──────────────────────────────────────────────────────────────────

export const RUN_WORD: Readonly<Record<GhRunState, { word: string; tone: RowTone }>> = {
  passed: { word: 'passed', tone: 'up' },
  failed: { word: 'failed', tone: 'down' },
  running: { word: 'running', tone: 'ink' },
  queued: { word: 'queued', tone: 'muted' },
  cancelled: { word: 'cancelled', tone: 'muted' },
  skipped: { word: 'skipped', tone: 'muted' },
};

/** The newest run of each workflow, newest first — the pipeline's state, not its history. */
export function latestPerWorkflow(runs: readonly GhRunLike[]): GhRunLike[] {
  const seen = new Set<string>();
  const out: GhRunLike[] = [];
  for (const r of [...runs].sort((a, b) => time(b.createdAt) - time(a.createdAt))) {
    if (seen.has(r.workflow)) continue;
    seen.add(r.workflow);
    out.push(r);
  }
  return out;
}

/**
 * The design's Deploys card: the version that is out, how, and since when.
 * Atlas ships through GitHub Releases (release.yml builds a draft on a tag;
 * publishing it is what reaches installs), so "live" is the newest published
 * release. With none yet, the hero says so and the release build's own last
 * run stands in. The rows are the newest run of each workflow.
 */
export function deploysFace(r: Extract<DeploysReport, { ok: true }>, now: number): DevFace {
  const published = r.releases.filter((x) => !x.draft).sort((a, b) => time(b.publishedAt ?? b.createdAt) - time(a.publishedAt ?? a.createdAt))[0];
  const draft = r.releases.filter((x) => x.draft).sort((a, b) => time(b.createdAt) - time(a.createdAt))[0];
  const newerDraft = draft && (!published || time(draft.createdAt) > time(published.publishedAt ?? published.createdAt)) ? draft : undefined;
  const latest = latestPerWorkflow(r.runs);
  const releaseRun = latest.find((x) => /release/i.test(x.workflow));
  const failing = latest.find((x) => x.state === 'failed');

  let hero: Pick<DevFace, 'value' | 'delta' | 'deltaTone' | 'sub'>;
  if (published) {
    hero = {
      value: published.tag,
      delta: published.prerelease ? 'pre-release' : 'live',
      deltaTone: published.prerelease ? 'blue' : 'up',
      // The design's "Shipped 41 minutes ago": publishing the release is what ships it.
      sub: [`Shipped ${ago(published.publishedAt ?? published.createdAt, now) || 'recently'}`, newerDraft ? `${newerDraft.tag} drafted` : null].filter(Boolean).join(' · '),
    };
  } else if (newerDraft) {
    hero = { value: newerDraft.tag, delta: 'draft', deltaTone: 'muted', sub: `Drafted ${ago(newerDraft.createdAt, now) || 'recently'} · publish it on GitHub to ship` };
  } else {
    hero = {
      value: 'No release',
      sub: releaseRun
        ? `Last release build ${RUN_WORD[releaseRun.state].word} ${ago(releaseRun.createdAt, now) || 'recently'}`
        : 'Nothing released from this repo yet',
    };
  }

  return {
    meta: r.repo,
    ...hero,
    rows: latest.map((x) => ({
      key: String(x.id),
      title: x.workflow,
      sub: [x.branch, ago(x.createdAt, now) || null].filter(Boolean).join(' · '),
      value: RUN_WORD[x.state].word,
      tone: RUN_WORD[x.state].tone,
      url: githubUrl(x.url),
    })),
    attention: failing ? { text: `${failing.workflow} failed${failing.branch ? ` on ${failing.branch}` : ''}`, tone: 'red', icon: 'warning' } : null,
    openUrl: repoUrl(r.repo, published || newerDraft ? '/releases' : '/actions'),
  };
}

// ── When gh cannot answer ────────────────────────────────────────────────────

/**
 * A missing or signed-out gh is a dormant widget: it says what it needs and
 * what would leave the Mac. An unreachable GitHub is not dormant; it is the
 * offline row over the last good reading (null here).
 */
export function dormantCopy(f: GhFailure): DormantCopy | null {
  switch (f.problem) {
    case 'missing':
      return { title: 'Needs the GitHub CLI', hint: `Install gh and run gh auth login. Atlas reads ${f.repo} through it and stores no token; only gh’s own requests to GitHub leave this Mac.` };
    case 'signed-out':
      return { title: 'GitHub CLI signed out', hint: `Run gh auth login in Terminal. Atlas reads ${f.repo} through it and stores no token.` };
    default:
      return null;
  }
}

/** The offline row: why, and how old what is still shown is. */
export function offlineText(reason: string, lastGoodAt: string | null, now: number): string {
  const age = ago(lastGoodAt, now);
  return age ? `${reason} · showing ${age === 'just now' ? 'a reading from just now' : `the reading from ${age}`}` : reason;
}
