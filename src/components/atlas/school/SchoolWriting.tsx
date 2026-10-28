/**
 * Writing — the School Tools editor (`Atlas School Tools Beta.dc.html`,
 * "Skrivning").
 *
 * The student's own documents, kept on this Mac, written section by section:
 * a line that starts with "# " is a heading, and each heading's text is its
 * own field under it (betaSchoolSections.ts). The document stays one plain
 * string underneath, so typing "# " on a new line starts a section and
 * removing a heading joins its text to the section above.
 *
 * Atlas helps from the margin, never in the page. "Ask Atlas" rewrites the
 * selected passage (or the whole text) shorter, clearer or more formal and
 * shows the result as a draft beside the page; it goes into the text only when
 * the student chooses "Use this", and the length card then stops saying that
 * every word is theirs. Margin notes are questions and pointers, never
 * rewrites, each numbered and anchored to the section it is about: the number
 * also marks that section, and clicking either one points at the other.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  REWRITES, cleanRewrite, lengthState, rewritePrompt, shortDate, uid, wordCount,
  type Doc, type MarginNote, type RewriteMode,
} from '@/lib/betaSchool';
import { anchoredMarginPrompt, parseAnchoredNotes } from '@/lib/betaSchoolAtlas';
import {
  appendSection, parseSections, placeNotes, removeHeading, renameHeading, replaceSectionText, sectionsForPrompt,
  type Section,
} from '@/lib/betaSchoolSections';
import { updateSchool, useSchool } from '@/lib/betaSchoolStore';
import { useAsk, type SchoolToast } from './useSchoolHooks';

interface Draft { mode: RewriteMode; start: number; end: number; original: string; text: string; done: boolean }

function patchDoc(id: string, fn: (d: Doc) => Doc) {
  updateSchool((s) => ({ ...s, docs: s.docs.map((d) => (d.id === id ? fn(d) : d)) }));
}

const numOrNull = (v: string): number | null => {
  const n = Math.round(Number(v));
  return v.trim() && Number.isFinite(n) && n > 0 ? n : null;
};

/** How long a pointed-at note or section stays marked. */
const MARK_MS = 1400;

/** One section's field: it grows with its text instead of scrolling inside a box. */
function SectionField({ s, onText, onSelect, fieldRef, marked, placeholder }: {
  s: Section;
  onText: (v: string) => void;
  onSelect: (el: HTMLTextAreaElement) => void;
  fieldRef: (el: HTMLTextAreaElement | null) => void;
  marked: boolean;
  placeholder: string;
}) {
  const el = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    const t = el.current;
    if (!t) return;
    t.style.height = 'auto';
    t.style.height = `${t.scrollHeight}px`;
  }, [s.text]);
  const read = () => { if (el.current) onSelect(el.current); };
  return (
    <textarea
      ref={(t) => { el.current = t; fieldRef(t); }}
      className={`b-sc-page-body${marked ? ' marked' : ''}`}
      value={s.text}
      placeholder={placeholder}
      aria-label={s.heading === null ? 'Text' : `Text of ${s.heading || 'untitled section'}`}
      onChange={(e) => { onText(e.target.value); onSelect(e.target); }}
      onSelect={read}
      onKeyUp={read}
      onMouseUp={read}
    />
  );
}

export function SchoolWriting({ onToast }: { onToast: SchoolToast }) {
  const school = useSchool();
  const docs = useMemo(() => [...school.docs].sort((a, b) => b.updated - a.updated), [school.docs]);
  const [activeId, setActiveId] = useState<string | null>(() => docs[0]?.id ?? null);
  const doc = activeId ? school.docs.find((d) => d.id === activeId) ?? null : null;
  // The selection as offsets into the whole document, whichever section it is in.
  const [sel, setSel] = useState<{ start: number; end: number }>({ start: 0, end: 0 });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [markNote, setMarkNote] = useState<string | null>(null);
  const [markSection, setMarkSection] = useState<number | null>(null);
  const fields = useRef(new Map<number, HTMLTextAreaElement>());
  const markTimer = useRef<number | null>(null);
  const rewriter = useAsk();
  const reader = useAsk();
  const { cancel: stopRewrite } = rewriter;
  const { cancel: stopReading } = reader;

  useEffect(() => { if (activeId && !doc) setActiveId(docs[0]?.id ?? null); }, [activeId, doc, docs]);
  // A rewrite or notes still arriving belong to the document they were asked about.
  useEffect(() => {
    stopRewrite();
    stopReading();
    setDraft(null);
    setSel({ start: 0, end: 0 });
  }, [activeId, stopRewrite, stopReading]);
  useEffect(() => () => { if (markTimer.current) window.clearTimeout(markTimer.current); }, []);

  const text = doc?.body ?? '';
  const sections = useMemo(() => parseSections(text), [text]);
  const placed = useMemo(() => placeNotes(doc?.notes ?? [], sections), [doc?.notes, sections]);

  const create = () => {
    const d: Doc = { id: uid('doc'), title: '', body: '', updated: Date.now(), min: null, max: null, atlasEdits: 0, notes: [] };
    updateSchool((s) => ({ ...s, docs: [...s.docs, d] }));
    setActiveId(d.id);
  };

  const remove = (d: Doc) => {
    updateSchool((s) => ({ ...s, docs: s.docs.filter((x) => x.id !== d.id) }));
    onToast(`Deleted “${d.title || 'Untitled'}”`, () => updateSchool((s) => ({ ...s, docs: [...s.docs, d] })));
  };

  const setBody = (fn: (body: string) => string) => {
    if (!doc) return;
    patchDoc(doc.id, (d) => ({ ...d, body: fn(d.body), updated: Date.now() }));
  };

  const hasSelection = sel.end > sel.start;
  const passage = hasSelection ? text.slice(sel.start, sel.end) : text;

  const rewrite = async (mode: RewriteMode) => {
    if (!doc || !passage.trim()) return;
    const start = hasSelection ? sel.start : 0;
    const end = hasSelection ? sel.end : text.length;
    const original = text.slice(start, end);
    setDraft({ mode, start, end, original, text: '', done: false });
    const out = await rewriter.ask(rewritePrompt(original, mode), (partial) => setDraft((d) => (d ? { ...d, text: partial } : d)));
    if (out === null) { setDraft(null); return; }
    setDraft((d) => (d ? { ...d, text: cleanRewrite(out), done: true } : d));
  };

  const applyDraft = () => {
    if (!doc || !draft) return;
    const current = doc.body;
    // The student may have kept typing while Atlas wrote; only replace the passage if it is still there as it was.
    if (current.slice(draft.start, draft.end) !== draft.original) {
      onToast('The text changed while Atlas was writing. Copy the draft instead.');
      return;
    }
    const before = { body: current, atlasEdits: doc.atlasEdits };
    const next = current.slice(0, draft.start) + draft.text + current.slice(draft.end);
    patchDoc(doc.id, (d) => ({ ...d, body: next, atlasEdits: d.atlasEdits + 1, updated: Date.now() }));
    setDraft(null);
    setSel({ start: 0, end: 0 });
    const id = doc.id;
    onToast('Atlas’s rewrite is in your text', () => patchDoc(id, (d) => ({ ...d, ...before, updated: Date.now() })));
  };

  const copy = async (value: string, what: string) => {
    try {
      await navigator.clipboard.writeText(value);
      onToast(`${what} copied`);
    } catch {
      onToast('Copying is not allowed here. Select the text and copy it yourself.');
    }
  };

  /** Notes are kept with the document, each anchored to its section by heading ('' before the first heading). */
  const askNotes = async () => {
    if (!doc || !text.trim()) return;
    const id = doc.id;
    const asked = sections;
    const out = await reader.ask(anchoredMarginPrompt(doc.title, sectionsForPrompt(asked), asked.length));
    if (out === null) return;
    const notes: MarginNote[] = parseAnchoredNotes(out, asked.length).map((n) => {
      const s = n.section !== null ? asked[n.section - 1] : null;
      return { id: uid('note'), text: n.text, anchor: s ? s.heading ?? '' : null };
    });
    patchDoc(id, (d) => ({ ...d, notes }));
    if (!notes.length) onToast('Nothing to point out right now. Keep writing.');
  };

  const dismissNote = (id: string) => {
    if (!doc) return;
    const docId = doc.id;
    const before = doc.notes;
    patchDoc(docId, (d) => ({ ...d, notes: d.notes.filter((n) => n.id !== id) }));
    onToast('Note dismissed', () => patchDoc(docId, (d) => ({ ...d, notes: before })));
  };

  const mark = (note: string | null, section: number | null) => {
    setMarkNote(note);
    setMarkSection(section);
    if (markTimer.current) window.clearTimeout(markTimer.current);
    markTimer.current = window.setTimeout(() => { setMarkNote(null); setMarkSection(null); }, MARK_MS);
  };

  /** The note's number in the margin points at its section: the field is focused and marked. */
  const pointAtSection = (note: MarginNote, section: Section | null) => {
    mark(note.id, section?.index ?? null);
    if (section) fields.current.get(section.index)?.focus();
  };

  /** A number beside a heading points at its note in the margin. */
  const pointAtNote = (note: MarginNote, section: Section) => {
    mark(note.id, section.index);
    document.getElementById(`b-sc-note-${note.id}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };

  if (!doc) {
    return (
      <section className="b-sc-card b-sc-blank" aria-label="Writing">
        <span className="b-sc-h2">Write something of your own</span>
        <p className="b-sc-muted">A plain page in sections, kept on this Mac. Atlas can rewrite a passage you choose, or leave questions in the margin; it never writes into your text unless you say so.</p>
        <button type="button" className="b-btn b-btn--primary" onClick={create}>New document</button>
      </section>
    );
  }

  const words = wordCount(text.replace(/^#{1,3}[ \t]+/gm, ''));
  const state = lengthState(words, doc.min, doc.max);
  const goal = doc.max ?? doc.min;
  const pct = goal ? Math.min(100, Math.round((words / goal) * 100)) : 0;
  const draftLabel = REWRITES.find((r) => r.key === draft?.mode)?.label ?? '';
  const titled = sections.some((s) => s.heading !== null);

  return (
    <div className="b-sc-tools">
      <section className="b-sc-page" aria-label="Your document">
        <input
          className="b-sc-page-title"
          value={doc.title}
          placeholder="Title"
          aria-label="Title"
          onChange={(e) => { const v = e.target.value; patchDoc(doc.id, (d) => ({ ...d, title: v, updated: Date.now() })); }}
        />
        {sections.map((s) => {
          const mine = placed.filter((p) => p.section?.index === s.index);
          return (
            <div key={s.index} className="b-sc-sec">
              {s.heading !== null || (titled && s.text) || mine.length ? (
                <div className="b-sc-sec-head">
                  {s.heading !== null ? (
                    <input
                      className="b-sc-sec-name"
                      value={s.heading}
                      placeholder="Section heading"
                      aria-label="Section heading"
                      onChange={(e) => { const v = e.target.value; setBody((b) => renameHeading(b, parseSections(b)[s.index] ?? s, v)); }}
                    />
                  ) : <span className="b-sc-sec-name">Before the first heading</span>}
                  {mine.map((p) => (
                    <button type="button" key={p.note.id} className={`b-sc-margin-n${markNote === p.note.id ? ' on' : ''}`} aria-label={`Note ${p.n}`} onClick={() => pointAtNote(p.note, s)}>{p.n}</button>
                  ))}
                  {s.heading !== null ? (
                    <button type="button" className="b-sc-x" aria-label={`Remove the heading ${s.heading || 'untitled'}`} title="Remove the heading; its text joins the section above" onClick={() => setBody((b) => removeHeading(b, parseSections(b)[s.index] ?? s))}>×</button>
                  ) : null}
                </div>
              ) : null}
              <SectionField
                s={s}
                marked={markSection === s.index}
                placeholder={s.index === 0 && !titled ? 'Start writing. A line that starts with “# ” begins a new section.' : 'Write this section.'}
                fieldRef={(el) => { if (el) fields.current.set(s.index, el); else fields.current.delete(s.index); }}
                onText={(v) => setBody((b) => replaceSectionText(b, parseSections(b)[s.index] ?? s, v))}
                onSelect={(el) => setSel({ start: s.textStart + el.selectionStart, end: s.textStart + el.selectionEnd })}
              />
            </div>
          );
        })}
        <button type="button" className="b-btn b-btn--ghost b-btn--row b-sc-addsec" onClick={() => setBody((b) => appendSection(b, 'New section'))}>+ Section</button>
      </section>

      <aside className="b-sc-side">
        <section className="b-sc-length" data-beta-tone="ink" aria-label="Length">
          <div className="b-sc-length-head">
            <span className="b-eyebrow b-eyebrow--onink">Length</span>
            <span className="b-sc-length-target">
              <input type="number" min={1} value={doc.min ?? ''} placeholder="min" aria-label="Fewest words" onChange={(e) => { const v = numOrNull(e.target.value); patchDoc(doc.id, (d) => ({ ...d, min: v })); }} />
              –
              <input type="number" min={1} value={doc.max ?? ''} placeholder="max" aria-label="Most words" onChange={(e) => { const v = numOrNull(e.target.value); patchDoc(doc.id, (d) => ({ ...d, max: v })); }} />
              words
            </span>
          </div>
          <span className="b-sc-length-n b-num">{words} <small>{words === 1 ? 'word' : 'words'}</small></span>
          {goal ? <span className="b-sc-length-bar"><span className={state} style={{ width: `${pct}%` }} /></span> : null}
          <span className="b-sc-length-line">
            {doc.atlasEdits === 0
              ? 'All written by you. Atlas has not added a word.'
              : `${doc.atlasEdits} Atlas ${doc.atlasEdits === 1 ? 'rewrite' : 'rewrites'} accepted into this text.`}
            {state === 'under' ? ` ${(doc.min ?? 0) - words} to go.` : state === 'over' ? ` ${words - (doc.max ?? 0)} over.` : ''}
          </span>
        </section>

        <section className="b-sc-list" aria-label="Ask Atlas">
          <div className="b-sc-list-head"><span className="b-sc-h3">Ask Atlas</span><span className="b-sc-muted">{hasSelection ? `${wordCount(passage)} selected words` : 'the whole text'}</span></div>
          <div className="b-sc-rewrites">
            {REWRITES.map((r) => (
              <button type="button" key={r.key} className="b-btn b-btn--card b-btn--row" disabled={rewriter.busy || !passage.trim()} onClick={() => void rewrite(r.key)}>{r.label}</button>
            ))}
          </div>
          {draft ? (
            <div className="b-sc-draftbox">
              <span className="b-sc-label">{draftLabel} · a draft, not in your text</span>
              <p>{draft.text || (rewriter.busy ? 'Atlas is writing…' : '')}</p>
              <div className="b-sc-row-actions">
                {draft.done ? <button type="button" className="b-btn b-btn--primary b-btn--row" onClick={applyDraft}>Use this</button> : null}
                {draft.done ? <button type="button" className="b-btn b-btn--card b-btn--row" onClick={() => void copy(draft.text, 'Draft')}>Copy</button> : null}
                <button type="button" className="b-btn b-btn--ghost b-btn--row" onClick={() => { rewriter.cancel(); setDraft(null); }}>{draft.done ? 'Discard' : 'Stop'}</button>
              </div>
            </div>
          ) : null}
          {rewriter.error ? <p className="b-sc-err" role="alert">{rewriter.error}</p> : null}

          <div className="b-sc-list-head b-sc-list-head--sub">
            <span className="b-sc-h3">Atlas in the margin</span>
            <button type="button" className="b-btn b-btn--card b-btn--row" disabled={reader.busy || !text.trim()} onClick={() => void askNotes()}>{reader.busy ? 'Reading…' : placed.length ? 'Read again' : 'Ask for notes'}</button>
          </div>
          <p className="b-sc-muted">Questions and pointers, never rewrites. Each is numbered for the section it is about.</p>
          {placed.map((p) => (
            <div key={p.note.id} id={`b-sc-note-${p.note.id}`} className={`b-sc-margin${markNote === p.note.id ? ' on' : ''}`}>
              <button type="button" className="b-sc-margin-n" aria-label={p.section ? `Go to ${p.section.heading || 'the section'}` : `Note ${p.n}`} onClick={() => pointAtSection(p.note, p.section)}>{p.n}</button>
              <p><small>{p.section ? (p.section.heading === null ? 'Before the first heading' : p.section.heading || 'Untitled section') : 'The whole text'}</small>{p.note.text}</p>
              <button type="button" className="b-sc-x" aria-label="Dismiss note" onClick={() => dismissNote(p.note.id)}>×</button>
            </div>
          ))}
          {reader.error ? <p className="b-sc-err" role="alert">{reader.error}</p> : null}
        </section>

        <section className="b-sc-list" aria-label="Your documents">
          <div className="b-sc-list-head">
            <span className="b-sc-label">Your documents</span>
            <span className="b-sc-row-actions">
              <button type="button" className="b-btn b-btn--card b-btn--row" disabled={!text.trim()} onClick={() => void copy(`${doc.title ? `${doc.title}\n\n` : ''}${text}`, 'Text')}>Copy text</button>
              <button type="button" className="b-btn b-btn--card b-btn--row" onClick={create}>New</button>
            </span>
          </div>
          {docs.map((d) => (
            <div key={d.id} className={`b-sc-list-row${d.id === doc.id ? ' on' : ''}`}>
              <button type="button" className="b-sc-list-main" onClick={() => setActiveId(d.id)}>
                <b>{d.title || 'Untitled'}</b>
                <span>{wordCount(d.body)} words · {shortDate(d.updated)}</span>
              </button>
              <button type="button" className="b-sc-x" aria-label={`Delete ${d.title || 'Untitled'}`} onClick={() => remove(d)}>×</button>
            </div>
          ))}
        </section>
      </aside>
    </div>
  );
}
