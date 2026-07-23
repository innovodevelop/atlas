import { useEffect, useRef } from 'react';
import { X, ArrowUp } from 'lucide-react';
import type { Message } from '@/types';

interface AtlasDrawerProps {
  open: boolean;
  onClose: () => void;
  messages: Message[];
  thinking: boolean;
  stateLabel: string;
  input: string;
  onInput: (v: string) => void;
  onSend: () => void;
}

// Right-side conversation drawer (design: .backdrop + .drawer).
export const AtlasDrawer = ({ open, onClose, messages, thinking, stateLabel, input, onInput, onSend }: AtlasDrawerProps) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [open, messages.length, thinking]);

  if (!open) return null;
  return (
    <div>
      <div className="backdrop" onClick={onClose} />
      <aside className="drawer">
        <div className="dhead">
          <div><h2 className="dtitle">Atlas</h2><p className="dstate">{stateLabel}</p></div>
          <button className="xbtn fx ac jc" onClick={onClose} aria-label="Close"><X className="i16" /></button>
        </div>
        <div className="msgs" ref={scrollRef}>
          {messages.map((m, i) => (
            <div className={`bub ${m.role === 'user' ? 'bubU' : 'bubA'}`} key={m.id ?? i}>{m.content}</div>
          ))}
          {thinking && (
            <div className="tdots"><span className="tdot" /><span className="tdot td2" /><span className="tdot td3" /></div>
          )}
        </div>
        <div className="din">
          <input
            className="inp"
            placeholder="Ask Atlas anything…"
            value={input}
            onChange={(e) => onInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') onSend(); }}
          />
          <button className="sendBtn fx ac jc" onClick={onSend} aria-label="Send"><ArrowUp className="i16" /></button>
        </div>
      </aside>
    </div>
  );
};
