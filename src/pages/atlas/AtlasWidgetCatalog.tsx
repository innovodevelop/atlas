import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { CardSize, CardSkin } from '@/components/atlas-ui/primitives';
import { Empty } from '@/components/atlas-ui/primitives';
import { WidgetPreview } from '@/components/atlas-ui/widgetCatalog/WidgetPreview';
import { useCatalogWidgets } from '@/components/atlas-ui/widgetCatalog/useCatalogWidgets';
import {
  APP_ONLY_COUNT, BUILDS, BUILT_COUNT, CATEGORY_LABEL, DESIGNED_COUNT,
  OFFICIAL_COUNT, SIZES, SIZE_LABEL, SKINS, STATES, WIDGETS,
  type CatalogBuild, type CatalogCategory, type CatalogSkin, type CatalogState,
} from '@/components/atlas-ui/widgetCatalog/registry';
import '@/styles/surfaces/widgetCatalog.css';

/**
 * Atlas — Widget catalog (`/widgets`).
 *
 * The widget system, shown as itself. `Atlas Widget Catalog.dc.html` is the
 * AUTHORITATIVE definition of that system — 51 widgets across ten categories —
 * so this surface lists all 51. Ten are built and read live data; 41 are
 * designed and not built, and each says which.
 *
 * The earlier cut listed only the ten shipped widgets. That avoided fabricating
 * 41 widgets, but at the cost of a catalog that omitted 80% of the system it
 * claimed to catalogue — so nothing in the app recorded what Atlas's widget set
 * actually is. Reversed on the user's call, 2026-08-04.
 *
 * FABRICATION IS PREVENTED BY THE TYPE, NOT BY OMISSION. `WidgetSpec` is a
 * discriminated union; a `built: false` entry has no value fields, so it cannot
 * reach the populated renderer. The design file's hand-written preview values
 * are deliberately not copied in — an unbuilt card shows its designed shape and
 * the concrete reason it does not exist, and no numbers at all.
 *
 * WHAT IT ADDS over a static spec: `status`. Three of the ten widgets sit on
 * hooks that quietly substitute built-in sample data when the call fails
 * (`useWeather`, `useStocks`, `useNews` all hand `fallbackData` to
 * `useDataFetching`). On the dashboard that is invisible — the card looks
 * populated. Here it reads "Fallback", with the reason.
 *
 * Back-navigation is the headline and Esc, per the surface chrome the app uses;
 * there is no header link and no dock (the wiring pass owns the dock).
 */
const AtlasWidgetCatalog = () => {
  const navigate = useNavigate();

  const [size, setSize] = useState<CardSize>('l');
  const [skin, setSkin] = useState<CatalogSkin>('both');
  const [state, setState] = useState<CatalogState>('live');
  const [cat, setCat] = useState<CatalogCategory | 'all'>('all');
  const [build, setBuild] = useState<CatalogBuild>('all');

  const data = useCatalogWidgets();

  const back = useCallback(() => {
    if (window.history.length > 1) navigate(-1);
    else navigate('/');
  }, [navigate]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') back();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [back]);

  // Every catalog category gets a chip now, because every category is real —
  // they come from the official set, not from what happens to be built. The
  // count reflects the current Built/Designed filter so a chip never promises
  // more than the grid will show.
  const pool = useMemo(
    () => (build === 'all' ? WIDGETS : WIDGETS.filter((w) => (build === 'built') === w.built)),
    [build],
  );

  const categories = useMemo(() => {
    const counts = new Map<CatalogCategory, number>();
    for (const w of pool) counts.set(w.category, (counts.get(w.category) ?? 0) + 1);
    return [...counts.entries()].map(([id, n]) => ({ id, label: CATEGORY_LABEL[id], n }));
  }, [pool]);

  const visible = useMemo(
    () => (cat === 'all' ? pool : pool.filter((w) => w.category === cat)),
    [cat, pool],
  );

  const skins = useMemo<CardSkin[]>(
    () => (skin === 'both' ? ['glass', 'ink'] : [skin]),
    [skin],
  );

  const cells = useMemo(
    () => visible.flatMap((spec) => skins.map((s) => ({ spec, skin: s }))),
    [visible, skins],
  );

  const skinLabel = skin === 'both' ? 'glass + ink' : skin;

  return (
    <div className="page wcat" data-screen-label="Atlas — Widget catalog">
      <div className="auro" />
      <div className="grain" aria-hidden />

      <section className="bandB wcat-band">
        <div className="wcat-bandmain">
          <h1
            className="greetB returnable"
            onClick={back}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); back(); } }}
            role="button"
            tabIndex={0}
            title="Back"
          >
            The widget system, <span className="accw">size by size, state by state.</span>
          </h1>
          <p className="gsubB">
            {`The official catalog defines ${OFFICIAL_COUNT} widgets. ${BUILT_COUNT - APP_ONLY_COUNT} of them ship today, at every size the card primitive can express, in both drawings — bound to the same hooks the dashboard reads, so no number here is invented. The other ${DESIGNED_COUNT} are designed and not built: they show their shape and what they are waiting on, and no values at all. Atlas also ships ${APP_ONLY_COUNT} widget the catalog does not list, so there are ${WIDGETS.length} cards here in total.`}
          </p>
          <p className="wcat-esc">
            Click the headline or press <span className="wcat-kbd">Esc</span> to go back.
          </p>
        </div>
        <div className="bandmetaB">
          <p className="bmvB tnum">{cells.length}</p>
          <p className="bmlB">
            previews · {SIZE_LABEL[size]} · {skinLabel}
          </p>
        </div>
      </section>

      <div className="wcat-controlwrap">
        <div className="wcat-controls" role="group" aria-label="Catalog filters">
          <span className="wcat-glabel">Size</span>
          <div className="wcat-chips">
            {SIZES.map((z) => (
              <button
                key={z.id}
                type="button"
                className={`wcat-chip${size === z.id ? ' on' : ''}`}
                aria-pressed={size === z.id}
                onClick={() => setSize(z.id)}
              >
                {z.label}
                <span className="wcat-dim tnum">{z.dim}</span>
              </button>
            ))}
          </div>

          <span className="wcat-glabel">Set</span>
          <div className="wcat-chips">
            {BUILDS.map((b) => (
              <button
                key={b.id}
                type="button"
                className={`wcat-chip${build === b.id ? ' on' : ''}`}
                aria-pressed={build === b.id}
                onClick={() => { setBuild(b.id); setCat('all'); }}
              >
                {b.label}
                <span className="wcat-dim tnum">
                  {b.id === 'all' ? WIDGETS.length : b.id === 'built' ? BUILT_COUNT : DESIGNED_COUNT}
                </span>
              </button>
            ))}
          </div>

          <span className="wcat-glabel">State</span>
          <div className="wcat-chips">
            {STATES.map((m) => (
              <button
                key={m.id}
                type="button"
                className={`wcat-chip${state === m.id ? ' on' : ''}`}
                aria-pressed={state === m.id}
                onClick={() => setState(m.id)}
              >
                {m.label}
              </button>
            ))}
          </div>

          <span className="wcat-glabel">Design</span>
          <div className="wcat-chips">
            {SKINS.map((d) => (
              <button
                key={d.id}
                type="button"
                className={`wcat-chip${skin === d.id ? ' on' : ''}`}
                aria-pressed={skin === d.id}
                onClick={() => setSkin(d.id)}
              >
                <span className={`wcat-swatch wcat-swatch-${d.id}`} aria-hidden />
                {d.label}
              </button>
            ))}
          </div>

          <div className="wcat-chips wcat-cats">
            <button
              type="button"
              className={`wcat-chip${cat === 'all' ? ' on' : ''}`}
              aria-pressed={cat === 'all'}
              onClick={() => setCat('all')}
            >
              All<span className="wcat-dim tnum">{pool.length}</span>
            </button>
            {categories.map((c) => (
              <button
                key={c.id}
                type="button"
                className={`wcat-chip${cat === c.id ? ' on' : ''}`}
                aria-pressed={cat === c.id}
                onClick={() => setCat(c.id)}
              >
                {c.label}<span className="wcat-dim tnum">{c.n}</span>
              </button>
            ))}
          </div>
        </div>

        {/* The one thing the design specifies that the app cannot draw. Said on
            screen rather than quietly omitted from the size row. */}
        <p className="wcat-caveat">
          The design specifies a fifth size — <strong>Hero, 6×3</strong>. The card primitive
          implements four; Hero is left out rather than aliased onto XL, because per-widget spans
          need a registry the dashboard does not have.
          {state === 'live' && ' “Live” is the real state of each source right now — force the others to review their drawings.'}
          {' '}State applies to the {BUILT_COUNT} built widgets only: a designed widget has no
          source to be live, empty or missing.
        </p>
      </div>

      <main className="wcat-grid">
        {cells.map(({ spec, skin: cellSkin }, i) => (
          <WidgetPreview
            key={`${spec.id}-${cellSkin}`}
            spec={spec}
            data={data[spec.id] ?? { status: 'empty' }}
            size={size}
            skin={cellSkin}
            state={state}
            delay={(i % 10) + 1}
          />
        ))}
      </main>

      {cells.length === 0 && (
        <div className="wcat-none">
          <Empty
            size="section"
            title="Nothing in this category"
            body={
              build === 'built'
                ? 'No widget in this category is built yet — switch the set to Designed to see what the catalog specifies for it.'
                : build === 'designed'
                  ? 'Every widget in this category is already built.'
                  : 'No widget carries this label.'
            }
            action={{ label: 'Show all widgets', onClick: () => { setCat('all'); setBuild('all'); } }}
          />
        </div>
      )}
    </div>
  );
};

export const surface = {
  path: '/widgets',
  label: 'Widget catalog',
  icon: 'LayoutGrid',
  entry: 'menu',
  mock: false,
  // A specification browser for the 51 widgets — 41 of them unbuilt, each with
  // the reason it does not exist. That is a document about the product, not
  // part of it.
  edition: 'admin',
} as const;

export default AtlasWidgetCatalog;
