/**
 * Atlas Widget Sheet — `/widget-sheet`.
 *
 * The per-widget spec sheet. Pick one of the dashboard's ten cards and the page
 * answers four questions about it: what it is for, what sizes it honours, what
 * it is bound to, and what it looks like in every state it can be in. It pairs
 * with the Widget Catalog, which shows the whole set at a glance; this one goes
 * one widget deep.
 *
 * WHY THIS SURFACE IS WORTH HAVING. Writing it required reading every card's
 * data path, and that turned up the thing the sheet now exists to record: when
 * a provider key is missing, `src-tauri/src/datafetch.rs` answers with plausible
 * sample data instead of an error — `mock_weather`, `mock_stock`, `mock_news` —
 * and the React hooks hold module-level fallbacks on top of that. So a keyless
 * install shows a confident 68°, four named companies with prices, and three
 * headlines, none of which are measurements of anything. "The data source is
 * absent" is a real state, it is not an error, and today it is invisible. It is
 * the sixth state on this sheet for exactly that reason.
 *
 * WHAT IS LIVE HERE. Everything about the *binding* — hook, transport, key,
 * refresh, and every "in the app today" note — was read from the repo. Whether
 * a key is actually present is read live from `brain_ai_status` via
 * `useSourceStatus`, so the sheet's own source panel can never be out of date
 * with the machine it is running on. Only the preview copy inside the state
 * tiles is spec sample content, and the page says so above the tiles.
 *
 * NOT PORTED from `Atlas Widget Sheet.dc.html`: its §02 "Proposed new widgets"
 * — Commute, Flight watch, Focus, Health, Home, Memory digest. Six cards with
 * no component, no hook and no place in the grid. A spec sheet whose source of
 * truth is the real card set cannot document widgets that do not exist; the
 * proposals belong in a roadmap, not in a specification.
 */
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Database, Info, Layers, Settings2, ShieldCheck, Sparkles, WifiOff,
} from 'lucide-react';
import { Empty, Panel, StatTile } from '@/components/atlas-ui/primitives';
import {
  SHIP_LABEL, SIZES, STATE_LABEL, WIDGETS,
  builtStateCount, definedStateCount, widgetById,
  type SizeId, type SourceSpec, type WidgetSpec,
} from '@/lib/mocks/widgetSheet';
import { WidgetPreview, widgetIcon } from '@/components/atlas-ui/widgetSheet/WidgetPreview';
import { useSourceStatus, type SourceStatus } from '@/components/atlas-ui/widgetSheet/useSourceStatus';
import '@/styles/surfaces/widgetSheet.css';

export const surface = {
  path: '/widget-sheet',
  label: 'Widget sheet',
  icon: 'Layers',
  entry: 'menu',
  mock: true,
} as const;

/** Which cells of a 2×2 slice each size occupies. Purely a diagram. */
const SPAN_CELLS: Record<SizeId, boolean[]> = {
  s: [true, false, false, false],
  m: [true, true, false, false],
  l: [true, false, true, false],
  xl: [true, true, true, true],
  hero: [false, false, false, false],
};

type Availability = 'ok' | 'missing' | 'unknown' | 'nokey' | 'none';

/**
 * Is this widget's source available right now?
 *
 * `nokey` and `ok` are different answers on purpose: "needs no key" is a
 * property of the widget, "the key is there" is a fact about this machine.
 * Collapsing them would let a local widget look like it had passed a check it
 * never took.
 */
function availabilityOf(source: SourceSpec, status: SourceStatus): Availability {
  if (source.kind === 'none') return 'none';
  if (!source.statusKey) return 'nokey';
  if (status.phase !== 'ready') return 'unknown';
  const present = status.keys[source.statusKey];
  if (present === undefined) return 'unknown';
  return present ? 'ok' : 'missing';
}

const AVAIL_TEXT: Record<Availability, string> = {
  ok: 'Key present on this Mac',
  missing: 'No key — this widget is in its no-source state right now',
  unknown: 'Cannot tell from here',
  nokey: 'No key needed',
  none: 'No source to check',
};

const AtlasWidgetSheet = () => {
  const navigate = useNavigate();
  const [selectedId, setSelectedId] = useState<string>(WIDGETS[0].id);
  const status = useSourceStatus();

  const widget = useMemo<WidgetSpec>(
    () => widgetById(selectedId) ?? WIDGETS[0],
    [selectedId],
  );

  const back = useCallback(() => navigate('/'), [navigate]);

  // Esc returns to the dashboard — the same contract as the focused widget
  // views. The headline is the other way back; there is no header link.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') back(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [back]);

  const defined = definedStateCount(widget);
  const built = builtStateCount(widget);
  const avail = availabilityOf(widget.source, status);
  const shipped = SIZES.find((s) => s.id === widget.shippedSize);

  return (
    <div className="page wsheet" data-screen-label="Atlas — Widget Sheet">
      <div className="auro" aria-hidden />
      <div className="grain" aria-hidden />

      <section className="bandB">
        <div className="f1">
          <h2
            className="greetB returnable"
            onClick={back}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); back(); } }}
            role="button"
            tabIndex={0}
            title="Return to dashboard"
          >
            Widget <span className="accw">sheet.</span>
          </h2>
          <p className="gsubB">
            {widget.name} — {widget.answers} Six states, one binding, and what the
            card actually does today. Press <span className="wsh-kbd">Esc</span> to return.
          </p>
        </div>
        <div className="bandmetaB">
          <p className="bmvB tnum">{built}<span className="wsh-of">/{defined}</span></p>
          <p className="bmlB">states built</p>
        </div>
      </section>

      <main className="wsh-main">
        {/* ---------------------------------------------------------- rail */}
        <nav className="wsh-rail" aria-label="Widgets">
          <p className="wsh-rail-head">The card set</p>
          {WIDGETS.map((w) => {
            const a = availabilityOf(w.source, status);
            return (
              <button
                key={w.id}
                type="button"
                className={`wsh-rail-item${w.id === widget.id ? ' on' : ''}`}
                aria-current={w.id === widget.id ? 'true' : undefined}
                onClick={() => setSelectedId(w.id)}
              >
                <span className="wsh-rail-ico">{widgetIcon(w.icon, 'i16')}</span>
                <span className="wsh-rail-main">
                  <span className="wsh-rail-name">{w.name}</span>
                  <span className="wsh-rail-cat">{w.category}</span>
                </span>
                {/* Not aria-hidden: the dot is the only place the rail says
                    whether this widget's source is actually there, and a
                    `title` on a hidden element reaches nobody. */}
                <span
                  className={`wsh-avail wsh-avail-${a}`}
                  role="img"
                  aria-label={AVAIL_TEXT[a]}
                  title={AVAIL_TEXT[a]}
                />
              </button>
            );
          })}
          {/* The sheet documents what is BUILT, one widget at a time. The
              official widget set — all 51 of them — is the catalog's job, and
              saying so here keeps two surfaces from each reading as the
              authoritative list of Atlas's widgets. */}
          <p className="wsh-rail-foot">
            The ten cards the dashboard renders, in detail. The official widget
            set is larger: see the <Link to="/widgets">widget catalog</Link>,
            which lists all 51 and marks which are built.
          </p>
        </nav>

        {/* --------------------------------------------------------- sheet */}
        <div className="wsh-body">
          <Panel title={widget.name} icon={widgetIcon(widget.icon, 'i16')} className="wsh-panel">
            <p className="wsh-answers">{widget.answers}</p>
            <p className="wsh-purpose">{widget.purpose}</p>
            <div className="wsh-stats">
              <StatTile layout="micro" label="Category" value={widget.category} tnum={false} />
              <StatTile layout="micro" label="Grid order" value={`#${widget.order}`} />
              <StatTile layout="micro" label="Shipped size" value={shipped?.label ?? '—'} tnum={false} />
              <StatTile layout="micro" label="Refresh" value={widget.source.refresh} tnum={false} />
            </div>
            <dl className="wsh-def">
              <dt>Opens</dt>
              <dd>{widget.opens ?? 'Nothing — this card is not openable.'}</dd>
            </dl>
          </Panel>

          {/* ------------------------------------------------------- sizes */}
          <Panel title="Sizes" icon={<Layers className="i16" />} className="wsh-panel">
            <p className="wsh-lede">
              Every widget is meant to honour the same ladder, so any of them drops
              into any slot. The diagram is a 2 × 2 slice of the dashboard grid.
            </p>
            <ul className="wsh-sizes">
              {SIZES.map((s) => {
                const isShipped = s.id === widget.shippedSize;
                const unavailable = s.app === null;
                return (
                  <li
                    key={s.id}
                    className={`wsh-size${isShipped ? ' on' : ''}${unavailable ? ' off' : ''}`}
                  >
                    <span className="wsh-span" aria-hidden>
                      {SPAN_CELLS[s.id].map((filled, i) => (
                        <span key={i} className={`wsh-span-cell${filled ? ' fill' : ''}`} />
                      ))}
                    </span>
                    <span className="wsh-size-main">
                      <span className="wsh-size-name">
                        {s.label}
                        {isShipped && <span className="wsh-tag">Shipped at</span>}
                      </span>
                      <span className="wsh-size-meta tnum">
                        {s.app ?? 'Unavailable'} · {s.cls} · catalog {s.catalog}
                      </span>
                      {s.note && <span className="wsh-size-note">{s.note}</span>}
                    </span>
                  </li>
                );
              })}
            </ul>
          </Panel>

          {/* ------------------------------------------------- data source */}
          <Panel title="Data source" icon={<Database className="i16" />} className="wsh-panel">
            {widget.source.kind === 'none' ? (
              <Empty
                size="block"
                icon={<Database className="i20" />}
                title="No data source"
                body="Nothing is bound to this card. Every value on its face is a literal in the component, and no key, connector or permission will change that."
              />
            ) : (
              <>
                <div className={`wsh-avail-bar wsh-avail-${avail}`}>
                  {avail === 'ok' && <ShieldCheck className="i16" aria-hidden />}
                  {avail === 'missing' && <WifiOff className="i16" aria-hidden />}
                  {(avail === 'unknown' || avail === 'nokey') && <Info className="i16" aria-hidden />}
                  <span className="f1">{AVAIL_TEXT[avail]}</span>
                  {widget.source.statusKey && <code className="wsh-code">{widget.source.statusKey}</code>}
                </div>
                {avail === 'unknown' && status.reason && (
                  <Empty size="inline" status="stale" body={status.reason} />
                )}

                {/* A definition list, not <Row>: these are key/value spec lines
                    with values long enough to wrap, and `.row0-title` truncates
                    to a single line by design. */}
                <dl className="wsh-def">
                  <dt>Hook</dt>
                  <dd><code className="wsh-code">{widget.source.hook}</code></dd>
                  <dt>Transport</dt>
                  <dd><code className="wsh-code">{widget.source.transport}</code></dd>
                  {widget.source.provider && (<><dt>Provider</dt><dd>{widget.source.provider}</dd></>)}
                  {widget.source.keychainAccount && (
                    <><dt>Key</dt><dd><code className="wsh-code">{widget.source.keychainAccount}</code></dd></>
                  )}
                  <dt>Refresh</dt>
                  <dd>{widget.source.refresh}</dd>
                </dl>
              </>
            )}

            <p className="wsh-sub">What is true about this binding today</p>
            <ul className="wsh-notes">
              {widget.source.notes.map((n, i) => <li key={i}>{n}</li>)}
            </ul>
          </Panel>

          {/* ------------------------------------------------------ states */}
          <Panel title="States" icon={<Sparkles className="i16" />} className="wsh-panel">
            <p className="wsh-lede">
              Five lifecycle states from the design, plus <strong>No source</strong> —
              the condition a widget is in when the data it needs was never
              configured. That is not an error and it is not offline; it deserves
              its own face. Content inside the tiles is sample copy from the spec,
              and the labels in them (“Set location”, “Join”) are drawings, not
              controls. The badge on each tile says what the shipped card does.
            </p>
            <div className="wsh-states">
              {widget.states.map((st) => (
                <figure key={st.id} className="wsh-state">
                  <figcaption className="wsh-state-head">
                    <span className="wsh-state-name">{STATE_LABEL[st.id]}</span>
                    <span className={`wsh-ship wsh-ship-${st.ship === 'n/a' ? 'na' : st.ship}`}>
                      {SHIP_LABEL[st.ship]}
                    </span>
                  </figcaption>
                  <p className="wsh-state-trigger">{st.trigger}</p>
                  {st.preview ? (
                    <WidgetPreview spec={st.preview} icon={widget.icon} />
                  ) : (
                    <div className="wsh-undefined">
                      <Empty
                        size="inline"
                        status="stale"
                        body={st.why ?? 'This widget does not define this state.'}
                      />
                    </div>
                  )}
                  <p className="wsh-state-ship">{st.shipNote}</p>
                </figure>
              ))}
            </div>
          </Panel>

          {/* --------------------------------------------------- behaviour */}
          <Panel title="Behaviour" icon={<Settings2 className="i16" />} className="wsh-panel">
            <dl className="wsh-def wsh-def-wide">
              {widget.behaviour.map((b) => (
                <Fragment key={b.label}>
                  <dt>{b.label}</dt>
                  <dd>{b.value}</dd>
                </Fragment>
              ))}
            </dl>
          </Panel>
        </div>
      </main>
    </div>
  );
};

export default AtlasWidgetSheet;
