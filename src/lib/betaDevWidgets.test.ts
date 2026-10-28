import { describe, expect, test } from 'bun:test';
import {
  deploysFace, dormantCopy, githubUrl, latestPerWorkflow, offlineText, pullsFace, repoUrl,
  type DeploysReport, type GhRunLike, type PullLike, type PullsReport, type ReleaseLike,
} from './betaDevWidgets';

const NOW = Date.parse('2026-10-28T16:00:00Z');
const minsAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

const pull = (over: Partial<PullLike> & { number: number }): PullLike => ({
  title: `PR ${over.number}`, url: `https://github.com/innovodevelop/atlas/pull/${over.number}`, state: 'review', author: 'someone',
  head: 'branch', base: 'atlas-redesign', createdAt: minsAgo(600), updatedAt: minsAgo(60), askedYou: false, ...over,
});
const pulls = (list: PullLike[], viewer: string | null = 'innovodevelop'): Extract<PullsReport, { ok: true }> =>
  ({ ok: true, repo: 'innovodevelop/atlas', checkedAt: minsAgo(0), viewer, pulls: list });

const ghRun = (over: Partial<GhRunLike> & { id: number; workflow: string }): GhRunLike => ({
  title: null, branch: 'ws-beta-redesign', event: 'push', state: 'passed', url: `https://github.com/innovodevelop/atlas/actions/runs/${over.id}`,
  createdAt: minsAgo(30), updatedAt: minsAgo(28), ...over,
});
const release = (over: Partial<ReleaseLike> & { tag: string }): ReleaseLike => ({
  name: null, draft: false, prerelease: false, publishedAt: minsAgo(41), createdAt: minsAgo(50), url: `https://github.com/innovodevelop/atlas/releases/tag/${over.tag}`, ...over,
});
const deploys = (releases: ReleaseLike[], runs: GhRunLike[]): Extract<DeploysReport, { ok: true }> =>
  ({ ok: true, repo: 'innovodevelop/atlas', checkedAt: minsAgo(0), releases, runs });

describe('Pull requests', () => {
  test('one waiting on you: the design’s “1 waiting · On you to review”, yours on top', () => {
    const f = pullsFace(pulls([
      pull({ number: 6, author: 'innovodevelop', updatedAt: minsAgo(5) }),
      pull({ number: 7, state: 'approved', updatedAt: minsAgo(90) }),
      pull({ number: 8, state: 'draft', askedYou: true, updatedAt: minsAgo(300) }),
    ]), NOW);
    expect(f).toMatchObject({ meta: 'innovodevelop/atlas', value: '1 waiting', delta: '3 open', sub: 'On you to review', openUrl: 'https://github.com/innovodevelop/atlas/pulls' });
    expect(f.rows.map((r) => [r.key, r.value, r.tone])).toEqual([['8', 'draft', 'muted'], ['6', 'review', 'ink'], ['7', 'approved', 'up']]);
    // Your own pull request does not name you; someone else's names them.
    expect(f.rows[1].sub).toBe('#6 · 5 min ago');
    expect(f.rows[2].sub).toBe('#7 · someone · 2 h ago');
    expect(f.attention).toEqual({ text: '1 pull request waiting on your review', tone: 'blue', icon: 'info' });
  });

  test('none waiting, and nothing open', () => {
    const f = pullsFace(pulls([pull({ number: 6, updatedAt: minsAgo(12) })]), NOW);
    expect(f).toMatchObject({ value: '1 open', delta: undefined, sub: 'None waiting on you · newest 12 min ago', attention: null });
    expect(pullsFace(pulls([], null), NOW)).toMatchObject({ value: '0 open', sub: 'Nothing open', rows: [] });
    expect(pullsFace(pulls([pull({ number: 9, updatedAt: minsAgo(180) })], null), NOW).sub).toBe('Newest updated 3 h ago');
  });
});

describe('Deploys', () => {
  test('a published release is live, with a newer draft named', () => {
    const f = deploysFace(deploys([release({ tag: 'v0.4.1', draft: true, publishedAt: null, createdAt: minsAgo(10) }), release({ tag: 'v0.4.0' })], [ghRun({ id: 1, workflow: 'CI' })]), NOW);
    expect(f).toMatchObject({ value: 'v0.4.0', delta: 'live', deltaTone: 'up', sub: 'Published 41 min ago · v0.4.1 drafted', openUrl: 'https://github.com/innovodevelop/atlas/releases' });
  });

  test('a draft alone says how to ship it; a pre-release is not “live”', () => {
    expect(deploysFace(deploys([release({ tag: 'v0.5.0', draft: true, publishedAt: null, createdAt: minsAgo(120) })], []), NOW))
      .toMatchObject({ value: 'v0.5.0', delta: 'draft', sub: 'Drafted 2 h ago · publish it on GitHub to ship' });
    expect(deploysFace(deploys([release({ tag: 'v0.5.0-rc1', prerelease: true })], []), NOW)).toMatchObject({ delta: 'pre-release', deltaTone: 'blue' });
  });

  test('no release yet (this repo today): the release build’s last run stands in; rows are the newest run per workflow', () => {
    const f = deploysFace(deploys([], [
      ghRun({ id: 4, workflow: 'CI', createdAt: minsAgo(17), state: 'passed' }),
      ghRun({ id: 3, workflow: 'Rust core', createdAt: minsAgo(17), state: 'queued' }),
      ghRun({ id: 2, workflow: 'CI', createdAt: minsAgo(18), state: 'failed' }),
      ghRun({ id: 1, workflow: 'Release', branch: 'atlas-redesign', createdAt: new Date(NOW - 79 * 86_400_000).toISOString(), state: 'cancelled' }),
    ]), NOW);
    expect(f).toMatchObject({ value: 'No release', sub: 'Last release build cancelled 79 d ago', openUrl: 'https://github.com/innovodevelop/atlas/actions' });
    expect(f.rows.map((r) => [r.title, r.value])).toEqual([['CI', 'passed'], ['Rust core', 'queued'], ['Release', 'cancelled']]);
    expect(f.rows[0].sub).toBe('ws-beta-redesign · 17 min ago');
    // The older failed CI run is history, not the pipeline's state.
    expect(f.attention).toBeNull();
    expect(deploysFace(deploys([], []), NOW).sub).toBe('Nothing released from this repo yet');
  });

  test('a workflow whose newest run failed raises attention', () => {
    const f = deploysFace(deploys([], [ghRun({ id: 2, workflow: 'Rust core', state: 'failed', branch: 'atlas-redesign' }), ghRun({ id: 1, workflow: 'CI' })]), NOW);
    expect(f.attention).toEqual({ text: 'Rust core failed on atlas-redesign', tone: 'red', icon: 'warning' });
    expect(latestPerWorkflow([]).length).toBe(0);
  });
});

describe('links and dormant states', () => {
  test('only github.com pages open', () => {
    expect(githubUrl('https://github.com/innovodevelop/atlas/pull/6')).toBe('https://github.com/innovodevelop/atlas/pull/6');
    expect(githubUrl('http://github.com/x')).toBeNull();
    expect(githubUrl('https://github.com.evil.example/x')).toBeNull();
    expect(githubUrl('javascript:alert(1)')).toBeNull();
    expect(githubUrl(null)).toBeNull();
    expect(repoUrl('innovodevelop/atlas', '/actions')).toBe('https://github.com/innovodevelop/atlas/actions');
    expect(repoUrl('../etc', '')).toBeNull();
  });

  test('a missing or signed-out gh is dormant and says what it needs; offline is not', () => {
    const base = { ok: false as const, repo: 'innovodevelop/atlas', checkedAt: minsAgo(0), message: '' };
    expect(dormantCopy({ ...base, problem: 'missing' })?.title).toBe('Needs the GitHub CLI');
    expect(dormantCopy({ ...base, problem: 'missing' })?.hint).toContain('stores no token');
    expect(dormantCopy({ ...base, problem: 'signed-out' })?.hint).toContain('gh auth login');
    expect(dormantCopy({ ...base, problem: 'unreachable' })).toBeNull();
    expect(offlineText('GitHub unreachable', minsAgo(12), NOW)).toBe('GitHub unreachable · showing the reading from 12 min ago');
    expect(offlineText('GitHub unreachable', null, NOW)).toBe('GitHub unreachable');
  });
});
