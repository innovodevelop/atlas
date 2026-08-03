import { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Cpu, Mail, Mic, MicOff, Sparkles, Settings, Home, CornerUpLeft } from 'lucide-react';
import { Dock, type DockItem } from '@/components/atlas-ui/primitives';
import { useAuth } from '@/hooks/useAuth';
import { useUserProfile } from '@/hooks/useUserProfile';
import { useWeather } from '@/hooks/useWeather';
import { useCalendarEvents } from '@/hooks/useCalendarEvents';
import { useUnifiedChat } from '@/hooks/useUnifiedChat';
import { useVoiceSession } from '@/hooks/useVoiceSession';
import { useAtlasSettings } from '@/hooks/useAtlasSettings';
import { toVoiceSettings } from '@/lib/voiceTuning';
import { useAgentRuns } from '@/hooks/useAgentRuns';
import { useAtlasPresence } from '@/hooks/useAtlasPresence';
import { presenceToWebGL, presenceLabel, isVoiceActive } from '@/components/atlas/presenceBridge';
import { getActiveWakePhrases } from '@/lib/wakeWord';
import { AtlasSphereLazy as AtlasSphere } from '@/components/atlas/AtlasSphereLazy';
import { timeOfDayGreeting } from './atlasHelpers';
import { useBandNarration, type BandContent } from './useBandNarration';
import {
  AtlasWeatherCard, AtlasCalendarCard, AtlasTasksCard,
  AtlasStocksCard, AtlasInboxCard, AtlasBriefingCard,
} from '@/components/atlas-ui/AtlasCards';
import { ProactiveInsight } from '@/components/atlas-ui/ProactiveInsight';
import {
  AtlasAirQualityCard, AtlasNowPlayingCard, AtlasActivityCard, AtlasWorldClockCard,
} from '@/components/atlas-ui/AtlasExtraCards';
import { AtmosphereCanvas } from '@/components/atlas-ui/AtmosphereCanvas';
import { AtlasDrawer } from '@/components/atlas-ui/AtlasDrawer';
import { AtlasExpanded } from '@/components/atlas-ui/AtlasExpanded';
import { AtlasSettings, type SettingsTab } from './AtlasSettings';
import { AccountMenu } from '@/components/atlas-ui/AccountMenu';

export type AtlasExpandedKey = 'weather' | 'calendar' | 'tasks' | 'stocks' | 'email' | 'news' | 'music' | null;

/**
 * Run `commit` after `ms` — but never later than the user's next sign of life.
 *
 * A plain setTimeout is not safe for anything that gates interaction. WKWebView
 * throttles timers hard when the window is not key, so a transition that
 * disables pointer events "for 340ms" can stay disabled indefinitely if the
 * user switches away and back. That is exactly how the dashboard ended up
 * scrollable but completely unclickable.
 *
 * So we race the timer against the first pointer/key/focus/visibility event
 * that arrives once the duration has actually elapsed (wall-clock, not timer
 * ticks). Whichever fires first commits, once.
 */
function commitAfter(ms: number, commit: () => void): void {
  const start = Date.now();
  const WAKE = ['pointerdown', 'keydown', 'focus', 'visibilitychange'] as const;
  let done = false;

  const finish = () => {
    if (done) return;
    done = true;
    window.clearTimeout(timer);
    WAKE.forEach((e) => window.removeEventListener(e, onWake, true));
    commit();
  };
  // Only rescue AFTER the animation would have finished, so an early click
  // during the transition does not cut the motion short.
  const onWake = () => { if (Date.now() - start >= ms) finish(); };

  const timer = window.setTimeout(finish, ms);
  WAKE.forEach((e) => window.addEventListener(e, onWake, true));
}

const AtlasDashboard = () => {
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const { profile } = useUserProfile();
  const { weather } = useWeather();
  const { events } = useCalendarEvents();

  const [drawerOpen, setDrawerOpen] = useState(false);
  // Full-screen widget system: the header + band stay mounted; only the grid
  // region swaps to the focused widget. `gridFolding` runs the staggered
  // fold-out before the focused view mounts; `viewExiting` runs the reverse.
  const [expanded, setExpanded] = useState<AtlasExpandedKey>(null);
  const [acctOpen, setAcctOpen] = useState(false);
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

  // Duplex voice loop via the local gateway (WS-B): capture, VAD barge-in,
  // streamed TTS playback — one hook, same AIState contract as before.
  const { settings: atlasSettings } = useAtlasSettings();
  const {
    audioLevel, effectiveAtlasState,
    handleManualActivate, muted, toggleMute,
  } = useVoiceSession({
    voiceId: atlasSettings.voiceId,
    ttsModelId: atlasSettings.ttsModel,
    voiceSettings: toVoiceSettings(atlasSettings),
  });

  // Auth gate (same behavior as the current dashboard)
  useEffect(() => {
    if (!authLoading && !user) navigate('/auth');
  }, [user, authLoading, navigate]);

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

  const name = profile?.nickname || profile?.first_name || profile?.display_name || 'there';
  const greetingPrefix = `${timeOfDayGreeting()}, `;
  const eventCount = events.length;

  // Home-state band content; the narration hook swaps to per-widget copy when a
  // widget is focused, animating the directional swap.
  const home = useMemo<BandContent>(() => ({
    lead: greetingPrefix,
    accent: `${name}.`,
    subline: [
      eventCount > 0 ? `${eventCount} ${eventCount === 1 ? 'event' : 'events'} today` : 'Nothing on your calendar',
      `${weather.location} · ${weather.condition}`,
    ].join(' · '),
    metaBig: `${Math.round(weather.temp)}°`,
    metaSmall: `${weather.location} · ${weather.condition}`,
  }), [greetingPrefix, name, eventCount, weather.location, weather.condition, weather.temp]);
  const { content: band, swapping } = useBandNarration(expanded, home);

  // Sphere presence: four of the six previously-dead states now have real
  // triggers. `working` from an executing run, `success` from one that just
  // finished, `alert` from one that failed, `muted` from the new mic gate.
  const { runs, activeRun } = useAgentRuns(10);
  const lastDone = useMemo(() => {
    const done = runs.filter((r) => r.status === 'completed' && r.finished_at);
    return done.length ? Date.parse(done[0].finished_at as string) : null;
  }, [runs]);
  const lastFault = useMemo(() => {
    const failed = runs.filter((r) => r.status === 'failed' && r.finished_at);
    return failed.length ? Date.parse(failed[0].finished_at as string) : null;
  }, [runs]);
  const presence = useAtlasPresence({
    voiceState: effectiveAtlasState,
    muted,
    runActive: !!activeRun,
    runCompletedAt: lastDone,
    faultAt: lastFault,
  });

  const initials = (name[0] || 'A').toUpperCase();
  // The one thing in the app allowed to be orange.
  const voiceOn = isVoiceActive(presence);

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
    { id: 'account', label: 'Account', icon: initials, kind: 'avatar',
      onClick: () => setAcctOpen((v) => !v),
      popover: acctOpen ? (
        <AccountMenu
          onClose={() => setAcctOpen(false)}
          onOpenSettings={(tab) => { setSettingsTab(tab); setSettingsOpen(true); }}
        />
      ) : undefined },
  ], [expanded, closeWidget, navigate, handleManualActivate, voiceOn, muted, toggleMute, initials, acctOpen]);

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
          <AtlasSphere state={presenceToWebGL(presence)} audioLevel={audioLevel} context="dashboard" className="orbcvB" />
        </div>
        <div>
          <h2
            className={`greetB${expanded ? ' returnable' : ''}`}
            onClick={expanded ? closeWidget : undefined}
            title={expanded ? 'Return to dashboard' : undefined}
          >{band.lead}<span className="accw">{band.accent}</span></h2>
          <p className="gsubB">{band.subline}</p>
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
          <AtlasWeatherCard onOpen={() => openWidget('weather')} />
          <AtlasCalendarCard onOpen={() => openWidget('calendar')} />
          <AtlasTasksCard onOpen={() => openWidget('tasks')} />
          <AtlasStocksCard onOpen={() => openWidget('stocks')} />
          <AtlasInboxCard onOpen={() => openWidget('email')} />
          <AtlasBriefingCard onOpen={() => openWidget('news')} />
          <AtlasAirQualityCard />
          <AtlasNowPlayingCard onOpen={() => openWidget('music')} />
          <AtlasActivityCard />
          <AtlasWorldClockCard />
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
