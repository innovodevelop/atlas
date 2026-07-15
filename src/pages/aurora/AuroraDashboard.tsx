import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Cpu, Mic, Sparkles } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useUserProfile } from '@/hooks/useUserProfile';
import { useWeather } from '@/hooks/useWeather';
import { useCalendarEvents } from '@/hooks/useCalendarEvents';
import { useUnifiedChat } from '@/hooks/useUnifiedChat';
import { useDashboardVoice } from '@/hooks/useDashboardVoice';
import { AtlasSphereLazy as AtlasSphere } from '@/components/atlas/AtlasSphereLazy';
import { timeOfDayGreeting, atlasStateLabel } from './auroraHelpers';
import {
  AuroraWeatherCard, AuroraCalendarCard, AuroraTasksCard,
  AuroraStocksCard, AuroraInboxCard, AuroraBriefingCard,
} from '@/components/aurora/AuroraCards';
import { AuroraDrawer } from '@/components/aurora/AuroraDrawer';
import { AuroraExpanded } from '@/components/aurora/AuroraExpanded';

export type AuroraExpandedKey = 'weather' | 'calendar' | 'tasks' | 'stocks' | 'email' | 'news' | null;

const AuroraDashboard = () => {
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const { profile } = useUserProfile();
  const { weather } = useWeather();
  const { events } = useCalendarEvents();

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [expanded, setExpanded] = useState<AuroraExpandedKey>(null);
  const [input, setInput] = useState('');

  // Sentence-streamed speech bridge (same pattern as the legacy dashboard)
  const speakSentenceRef = useRef<(s: string) => void>(() => {});
  const handleSpeakSentence = useCallback((s: string) => speakSentenceRef.current(s), []);

  const { messages, aiState, setAiState, isLoading, sendMessage } = useUnifiedChat({
    enableMemory: true,
    onSpeakSentence: handleSpeakSentence,
  });

  const {
    audioLevel, effectiveAtlasState, speakSentence,
    handleManualActivate,
  } = useDashboardVoice({ sendMessage, stopAudio: undefined, aiState, isLoading, setAiState });

  useEffect(() => { speakSentenceRef.current = speakSentence; }, [speakSentence]);

  // Auth gate (same behavior as the current dashboard)
  useEffect(() => {
    if (import.meta.env.VITE_PREVIEW_NOAUTH === '1') return; // preview-only bypass
    if (!authLoading && !user) navigate('/auth');
  }, [user, authLoading, navigate]);

  // Esc closes drawer / expanded
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setDrawerOpen(false); setExpanded(null); } };
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
  const greeting = `${timeOfDayGreeting()}, ${name}.`;
  const eventCount = events.length;
  const subline = [
    eventCount > 0 ? `${eventCount} ${eventCount === 1 ? 'event' : 'events'} today` : 'Nothing on your calendar',
    `${weather.location} · ${weather.condition}`,
  ].join(' · ');

  const initials = (name[0] || 'A').toUpperCase();

  return (
    <div className="page" data-screen-label="Atlas — Workshop">
      <div className="auro" />
      <div className="grain" />

      <header className="hdrB">
        <div className="fx ac gap12 pointer" onClick={() => navigate('/')}>
          <div className="mk" /><h1 className="wordB">Atlas</h1>
        </div>
        <div className="stind">
          <span className="eq"><span className="eqb" /><span className="eqb" /><span className="eqb" /><span className="eqb" /><span className="eqb" /></span>
          {atlasStateLabel(effectiveAtlasState)}
        </div>
      </header>

      <section className="bandB">
        <div className="orbwrapB" onClick={() => setDrawerOpen(true)}>
          <div className="orbhalo" />
          <AtlasSphere state={effectiveAtlasState} audioLevel={audioLevel} context="dashboard" className="orbcvB" />
        </div>
        <div>
          <h2 className="greetB">{greeting}</h2>
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
        <button className="dockb" onClick={handleManualActivate} aria-label="Voice">
          <Mic className="i16" /><span className="dockl">Voice</span>
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
