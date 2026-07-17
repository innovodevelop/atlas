import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Cpu, LayoutGrid, Mic, ArrowUp } from 'lucide-react';
import { useUserProfile } from '@/hooks/useUserProfile';
import { useUnifiedChat } from '@/hooks/useUnifiedChat';
import { useVoiceSession } from '@/hooks/useVoiceSession';
import { useAtlasSettings } from '@/hooks/useAtlasSettings';
import { AtlasSphereLazy as AtlasSphere } from '@/components/atlas/AtlasSphereLazy';
import { timeOfDayGreeting } from './auroraHelpers';

const CHIPS = [
  { label: 'Check emails', q: 'Check my emails' },
  { label: 'Search flights', q: 'Search flights to Paris' },
  { label: 'Stock analysis', q: 'Give me a stock analysis' },
  { label: 'Create document', q: 'Create a document' },
];

// Voice-first landing (design: Aurora — Home / Voice).
const AuroraHome = () => {
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
  });

  const send = useCallback((text?: string) => {
    const v = (text ?? input).trim();
    if (!v) return;
    setInput('');
    void sendMessage(v);
  }, [input, sendMessage]);

  const name = profile?.nickname || profile?.first_name || profile?.display_name || 'there';
  const recent = messages.slice(-4);

  return (
    <div className="overlay" data-screen-label="Aurora — Home / Voice">
      <div className="ovwash" />
      <div className="homeorbwrap"><div className="homeorb"><div className="homeorbglow" />
        <AtlasSphere state={effectiveAtlasState} audioLevel={audioLevel} context="core" className="orbcvB w100" onClick={handleManualActivate} />
      </div></div>

      <div className="homewrap">
        <header className="homehead">
          <div className="fx ac gap12"><div className="mk" /><h1 className="wordB">Atlas</h1></div>
          <div className="fx ac gap10">
            <div className="stind"><span className="stpulse" /><span className="stshimmer">Listening</span></div>
            <button className="homebtn" onClick={() => navigate('/atlas-core')} title="Atlas Core"><Cpu className="i16" /></button>
            <button className="homebtn" onClick={() => navigate('/')} title="Dashboard"><LayoutGrid className="i16" /></button>
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
            <button className="chip" key={c.label} onClick={() => send(c.q)}>{c.label}</button>
          ))}
          <button className="chip demo" onClick={() => navigate('/atlas-core')}>Atlas Core</button>
        </div>
      </div></div>
    </div>
  );
};

export default AuroraHome;
