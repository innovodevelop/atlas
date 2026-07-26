import { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Cpu, Mic, Sparkles, Settings, Home, CornerUpLeft } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useUserProfile } from '@/hooks/useUserProfile';
import { useWeather } from '@/hooks/useWeather';
import { useCalendarEvents } from '@/hooks/useCalendarEvents';
import { useUnifiedChat } from '@/hooks/useUnifiedChat';
import { useVoiceSession } from '@/hooks/useVoiceSession';
import { useAtlasSettings } from '@/hooks/useAtlasSettings';
import { AtlasSphereLazy as AtlasSphere } from '@/components/atlas/AtlasSphereLazy';
import { timeOfDayGreeting, atlasStateLabel } from './atlasHelpers';
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
    handleManualActivate,
  } = useVoiceSession({
    voiceId: atlasSettings.voiceId,
    ttsModelId: atlasSettings.ttsModel,
  });

  // Auth gate (same behavior as the current dashboard)
  useEffect(() => {
    if (!authLoading && !user) navigate('/auth');
  }, [user, authLoading, navigate]);

  // Open a widget: fold the grid up into Atlas, then mount the focused view.
  const openWidget = useCallback((key: Exclude<AtlasExpandedKey, null>) => {
    setGridFolding(true);
    window.setTimeout(() => { setExpanded(key); setGridFolding(false); }, 340);
  }, []);

  // Close: slide the focused view out, then bring the grid back (folds in on remount).
  const closeWidget = useCallback(() => {
    setExpanded((cur) => {
      if (!cur) return cur;
      setViewExiting(true);
      window.setTimeout(() => { setExpanded(null); setViewExiting(false); }, 300);
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

  const initials = (name[0] || 'A').toUpperCase();

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
          <AtlasSphere state={effectiveAtlasState} audioLevel={audioLevel} context="dashboard" className="orbcvB" />
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
          <button className="bandlisten" onClick={handleManualActivate} title="Speak to Atlas">
            <span className="eq"><span className="eqb" /><span className="eqb" /><span className="eqb" /><span className="eqb" /><span className="eqb" /></span>
            <span>{atlasStateLabel(effectiveAtlasState)}</span>
          </button>
        </div>
        <div className="bandmetaB">
          <p className="bmvB tnum">{band.metaBig}</p>
          <p className="bmlB">{band.metaSmall}</p>
        </div>
      </section>

      {/* Bottom dock — Workshop's fixed centered pill with hover-expanding labels */}
      <div className="dock">
        {/* Was two buttons, both navigating to /atlas-core. The duplicate is now
            Home — the affordance the wordmark took with it. On the dashboard it
            closes a focused widget; elsewhere it returns here. */}
        <button
          className="dockb"
          onClick={() => { if (expanded) closeWidget(); else navigate('/'); }}
          aria-label="Home"
        >
          <Home className="i16" /><span className="dockl">Home</span>
        </button>
        <button className="dockb" onClick={() => navigate('/atlas-core')} aria-label="Atlas Core">
          <Cpu className="i16" /><span className="dockl">Core</span>
        </button>
        <button className="dockb" onClick={handleManualActivate} aria-label="Voice">
          <Mic className="i16" /><span className="dockl">Voice</span>
        </button>
        <button className="dockb" onClick={() => setSettingsOpen(true)} aria-label="Settings">
          <Settings className="i16" /><span className="dockl">Settings</span>
        </button>
        <button className="dockb dockcta" onClick={() => setDrawerOpen(true)} aria-label="New chat">
          <Sparkles className="i16" /><span className="dockl">New chat</span>
        </button>
        {/* Was a navigate('/atlas-core') with no account surface behind it. */}
        <div className="acctwrap">
          <button
            className="dockav"
            onClick={() => setAcctOpen((v) => !v)}
            aria-label="Account"
            aria-haspopup="menu"
            aria-expanded={acctOpen}
          >{initials}</button>
          {acctOpen && (
            <AccountMenu
              onClose={() => setAcctOpen(false)}
              onOpenSettings={(tab) => { setSettingsTab(tab); setSettingsOpen(true); }}
            />
          )}
        </div>
      </div>

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
