/**
 * Small pieces the School views that draw school data share: the empty state
 * that says which connection a view needs, and the line that says when the
 * data was fetched, with Refresh and the last error.
 */
import { hhmm, shortDate, startOfDay } from '@/lib/betaSchool';
import { refreshLectio, refreshMoodle, useSchoolSync } from '@/lib/betaSchoolSync';
import type { SchoolTab } from './schoolTabs';

export function NeedsSchool({ source, line, onTab }: { source: 'Lectio' | 'LearnIT'; line: string; onTab: (t: SchoolTab) => void }) {
  return (
    <section className="b-sc-card b-sc-needs" aria-label={`Connect ${source}`}>
      <span className="b-sc-h3">Connect {source}</span>
      <p className="b-sc-muted">{line}</p>
      <button type="button" className="b-btn b-btn--primary b-btn--row" onClick={() => onTab('school')}>Connect {source}</button>
    </section>
  );
}

const updated = (ms: number, now: number) => (startOfDay(ms) === startOfDay(now) ? `today ${hhmm(ms)}` : `${shortDate(ms)} ${hhmm(ms)}`);

export function SyncLine({ which }: { which: 'lectio' | 'moodle' }) {
  const sync = useSchoolSync();
  const part = sync[which];
  const name = which === 'lectio' ? 'Lectio' : 'LearnIT';
  const busy = part.phase === 'syncing';
  return (
    <div className="b-sc-syncline">
      <span>{part.cache ? `From ${name} · updated ${updated(part.cache.fetchedAt, Date.now())}` : `Waiting for ${name}…`}</span>
      <button type="button" className="b-btn b-btn--card b-btn--row" disabled={busy} onClick={() => void (which === 'lectio' ? refreshLectio() : refreshMoodle())}>{busy ? 'Refreshing…' : 'Refresh'}</button>
      {part.error ? <span className="b-sc-err" role="alert">{part.error}</span> : null}
    </div>
  );
}
