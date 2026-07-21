import { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Cpu, Mic, Sparkles, Settings, Shield, CornerUpLeft } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useUserProfile } from '@/hooks/useUserProfile';
import { useWeather } from '@/hooks/useWeather';
import { useCalendarEvents } from '@/hooks/useCalendarEvents';
import { useUnifiedChat } from '@/hooks/useUnifiedChat';
import { useVoiceSession } from '@/hooks/useVoiceSession';
import { useAtlasSettings } from '@/hooks/useAtlasSettings';
import { AtlasSphereLazy as AtlasSphere } from '@/components/atlas/AtlasSphereLazy';
import { timeOfDayGreeting, atlasStateLabel } from './auroraHelpers';
import { useBandNarration, type BandContent } from './useBandNarration';
import {
  AuroraWeatherCard, AuroraCalendarCard, AuroraTasksCard,
  AuroraStocksCard, AuroraInboxCard, AuroraBriefingCard,
} from '@/components/aurora/AuroraCards';
import {
  AuroraAirQualityCard, AuroraNowPlayingCard, AuroraActivityCard, AuroraWorldClockCard,
} from '@/components/aurora/AuroraExtraCards';
import { HeaderWave } from '@/components/aurora/HeaderWave';
import { AtmosphereCanvas } from '@/components/aurora/AtmosphereCanvas';
import { AuroraDrawer } from '@/components/aurora/AuroraDrawer';
import { AuroraExpanded } from '@/components/aurora/AuroraExpanded';
import { AuroraSettings } from './AuroraSettings';

export type AuroraExpandedKey = 'weather' | 'calendar' | 'tasks' | 'stocks' | 'email' | 'news' | 'music' | null;

const AuroraDashboard = ({ preview = false }: { preview?: boolean } = {}) => {
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const { profile } = useUserProfile();
  const { weather } = useWeather();
  const { events } = useCalendarEvents();

  const [drawerOpen, setDrawerOpen] = useState(false);
  // Full-screen widget system: the header + band stay mounted; only the grid
  // region swaps to the focused widget. `gridFolding` runs the staggered
  // fold-out before the focused view mounts; `viewExiting` runs the reverse.
  const [expanded, setExpanded] = useState<AuroraExpandedKey>(null);
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
    if (preview || import.meta.env.VITE_PREVIEW_NOAUTH === '1') return; // preview-only bypass
    if (!authLoading && !user) navigate('/auth');
  }, [preview, user, authLoading, navigate]);

  // Open a widget: fold the grid up into Atlas, then mount the focused view.
  const openWidget = useCallback((key: Exclude<AuroraExpandedKey, null>) => {
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

      {/* Design "Atlas Dashboard (Current)": floating pill header with the
          animated glow wash + full-width audio-wave canvas; the shimmer label
          and eq bars float centered over the wave. */}
      <header className="hdrB">
        <div className="hdrbg" />
        <HeaderWave state={effectiveAtlasState} audioLevel={audioLevel} />
        <div className="fx ac gap10 pointer" style={{ position: 'relative' }} onClick={() => navigate('/')}>
          <span className="wm" style={{ fontFamily: "'Geist',system-ui,sans-serif", fontWeight: 500, letterSpacing: '-.035em' }}>atlas</span>
        </div>
        <div className="hdrviz" title="Speak to Atlas" onClick={handleManualActivate}>
          <span className="wavelbl">
            <span className="eq"><span className="eqb" /><span className="eqb" /><span className="eqb" /><span className="eqb" /><span className="eqb" /></span>
            <span className="stshimmer">{atlasStateLabel(effectiveAtlasState)}</span>
          </span>
        </div>
      </header>

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
        </div>
        <div className="bandmetaB">
          <p className="bmvB tnum">{band.metaBig}</p>
          <p className="bmlB">{band.metaSmall}</p>
        </div>
      </section>

      {/* Bottom dock — Workshop's fixed centered pill with hover-expanding labels */}
      <div className="dock">
        <button className="dockb" onClick={() => navigate('/atlas-core')} aria-label="Atlas Core">
          <Cpu className="i16" /><span className="dockl">Core</span>
        </button>
        <button className="dockb" onClick={() => navigate('/atlas-core')} aria-label="Control">
          <Shield className="i16" /><span className="dockl">Control</span>
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
        <button className="dockav" onClick={() => navigate('/atlas-core')} aria-label="Profile">{initials}</button>
      </div>

      {/* Grid region: shows the widget grid, OR the focused widget — the header
          and band above stay mounted either way (design Change 1). */}
      {!expanded ? (
        <main className={`gridB${gridFolding ? ' folding' : ''}`}>
          <AuroraWeatherCard onOpen={() => openWidget('weather')} />
          <AuroraCalendarCard onOpen={() => openWidget('calendar')} />
          <AuroraTasksCard onOpen={() => openWidget('tasks')} />
          <AuroraStocksCard onOpen={() => openWidget('stocks')} />
          <AuroraInboxCard onOpen={() => openWidget('email')} />
          <AuroraBriefingCard onOpen={() => openWidget('news')} />
          <AuroraAirQualityCard />
          <AuroraNowPlayingCard onOpen={() => openWidget('music')} />
          <AuroraActivityCard />
          <AuroraWorldClockCard />
        </main>
      ) : (
        <div className={`focusview${viewExiting ? ' exiting' : ''}`}>
          <button className="retbar" onClick={closeWidget} aria-label="Return to dashboard">
            <CornerUpLeft className="i16" />Tap the title or press Esc to return
          </button>
          <AuroraExpanded
            which={expanded}
            onClose={closeWidget}
            onOpenDrawer={() => { closeWidget(); setDrawerOpen(true); }}
            sphereState={effectiveAtlasState}
            audioLevel={audioLevel}
          />
        </div>
      )}

      <AuroraDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        messages={messages}
        thinking={isLoading}
        stateLabel={isLoading ? 'thinking' : 'idle'}
        input={input}
        onInput={setInput}
        onSend={send}
      />

      {settingsOpen && <AuroraSettings onClose={() => setSettingsOpen(false)} />}
    </div>
  );
};

export default AuroraDashboard;
