/**
 * Atlas Health — `/health`.
 *
 * ── THE ONE THING TO KNOW ───────────────────────────────────────────────────
 *
 * EVERY NUMBER ON THIS SCREEN IS SAMPLE DATA. The app has no health data source
 * of any kind: no HealthKit bridge, no wearable pairing, no lab import, nothing
 * in SQLite. The surface is built against `src/lib/mocks/health.ts` and says so
 * in three places you cannot miss — a strip under the band, a `Sample` stamp on
 * every card, and a stamp on the body model.
 *
 * That is a deliberate, labelled exception to the project rule "honest UI, not
 * fake data", and it is honest *because* it is labelled. The moment the label
 * comes off, this becomes the thing T4 deleted 34 files to get rid of. Every
 * sample treatment is gated on `health.isMock` — the value the hook reports —
 * so a real adapter turns all of it off by returning `false`, with no edit here.
 *
 * ── WHAT IS REAL ────────────────────────────────────────────────────────────
 *
 * The *behaviour* is real, and it is what makes the surface worth reviewing:
 * the source and signal switches in the Sources view genuinely decide what the
 * Body view is allowed to render. Pause Apple Watch and six cards fall to "Not
 * measured". Turn Workouts off and the figure's legs stop being shaded. Turn
 * everything off and the whole surface reaches its real empty state — the same
 * one a real adapter hits on day one, when `snapshot` is `null`.
 *
 * ── CHROME ──────────────────────────────────────────────────────────────────
 *
 * `.page` root, band header, no dock (the wiring pass owns that). Back is the
 * clickable headline plus Esc, never a header link — from the Sources view Esc
 * returns to Body first, then leaves the surface, so a single key never skips a
 * step.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Activity, HeartPulse, LayoutGrid, SlidersHorizontal } from 'lucide-react';
import { Button, Empty } from '@/components/atlas-ui/primitives';
import { HealthClayCard } from '@/components/atlas-ui/health/HealthClayCard';
import { HealthSources } from '@/components/atlas-ui/health/HealthSources';
import { HealthWidget } from '@/components/atlas-ui/health/HealthWidget';
import { metricAvailability, useAtlasHealthMock as useHealth } from '@/lib/mocks/health';
import type { ClayMode } from '@/lib/mocks/health';
import '@/styles/surfaces/health.css';

/**
 * Registration data for the wiring pass. `entry: 'menu'` rather than `'dock'`
 * on purpose: README §7 fixes the dock at Home · Core · Teach · Mail ·
 * Architecture · Voice · avatar, and Health is not in it. The design's own
 * prototype nav does promote Health, so this is a call worth revisiting once
 * all nine new surfaces have landed and someone can see the whole set at once.
 */
export const surface = {
  path: '/health',
  label: 'Health',
  icon: 'HeartPulse',
  entry: 'menu',
  mock: true,
} as const;

type View = 'body' | 'sources';

const AtlasHealth = () => {
  const navigate = useNavigate();
  const health = useHealth();
  const [view, setView] = useState<View>('body');
  const [clayMode, setClayMode] = useState<ClayMode>('recovery');

  const { snapshot, isMock } = health;

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

  const liveSources = snapshot ? snapshot.sources.filter((s) => s.enabled).length : 0;
  const readable = cards.filter((c) => c.block.available).length;

  /**
   * The band's right-hand figure. Readiness when it is measured, an em dash when
   * it is not — never a zero, which would read as a real reading of nothing.
   */
  const headline = useMemo(() => {
    const recovery = cards.find((c) => c.metric.id === 'recovery');
    if (recovery && recovery.block.available && recovery.metric.value) {
      return { value: recovery.metric.value, label: 'Readiness' };
    }
    return { value: '—', label: liveSources === 0 ? 'No source' : 'Not measured' };
  }, [cards, liveSources]);

  const subline = !snapshot
    ? 'Atlas is not reading any health data.'
    : liveSources === 0
      ? 'Every source is paused, so there is nothing to model.'
      : `${readable} of ${cards.length} cards have something behind them. Atlas reads — it never writes back.`;

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
              Sources
            </Button>
          </nav>
        </div>
        <div className="bandmetaB">
          <p className="bmvB tnum">{headline.value}</p>
          <p className="bmlB">{headline.label}</p>
        </div>
      </section>

      {/* The sample-data treatment. Not a console warning, not a comment — a
          designed strip that is on screen for as long as the data is invented,
          and disappears on its own the day `isMock` turns false. */}
      {isMock && (
        <div className="hl-sample" role="note">
          <span className="hl-sample-ico" aria-hidden><Activity className="i16" /></span>
          <p className="hl-sample-text">
            <strong>Sample data.</strong> Atlas is not connected to Apple Health, a watch, or
            anything else — none of these readings came from you. The switches in Sources are
            live, so you can see exactly which card depends on which signal.
          </p>
          {view !== 'sources' && (
            <Button variant="text" size="sm" onClick={() => setView('sources')}>
              See what would feed it
            </Button>
          )}
        </div>
      )}

      {health.error ? (
        <div className="hl-stage">
          <Empty
            size="section"
            status="error"
            icon={<HeartPulse className="i20" />}
            title="Health could not be read"
            body={health.error}
          />
        </div>
      ) : !snapshot ? (
        /* The day-one state of any real adapter: connected to nothing at all. */
        <div className="hl-stage">
          <Empty
            size="section"
            icon={<HeartPulse className="i20" />}
            title="Nothing to show yet"
            body="Atlas is not reading any health data. Connect Apple Health, pair a watch, or import a lab panel and this surface fills in."
            action={{ label: 'Open sources', onClick: () => setView('sources') }}
          />
        </div>
      ) : view === 'sources' ? (
        <div className="hl-stage">
          <HealthSources
            snapshot={snapshot}
            isMock={isMock}
            onSource={health.setSourceEnabled}
            onSignal={health.setSignalEnabled}
          />
        </div>
      ) : liveSources === 0 ? (
        /* Reachable from the UI: pause every source in the Sources view. */
        <div className="hl-stage">
          <Empty
            size="section"
            status="stale"
            icon={<HeartPulse className="i20" />}
            title="Every source is paused"
            body="Atlas is not reading anything, so it has nothing to model. Turn a source back on and your body comes back."
            action={{ label: 'Open sources', onClick: () => setView('sources') }}
          />
        </div>
      ) : (
        <main className="hl-grid">
          <HealthClayCard snapshot={snapshot} mode={clayMode} onMode={setClayMode} isMock={isMock} />
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

export default AtlasHealth;
