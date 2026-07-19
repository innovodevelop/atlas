import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Cpu, Mic, Sparkles, Settings, Shield } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useUserProfile } from '@/hooks/useUserProfile';
import { useWeather } from '@/hooks/useWeather';
import { useCalendarEvents } from '@/hooks/useCalendarEvents';
import { useUnifiedChat } from '@/hooks/useUnifiedChat';
import { useVoiceSession } from '@/hooks/useVoiceSession';
import { useAtlasSettings } from '@/hooks/useAtlasSettings';
import { AtlasSphereLazy as AtlasSphere } from '@/components/atlas/AtlasSphereLazy';
import { timeOfDayGreeting, atlasStateLabel } from './auroraHelpers';
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

export type AuroraExpandedKey = 'weather' | 'calendar' | 'tasks' | 'stocks' | 'email' | 'news' | null;

const AuroraDashboard = () => {
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const { profile } = useUserProfile();
  const { weather } = useWeather();
  const { events } = useCalendarEvents();

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [expanded, setExpanded] = useState<AuroraExpandedKey>(null);
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
    if (import.meta.env.VITE_PREVIEW_NOAUTH === '1') return; // preview-only bypass
    if (!authLoading && !user) navigate('/auth');
  }, [user, authLoading, navigate]);

  // Esc closes drawer / expanded
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setDrawerOpen(false); setExpanded(null); setSettingsOpen(false); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const send = useCallback(() => {
    const v = input.trim();
    if (!v) return;
    setInput('');
    void sendMessage(v);
  }, [input, sendMessage]);

  const name = profile?.nickname || profile?.first_name || profile?.display_name || 'there';
  const greetingPrefix = `${timeOfDayGreeting()}, `;
  const eventCount = events.length;
  const subline = [
    eventCount > 0 ? `${eventCount} ${eventCount === 1 ? 'event' : 'events'} today` : 'Nothing on your calendar',
    `${weather.location} · ${weather.condition}`,
  ].join(' · ');

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

      <section className="bandB">
        <div className="orbwrapB" onClick={() => setDrawerOpen(true)}>
          <div className="orbhalo" />
          <AtlasSphere state={effectiveAtlasState} audioLevel={audioLevel} context="dashboard" className="orbcvB" />
        </div>
        <div>
          <h2 className="greetB">{greetingPrefix}<span className="accw">{name}.</span></h2>
          <p className="gsubB">{subline}</p>
        </div>
        <div className="bandmetaB">
          <p className="bmvB tnum">{Math.round(weather.temp)}°</p>
          <p className="bmlB">{weather.location} · {weather.condition}</p>
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

      <main className="gridB">
        <AuroraWeatherCard onOpen={() => setExpanded('weather')} />
        <AuroraCalendarCard onOpen={() => setExpanded('calendar')} />
        <AuroraTasksCard onOpen={() => setExpanded('tasks')} />
        <AuroraStocksCard onOpen={() => setExpanded('stocks')} />
        <AuroraInboxCard onOpen={() => setExpanded('email')} />
        <AuroraBriefingCard onOpen={() => setExpanded('news')} />
        <AuroraAirQualityCard />
        <AuroraNowPlayingCard />
        <AuroraActivityCard />
        <AuroraWorldClockCard />
      </main>

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

      <AuroraExpanded
        which={expanded}
        onClose={() => setExpanded(null)}
        onOpenDrawer={() => { setExpanded(null); setDrawerOpen(true); }}
        sphereState={effectiveAtlasState}
        audioLevel={audioLevel}
      />
    </div>
  );
};

export default AuroraDashboard;
