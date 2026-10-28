/**
 * The tailored heroes of Beta phase 3 — Core, Teach and Architecture
 * (`Atlas Core Beta.dc.html`, `Atlas Teach Beta.dc.html`,
 * `Atlas Architecture Beta.dc.html`, each file's `<header>`): one component,
 * three shapes, rendered above each screen's existing body while the flag is
 * on. Core is the ink orbit lab around the sphere; Teach is the sphere as a
 * microphone; Architecture is the isometric layer stack under a small sphere.
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { VeilSphere } from './VeilSphere';
import { useBetaNavigate } from '@/lib/viewTransitions';
import { setTalkAnchor } from '@/lib/talkBus';
import type { QuickSphereState } from '@/lib/quickSphere';

interface Common {
  eyebrow: ReactNode;
  title: ReactNode;
  intro: ReactNode;
  /** Pin the sphere's state; omit to follow the bus. */
  state?: QuickSphereState;
  /** Rendered after the text (chips, a status line). */
  children?: ReactNode;
}

export function CoreHero(p: Common) {
  const navigate = useBetaNavigate();
  return (
    <header className="b-hero b-hero--core" data-beta-tone="ink" data-screen-label="Core hero">
      <button type="button" className="b-hero-back b-hero-back--ink" title="Back · Esc" onClick={() => navigate('/')}>← Home</button>
      <div className="b-orbit" aria-hidden>
        <svg viewBox="0 0 220 220" className="b-orbit-rings">
          <circle cx="110" cy="110" r="104" fill="none" stroke="rgba(249,247,244,.14)" strokeWidth="1" strokeDasharray="2 6" />
          <circle cx="110" cy="110" r="80" fill="none" stroke="rgba(143,169,255,.28)" strokeWidth="1" />
          <circle cx="214" cy="110" r="4" fill="#8fa9ff" />
          <circle cx="30" cy="110" r="3" fill="#50dca0" />
          <circle cx="110" cy="6" r="3" fill="#ffb36b" />
        </svg>
        <div className="b-orbit-sphere"><VeilSphere size="mini" ink bg="transparent" tone={[30, 30, 36]} state={p.state} /></div>
      </div>
      <div className="b-hero-text">
        <span className="b-eyebrow b-eyebrow--onink">{p.eyebrow}</span>
        <h1 className="b-hero-h1">{p.title}</h1>
        <p className="b-hero-intro">{p.intro}</p>
        {p.children}
      </div>
    </header>
  );
}

export interface TeachHeroProps extends Common {
  /** The sphere is the microphone: the live state decides the label under it. */
  micLabel: string;
  onTapSphere: () => void;
}

export function TeachHero(p: TeachHeroProps) {
  const navigate = useBetaNavigate();
  const ref = useRef<HTMLButtonElement | null>(null);
  useEffect(() => { setTalkAnchor(ref.current); return () => setTalkAnchor(null); }, []);
  return (
    <header className="b-hero b-hero--teach" data-screen-label="Teach hero">
      <button type="button" className="b-hero-back" title="Back · Esc" onClick={() => navigate('/')}>← Home</button>
      <button type="button" ref={ref} className="b-hero-mic" title={p.micLabel} aria-label={p.micLabel} onClick={p.onTapSphere}>
        <VeilSphere size="short" bg="#f1eeea" state={p.state} />
        <span className="b-hero-mic-label">{p.micLabel}</span>
      </button>
      <div className="b-hero-text">
        <span className="b-eyebrow">{p.eyebrow}</span>
        <h1 className="b-hero-h1 b-hero-h1--balance">{p.title}</h1>
        <p className="b-hero-intro">{p.intro}</p>
        {p.children}
      </div>
    </header>
  );
}

export interface ArchitectureHeroProps extends Common {
  /** The stack's layers, top to bottom: label and the tone of the slab. */
  layers: { label: string; tone: 'blue' | 'blue-soft' | 'paper' | 'sand' | 'ink' }[];
}

export function ArchitectureHero(p: ArchitectureHeroProps) {
  const navigate = useBetaNavigate();
  return (
    <header className="b-hero b-hero--arch" data-screen-label="Architecture hero">
      <button type="button" className="b-hero-back" title="Back · Esc" onClick={() => navigate('/')}>← Home</button>
      <div className="b-hero-text">
        <span className="b-eyebrow b-hero-live"><i />{p.eyebrow}</span>
        <h1 className="b-hero-h1">{p.title}</h1>
        <p className="b-hero-intro">{p.intro}</p>
        {p.children}
      </div>
      <div className="b-stack" aria-hidden>
        <div className="b-stack-sphere"><VeilSphere size="mini" bg="#f1eeea" state={p.state} /></div>
        <div className="b-stack-layers">
          {p.layers.map((l) => <span key={l.label} className={`b-stack-layer b-stack-layer--${l.tone}`}>{l.label}</span>)}
        </div>
      </div>
    </header>
  );
}
