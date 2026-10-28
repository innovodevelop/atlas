/**
 * Materials (`Atlas School Beta.dc.html`, "Materialer"): what the student's
 * teachers shared on LearnIT, per course, with a search. A material opens on
 * LearnIT; one Atlas can read as text (a page, a text file) can also become
 * card drafts, which the student keeps or discards — nothing is added to
 * Cards before Keep.
 *
 * What leaves the Mac: the file request to the Moodle site when a material is
 * read, and its text, to the brain, when the student asks for cards.
 */
import { useMemo, useState } from 'react';
import { cardsPrompt, parseCardDrafts, shortDate, uid } from '@/lib/betaSchool';
import { PREP_TEXT_MAX } from '@/lib/betaSchoolAtlas';
import { courseColour } from '@/lib/betaSchoolIcs';
import { isReadable, type MoodleFile, type MoodleMaterial } from '@/lib/betaSchoolMoodle';
import { readMoodleText, useSchoolSync } from '@/lib/betaSchoolSync';
import { openExternal } from '@/components/atlas-ui/answerViews/openExternal';
import { keepCards } from './schoolActions';
import { NeedsSchool, SyncLine } from './SchoolBits';
import { useAsk, type SchoolToast } from './useSchoolHooks';
import type { SchoolTab } from './schoolTabs';

const KIND: Record<string, string> = { resource: 'File', page: 'Page', url: 'Link', folder: 'Folder', book: 'Book' };

export function SchoolMaterials({ onTab, onToast }: { onTab: (t: SchoolTab) => void; onToast: SchoolToast }) {
  const sync = useSchoolSync();
  const data = sync.moodle.cache?.data ?? null;
  const [q, setQ] = useState('');
  const [course, setCourse] = useState<number | 'all'>('all');
  const [openId, setOpenId] = useState<number | null>(null);
  const courseName = (id: number) => data?.courses.find((c) => c.id === id)?.name ?? '';

  const mats = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (data?.materials ?? []).filter((m) => (course === 'all' || m.courseId === course)
      && (!needle || `${m.name} ${m.section} ${m.description} ${m.files.map((f) => f.name).join(' ')}`.toLowerCase().includes(needle)));
  }, [data, q, course]);
  const open = openId !== null ? data?.materials.find((m) => m.id === openId) ?? null : null;

  if (!sync.conn?.moodle.connected && !data) {
    return <NeedsSchool source="LearnIT" line="Materials come from your courses on LearnIT. Connect it and everything your teachers shared shows here, per course." onTab={onTab} />;
  }
  if (data?.unavailable.includes('materials')) {
    return <p className="b-sc-banner"><b>This site does not share course contents with your key.</b> <span>Open your materials on LearnIT.</span></p>;
  }

  return (
    <div className="b-sc-mats">
      <div className="b-sc-sched-bar">
        <input className="b-sc-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search materials" aria-label="Search materials" />
        <div className="b-sc-chips">
          <button type="button" className={`b-sc-chip${course === 'all' ? ' on' : ''}`} onClick={() => setCourse('all')}>All</button>
          {(data?.courses ?? []).map((c) => (
            <button type="button" key={c.id} className={`b-sc-chip${course === c.id ? ' on' : ''}`} onClick={() => setCourse(c.id)}>{c.short || c.name}</button>
          ))}
        </div>
      </div>
      {open ? <MaterialOpen key={open.id} m={open} course={courseName(open.courseId)} onClose={() => setOpenId(null)} onToast={onToast} /> : null}
      <section className="b-sc-card b-sc-mat-grid" aria-label="Materials">
        {mats.map((m) => (
          <button type="button" key={m.id} className={`b-sc-mat${openId === m.id ? ' on' : ''}`} onClick={() => setOpenId(m.id)}>
            <i style={{ background: courseColour(courseName(m.courseId) || m.name) }} />
            <span><b>{m.name}</b><span>{[courseName(m.courseId), KIND[m.kind] ?? m.kind, m.modified ? shortDate(m.modified) : m.section].filter(Boolean).join(' · ')}</span></span>
          </button>
        ))}
        {!mats.length ? <div className="b-sc-empty">{data ? (q || course !== 'all' ? 'Nothing matches.' : 'No materials on LearnIT.') : 'Fetching your materials…'}</div> : null}
      </section>
      <SyncLine which="moodle" />
    </div>
  );
}

function MaterialOpen({ m, course, onClose, onToast }: { m: MoodleMaterial; course: string; onClose: () => void; onToast: SchoolToast }) {
  const atlas = useAsk();
  const [reading, setReading] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<{ id: string; front: string; back: string }[]>([]);

  const makeCards = async (f: MoodleFile) => {
    setErr(null);
    setDrafts([]);
    setReading(f.url);
    const r = await readMoodleText(f.url);
    setReading(null);
    if ('error' in r) { setErr(r.error); return; }
    const answer = await atlas.ask(cardsPrompt(r.text.slice(0, PREP_TEXT_MAX)));
    if (answer === null) return;
    const parsed = parseCardDrafts(answer);
    if (!parsed.length) { setErr('Atlas read it but drafted no cards from it.'); return; }
    setDrafts(parsed.map((d) => ({ ...d, id: uid('draft') })));
  };

  const keep = (ids: string[]) => {
    const picked = drafts.filter((d) => ids.includes(d.id));
    if (!picked.length) return;
    const { undo } = keepCards(course || m.name, picked);
    setDrafts((list) => list.filter((d) => !ids.includes(d.id)));
    onToast(`${picked.length} ${picked.length === 1 ? 'card' : 'cards'} added to ${course || m.name}`, undo);
  };

  return (
    <section className="b-sc-card b-sc-mat-open" aria-label={m.name}>
      <div className="b-sc-panel-head">
        <span className="b-sc-h3">{m.name}</span>
        <button type="button" className="b-sc-x" aria-label="Close" onClick={onClose}>×</button>
      </div>
      <span className="b-sc-muted">{[course, m.section].filter(Boolean).join(' · ')}</span>
      {m.description ? <p className="b-sc-brief">{m.description}</p> : null}
      {m.files.map((f) => (
        <div key={f.url} className="b-sc-file">
          <b>{f.name}</b>
          {isReadable(f.mime) ? (
            <button type="button" className="b-btn b-btn--tinted b-btn--row" disabled={atlas.busy || reading !== null} onClick={() => void makeCards(f)}>
              {reading === f.url ? 'Reading…' : atlas.busy ? 'Drafting…' : 'Draft cards'}
            </button>
          ) : <span>Atlas cannot read this file</span>}
        </div>
      ))}
      <div className="b-sc-row-actions">
        {m.url ? <button type="button" className="b-btn b-btn--card b-btn--row" onClick={() => void openExternal(m.url)}>Open on LearnIT</button> : null}
      </div>
      {err ? <p className="b-sc-err" role="alert">{err}</p> : null}
      {atlas.error ? <p className="b-sc-err" role="alert">{atlas.error}</p> : null}
      {drafts.length ? (
        <div className="b-sc-drafts">
          <div className="b-sc-row-actions"><span className="b-sc-label">{drafts.length} drafts · nothing is added until you keep it</span><button type="button" className="b-btn b-btn--primary b-btn--row" onClick={() => keep(drafts.map((d) => d.id))}>Keep all</button></div>
          {drafts.map((d) => (
            <div key={d.id} className="b-sc-draft">
              <span><b>{d.front}</b><span>{d.back}</span></span>
              <span className="b-sc-row-actions">
                <button type="button" className="b-btn b-btn--card b-btn--row" onClick={() => keep([d.id])}>Keep</button>
                <button type="button" className="b-btn b-btn--ghost b-btn--row" onClick={() => setDrafts((list) => list.filter((x) => x.id !== d.id))}>Discard</button>
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
