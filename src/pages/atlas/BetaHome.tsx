/**
 * The Beta Home — `/` while the beta_ui flag is on (Beta redesign phase 2,
 * `Atlas Dashboard Beta.dc.html`).
 *
 * Stage band first: the sphere, the greeting, the day's context, three asks,
 * and the next event with its two actions. Under it the user's widgets on
 * the six-column grid, packed to the rows this window has. Edit Home swaps
 * the page for the editor; a widget's full view takes the whole page, as the
 * widget screens in the design do. The band stays mounted but hidden there,
 * so its sphere sleeps instead of starting over on the way back.
 *
 * Shares the voice loop, greeting gate and presence with the Workshop
 * dashboard through `useHomeSession`, and the layout table through
 * `useBetaHome`.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useHomeSession } from '@/hooks/useHomeSession';
import { useBetaHome } from '@/hooks/useBetaHome';
import { useCalendarEvents } from '@/hooks/useCalendarEvents';
import { useMailIntelligence } from '@/hooks/useMailIntelligence';
import { useTasks } from '@/hooks/useTasks';
import { StageBand } from '@/components/atlas/home/StageBand';
import { HomeGrid } from '@/components/atlas/home/HomeGrid';
import { HomeWidget } from '@/components/atlas/home/widgets';
import { EditHome } from '@/components/atlas/home/EditHome';
import { AtlasIcon } from '@/components/atlas/AtlasIcon';
import { FullView } from '@/components/atlas/home/views/FullView';
import { WIDGET_BY_ID, packStage, stageRowCount, type HomeSlot, type HomeViewKey } from '@/lib/betaHome';
import { useBetaNavigate } from '@/lib/viewTransitions';
import { isRoutable } from '@/surfaces';
import type { CalendarEvent } from '@/hooks/useCalendarEvents';

const BetaHome = () => {
  const navigate = useBetaNavigate();
  const home = useBetaHome();
  const { settings, layout } = home;
  const greetingSetting = settings.greeting.toLowerCase();
  const session = useHomeSession({ spokenGreeting: greetingSetting !== 'never' && greetingSetting !== 'off' });
  const { updateEvent } = useCalendarEvents();
  const { alerts } = useMailIntelligence();
  const { tasks } = useTasks();
  const needsYou = alerts.filter((a) => !a.acknowledged).length;
  const tasksOpen = tasks.filter((t) => !t.completed).length;

  const [expanded, setExpanded] = useState<HomeViewKey | null>(null);
  const [editing, setEditing] = useState(false);

  // The row budget: what fits between the band and the dock at this window size.
  const bandRef = useRef<HTMLDivElement | null>(null);
  const [rows, setRows] = useState(3);
  useLayoutEffect(() => {
    // The band is hidden under a full view, so there is nothing to measure.
    if (expanded) return;
    const measure = () => {
      const band = bandRef.current?.getBoundingClientRect().height ?? 260;
      setRows(Math.max(1, stageRowCount(window.innerHeight, band)));
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [layout, expanded]);

  // Esc leaves the full view (the Talk panel captures its own Esc first).
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setExpanded(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded]);

  const openWidget = useCallback((slot: HomeSlot) => {
    const def = WIDGET_BY_ID.get(slot.id);
    if (!def?.opens) return undefined;
    if ('view' in def.opens) {
      const view = def.opens.view;
      return () => setExpanded(view);
    }
    const route = def.opens.route;
    return isRoutable(route) ? () => navigate(route) : undefined;
  }, [navigate]);

  const push = useCallback((e: CalendarEvent, minutes: number) => {
    const start = new Date(Date.parse(e.start_time) + minutes * 60000).toISOString();
    const end = e.end_time ? new Date(Date.parse(e.end_time) + minutes * 60000).toISOString() : null;
    void updateEvent(e.id, { start_time: start, end_time: end });
  }, [updateEvent]);

  const forceTone = settings.surface === 'Paper' ? 'paper' as const : settings.surface === 'Ink' ? 'ink' as const : undefined;
  const dropped = layout === 'stage' ? packStage(home.slots, rows).dropped : [];
  const variant = layout === 'stage' ? 'tall' : layout === 'grid' ? 'short' : 'centred';

  if (editing) {
    return (
      <EditHome
        slots={home.slots}
        layout={layout}
        settings={settings}
        rows={rows}
        onCancel={() => setEditing(false)}
        onDone={(next) => { setEditing(false); void home.apply(next); }}
      />
    );
  }

  return (
    <div className={`b-home b-home--${layout}${settings.labels === 'On hover' ? ' b-home--hoverlabels' : ''}`} data-screen-label="Beta — Home">
      <div ref={bandRef} hidden={expanded !== null}>
        <StageBand
          session={session}
          needsYou={needsYou}
          tasksOpen={tasksOpen}
          atlasSize={settings.atlasSize}
          variant={variant}
          onOpenCalendar={() => setExpanded('calendar')}
          onPush={push}
        />
      </div>

      {expanded ? (
        <div className="b-fullview">
          <button type="button" className="b-fullview-bar" onClick={() => setExpanded(null)} aria-label="Back to Home">
            <AtlasIcon name="chevron left" size={16} />Back to Home · Esc
          </button>
          <FullView which={expanded} onClose={() => setExpanded(null)} />
        </div>
      ) : (
        <>
          <div className="b-home-bar">
            <span className="b-eyebrow">Your widgets</span>
            {dropped.length ? (
              <button type="button" className="b-chip b-chip--card b-home-more" onClick={() => setEditing(true)} title="These do not fit at this window size">
                {dropped.length} more in Edit Home
              </button>
            ) : null}
            <button type="button" className="b-btn b-btn--ghost" onClick={() => setEditing(true)}>
              <AtlasIcon name="edit" size={16} />Edit Home
            </button>
          </div>
          <HomeGrid
            slots={home.slots}
            rows={layout === 'stage' ? rows : undefined}
            density={settings.density}
            render={(slot) => <HomeWidget key={slot.id} id={slot.id} size={slot.size} delay={slot.delay} open={openWidget(slot)} forceTone={forceTone} autoState />}
          />
          {home.slots.length === 0 ? (
            <div className="b-empty b-home-empty">
              <p><b>Nothing on your Home yet.</b></p>
              <p>Add widgets, or ask Atlas what it can show you.</p>
              <button type="button" className="b-btn b-btn--primary" onClick={() => setEditing(true)}>Add widgets</button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
};

export default BetaHome;
