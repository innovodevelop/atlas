import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Cpu, Mail, Mic, MicOff, Sparkles, Settings, Home, CornerUpLeft } from 'lucide-react';
import { Dock, type DockItem } from '@/components/atlas-ui/primitives';
import { useUnifiedChat } from '@/hooks/useUnifiedChat';
import { presenceLabel } from '@/lib/presenceBridge';
import { getActiveWakePhrases } from '@/lib/wakeWord';
import { AtlasSphereCanvas } from '@/components/atlas-ui/AtlasSphereCanvas';
import { useBandNarration } from './useBandNarration';
import { useHomeSession } from '@/hooks/useHomeSession';
import { commitAfter } from '@/lib/commitAfter';
import {
  AtlasWeatherCard, AtlasCalendarCard, AtlasTasksCard,
  AtlasStocksCard, AtlasInboxCard, AtlasBriefingCard,
} from '@/components/atlas-ui/AtlasCards';
import { ProactiveInsight } from '@/components/atlas-ui/ProactiveInsight';
import {
  AtlasAirQualityCard, AtlasNowPlayingCard, AtlasActivityCard, AtlasWorldClockCard,
} from '@/components/atlas-ui/AtlasExtraCards';
import { useDashboardLayout } from '@/hooks/useDashboardLayout';
import { AtmosphereCanvas } from '@/components/atlas-ui/AtmosphereCanvas';
import { AtlasDrawer } from '@/components/atlas-ui/AtlasDrawer';
import { AtlasExpanded } from '@/components/atlas-ui/AtlasExpanded';
import { AtlasSettings, type SettingsTab } from './AtlasSettings';
import { useAccountDockItem } from '@/components/atlas-ui/useAccountDockItem';

/**
 * Registration data. Mirrored in `src/surfaces.ts`, which is what the router,
 * the dock and the account menu are built from; `surfaces.test.ts` fails if the
 * two ever disagree.
 *
 * The registry entry carries `aliases: ['/dashboard']` — one page, two paths —
 * and `eager: true`: this is the default route, so it must not depend on a
 * runtime chunk fetch that could fail in the webview and leave a blank window.
 */
export const surface = {
  path: '/',
  label: 'Dashboard',
  icon: 'Home',
  entry: 'dock' as const,
  mock: false,
  edition: 'consumer' as const,
};

export type AtlasExpandedKey = 'weather' | 'calendar' | 'tasks' | 'stocks' | 'email' | 'news' | 'music' | null;

type WidgetRenderer = (props: { onOpen?: () => void }) => React.ReactNode;

const WIDGET_RENDERERS: Record<string, { component: WidgetRenderer; expandKey?: Exclude<AtlasExpandedKey, null> }> = {
  weather: { component: ({ onOpen }) => <AtlasWeatherCard onOpen={onOpen} />, expandKey: 'weather' },
  calendar: { component: ({ onOpen }) => <AtlasCalendarCard onOpen={onOpen} />, expandKey: 'calendar' },
  tasks: { component: ({ onOpen }) => <AtlasTasksCard onOpen={onOpen} />, expandKey: 'tasks' },
  stocks: { component: ({ onOpen }) => <AtlasStocksCard onOpen={onOpen} />, expandKey: 'stocks' },
  mail: { component: ({ onOpen }) => <AtlasInboxCard onOpen={onOpen} />, expandKey: 'email' },
  briefing: { component: ({ onOpen }) => <AtlasBriefingCard onOpen={onOpen} />, expandKey: 'news' },
  air: { component: () => <AtlasAirQualityCard /> },
  music: { component: ({ onOpen }) => <AtlasNowPlayingCard onOpen={onOpen} />, expandKey: 'music' },
  activity: { component: () => <AtlasActivityCard /> },
  worldclock: { component: () => <AtlasWorldClockCard /> },
};

// `commitAfter` moved to @/lib/commitAfter when the Clock surface needed the
// same guarantee — see that file for why a plain setTimeout is unsafe here.

const AtlasDashboard = () => {
  const navigate = useNavigate();
  // Voice loop, greeting gate, presence and the written band all live in the
  // Home session, shared with the Beta Home (src/hooks/useHomeSession.ts).
  const {
    user, greeting, home, presence, voiceOn, effectiveAtlasState, audioLevel,
    muted, toggleMute, handleManualActivate,
  } = useHomeSession();

  const [drawerOpen, setDrawerOpen] = useState(false);
  // Full-screen widget system: the header + band stay mounted; only the grid
  // region swaps to the focused widget. `gridFolding` runs the staggered
  // fold-out before the focused view mounts; `viewExiting` runs the reverse.
  const [expanded, setExpanded] = useState<AtlasExpandedKey>(null);
  // Lets the account menu deep-link straight to Memory & Privacy, which
  // owns the account-deletion flow the privacy policy points users at.
  const [settingsTab, setSettingsTab] = useState<SettingsTab | undefined>();
  const [gridFolding, setGridFolding] = useState(false);
  const [viewExiting, setViewExiting] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [input, setInput] = useState('');

  // Text chat (drawer). Speech is entirely the gateway session's job now.
  const { messages, isLoading, sendMessage } = useUnifiedChat({
    enableMemory: true,
  });

  // Open a widget: fold the grid up into Atlas, then mount the focused view.
  //
  // commitAfter, not a bare setTimeout. Both of these transitions disable
  // interaction while they run (`.gridB.folding` sets pointer-events:none), and
  // WKWebView defers — occasionally drops — timers when the window is not key.
  // A single lost timer therefore left the entire card grid permanently
  // unclickable with no error and nothing on screen to explain it.
  const openWidget = useCallback((key: Exclude<AtlasExpandedKey, null>) => {
    setGridFolding(true);
    commitAfter(340, () => { setExpanded(key); setGridFolding(false); });
  }, []);

  // Close: slide the focused view out, then bring the grid back (folds in on remount).
  const closeWidget = useCallback(() => {
    setExpanded((cur) => {
      if (!cur) return cur;
      setViewExiting(true);
      commitAfter(300, () => { setExpanded(null); setViewExiting(false); });
      return cur;
    });
  }, []);

  // Esc closes drawer / settings / focused widget
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setDrawerOpen(false); setSettingsOpen(false); closeWidget(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closeWidget]);

  const send = useCallback(() => {
    const v = input.trim();
    if (!v) return;
    setInput('');
    void sendMessage(v);
  }, [input, sendMessage]);

  const { visibleSlots } = useDashboardLayout();
  const { content: band, swapping } = useBandNarration(expanded, home);


  // Shared with /mail. Here it opens Settings as an OVERLAY — a modal over your
  // own desk is the right feel on the dashboard, and it is what keeps the
  // menu's deep-link-to-a-tab behaviour. Mail, which has no overlay, passes a
  // callback that routes to /settings instead.
  const openSettings = useCallback(
    (tab?: 'memory') => { setSettingsTab(tab); setSettingsOpen(true); },
    [],
  );
  const accountItem = useAccountDockItem(openSettings);

  // One dock definition, shared shape with /mail. `onClick` beats `to`, which
  // is what lets Home mean "close the focused widget" here and "navigate" there.
  const dockItems = useMemo<DockItem[]>(() => [
    { id: 'home', label: 'Home', icon: <Home className="i16" />,
      onClick: () => { if (expanded) closeWidget(); else navigate('/'); } },
    { id: 'core', label: 'Core', icon: <Cpu className="i16" />, to: '/atlas-core' },
    // The inbox card is a glance; supervising what Atlas does with mail needs
    // the full three-pane route.
    { id: 'mail', label: 'Mail', icon: <Mail className="i16" />, to: '/mail' },
    { id: 'voice', label: 'Voice', icon: <Mic className="i16" />, kind: 'action',
      onClick: handleManualActivate, voiceActive: voiceOn },
    // The `muted` sphere state was specified with no way to reach it — the
    // audit's rule was to build the control before the visual.
    { id: 'mute', label: 'Mute', icon: <Mic className="i16" />, kind: 'toggle',
      pressed: muted, pressedIcon: <MicOff className="i16" />, pressedLabel: 'Unmute',
      tone: 'danger', onClick: toggleMute },
    { id: 'settings', label: 'Settings', icon: <Settings className="i16" />, kind: 'action',
      onClick: () => setSettingsOpen(true) },
    { id: 'chat', label: 'New chat', icon: <Sparkles className="i16" />, kind: 'cta',
      onClick: () => setDrawerOpen(true) },
    accountItem,
  ], [expanded, closeWidget, navigate, handleManualActivate, voiceOn, muted, toggleMute, accountItem]);

  return (
    <div className="page" data-screen-label="Atlas — Workshop">
      <div className="auro" />
      <AtmosphereCanvas />
      <div className="grain" />
      <ProactiveInsight />

      {/* The pill top bar is gone (2026-07-26 handoff): the greeting band IS the
          header now. What the bar carried moved rather than vanished — the
          wordmark's home action is the dock's Home item, and the listening
          indicator sits under the subline below, because it is the only text
          telling the user the wake phrase and that the microphone is live. */}
      <section className={`bandB${swapping ? ' swapping' : ''}`}>
        <div className="orbwrapB" onClick={() => setDrawerOpen(true)}>
          <div className="orbhalo" />
          {/* `presence` goes straight in now. It used to run through
              presenceToWebGL(), which folded eight states onto the six the
              three.js sphere could draw — and collapsed `success` and `alert`
              onto the same visual, so a failed agent run looked exactly like a
              finished one. This renderer implements all ten natively, so the
              lossy map is gone rather than reimplemented. */}
          <AtlasSphereCanvas className="sphcv" state={presence} />
        </div>
        <div>
          <h2
            className={`greetB${expanded ? ' returnable' : ''}`}
            onClick={expanded ? closeWidget : undefined}
            title={expanded ? 'Return to dashboard' : undefined}
          >{band.lead}<span className="accw">{band.accent}</span></h2>
          {/* The gate answers "why did Atlas just talk to me?" in `reason` — but
              it answers the quiet case too, and that half had nowhere to go.
              Hung off the home subline only: when a widget is focused this line
              narrates the widget, and a greeting reason there would be stale. */}
          <p className="gsubB" title={!expanded && greeting ? greeting.reason : undefined}>{band.subline}</p>
          {/* Relocated from the removed top bar. Kept as a live disclosure that
              the microphone is on and which phrase wakes it — dropping it with
              the header would have made an always-listening app say so
              nowhere. Still the manual-activate affordance. */}
          <button
            className={`bandlisten${voiceOn ? ' voiceon' : ''}`}
            onClick={muted ? toggleMute : handleManualActivate}
            title={muted ? 'Turn the microphone back on' : 'Speak to Atlas'}
          >
            <span className="eq"><span className="eqb" /><span className="eqb" /><span className="eqb" /><span className="eqb" /><span className="eqb" /></span>
            <span>{presenceLabel(presence, getActiveWakePhrases())}</span>
          </button>
        </div>
        <div className="bandmetaB">
          <p className="bmvB tnum">{band.metaBig}</p>
          <p className="bmlB">{band.metaSmall}</p>
        </div>
      </section>

      {/* Bottom dock. Icon-only at rest with `title` tooltips; only the current
          screen carries a label (README §7). Both dock copies — here and in
          /mail — are now the same component fed different items. */}
      <Dock items={dockItems} current="home" />

      {/* Grid region: shows the widget grid, OR the focused widget — the header
          and band above stay mounted either way (design Change 1). */}
      {!expanded ? (
        <main className={`gridB${gridFolding ? ' folding' : ''}`}>
          {visibleSlots.map((slot) => {
            const entry = WIDGET_RENDERERS[slot.widget_id];
            if (!entry) return null;
            const onOpen = entry.expandKey ? () => openWidget(entry.expandKey!) : undefined;
            return <React.Fragment key={slot.widget_id}>{entry.component({ onOpen })}</React.Fragment>;
          })}
        </main>
      ) : (
        <div className={`focusview${viewExiting ? ' exiting' : ''}`}>
          <button className="retbar" onClick={closeWidget} aria-label="Return to dashboard">
            <CornerUpLeft className="i16" />Tap the title or press Esc to return
          </button>
          <AtlasExpanded
            which={expanded}
            onClose={closeWidget}
            onOpenDrawer={() => { closeWidget(); setDrawerOpen(true); }}
            sphereState={effectiveAtlasState}
            audioLevel={audioLevel}
          />
        </div>
      )}

      <AtlasDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        messages={messages}
        thinking={isLoading}
        stateLabel={isLoading ? 'thinking' : 'idle'}
        input={input}
        onInput={setInput}
        onSend={send}
      />

      {settingsOpen && (
        <AtlasSettings
          initialTab={settingsTab}
          onClose={() => { setSettingsOpen(false); setSettingsTab(undefined); }}
        />
      )}
    </div>
  );
};

export default AtlasDashboard;
