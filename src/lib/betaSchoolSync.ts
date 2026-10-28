/**
 * The School screen's two connections — Lectio's calendar feed and LearnIT
 * (Moodle) — as one small store, read with `useSyncExternalStore`.
 *
 * Rust does every fetch (src-tauri/src/school.rs) and keeps the link and the
 * token in the Keychain; this module never holds either for longer than the
 * one `invoke` that hands a newly pasted one over. What comes back is cached
 * on this Mac under two keys of its own, apart from the student's own work in
 * `atlas:school`, so a damaged or cleared cache never touches that:
 *
 *   - `atlas:school:lectio` — the schedule as lessons (betaSchoolIcs.ts);
 *   - `atlas:school:moodle` — courses, assignments, materials, conversations
 *     and grade items (betaSchoolMoodle.ts).
 *
 * The cache is what the screen draws, so the schedule is there offline and
 * the moment School opens; a refresh replaces it when it lands. Disconnecting
 * deletes the Keychain item and the cache together.
 *
 * What leaves the Mac: a request to lectio.dk for the calendar, and read-only
 * web-service calls to the Moodle site — when School opens, hourly while it
 * stays open (useSchoolSyncLoop in the School components), and on Refresh.
 */
import { useSyncExternalStore } from 'react';
import { htmlToText, moodleErrorText, parseMoodleCache, readAssignments, readContents, readConversations, readCourses, readGradeItems, readSiteInfo, type MoodleCache, type MoodleData } from './betaSchoolMoodle';
import { lessonsFromIcs, parseLectioCache, type LectioCache } from './betaSchoolIcs';

export const LECTIO_CACHE_KEY = 'atlas:school:lectio';
export const MOODLE_CACHE_KEY = 'atlas:school:moodle';
export const LEARNIT_SITE = 'https://learnit.itu.dk';

export type SyncPhase = 'idle' | 'syncing' | 'error';

export interface Connections { lectio: boolean; moodle: { connected: boolean; site: string | null } }

export interface SyncState {
  /** False outside the desktop app, where there is no Rust to fetch with. */
  desktop: boolean;
  /** Null until Rust has said what is connected. */
  conn: Connections | null;
  lectio: { phase: SyncPhase; error: string | null; cache: LectioCache | null };
  moodle: { phase: SyncPhase; error: string | null; cache: MoodleCache | null };
}

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

let invokeImpl: Invoke | null = null;
async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!invokeImpl) {
    const core = await import('@tauri-apps/api/core');
    invokeImpl = core.invoke as Invoke;
  }
  return invokeImpl<T>(cmd, args);
}

/** For tests: answer Rust's commands without Rust. */
export function _setSchoolInvoke(fn: Invoke | null): void { invokeImpl = fn; }

function readCache<T>(key: string, parse: (raw: string | null) => T | null): T | null {
  try { return parse(window.localStorage.getItem(key)); } catch { return null; }
}

function writeCache(key: string, value: unknown): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or blocked: the data still shows until Atlas closes, and the next open fetches again.
  }
}

function initial(): SyncState {
  const hasWindow = typeof window !== 'undefined';
  return {
    desktop: hasWindow && '__TAURI_INTERNALS__' in window,
    conn: null,
    lectio: { phase: 'idle', error: null, cache: hasWindow ? readCache(LECTIO_CACHE_KEY, parseLectioCache) : null },
    moodle: { phase: 'idle', error: null, cache: hasWindow ? readCache(MOODLE_CACHE_KEY, parseMoodleCache) : null },
  };
}

let state: SyncState | null = null;
const listeners = new Set<() => void>();

export function getSchoolSync(): SyncState {
  if (state === null) state = initial();
  return state;
}

function set(fn: (s: SyncState) => SyncState): void {
  state = fn(getSchoolSync());
  listeners.forEach((l) => l());
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function useSchoolSync(): SyncState {
  return useSyncExternalStore(subscribe, getSchoolSync, getSchoolSync);
}

const errText = (e: unknown): string => (typeof e === 'string' ? e : e instanceof Error ? e.message : 'Something went wrong.');

/** What a Lectio error string from Rust means, said plainly. Rust's own sentences pass through. */
export function lectioErrorText(err: string): string {
  if (err === 'not-connected') return 'Lectio is not connected.';
  if (err === 'not-a-calendar') return 'Lectio did not send a calendar for this link. It may have expired: copy a fresh one from Lectio → Skema → Abonnér.';
  if (/^http:(401|403|404|410)$/.test(err)) return 'Lectio no longer knows this link. Copy a fresh one from Lectio → Skema → Abonnér.';
  if (err.startsWith('http:')) return `Lectio answered with an error (HTTP ${err.slice(5)}). Try again later.`;
  if (err.startsWith('unreachable')) return 'Lectio could not be reached. Check your connection.';
  if (err === 'too-large') return 'The calendar was larger than Atlas will read.';
  return err.slice(0, 240) || 'Something went wrong.';
}

const NOT_DESKTOP = 'School connects to Lectio and LearnIT only in the Atlas app on your Mac.';

// ── Connections ──────────────────────────────────────────────────────────────

let connLoad: Promise<Connections | null> | null = null;

/** Asks Rust what is connected. A cache whose connection is gone is dropped with it. */
export function loadConnections(): Promise<Connections | null> {
  if (!getSchoolSync().desktop) return Promise.resolve(null);
  if (!connLoad) {
    connLoad = invoke<Connections>('school_connections')
      .then((conn) => {
        if (!conn.lectio && getSchoolSync().lectio.cache) writeCache(LECTIO_CACHE_KEY, null);
        if (!conn.moodle.connected && getSchoolSync().moodle.cache) writeCache(MOODLE_CACHE_KEY, null);
        set((s) => ({
          ...s,
          conn,
          lectio: conn.lectio ? s.lectio : { phase: 'idle', error: null, cache: null },
          moodle: conn.moodle.connected ? s.moodle : { phase: 'idle', error: null, cache: null },
        }));
        return conn;
      })
      .catch(() => null)
      .finally(() => { connLoad = null; });
  }
  return connLoad;
}

// ── Lectio ───────────────────────────────────────────────────────────────────

function keepLectio(ics: string): void {
  const cache: LectioCache = { fetchedAt: Date.now(), lessons: lessonsFromIcs(ics, Date.now()) };
  writeCache(LECTIO_CACHE_KEY, cache);
  set((s) => ({ ...s, lectio: { phase: 'idle', error: null, cache } }));
}

/** Checks and keeps a pasted link (Rust fetches it once first). Resolves to an error to show, or null. */
export async function connectLectio(link: string): Promise<string | null> {
  if (!getSchoolSync().desktop) return NOT_DESKTOP;
  set((s) => ({ ...s, lectio: { ...s.lectio, phase: 'syncing', error: null } }));
  try {
    const ics = await invoke<string>('school_lectio_connect', { link });
    set((s) => ({ ...s, conn: { ...(s.conn ?? { moodle: { connected: false, site: null } }), lectio: true } }));
    keepLectio(ics);
    return null;
  } catch (e) {
    const msg = lectioErrorText(errText(e));
    set((s) => ({ ...s, lectio: { ...s.lectio, phase: 'idle', error: null } }));
    return msg;
  }
}

let lectioRun: Promise<void> | null = null;

export function refreshLectio(): Promise<void> {
  const s0 = getSchoolSync();
  if (!s0.desktop || !s0.conn?.lectio) return Promise.resolve();
  if (!lectioRun) {
    set((s) => ({ ...s, lectio: { ...s.lectio, phase: 'syncing' } }));
    lectioRun = invoke<string>('school_lectio_fetch')
      .then(keepLectio)
      .catch((e) => set((s) => ({ ...s, lectio: { ...s.lectio, phase: 'error', error: lectioErrorText(errText(e)) } })))
      .finally(() => { lectioRun = null; });
  }
  return lectioRun;
}

export async function disconnectLectio(): Promise<string | null> {
  try {
    await invoke('school_lectio_disconnect');
  } catch (e) {
    return errText(e);
  }
  writeCache(LECTIO_CACHE_KEY, null);
  set((s) => ({ ...s, conn: s.conn ? { ...s.conn, lectio: false } : s.conn, lectio: { phase: 'idle', error: null, cache: null } }));
  return null;
}

// ── LearnIT (Moodle) ─────────────────────────────────────────────────────────

const call = (fn: string, params: Record<string, string> = {}) => invoke<unknown>('school_moodle_call', { function: fn, params });

/** Runs `fn` over `items`, `n` at a time; a failed item is null and the rest go on. */
async function eachLimit<T, R>(items: readonly T[], n: number, fn: (t: T) => Promise<R>): Promise<(R | null)[]> {
  const out: (R | null)[] = new Array(items.length).fill(null);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try { out[i] = await fn(items[i]); } catch { out[i] = null; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

/**
 * Everything the School views read from Moodle, in one pass. A part the
 * site's service does not offer is listed as unavailable so its view can say
 * so; a part that fails this time keeps what the last pass found.
 */
export async function fetchMoodle(prev: MoodleData | null): Promise<MoodleData> {
  const site = readSiteInfo(await call('core_webservice_get_site_info'));
  if (!site) throw new Error('not-moodle');
  const offers = (fn: string) => !site.functions.length || site.functions.includes(fn);
  const unavailable: string[] = [];
  const part = async <T>(name: string, fn: string, run: () => Promise<T>, fallback: T): Promise<T> => {
    if (!offers(fn)) { unavailable.push(name); return fallback; }
    try { return await run(); } catch { return fallback; }
  };

  const courses = await part('courses', 'core_enrol_get_users_courses',
    async () => readCourses(await call('core_enrol_get_users_courses', { userid: String(site.userId) })).slice(0, 40), prev?.courses ?? []);
  const courseIds = courses.map((c) => c.id);

  const [assignments, materials, conversations, grades] = await Promise.all([
    part('assignments', 'mod_assign_get_assignments', async () => {
      if (!courseIds.length) return [];
      const params: Record<string, string> = {};
      courseIds.forEach((id, i) => { params[`courseids[${i}]`] = String(id); });
      return readAssignments(await call('mod_assign_get_assignments', params));
    }, prev?.assignments ?? []),
    part('materials', 'core_course_get_contents', async () => {
      const per = await eachLimit(courseIds, 4, async (id) => readContents(id, await call('core_course_get_contents', { courseid: String(id) })));
      return per.flatMap((m, i) => m ?? prev?.materials.filter((x) => x.courseId === courseIds[i]) ?? []);
    }, prev?.materials ?? []),
    part('messages', 'core_message_get_conversations', async () => readConversations(await call('core_message_get_conversations', { userid: String(site.userId), limitnum: '40' }), site.userId), prev?.conversations ?? []),
    part('grades', 'gradereport_user_get_grade_items', async () => {
      const per = await eachLimit(courseIds, 4, async (id) => readGradeItems(id, await call('gradereport_user_get_grade_items', { courseid: String(id), userid: String(site.userId) })));
      return per.flatMap((g, i) => g ?? prev?.grades.filter((x) => x.courseId === courseIds[i]) ?? []);
    }, prev?.grades ?? []),
  ]);

  return { site, courses, assignments, materials, conversations, grades, unavailable };
}

let moodleRun: Promise<void> | null = null;

export function refreshMoodle(): Promise<void> {
  const s0 = getSchoolSync();
  if (!s0.desktop || !s0.conn?.moodle.connected) return Promise.resolve();
  if (!moodleRun) {
    set((s) => ({ ...s, moodle: { ...s.moodle, phase: 'syncing' } }));
    moodleRun = fetchMoodle(s0.moodle.cache?.data ?? null)
      .then((data) => {
        const cache: MoodleCache = { fetchedAt: Date.now(), site: getSchoolSync().conn?.moodle.site ?? '', data };
        writeCache(MOODLE_CACHE_KEY, cache);
        set((s) => ({ ...s, moodle: { phase: 'idle', error: null, cache } }));
      })
      .catch((e) => set((s) => ({ ...s, moodle: { ...s.moodle, phase: 'error', error: moodleErrorText(errText(e)) } })))
      .finally(() => { moodleRun = null; });
  }
  return moodleRun;
}

/**
 * Hands the site and the key to Rust, which checks them against the site
 * before keeping either. The key is not kept here: the caller clears its field.
 */
export async function connectMoodle(site: string, token: string): Promise<string | null> {
  if (!getSchoolSync().desktop) return NOT_DESKTOP;
  try {
    await invoke('school_moodle_connect', { site, token });
  } catch (e) {
    return moodleErrorText(errText(e));
  }
  const conn = await loadConnections();
  if (!conn?.moodle.connected) return 'LearnIT accepted the key, but Atlas could not keep it in the Keychain.';
  await refreshMoodle();
  return null;
}

export async function disconnectMoodle(): Promise<string | null> {
  try {
    await invoke('school_moodle_disconnect');
  } catch (e) {
    return errText(e);
  }
  writeCache(MOODLE_CACHE_KEY, null);
  set((s) => ({ ...s, conn: s.conn ? { ...s.conn, moodle: { connected: false, site: null } } : s.conn, moodle: { phase: 'idle', error: null, cache: null } }));
  return null;
}

/**
 * One material's text, for cards or for preparing. Rust fetches it with the
 * token and refuses anything that is not text; the reason comes back said
 * plainly, so the screen can offer pasting instead.
 */
export async function readMoodleText(url: string): Promise<{ text: string } | { error: string }> {
  try {
    const r = await invoke<{ mime: string; text: string }>('school_moodle_file', { url });
    const text = /html/.test(r.mime) ? htmlToText(r.text) : r.text.trim();
    return text ? { text } : { error: 'There is no text in this file.' };
  } catch (e) {
    const err = errText(e);
    if (err.startsWith('not-text')) return { error: 'Atlas can only read text and web pages, not PDFs, slides or images. Paste the text instead.' };
    return { error: moodleErrorText(err) };
  }
}

/** The connections, as the hourly loop sees them. */
export function staleness(now: number): { lectio: number | null; moodle: number | null } {
  const s = getSchoolSync();
  return {
    lectio: s.conn?.lectio ? now - (s.lectio.cache?.fetchedAt ?? 0) : null,
    moodle: s.conn?.moodle.connected ? now - (s.moodle.cache?.fetchedAt ?? 0) : null,
  };
}

export function _resetSchoolSync(): void {
  state = null;
  connLoad = null;
  lectioRun = null;
  moodleRun = null;
}
