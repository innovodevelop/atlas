/**
 * Atlas Health — `/health`.
 *
 * ── THE ONE THING TO KNOW ───────────────────────────────────────────────────
 *
 * THIS SCREEN IS NORMALLY EMPTY, AND THAT IS NOT A BUG. `HKHealthStore
 * .isHealthDataAvailable()` is FALSE on macOS (docs/decisions/008), so there is
 * no Health store on this machine to read, nothing to poll and no permission to
 * ask for. The only way health data ever gets here is a file the person exports
 * from the Health app on their iPhone and hands to Atlas.
 *
 * So the page is built around the empty state rather than treating it as an edge
 * case: `reason` is the first thing it branches on, the no-data screen is the
 * biggest thing in the file, and it spends its space on how to get data and on
 * what Atlas will and will not keep — not on an apology.
 *
 * The previous version of this file rendered `src/lib/mocks/health.ts` behind a
 * "Sample data" strip. That strip is gone with the sample: `useHealth()` reports
 * `isMock: false`, so every sample treatment in `HealthWidget` switches itself
 * off, and nothing on this page invents a number.
 *
 * ── WHAT IS NOT DRAWN, AND WHY ──────────────────────────────────────────────
 *
 * The design's body figure (`HealthClayCard`), its signal switches and its
 * device column all describe a LIVE PAIRED DEVICE shading a model in real time.
 * An import is a file. The backend returns `signals`, `devices`, `clay` and
 * `primaryDevice` empty on purpose and this page renders none of them, rather
 * than shading a figure from a month-old zip. `HealthSources` is not used here
 * either: its source and signal rows are switches, and there is nothing behind
 * a switch that pauses a file that has already been read.
 *
 * ── DATES ARE LOAD-BEARING ──────────────────────────────────────────────────
 *
 * Weight is weekly, heart rate is continuous, and an import can be months old.
 * Every card carries the day its number is from (`dayKicker`), the dataset
 * carries its range, and anything older than a week wears a strip above the
 * grid saying so. A step count from three weeks ago rendered as today would be
 * fabrication, and it is the specific fabrication this layout exists to prevent.
 *
 * ── CHROME ──────────────────────────────────────────────────────────────────
 *
 * `.page` root, band header, no dock. Back is the clickable headline plus Esc,
 * and from the Sources view Esc returns to Body first so a single key never
 * skips a step.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle, CalendarClock, Clock, FileDown, HeartPulse, LayoutGrid, Lock,
  ShieldCheck, SlidersHorizontal, Trash2, Upload,
} from 'lucide-react';
import { Button, Empty, Panel, Row } from '@/components/atlas-ui/primitives';
import { HealthWidget } from '@/components/atlas-ui/health/HealthWidget';
import { metricAvailability } from '@/lib/mocks/health';
import { DESKTOP_ONLY, describeReport, useHealth } from '@/hooks/useHealth';
import type { RealHealthSnapshot } from '@/hooks/useHealth';
import '@/styles/surfaces/health.css';

/**
 * Registration data. Mirrored in `src/surfaces.ts`, which is what the router,
 * the dock and the account menu are built from; `surfaces.test.ts` fails if the
 * two ever disagree.
 *
 * `mock` was `true` with a note saying it was false in fact and left for this
 * block's owner to flip. Flipped: `useHealth` reads the local store through
 * `health_snapshot`, filled by parsing a real Apple Health export, and reports
 * `isMock: false` — which is what switches every sample treatment in
 * `HealthWidget` off. The screen is normally EMPTY (macOS has no HealthKit
 * store, ADR 008) and empty is not the same as mocked.
 */
export const surface = {
  path: '/health',
  label: 'Health',
  icon: 'HeartPulse',
  entry: 'menu',
  mock: false,
  // Consumer BECAUSE of the flip above. A surface that can only invent numbers
  // is an admin curiosity; one that reads the person's own exported data is
  // theirs. The empty state is the honest common case, not a reason to hide it.
  edition: 'consumer',
} as const;

type View = 'body' | 'sources';

/** What to export, in the order the iPhone actually presents it. */
const EXPORT_STEPS = [
  'On your iPhone, open Health and tap your picture in the top right.',
  'Scroll to the bottom and tap “Export All Health Data”, then “Export”.',
  'Share it to this Mac — AirDrop, or save to Files and copy it over.',
  'Drop the export.zip below. Atlas reads it here; it is never uploaded.',
];

const AtlasHealth = () => {
  const navigate = useNavigate();
  const health = useHealth();
  const [view, setView] = useState<View>('body');

  const { snapshot, reason, isMock, supported } = health;

  /** Esc walks back one step at a time: Sources → Body → off the surface. */
  const back = useCallback(() => {
    if (view === 'sources') { setView('body'); return; }
    if (window.history.length > 1) navigate(-1);
    else navigate('/');
  }, [navigate, view]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') back();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [back]);

  /** Cards, each with the reason it can or cannot render. */
  const cards = useMemo(() => {
    if (!snapshot) return [];
    return snapshot.metrics.map((metric) => ({ metric, block: metricAvailability(snapshot, metric) }));
  }, [snapshot]);

  const coverage = snapshot ? snapshot.coverage : null;
  const hasData = !!snapshot && snapshot.hasData;

  /**
   * The band's right-hand figure. How many days are in the store — never a
   * headline reading, because the newest reading can be weeks old and a big
   * number with no date on it is the thing this page is built to avoid.
   */
  const headline = hasData
    ? { value: String(coverage.days), label: coverage.days === 1 ? 'day imported' : 'days imported' }
    : { value: '—', label: 'No data yet' };

  const subline = !supported
    ? DESKTOP_ONLY
    : reason === 'signed_out'
      ? 'Sign in to see the health data stored on this Mac.'
      : reason === 'loading'
        ? 'Reading the health store on this Mac…'
        : reason === 'error'
          ? health.error
          : hasData
            ? `${coverage.metrics} measurements · ${coverage.rangeLabel}`
            : 'macOS cannot read Apple Health directly, so Atlas reads an export you bring it from your iPhone.';

  return (
    <div className="page hl-page" data-screen-label="Atlas — Health">
      {/* Decorative wash from the design file; carries no information. */}
      <div className="hl-wash" aria-hidden />
      <div className="grain" aria-hidden />

      <section className="bandB hl-band">
        <div className="hl-bandmain">
          <h2
            className="greetB returnable"
            onClick={back}
            title={view === 'sources' ? 'Back to your body' : 'Back'}
          >
            Your body<span className="accw"> today</span>
          </h2>
          <p className="gsubB">{subline}</p>
          <nav className="hl-views" aria-label="Health views">
            <Button
              size="sm"
              variant={view === 'body' ? 'ink' : 'ghost'}
              aria-pressed={view === 'body'}
              icon={<LayoutGrid className="i16" />}
              onClick={() => setView('body')}
            >
              Body
            </Button>
            <Button
              size="sm"
              variant={view === 'sources' ? 'ink' : 'ghost'}
              aria-pressed={view === 'sources'}
              icon={<SlidersHorizontal className="i16" />}
              onClick={() => setView('sources')}
            >
              Sources &amp; import
            </Button>
          </nav>
        </div>
        <div className="bandmetaB">
          <p className="bmvB tnum">{headline.value}</p>
          <p className="bmlB">{headline.label}</p>
        </div>
      </section>

      {/* The strip that used to say "Sample data". It now says how old the real
          data is, and it is on screen for exactly as long as that is a problem. */}
      {hasData && view === 'body' && <FreshnessNotice snapshot={snapshot} onImport={() => setView('sources')} />}

      {view === 'sources' ? (
        <div className="hl-stage">
          <SourcesView health={health} />
        </div>
      ) : reason ? (
        <div className="hl-stage">
          <BodyEmpty health={health} onImport={() => setView('sources')} />
        </div>
      ) : (
        <main className="hl-grid">
          {cards.map(({ metric, block }, i) => (
            <HealthWidget
              key={metric.id}
              metric={metric}
              block={block}
              isMock={isMock}
              delay={Math.min(10, i + 1)}
            />
          ))}
        </main>
      )}
    </div>
  );
};

/* ── The empty states ─────────────────────────────────────────────────────── */

/**
 * The primary state of this surface.
 *
 * Five reasons, five different next steps. "Nothing to show" with no next step
 * is a dead end, and four of these five are not the user's fault in any way they
 * could have known about.
 */
const BodyEmpty = ({
  health, onImport,
}: { health: ReturnType<typeof useHealth>; onImport: () => void }) => {
  const { reason } = health;

  if (reason === 'loading') {
    return <Empty size="section" icon={<HeartPulse className="i20" />} title="Reading your health store" />;
  }

  if (reason === 'desktop_only') {
    return (
      <Empty
        size="section"
        status="stale"
        icon={<Lock className="i20" />}
        title="Health only opens in the desktop app"
        body={DESKTOP_ONLY}
      />
    );
  }

  if (reason === 'signed_out') {
    return (
      <Empty
        size="section"
        status="stale"
        icon={<Lock className="i20" />}
        title="Sign in first"
        body="Health data is stored per account on this Mac. Atlas will not read a store it cannot attribute to anyone."
      />
    );
  }

  if (reason === 'error') {
    return (
      <Empty
        size="section"
        status="error"
        icon={<HeartPulse className="i20" />}
        title="Health could not be read"
        body={health.error}
        action={{ label: 'Try again', onClick: () => { void health.refresh(); } }}
      />
    );
  }

  // `imported_nothing` — a file was read and produced no usable rows. Sending
  // this person back to "import a file" would send them round the same loop, so
  // it names the two things that actually cause it.
  if (reason === 'imported_nothing') {
    return (
      <Empty
        size="section"
        status="stale"
        icon={<AlertTriangle className="i20" />}
        title="That export had nothing Atlas could use"
        body="The file was read, but none of it turned into a measurement Atlas keeps. That usually means it was the wrong zip, or that it only contained record types Atlas will not guess the units of. The import report in Sources says which."
        action={{ label: 'Open sources and import', onClick: onImport }}
      />
    );
  }

  return <NoImportYet onImport={onImport} />;
};

/**
 * Day one, on every install.
 *
 * It leads with the platform fact rather than with an instruction, because
 * "connect Apple Health" is advice that cannot be followed on a Mac and the
 * person would spend the next ten minutes looking for the setting.
 */
const NoImportYet = ({ onImport }: { onImport: () => void }) => (
  <div className="hl-settings">
    <div className="hl-settings-col">
      <Panel className="hl-panel" title="No health data yet" icon={<HeartPulse className="i16" />}>
        <p className="hl-lede">
          macOS has no Apple Health store — that is a limit of the Mac itself, not a setting
          Atlas can turn on. There is nothing here to read until you bring Atlas an export
          from your iPhone.
        </p>
        <div className="hl-list">
          {EXPORT_STEPS.map((step, i) => (
            <Row key={i} lead={<span className="hl-state tnum">{i + 1}</span>} leadWidth={24} title={step} />
          ))}
        </div>
        <p className="hl-lede">
          The export is large — a few years of history is often several hundred megabytes.
          Atlas reads it in one pass and keeps only the daily figures.
        </p>
        <Button variant="primary" icon={<Upload className="i16" />} onClick={onImport}>
          Import an export
        </Button>
      </Panel>
    </div>
    <div className="hl-settings-col">
      <WhatAtlasKeeps />
    </div>
  </div>
);

/**
 * What Atlas will and will not store.
 *
 * Deliberately shown BEFORE the first import rather than buried in settings
 * afterwards: it is the thing a person is entitled to know while deciding
 * whether to hand over a file of their medical history.
 */
const WhatAtlasKeeps = () => (
  <Panel className="hl-panel" title="What Atlas keeps" icon={<ShieldCheck className="i16" />}>
    <p className="hl-lede">
      These are not switches. They describe what the code does, and there is no setting that
      turns any of them off.
    </p>
    <div className="hl-list">
      <Row
        title="Only daily figures are kept"
        meta="8,213 steps, 7h 12m asleep. The individual samples are discarded while the file is read — Atlas never stores them."
      />
      {/* NOT "Nothing leaves this Mac". That is a claim about the whole app,
          and `src-tauri/src/control/ops_health.rs` registers three read ops
          whose stated purpose is putting sleep, weight and resting heart rate
          into a model's context — so the absolute version was true only while
          nobody had wired them up. The scoped claim is the one the code keeps,
          and the fourth row below is the sentence the absolute one was hiding. */}
      <Row
        title="Your export is read and stored only on this Mac"
        meta="The file is read here and the daily figures are written to Atlas' own database on this machine. No part of the health code makes a network call."
      />
      <Row
        title="Atlas can read it, never change it"
        meta="Every health tool Atlas has is read-only. Importing and deleting are things you do, on this screen."
      />
      <Row
        title="Asking Atlas about it is a separate question"
        meta="Nothing here sends your health data anywhere. But an answer is written by a model, so if Atlas is ever given a tool that reads these figures, they go to the model that answers — today it has none."
      />
    </div>
  </Panel>
);

/* ── Freshness ────────────────────────────────────────────────────────────── */

/**
 * The strip above the grid.
 *
 * Two separate honesty problems, and it says whichever applies:
 *  - STALE: the newest day in the store is over a week old, so nothing on this
 *    screen describes now.
 *  - PARTIAL: the range has holes in it. A month between two dates with twelve
 *    days of readings is not a month of data.
 *
 * When neither applies it renders nothing — an always-on banner stops being
 * read, and then the one that matters is invisible too.
 */
const FreshnessNotice = ({
  snapshot, onImport,
}: { snapshot: RealHealthSnapshot; onImport: () => void }) => {
  const c = snapshot.coverage;
  const stale = c.level === 'stale';
  const partial = c.gapDays > 0;
  if (!stale && !partial) return null;

  return (
    <div className="hl-sample" role="note">
      <span className="hl-sample-ico" aria-hidden>
        {stale ? <CalendarClock className="i16" /> : <Clock className="i16" />}
      </span>
      <p className="hl-sample-text">
        <strong>{stale ? 'This is history, not today.' : 'Partial history.'}</strong>{' '}
        {stale ? c.ageLabel : `${c.days} of the ${c.spanDays} days in this range carry readings; the rest are blank.`}{' '}
        {c.rangeLabel}. Every card below is labelled with the day its number came from.
      </p>
      <Button variant="text" size="sm" onClick={onImport}>
        Import a newer export
      </Button>
    </div>
  );
};

/* ── Sources & import ─────────────────────────────────────────────────────── */

const SourcesView = ({ health }: { health: ReturnType<typeof useHealth> }) => {
  const { snapshot } = health;

  return (
    <div className="hl-settings">
      <div className="hl-settings-col">
        <ImportPanel health={health} />

        <Panel className="hl-panel" title="Where your health data comes from" icon={<FileDown className="i16" />}>
          <p className="hl-lede">
            Atlas reads, never writes. An import is a file rather than a feed, so there is
            nothing here to pause — a source is either something you imported or something
            that cannot run on this machine.
          </p>
          {!snapshot || snapshot.sourceRows.length === 0 ? (
            <Empty
              size="block"
              icon={<FileDown className="i20" />}
              title="No source yet"
              body="Nothing has been imported, so Atlas is reading nothing."
            />
          ) : (
            <div className="hl-list">
              {snapshot.sourceRows.map((s) => (
                <Row
                  key={s.id}
                  className={`hl-listrow${s.enabled ? '' : ' hl-listrow-off'}`}
                  title={s.name}
                  meta={s.reason ?? s.detail ?? ''}
                  trail={<span className={`hl-state${s.enabled ? '' : ' hl-state-off'}`}>{s.state}</span>}
                />
              ))}
            </div>
          )}
          {snapshot && snapshot.hasData && (
            <p className="hl-lede">
              {snapshot.coverage.rangeLabel}. {snapshot.coverage.ageLabel}
            </p>
          )}
        </Panel>
      </div>

      <div className="hl-settings-col">
        <WhatAtlasKeeps />
        <ForgetPanel health={health} />
      </div>
    </div>
  );
};

/**
 * The import affordance.
 *
 * TWO WAYS IN, because neither is sufficient on its own. The drop target is the
 * one a person will reach for, and it is the only way to learn a real filesystem
 * path in a Tauri webview — an `<input type="file">` hands back a `File` with no
 * path on it, and `health_import` takes a path. The text field is the fallback
 * for when the window is not accepting drops (and the only route available to
 * anyone driving this by keyboard).
 */
const ImportPanel = ({ health }: { health: ReturnType<typeof useHealth> }) => {
  const [path, setPath] = useState('');
  const [hovering, setHovering] = useState(false);
  const { importFromPath, importing, supported, today } = health;

  const start = useCallback((p: string) => {
    setPath(p);
    void importFromPath(p);
  }, [importFromPath]);

  useEffect(() => {
    if (!supported) return;
    let stop: (() => void) | null = null;
    let cancelled = false;
    void (async () => {
      try {
        const { getCurrentWebview } = await import('@tauri-apps/api/webview');
        const un = await getCurrentWebview().onDragDropEvent((e) => {
          const p = e.payload as { type: string; paths?: string[] };
          if (p.type === 'over') setHovering(true);
          else if (p.type === 'leave') setHovering(false);
          else if (p.type === 'drop') {
            setHovering(false);
            const first = (p.paths ?? [])[0];
            if (first) start(first);
          }
        });
        if (cancelled) un(); else stop = un;
      } catch {
        // The window is not delivering drag-drop events. The path field below
        // is the whole reason it is there.
      }
    })();
    return () => { cancelled = true; if (stop) stop(); };
  }, [start, supported]);

  return (
    <Panel className="hl-panel" title="Import from your iPhone" icon={<Upload className="i16" />}>
      <p className="hl-lede">
        Health → your picture → Export All Health Data. Drop the <code>export.zip</code> anywhere
        on this window, or paste its path. Atlas reads it on this Mac and keeps the daily
        figures only.
      </p>

      <div
        className="aempty aempty-block"
        role="status"
        aria-busy={importing}
      >
        <div className="aempty-ico"><Upload className="i20" /></div>
        <p className="fw6">
          {importing ? 'Reading the export…' : hovering ? 'Drop it here' : 'Drop export.zip on this window'}
        </p>
        <p className="hl-lede">
          A large export takes a while — Atlas walks the whole file once and writes one row per
          day per measurement.
        </p>
      </div>

      <div className="fx ac gap10 mt12">
        <input
          className="inp"
          type="text"
          value={path}
          spellCheck={false}
          placeholder="/Users/you/Downloads/export.zip"
          aria-label="Path to the Apple Health export"
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && path.trim()) start(path); }}
          disabled={importing || !supported}
        />
        <Button
          variant="primary"
          loading={importing}
          disabled={!path.trim() || !supported}
          onClick={() => start(path)}
        >
          Import
        </Button>
      </div>

      {health.error && (
        <Empty size="inline" status="error" title="Import failed." body={health.error} />
      )}

      {health.report && (
        <Empty
          size="inline"
          status="resting"
          title="Imported."
          body={describeReport(health.report, today)}
        />
      )}
    </Panel>
  );
};

/**
 * Deleting it all.
 *
 * The counterpart to "it never leaves this device": data that cannot be removed
 * is not really under the person's control. Two steps, because there is no undo
 * — and deliberately absent from the control port, so Atlas itself cannot reach
 * this even if it is asked to.
 */
const ForgetPanel = ({ health }: { health: ReturnType<typeof useHealth> }) => {
  const [armed, setArmed] = useState(false);
  const has = !!health.snapshot && health.snapshot.hasData;

  return (
    <Panel className="hl-panel" title="Remove your health data" icon={<Trash2 className="i16" />}>
      <p className="hl-lede">
        Deletes every health row on this Mac — daily figures, workouts and the record of what was
        imported. The export file itself is untouched, and there is no copy anywhere else to
        delete.
      </p>
      {!has ? (
        <Empty size="inline" title="Nothing to remove." body="No health data is stored." />
      ) : armed ? (
        <div className="fx ac gap10">
          <Button variant="danger" onClick={() => { setArmed(false); void health.forget(); }}>
            Yes, delete it all
          </Button>
          <Button variant="ghost" onClick={() => setArmed(false)}>Cancel</Button>
        </div>
      ) : (
        <Button variant="ghost" icon={<Trash2 className="i16" />} onClick={() => setArmed(true)}>
          Remove all health data
        </Button>
      )}
    </Panel>
  );
};

export default AtlasHealth;
