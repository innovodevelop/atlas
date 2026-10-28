/**
 * Edit Home — the full-screen editor from `Atlas Dashboard Beta.dc.html`
 * ("Edit Home"): drag to reorder, pick a size, × to remove, a capacity meter
 * against the stage's row budget, Add widgets with search, Home settings,
 * the layout switch, Reset, and Cancel that restores what was there.
 *
 * The draft lives in `editorReducer` (src/lib/betaHome.ts) and nothing is
 * written until Done; the page owns persistence.
 */
import { useMemo, useReducer, useState, type DragEvent } from 'react';
import {
  SETTING_COPY, SPANS, WIDGETS, WIDGET_BY_ID, capacity, editorReducer, openEditor, overflowIds,
  type EditorState, type HomeLayout, type HomeSettings, type HomeSlot, type WidgetGroup, type WidgetSize,
} from '@/lib/betaHome';

export interface EditHomeProps {
  slots: readonly HomeSlot[];
  layout: HomeLayout;
  settings: HomeSettings;
  /** Rows the stage has at this window size. */
  rows: number;
  onDone: (next: { slots: HomeSlot[]; layout: HomeLayout; settings: HomeSettings }) => void;
  onCancel: () => void;
}

const LAYOUTS: { k: HomeLayout; t: string; d: string }[] = [
  { k: 'stage', t: 'Stage', d: 'The moment first, widgets below' },
  { k: 'grid', t: 'Grid', d: 'The classic grid, widgets in reading order' },
  { k: 'centred', t: 'Centred', d: 'Atlas in the middle, widgets around it' },
];

// 'Work' holds the admin edition's developer widgets; a consumer build has none, so the group drops out.
const GROUP_ORDER: WidgetGroup[] = ['Day', 'Communication', 'Money', 'Body', 'Home', 'Media', 'Air & time', 'Work'];

export function EditHome({ slots, layout, settings, rows, onDone, onCancel }: EditHomeProps) {
  const [state, dispatch] = useReducer(editorReducer, undefined, () => openEditor(slots, layout, settings) as EditorState);
  const [query, setQuery] = useState('');
  const [dragging, setDragging] = useState<string | null>(null);
  const cap = capacity(state.slots, rows);
  const over = overflowIds(state.slots, rows);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    return GROUP_ORDER.map((g) => ({
      label: g,
      items: WIDGETS.filter((w) => w.group === g && (!q || w.label.toLowerCase().includes(q) || w.meta.toLowerCase().includes(q))),
    })).filter((g) => g.items.length);
  }, [query]);
  const onCount = state.slots.length;

  const onDragStart = (id: string) => (e: DragEvent) => { setDragging(id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', id); };
  const onDragOver = (e: DragEvent) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; };
  const onDrop = (before: string | null) => (e: DragEvent) => {
    e.preventDefault();
    const id = dragging ?? e.dataTransfer.getData('text/plain');
    if (id && id !== before) dispatch({ type: 'move', id, before });
    setDragging(null);
  };

  return (
    <div className="b-editor" role="dialog" aria-label="Edit Home">
      <header className="b-editor-head">
        <div className="b-editor-title">
          <span className="b-eyebrow b-eyebrow--onink">Editing Home</span>
          <span className="b-editor-h">{cap.over ? 'Too much for this window' : 'Your Home, your order'}</span>
        </div>
        <div className="b-seg b-seg--onink" role="radiogroup" aria-label="Layout">
          {LAYOUTS.map((l) => (
            <button type="button" key={l.k} role="radio" aria-checked={state.layout === l.k} className={state.layout === l.k ? 'on' : ''} title={l.d} onClick={() => dispatch({ type: 'layout', layout: l.k })}>{l.t}</button>
          ))}
        </div>
        <button type="button" className="b-btn b-btn--onink" onClick={() => dispatch({ type: 'reset' })}>Reset</button>
        <button type="button" className="b-btn b-btn--onink" onClick={() => { dispatch({ type: 'cancel' }); onCancel(); }}>Cancel</button>
        <button type="button" className="b-btn b-btn--paper" onClick={() => onDone({ slots: state.slots, layout: state.layout, settings: state.settings })}>Done</button>
      </header>

      <div className="b-editor-body">
        <section className="b-editor-main">
          <div className="b-editor-band"><span className="b-editor-band-orb" /><span><b>Stage band</b><span>Atlas, greeting and Now in focus. Always first, not editable here.</span></span></div>
          <div className="b-editor-cap">
            <b>Your widgets</b><span>Drag to reorder · pick a size · × to remove</span>
            <span className={`b-editor-cap-n b-num tone-${cap.tone}`}>{cap.label}</span>
          </div>
          <div className="b-editor-meter"><span className={`tone-${cap.tone}`} style={{ width: `${Math.min(100, Math.round((cap.used / Math.max(1, cap.total)) * 100))}%` }} /></div>
          <div className="b-editor-grid" onDragOver={onDragOver} onDrop={onDrop(null)}>
            {state.slots.map((s) => {
              const def = WIDGET_BY_ID.get(s.id);
              if (!def) return null;
              const [c, r] = SPANS[s.size];
              return (
                <div
                  key={s.id}
                  className={`b-editor-card${dragging === s.id ? ' dragging' : ''}${over.has(s.id) ? ' over' : ''}`}
                  style={{ gridColumn: `span ${c}`, gridRow: `span ${r}` }}
                  draggable
                  onDragStart={onDragStart(s.id)}
                  onDragOver={onDragOver}
                  onDrop={onDrop(s.id)}
                  onDragEnd={() => setDragging(null)}
                >
                  <div className="b-editor-card-head">
                    <span className="b-editor-grip" aria-hidden>⋮⋮</span>
                    <span className="b-editor-card-text"><b>{def.label}</b><span>{def.meta}</span></span>
                    <button type="button" className="b-editor-x" aria-label={`Remove ${def.label}`} onClick={() => dispatch({ type: 'remove', id: s.id })}>×</button>
                  </div>
                  {over.has(s.id) ? <span className="b-editor-warn">Won’t fit at this window size</span> : null}
                  <div className="b-editor-sizes">
                    {def.sizes.map((z: WidgetSize) => (
                      <button type="button" key={z} className={z === s.size ? 'on' : ''} title={`${SPANS[z][0]} × ${SPANS[z][1]}`} onClick={() => dispatch({ type: 'size', id: s.id, size: z })}>{z}</button>
                    ))}
                  </div>
                </div>
              );
            })}
            {state.slots.length === 0 ? <div className="b-editor-empty">Nothing below the band. Add a widget from the right.</div> : null}
          </div>
        </section>

        <aside className="b-editor-side">
          <section className="b-editor-panel b-editor-panel--card">
            <div className="b-editor-panel-head"><span className="b-card-title">Add widgets</span><span className="bw-meta b-num">{onCount} on Home</span></div>
            <input className="b-input" placeholder="Search widgets" aria-label="Search widgets" value={query} onChange={(e) => setQuery(e.target.value)} />
            {groups.map((g) => (
              <div key={g.label} className="b-editor-group">
                <span className="b-editor-group-l">{g.label}</span>
                {g.items.map((w) => {
                  const on = state.slots.some((s) => s.id === w.id);
                  const unwired = w.source === 'unwired';
                  return (
                    <div key={w.id} className={`b-editor-add${on ? ' on' : ''}`}>
                      <span className="b-editor-card-text"><b>{w.label}</b><span>{w.meta}</span></span>
                      <button
                        type="button"
                        className={`b-btn b-btn--row${on ? ' b-btn--ghost' : ' b-btn--tinted'}`}
                        disabled={unwired && !on}
                        title={unwired ? 'Not wired to a source yet' : undefined}
                        onClick={() => dispatch(on ? { type: 'remove', id: w.id } : { type: 'add', id: w.id })}
                      >{on ? 'Remove' : unwired ? 'Soon' : 'Add'}</button>
                    </div>
                  );
                })}
              </div>
            ))}
            {groups.length === 0 ? <p className="b-editor-nohits">No widget by that name. The Widget Catalog has everything Atlas can show.</p> : null}
          </section>
          <section className="b-editor-panel">
            <span className="b-card-title">Home settings</span>
            {(Object.keys(SETTING_COPY) as (keyof HomeSettings)[]).map((k) => (
              <div key={k} className="b-editor-setting">
                <span className="b-editor-card-text"><b>{SETTING_COPY[k].t}</b><span>{SETTING_COPY[k].d}</span></span>
                <button type="button" className="b-btn b-btn--row b-btn--tinted" onClick={() => dispatch({ type: 'setting', key: k })}>{state.settings[k]}</button>
              </div>
            ))}
          </section>
        </aside>
      </div>
    </div>
  );
}
