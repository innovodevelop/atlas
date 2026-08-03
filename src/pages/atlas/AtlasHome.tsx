import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Cpu, LayoutGrid, Mic, ArrowUp } from 'lucide-react';
import { useUserProfile } from '@/hooks/useUserProfile';
import { useUnifiedChat } from '@/hooks/useUnifiedChat';
import { useVoiceSession } from '@/hooks/useVoiceSession';
import { useAtlasSettings } from '@/hooks/useAtlasSettings';
import { toVoiceSettings } from '@/lib/voiceTuning';
import { AtlasSphereLazy as AtlasSphere } from '@/components/atlas/AtlasSphereLazy';
import { Button } from '@/components/atlas-ui/primitives';
import { timeOfDayGreeting } from './atlasHelpers';

const CHIPS = [
  { label: 'Check emails', q: 'Check my emails' },
  { label: 'Search flights', q: 'Search flights to Paris' },
  { label: 'Stock analysis', q: 'Give me a stock analysis' },
  { label: 'Create document', q: 'Create a document' },
];

// Voice-first landing (design: Atlas — Home / Voice).
const AtlasHome = () => {
  const navigate = useNavigate();
  const { profile } = useUserProfile();
  const [input, setInput] = useState('');

  const { messages, isLoading, sendMessage } = useUnifiedChat({
    enableMemory: true, source: 'voice_chat',
  });
  // Duplex voice via the local gateway (speech is the session's job now).
  const { settings: atlasSettings } = useAtlasSettings();
  const { audioLevel, effectiveAtlasState, handleManualActivate } = useVoiceSession({
    voiceId: atlasSettings.voiceId,
    ttsModelId: atlasSettings.ttsModel,
    voiceSettings: toVoiceSettings(atlasSettings),
  });
  // The listening pill said "Listening" unconditionally, in Atlas Blue, whether
  // or not the microphone was capturing. It now reflects the real voice state
  // and is the only place on this screen allowed to use --acc2.
  const voiceOn = effectiveAtlasState === 'listening' || effectiveAtlasState === 'speaking';

  const send = useCallback((text?: string) => {
    const v = (text ?? input).trim();
    if (!v) return;
    setInput('');
    void sendMessage(v);
  }, [input, sendMessage]);

  const name = profile?.nickname || profile?.first_name || profile?.display_name || 'there';
  const recent = messages.slice(-4);

  return (
    <div className="overlay" data-screen-label="Atlas — Home / Voice">
      <div className="ovwash" />
      <div className="homeorbwrap"><div className="homeorb"><div className="homeorbglow" />
        <AtlasSphere state={effectiveAtlasState} audioLevel={audioLevel} context="core" className="orbcvB w100" onClick={handleManualActivate} />
      </div></div>

      <div className="homewrap">
        <header className="homehead">
          <div className="fx ac gap12"><div className="mk" /><h1 className="wordB">Atlas</h1></div>
          <div className="fx ac gap10">
            <div className={`stind${voiceOn ? ' voiceon' : ''}`}>
              <span className="stpulse" />
              <span className="stshimmer">
                {effectiveAtlasState === 'speaking' ? 'Speaking' : voiceOn ? 'Listening' : 'Ready'}
              </span>
            </div>
            <Button size="icon" aria-label="Atlas Core" title="Atlas Core" onClick={() => navigate('/atlas-core')}><Cpu className="i16" /></Button>
            <Button size="icon" aria-label="Dashboard" title="Dashboard" onClick={() => navigate('/')}><LayoutGrid className="i16" /></Button>
            <div className="avB fx ac jc">{(name[0] || 'A').toUpperCase()}</div>
          </div>
        </header>

        <div className="homemid">
          <h2 className="homehi">{timeOfDayGreeting()}, {name}</h2>
          <p className="homesub">I'm <span className="hl">Atlas</span>, your neural interface — ask me anything.</p>
        </div>

        <div className="homepanel col">
          {recent.map((m, i) => (
            <div className={`homemsg ${m.role === 'user' ? 'hmU' : 'hmA'}`} key={m.id ?? i}>{m.content}</div>
          ))}
          {isLoading && <div className="tdots"><span className="tdot" /><span className="tdot td2" /><span className="tdot td3" /></div>}
        </div>
      </div>

      <div className="homefoot"><div className="homefootin">
        <div className="homeask">
          <button className="homemic" onClick={handleManualActivate}><Mic className="i16" /></button>
          <input className="homeaskin" placeholder="Message Atlas…" value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') send(); }} />
          <button className="homesend" onClick={() => send()}><ArrowUp className="i16" /></button>
        </div>
        <div className="chips">
          {CHIPS.map((c) => (
            <Button className="chip" size="sm" variant="ghost" key={c.label} onClick={() => send(c.q)}>{c.label}</Button>
          ))}
          <Button className="chip demo" size="sm" variant="ghost" onClick={() => navigate('/atlas-core')}>Atlas Core</Button>
        </div>
      </div></div>
    </div>
  );
};

export default AtlasHome;
