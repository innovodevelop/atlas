/**
 * Spreadsheet — the School Tools grid (`Atlas School Tools Beta.dc.html`,
 * "Regneark").
 *
 * A real small sheet, A–F by 1–12, kept on this Mac: type a number, text or a
 * formula into the bar, and the grid recomputes through `evaluateSheet` (a
 * parser, not eval). Borderless as the design draws it: a 2 px gutter of the
 * panel colour between cells, a blue fill for the selection with the one inset
 * ring, a paler blue for the ranges the selected formula reads.
 *
 * Atlas can explain a cell or look for anything odd; it reads the sheet and
 * answers beside it, and never types into a cell. "Suggest a column" asks for
 * a header and formulas for the next empty column: they show in the grid as a
 * pale draft, computed like the rest, and reach the sheet only on "Keep
 * column" (betaSchoolAtlas.ts checks Atlas can write nowhere else).
 *
 * Keys on the grid: arrows move, Enter edits, typing starts an edit, Delete
 * clears. In the bar: Enter commits and moves down, Tab moves right, Esc
 * cancels.
 */
import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  SHEET_COLS, SHEET_FUNCTIONS, SHEET_ROWS, evaluateSheet, formatCell, inRanges, isError, moveRef,
  parseRef, rangesIn, refOf, sheetPrompt, sheetText, type SheetAsk,
} from '@/lib/betaSchool';
import { columnPrompt, columnTaken, dataRows, nextEmptyColumn, parseColumn, previewColumn, type ColumnDraft } from '@/lib/betaSchoolAtlas';
import { updateSchool, useSchool } from '@/lib/betaSchoolStore';
import { useAsk, type SchoolToast } from './useSchoolHooks';

export function SchoolSheet({ onToast }: { onToast: SchoolToast }) {
  const { sheet } = useSchool();
  const [column, setColumn] = useState<ColumnDraft | null>(null);
  const preview = useMemo(() => (column ? previewColumn(sheet, column) : null), [sheet, column]);
  const values = useMemo(() => preview?.values ?? evaluateSheet(sheet), [sheet, preview]);
  const [sel, setSel] = useState('A1');
  const [edit, setEditState] = useState<string | null>(null);
  // Mirrored in a ref: the bar's blur fires inside the same event as Esc or
  // Enter, before the state update lands, and must see the edit as already
  // finished rather than commit it a second time (or commit a cancelled one).
  const editRef = useRef<string | null>(null);
  const setEdit = (v: string | null) => { editRef.current = v; setEditState(v); };
  const [answer, setAnswer] = useState<{ title: string; text: string } | null>(null);
  const grid = useRef<HTMLDivElement | null>(null);
  const bar = useRef<HTMLInputElement | null>(null);
  const atlas = useAsk();

  const raw = sheet[sel] ?? '';
  const shown = edit ?? raw;
  const ranges = useMemo(() => rangesIn(edit ?? raw), [edit, raw]);
  const selPos = parseRef(sel) ?? { col: 0, row: 1 };
  const selValue = values[sel];

  const commit = (value: string | null = editRef.current) => {
    if (value === null) return;
    const v = value.trim() ? value : '';
    updateSchool((s) => {
      const next = { ...s.sheet };
      if (v) next[sel] = v; else delete next[sel];
      return { ...s, sheet: next };
    });
    setEdit(null);
  };

  const startEdit = (initial?: string) => {
    setEdit(initial ?? raw);
    requestAnimationFrame(() => {
      const el = bar.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  };

  const onGridKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // Tab is left alone so keyboard users can leave the grid.
    const moves: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (moves[e.key]) { e.preventDefault(); setSel((r) => moveRef(r, ...moves[e.key])); return; }
    if (e.key === 'Enter' || e.key === 'F2') { e.preventDefault(); startEdit(); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); if (raw) commit(''); return; }
    if (e.key.length === 1) { e.preventDefault(); startEdit(e.key); }
  };

  const onBarKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      commit(shown);
      setSel((r) => (e.key === 'Enter' ? moveRef(r, 0, e.shiftKey ? -1 : 1) : moveRef(r, e.shiftKey ? -1 : 1, 0)));
      grid.current?.focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setEdit(null);
      grid.current?.focus();
    }
  };

  const pick = (ref: string) => {
    if (editRef.current !== null) commit();
    setSel(ref);
  };

  const ask = async (kind: SheetAsk) => {
    const title = kind === 'explain' ? `What ${sel} does` : 'Anything odd?';
    // A new question drops a column draft still waiting: the answer box holds one thing at a time.
    setColumn(null);
    setAnswer({ title, text: '' });
    const text = await atlas.ask(
      sheetPrompt(kind, sheetText(sheet, evaluateSheet(sheet)), kind === 'explain' ? { ref: sel, raw, value: formatCell(selValue) } : null),
      (partial) => setAnswer({ title, text: partial }),
    );
    if (text === null) { setAnswer(null); return; }
    setAnswer({ title, text: text.trim() });
  };

  const nextCol = nextEmptyColumn(sheet);

  const suggest = async () => {
    if (nextCol === null) return;
    setColumn(null);
    const title = `A column for ${SHEET_COLS[nextCol]}`;
    setAnswer({ title, text: '' });
    const plain = evaluateSheet(sheet);
    const text = await atlas.ask(columnPrompt(sheetText(sheet, plain), nextCol, dataRows(sheet)));
    if (text === null) { setAnswer(null); return; }
    const parsed = parseColumn(text, nextCol);
    if (!parsed) { setAnswer({ title, text: 'Atlas answered, but not as a column it could draft. Try again.' }); return; }
    setColumn(parsed);
    setAnswer({ title: `Draft: ${parsed.header}`, text: parsed.why || `A new column ${SHEET_COLS[nextCol]}, pale until you keep it.` });
  };

  const keepColumn = () => {
    if (!column) return;
    if (columnTaken(sheet, column)) { onToast('You have typed in that column since. Atlas will not write over it.'); setColumn(null); return; }
    const before = sheet;
    const draft = column;
    updateSchool((s) => ({ ...s, sheet: { ...s.sheet, [refOf(draft.col, 1)]: draft.header, ...draft.cells } }));
    setColumn(null);
    setAnswer(null);
    onToast(`Column ${SHEET_COLS[draft.col]} is yours now`, () => updateSchool((s) => ({ ...s, sheet: before })));
  };

  const discardColumn = () => { setColumn(null); setAnswer(null); };

  const clear = () => {
    const before = sheet;
    updateSchool((s) => ({ ...s, sheet: {} }));
    setEdit(null);
    setAnswer(null);
    setColumn(null);
    onToast('Sheet cleared', () => updateSchool((s) => ({ ...s, sheet: before })));
  };

  const empty = Object.keys(sheet).length === 0;
  const stats = selValue === undefined
    ? `${sel} · empty`
    : typeof selValue === 'number'
      ? `${sel} = ${formatCell(selValue)}${ranges.length ? ` · reads ${ranges.map((r) => `${r.from}:${r.to}`).join(', ')}` : ''}`
      : isError(selValue) ? `${sel} · ${selValue}` : `${sel} · text`;

  return (
    <div className="b-sc-tools">
      <section className="b-sc-sheet" aria-label="Spreadsheet">
        <div className="b-sc-fbar">
          <span className="b-sc-fbar-ref b-num">{sel}</span>
          <span className="b-sc-fbar-fx b-num" aria-hidden>ƒx</span>
          <input
            ref={bar}
            className="b-num"
            value={shown}
            aria-label={`Contents of ${sel}`}
            placeholder="A number, text, or =SUM(B2:B6)"
            onChange={(e) => setEdit(e.target.value)}
            onKeyDown={onBarKey}
            onBlur={() => { if (editRef.current !== null) commit(); }}
          />
        </div>
        <div className="b-sc-grid-scroll nosb">
          <div ref={grid} className="b-sc-grid" role="grid" aria-label="Spreadsheet, A to F by 1 to 12" aria-rowcount={SHEET_ROWS + 1} aria-colcount={SHEET_COLS.length + 1} tabIndex={0} onKeyDown={onGridKey}>
            <div className="b-sc-grid-row" role="row">
              <span className="b-sc-gh" aria-hidden />
              {SHEET_COLS.map((c, ci) => <span key={c} role="columnheader" className={`b-sc-gh${ci === selPos.col ? ' on' : ''}`}>{c}</span>)}
            </div>
            {Array.from({ length: SHEET_ROWS }, (_, i) => i + 1).map((row) => (
              <div key={row} className="b-sc-grid-row" role="row">
                <span role="rowheader" className={`b-sc-gh${row === selPos.row ? ' on' : ''}`}>{row}</span>
                {SHEET_COLS.map((_, col) => {
                  const ref = refOf(col, row);
                  const v = values[ref];
                  const drafted = column ? (row === 1 && col === column.col ? column.header : column.cells[ref]) : undefined;
                  const cellRaw = sheet[ref] ?? drafted ?? '';
                  const cls = [
                    'b-sc-cell',
                    drafted !== undefined && !sheet[ref] ? 'draft' : '',
                    ref === sel ? 'sel' : inRanges(ref, ranges) ? 'range' : '',
                    typeof v === 'number' ? 'num' : '',
                    v !== undefined && isError(v) ? 'err' : '',
                    row === 1 && cellRaw ? 'head' : '',
                  ].filter(Boolean).join(' ');
                  return (
                    <button
                      type="button"
                      key={ref}
                      role="gridcell"
                      tabIndex={-1}
                      aria-selected={ref === sel}
                      aria-label={`${ref}${cellRaw ? `, ${formatCell(v)}` : ', empty'}`}
                      title={cellRaw.startsWith('=') ? cellRaw : undefined}
                      className={cls}
                      onClick={() => { pick(ref); grid.current?.focus(); }}
                      onDoubleClick={() => { pick(ref); startEdit(); }}
                    >
                      {ref === sel && edit !== null ? edit : formatCell(v)}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
        <div className="b-sc-sheet-foot">
          <span className="b-num">{stats}</span>
          <button type="button" className="b-btn b-btn--ghost b-btn--row" disabled={empty} onClick={clear}>Clear sheet</button>
        </div>
      </section>

      <aside className="b-sc-side">
        <section className="b-sc-list" aria-label="Ask Atlas about this sheet">
          <span className="b-sc-h3">Ask Atlas about this sheet</span>
          <p className="b-sc-muted">Atlas explains and proposes. Anything it suggests appears as a pale draft you keep or discard; it never types into your cells.</p>
          <button type="button" className="b-sc-askrow" disabled={atlas.busy || !raw} onClick={() => void ask('explain')}>
            <span>Explain {sel}</span><small>{raw ? 'Read-only' : 'Pick a filled cell'}</small>
          </button>
          <button type="button" className="b-sc-askrow" disabled={atlas.busy || empty} onClick={() => void ask('check')}>
            <span>Anything odd in my data?</span><small>{empty ? 'The sheet is empty' : 'Read-only'}</small>
          </button>
          <button type="button" className="b-sc-askrow" disabled={atlas.busy || empty || nextCol === null} onClick={() => void suggest()}>
            <span>Suggest a column</span><small>{empty ? 'The sheet is empty' : nextCol === null ? 'The sheet is full to F' : `A draft in ${SHEET_COLS[nextCol]}`}</small>
          </button>
        </section>
        {answer ? (
          <section className="b-sc-note b-sc-note--emphasis b-sc-answer" aria-live="polite">
            <span className="b-sc-label">{answer.title}</span>
            <p>{answer.text || 'Atlas is reading the sheet…'}</p>
            {column && preview?.errors ? <p className="b-sc-muted">{preview.errors} of its {Object.keys(column.cells).length} formulas give an error. Keep it only if you will fix them.</p> : null}
            <div className="b-sc-row-actions">
              {column ? (
                <>
                  <button type="button" className="b-btn b-btn--primary b-btn--row" onClick={keepColumn}>Keep column</button>
                  <button type="button" className="b-btn b-btn--card b-btn--row" onClick={discardColumn}>Discard</button>
                </>
              ) : (
                <button type="button" className="b-btn b-btn--card b-btn--row" onClick={() => { atlas.cancel(); setAnswer(null); }}>{atlas.busy ? 'Stop' : 'Close'}</button>
              )}
            </div>
          </section>
        ) : null}
        {atlas.error ? <p className="b-sc-err" role="alert">{atlas.error}</p> : null}
        <section className="b-sc-list" aria-label="Formulas">
          <span className="b-sc-label">Formulas</span>
          <p className="b-sc-muted">Start with “=”. Use + − * / ^, brackets, cells like B3 and ranges like B2:B6 inside a function. Numbers can use a decimal point or comma. Angles are in radians; RADIANS(45) converts.</p>
          <div className="b-sc-fns">{SHEET_FUNCTIONS.map((f) => <span key={f} className="b-num">{f}</span>)}</div>
        </section>
      </aside>
    </div>
  );
}
