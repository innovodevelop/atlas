 import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
 import { motion } from 'framer-motion';
 import { Link, useLocation, useNavigate } from 'react-router-dom';
 import { ArrowLeft, Network, Brain, Layers, GraduationCap, Sparkles, Zap } from 'lucide-react';
 import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
 import { AtlasSphereCanvas } from '@/components/atlas-ui/AtlasSphereCanvas';
 import ArchitectureOverview from '@/components/architecture/ArchitectureOverview';
 import AIProvidersSection from '@/components/architecture/AIProvidersSection';
 import MemoryArchitectureSection from '@/components/architecture/MemoryArchitectureSection';
 import LearningPipelineSection from '@/components/architecture/LearningPipelineSection';
 import SphereDocumentation from '@/components/architecture/SphereDocumentation';
 import { isBetaUi } from '@/lib/betaFlag';
 import { ArchitectureHero } from '@/components/atlas/BetaScreenHero';
 import { AtlasIcon } from '@/components/atlas/AtlasIcon';
 import { VeilSphere } from '@/components/atlas/VeilSphere';
 import { useAtlasMemory } from '@/hooks/useAtlasMemory';
 import { useBetaNavigate } from '@/lib/viewTransitions';
 import { escapeAction } from '@/lib/betaScreenKeys';
 import { reducedMotion, type QuickSphereState } from '@/lib/quickSphere';
 import { SPHERE } from '@/lib/betaTokens';
 import {
   ARCH_TABS, EDGE, HERO_LAYERS, LEARNING_STEPS, LOCAL_PARTS, MEMORY_KINDS, REMOTE_SERVICES, RUNS_WHERE,
   SPHERE_STATES, STAYS_HERE, TECH_LOCAL_LINE, TECH_STACK_LINE, TRIP, TRIP_ORDER,
   archEyebrow, archTabFromHash, memoryFacts, sphereStateColor, sphereTechLine, topCategories,
   type ArchTab, type RemoteService, type TripKey,
 } from '@/lib/betaArchitecture';
 // Every class in it is the Beta body's own, so the Workshop page never sees it.
 import '@/styles/beta/architecture.css';

/**
 * Registration data. Mirrored in `src/surfaces.ts`, which is what the router,
 * the dock and the account menu are built from; `surfaces.test.ts` fails if the
 * two ever disagree.
 *
 * Admin: this is documentation ABOUT Atlas — provider tables, the memory
 * pipeline, the sphere's states — written for whoever builds it. Nothing here
 * is a thing a user does.
 *
 * (This block is deliberately not indented like the rest of the file. Every
 * other line carries a stray leading space from an old patch; matching it would
 * spread the mistake.)
 */
export const surface = {
  path: '/atlas-architecture',
  label: 'How Atlas works',
  icon: 'Network',
  entry: 'menu' as const,
  mock: false,
  edition: 'admin' as const,
};

 const WorkshopArchitecture = () => {
   const [activeTab, setActiveTab] = useState('overview');
 
   const tabs = [
     { id: 'overview', label: 'Overview', icon: Network },
     { id: 'providers', label: 'AI Providers', icon: Brain },
     { id: 'memory', label: 'Memory', icon: Layers },
     { id: 'learning', label: 'Learning', icon: GraduationCap },
     { id: 'sphere', label: 'Sphere', icon: Sparkles },
   ];
 
   return (
     <div className="min-h-screen bg-background text-foreground">
       {/* Background gradient */}
       <div className="fixed inset-0 bg-gradient-to-br from-background via-background to-primary/5 pointer-events-none" />
       
       {/* Header */}
       <header className="sticky top-0 z-50 backdrop-blur-xl bg-background/80 border-b border-border/30">
         <div className="max-w-7xl mx-auto px-4 py-4">
           <div className="flex items-center justify-between">
             <div className="flex items-center gap-4">
               <Link 
                 to="/dashboard" 
                 className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors"
               >
                 <ArrowLeft className="w-4 h-4" />
                 <span className="text-sm">Dashboard</span>
               </Link>
               <div className="h-4 w-px bg-border/50" />
               <h1 className="text-lg font-semibold">Atlas Architecture</h1>
             </div>
             <Link
               to="/atlas-core"
               className="text-sm text-muted-foreground hover:text-primary transition-colors"
             >
               View Atlas Core →
             </Link>
           </div>
         </div>
       </header>
 
       <main className="relative max-w-7xl mx-auto px-4 py-8">
         {/* Hero Section */}
         <motion.div 
           className="text-center mb-12"
           initial={{ opacity: 0, y: 20 }}
           animate={{ opacity: 1, y: 0 }}
         >
           <div className="flex items-center justify-center mb-6">
             <div className="w-32 h-32">
               {/* Reference art on a documentation page — there is no live
                   presence to read here, so "idle" is the honest resting state.
                   128 px, so the cloud runs at a third of the tuned count. */}
               <AtlasSphereCanvas state="idle" countScale={0.35} />
             </div>
           </div>
           <h2 className="text-3xl font-bold mb-4">
             Understanding Atlas Intelligence
           </h2>
           <p className="text-muted-foreground max-w-2xl mx-auto">
             A comprehensive guide to how Atlas works—from multi-model AI orchestration and 
             persistent memory systems to continuous learning and the live sphere.
           </p>
         </motion.div>
 
         {/* Tabs */}
         <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
           <TabsList className="w-full flex justify-center gap-1 mb-8 bg-muted/20 p-1 rounded-xl">
             {tabs.map((tab) => {
               const Icon = tab.icon;
               return (
                 <TabsTrigger
                   key={tab.id}
                   value={tab.id}
                   className="flex items-center gap-2 px-4 py-2 rounded-lg data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
                 >
                   <Icon className="w-4 h-4" />
                   <span className="hidden sm:inline">{tab.label}</span>
                 </TabsTrigger>
               );
             })}
           </TabsList>
 
           <TabsContent value="overview">
             <ArchitectureOverview />
           </TabsContent>
 
           <TabsContent value="providers">
             <AIProvidersSection />
           </TabsContent>
 
           <TabsContent value="memory">
             <MemoryArchitectureSection />
           </TabsContent>
 
           <TabsContent value="learning">
             <LearningPipelineSection />
           </TabsContent>
 
           <TabsContent value="sphere">
             <SphereDocumentation />
           </TabsContent>
         </Tabs>
       </main>
 
       {/* Footer */}
       <footer className="border-t border-border/30 py-6 mt-12">
         <div className="max-w-7xl mx-auto px-4 text-center text-sm text-muted-foreground">
           <p>Atlas AI Architecture Documentation • Built with Lovable</p>
         </div>
       </footer>
     </div>
   );
 };
 

/**
 * The screen. The beta_ui flag is read once at boot (changing it reloads the
 * window), so it picks one of two bodies: with the flag off the Workshop page
 * above renders exactly as it did.
 */
const AtlasArchitecture = () => (isBetaUi() ? <BetaArchitecture /> : <WorkshopArchitecture />);

// ── Beta (Atlas Architecture Beta.dc.html) ──────────────────────────────────
//
// The Workshop page's five sections, written again in the design's plain voice
// and checked against the code (see the header of src/lib/betaArchitecture.ts
// for where the design and the app disagree). The Workshop section components
// are left as they were for the flag-off build. The open section lives in the
// URL hash, as on Core, so `/atlas-architecture#memory` lands on Memory.

function BetaArchitecture() {
  const navigate = useBetaNavigate();
  const routeNavigate = useNavigate();
  const location = useLocation();
  const tab: ArchTab = archTabFromHash(location.hash) ?? 'overview';
  const [technical, setTechnical] = useState(false);

  // Replace, not push: switching sections is not a place Back should walk through.
  const openTab = useCallback((key: ArchTab) => {
    routeNavigate(
      { pathname: location.pathname, search: location.search, hash: key === 'overview' ? '' : `#${key}` },
      { replace: true },
    );
  }, [routeNavigate, location.pathname, location.search]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const act = escapeAction(e);
      if (act === 'blur') (e.target as HTMLElement).blur();
      else if (act === 'step') navigate('/');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate]);

  return (
    <div className="b-arch" data-screen-label="Atlas — How Atlas works">
      <ArchitectureHero
        eyebrow={archEyebrow()}
        title="How Atlas works"
        intro="A plain account of where your words go, what stays on this Mac, and what doesn’t."
        layers={[...HERO_LAYERS]}
      />
      <div className="b-arch-bar">
        <nav className="b-arch-seg" aria-label="Architecture sections">
          {ARCH_TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              className={`b-arch-seg-btn${t.key === tab ? ' on' : ''}`}
              aria-current={t.key === tab ? 'page' : undefined}
              onClick={() => openTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <span className="b-arch-sp" />
        <div className="b-arch-seg b-arch-seg--small" role="group" aria-label="Detail level">
          <button type="button" className={`b-arch-seg-btn${technical ? '' : ' on'}`} aria-pressed={!technical} onClick={() => setTechnical(false)}>Plain</button>
          <button type="button" className={`b-arch-seg-btn${technical ? ' on' : ''}`} aria-pressed={technical} onClick={() => setTechnical(true)}>Technical</button>
        </div>
      </div>
      <main className="b-arch-main" aria-label={`How Atlas works · ${ARCH_TABS.find((t) => t.key === tab)?.label ?? 'Overview'}`}>
        {tab === 'overview' ? <ArchOverview technical={technical} onRemembers={() => navigate('/atlas-core#memory')} /> : null}
        {tab === 'providers' ? <ArchProviders technical={technical} /> : null}
        {tab === 'memory' ? <ArchMemory /> : null}
        {tab === 'learning' ? <ArchLearning onTeach={() => navigate('/teach')} /> : null}
        {tab === 'sphere' ? <ArchSphere technical={technical} /> : null}
      </main>
    </div>
  );
}

function SectionHead({ eyebrow, title, children }: { eyebrow: string; title: string; children?: ReactNode }) {
  return (
    <div className="b-arch-head">
      <span className="b-arch-eyebrow">{eyebrow}</span>
      <h2 className="b-arch-h2">{title}</h2>
      {children}
    </div>
  );
}

/** The diagram is drawn at this size and scaled to fit; below MIN_SCALE the list takes over. */
const TRIP_W = 1160;
const TRIP_H = 670;
const MIN_SCALE = 0.62;

/** The width of an element, kept current. */
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

const TRIP_BOXES: readonly { k: TripKey; x: number; y: number; w: number; h: number; tone?: 'page' | 'emph'; icon?: 'mic' | 'memory' }[] = [
  { k: 'speak', x: 28, y: 96, w: 150, h: 86, tone: 'page', icon: 'mic' },
  { k: 'hear', x: 204, y: 96, w: 176, h: 86 },
  { k: 'lookup', x: 406, y: 96, w: 176, h: 86 },
  { k: 'request', x: 608, y: 96, w: 186, h: 86, tone: 'emph' },
  { k: 'answer', x: 608, y: 214, w: 186, h: 92 },
  { k: 'keep', x: 406, y: 214, w: 176, h: 92 },
  { k: 'write', x: 204, y: 214, w: 176, h: 92, tone: 'page', icon: 'memory' },
];

// The AI provider sits on the right, under the arrows that carry the request
// out and the reply back; ElevenLabs, which only ever hears speech and reads
// replies aloud, on the left.
const AI_PROVIDER = REMOTE_SERVICES.find((s) => s.emphasis) ?? REMOTE_SERVICES[0];
const SPEECH_SERVICE = REMOTE_SERVICES.find((s) => s !== AI_PROVIDER) ?? REMOTE_SERVICES[1];

function RemoteCard({ s, x }: { s: RemoteService; x?: number }) {
  return (
    <div className={x == null ? 'b-arch-triplist-remote' : 'b-arch-trip-remote'} style={x == null ? undefined : { left: x, top: 468 }}>
      <div className="b-arch-trip-remote-top">
        <p className="b-arch-trip-remote-n">{s.name}</p>
        <span className={`b-arch-tag${s.emphasis ? ' b-arch-tag--blue' : ''}`}>{s.tag}</span>
      </div>
      <p className="b-arch-trip-remote-d">{s.body}</p>
      <p className="b-arch-trip-remote-s">Sees: {s.sees}. Never: {s.never}.</p>
    </div>
  );
}

function TripDiagram({ technical }: { technical: boolean }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const scale = width ? Math.min(1, width / TRIP_W) : 1;
  const animate = !reducedMotion();

  return (
    <div ref={ref} className="b-arch-trip">
      {width > 0 && scale < MIN_SCALE ? (
        <TripList technical={technical} />
      ) : (
        <div className="b-arch-trip-fit" style={{ height: TRIP_H * scale }}>
          <div className="b-arch-trip-box" style={{ width: TRIP_W, height: TRIP_H, transform: `scale(${scale})` }}>
            <svg viewBox={`0 0 ${TRIP_W} ${TRIP_H}`} className="b-arch-trip-svg" aria-hidden>
              <defs>
                <marker id="b-arch-ah" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,1 L9,5 L0,9 z" fill="#b6b1aa" /></marker>
                <marker id="b-arch-ahb" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,1 L9,5 L0,9 z" fill="#3461f2" /></marker>
                <marker id="b-arch-ahg" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,1 L9,5 L0,9 z" fill="#0a7a53" /></marker>
              </defs>
              <rect x="8" y="8" width="1144" height="340" rx="26" fill="#fffdfa" />
              <rect x="8" y="416" width="1144" height="234" rx="26" fill="#f9f7f4" />
              <line x1="8" y1="382" x2="1152" y2="382" stroke="#3461f2" strokeOpacity=".38" strokeWidth="1.5" strokeDasharray="8 8" />
              <path d="M178,139 H204" stroke="#b6b1aa" strokeWidth="1.6" fill="none" markerEnd="url(#b-arch-ah)" />
              <path d="M380,139 H406" stroke="#b6b1aa" strokeWidth="1.6" fill="none" markerEnd="url(#b-arch-ah)" />
              <path d="M582,139 H608" stroke="#b6b1aa" strokeWidth="1.6" fill="none" markerEnd="url(#b-arch-ah)" />
              <path d="M794,139 H852 Q880,139 880,167 V402" stroke="#3461f2" strokeWidth="2" fill="none" markerEnd="url(#b-arch-ahb)" />
              <path d="M704,416 V306" stroke="#0a7a53" strokeWidth="2" fill="none" markerEnd="url(#b-arch-ahg)" />
              <path d="M614,257 H588" stroke="#b6b1aa" strokeWidth="1.6" fill="none" markerEnd="url(#b-arch-ah)" />
              <path d="M412,257 H386" stroke="#b6b1aa" strokeWidth="1.6" fill="none" markerEnd="url(#b-arch-ah)" />
              <path d="M295,214 C295,192 400,204 497,188" stroke="#b6b1aa" strokeWidth="1.6" fill="none" strokeDasharray="5 5" markerEnd="url(#b-arch-ah)" />
              {/* SMIL ignores the reduced-motion media query, so the moving
                  dots are simply not drawn when it is set. */}
              {animate ? (
                <g>
                  <circle r="3.5" fill="#3461f2"><animateMotion dur="2.6s" repeatCount="indefinite" path="M794,139 H852 Q880,139 880,167 V402" /></circle>
                  <circle r="3.5" fill="#0a7a53"><animateMotion dur="2.6s" begin="1.3s" repeatCount="indefinite" path="M704,416 V306" /></circle>
                  <circle r="3" fill="#3461f2"><animateMotion dur="1.5s" repeatCount="indefinite" path="M178,139 H406" /></circle>
                  <circle r="3" fill="#3461f2"><animateMotion dur="1.5s" begin=".5s" repeatCount="indefinite" path="M406,139 H608" /></circle>
                </g>
              ) : null}
            </svg>

            <p className="b-arch-trip-k" style={{ left: 30, top: 26 }}>On this Mac</p>
            <p className="b-arch-trip-note" style={{ left: 30, top: 48 }}>Nothing in this panel is sent anywhere</p>
            {TRIP_BOXES.map((b) => (
              <div
                key={b.k}
                className={`b-arch-trip-step${b.tone ? ` b-arch-trip-step--${b.tone}` : ''}`}
                style={{ left: b.x, top: b.y, width: b.w, minHeight: b.h }}
              >
                {b.icon ? <AtlasIcon name={b.icon} size={17} weight={1.8} /> : null}
                <p className="b-arch-trip-step-t">{TRIP[b.k].title}</p>
                <p className="b-arch-trip-step-d">{TRIP[b.k].body}</p>
              </div>
            ))}
            <p className="b-arch-trip-loop" style={{ left: 296, top: 196 }}>next time, it remembers</p>
            <div className="b-arch-trip-stays" style={{ left: 28, top: 190 }}>
              <p className="b-arch-trip-stays-k">Stays here</p>
              <p className="b-arch-trip-stays-v">{STAYS_HERE.map((s, i) => <span key={s}>{i ? <br /> : null}{s}</span>)}</p>
            </div>
            {technical ? <span className="b-arch-trip-tech" style={{ left: 204, top: 322 }}>{TECH_LOCAL_LINE}</span> : null}
            <div className="b-arch-trip-edge" style={{ left: 24, top: 370 }}>The edge of your Mac</div>
            <div className="b-arch-trip-label b-arch-trip-label--in" style={{ left: 370, top: 350, width: 318 }}>
              <p>{EDGE.returns.title}</p><p>{EDGE.returns.body}</p>
            </div>
            <div className="b-arch-trip-label b-arch-trip-label--out" style={{ left: 896, top: 350, width: 250 }}>
              <p>{EDGE.leaves.title}</p><p>{EDGE.leaves.body}</p>
            </div>
            <p className="b-arch-trip-k" style={{ left: 40, top: 436 }}>Somewhere else</p>
            <RemoteCard s={SPEECH_SERVICE} x={40} />
            <RemoteCard s={AI_PROVIDER} x={600} />
          </div>
        </div>
      )}
    </div>
  );
}

/** The same trip as a numbered list, for widths the diagram cannot fit. */
function TripList({ technical }: { technical: boolean }) {
  return (
    <div className="b-arch-triplist">
      <p className="b-arch-triplist-k">On this Mac</p>
      <ol className="b-arch-triplist-steps">
        {TRIP_ORDER.map((k, i) => (
          <li key={k} className={`b-arch-triplist-step${k === 'request' ? ' emph' : ''}`}>
            <span className="b-arch-triplist-n">{i + 1}</span>
            <span className="b-arch-triplist-main"><b>{TRIP[k].title}</b><span>{TRIP[k].body}</span></span>
          </li>
        ))}
      </ol>
      <p className="b-arch-triplist-stays"><b>Stays here:</b> {STAYS_HERE.join(', ').toLowerCase()}.</p>
      {technical ? <p className="b-arch-mono">{TECH_LOCAL_LINE}</p> : null}
      <p className="b-arch-triplist-edge out"><b>{EDGE.leaves.title}.</b> {EDGE.leaves.body}</p>
      <p className="b-arch-triplist-edge in"><b>{EDGE.returns.title}.</b> {EDGE.returns.body}</p>
      <p className="b-arch-triplist-k">Somewhere else</p>
      <RemoteCard s={AI_PROVIDER} />
      <RemoteCard s={SPEECH_SERVICE} />
    </div>
  );
}

function ArchOverview({ technical, onRemembers }: { technical: boolean; onRemembers: () => void }) {
  return (
    <>
      <section className="b-arch-panel" aria-labelledby="b-arch-trip-h">
        <div className="b-arch-head b-arch-head--split">
          <div>
            <span className="b-arch-eyebrow">The whole picture</span>
            <h2 id="b-arch-trip-h" className="b-arch-h2">One trip through Atlas</h2>
          </div>
          <p className="b-arch-lede">Follow it left to right along the top, and back along the bottom. Everything in the white panel happens here, on your machine.</p>
        </div>
        <TripDiagram technical={technical} />
      </section>

      <section className="b-arch-ink" aria-labelledby="b-arch-clear-h">
        <span className="b-arch-ink-k">The part worth being clear about</span>
        <h2 id="b-arch-clear-h" className="b-arch-ink-h">Your memories stay on this Mac. The requests built from them do not.</h2>
        <div className="b-arch-ink-cols">
          <p>Atlas keeps everything it knows about you in a single file on your own disk. No copy is uploaded, no account holds it, and deleting it deletes it.</p>
          <p>But to answer you, it has to send your question somewhere, and it sends the relevant memories along with it. That’s what makes the answer feel like yours.</p>
          <p>So the file never travels. Sentences from it do, a handful at a time, every time you ask something. That’s the honest shape of it.</p>
        </div>
        <div className="b-arch-ink-actions">
          <button type="button" className="b-arch-cta" onClick={onRemembers}>See exactly what Atlas remembers</button>
          <span>Every memory is listed in Core; Settings → Memory &amp; Privacy removes any of them.</span>
        </div>
      </section>

      <section className="b-arch-card" aria-labelledby="b-arch-runs-h">
        <div className="b-arch-head">
          <span className="b-arch-eyebrow">In short</span>
          <h2 id="b-arch-runs-h" className="b-arch-h2 b-arch-h2--small">What runs where</h2>
        </div>
        {RUNS_WHERE.map((r) => (
          <div key={r.what} className="b-arch-run">
            <span>{r.what}</span>
            <span className={`b-arch-run-w${r.local ? ' local' : ''}`}>{r.where}</span>
          </div>
        ))}
        {technical ? <p className="b-arch-mono">{TECH_STACK_LINE}</p> : null}
        <p className="b-arch-foot">Turn off the network and Atlas still knows you: the memory file and its search are here. It can’t turn your speech into words or answer you until the network is back.</p>
      </section>
    </>
  );
}

function ArchProviders({ technical }: { technical: boolean }) {
  return (
    <>
      <section className="b-arch-panel">
        <SectionHead eyebrow="Somewhere else" title="Two services, and what each one sees" />
        <div className="b-arch-cards b-arch-cards--wide">
          {REMOTE_SERVICES.map((p) => (
            <div key={p.name} className="b-arch-svc">
              <div className="b-arch-svc-top">
                <span className="b-arch-svc-n">{p.name}</span>
                <span className={`b-arch-tag${p.emphasis ? ' b-arch-tag--blue' : ''}`}>{p.tag}</span>
              </div>
              <p className="b-arch-body">{p.body}</p>
              <div className="b-arch-sees">
                <div className="sees"><p>Sees</p><p>{p.sees}</p></div>
                <div className="never"><p>Never sees</p><p>{p.never}</p></div>
              </div>
              {technical ? <p className="b-arch-mono">{p.tech}</p> : null}
            </div>
          ))}
        </div>
      </section>
      <section className="b-arch-panel">
        <SectionHead eyebrow="Kept here" title="Four things that never go online">
          <p className="b-arch-lede">These run on your machine because they have to be fast, because they’re always on, or because sending them would be indefensible.</p>
        </SectionHead>
        <div className="b-arch-cards">
          {LOCAL_PARTS.map((l) => (
            <div key={l.title} className="b-arch-local">
              <span className="b-arch-local-ico"><AtlasIcon name={l.icon} size={19} weight={1.5} /></span>
              <p className="b-arch-local-t">{l.title}</p>
              <p className="b-arch-body">{l.body}</p>
              {technical ? <p className="b-arch-mono">{l.tech}</p> : null}
            </div>
          ))}
        </div>
      </section>
    </>
  );
}

function ArchMemory() {
  // The same read Core's Memory tab makes: the brain's own list, on this Mac.
  const { memories, byCategory, state, message } = useAtlasMemory();
  const cats = topCategories(byCategory);
  const facts = memoryFacts({ state, count: memories.length, message });
  return (
    <>
      <section className="b-arch-panel b-arch-split">
        <SectionHead eyebrow="How it remembers" title="Three kinds of memory">
          <p className="b-arch-lede">They behave differently on purpose. Only the third one lasts.</p>
        </SectionHead>
        <div className="b-arch-list">
          {MEMORY_KINDS.map((k) => (
            <div key={k.n} className={`b-arch-kind${k.lasting ? ' lasting' : ''}`}>
              <span className="b-arch-kind-n">{k.n}</span>
              <div className="b-arch-kind-main">
                <p className="b-arch-kind-t">{k.title}</p>
                <p className="b-arch-body">{k.body}</p>
                {k.lasting && cats.shown.length ? (
                  <ul className="b-arch-chips" aria-label="The categories in your memory file">
                    {cats.shown.map((c) => <li key={c} className="b-arch-chip">{c}</li>)}
                    {cats.more ? <li className="b-arch-chip">+ {cats.more} more</li> : null}
                  </ul>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      </section>
      <section className="b-arch-card b-arch-facts" aria-label="Memory in figures">
        {facts.map((m) => (
          <div key={m.title} className="b-arch-fact">
            <p className="b-arch-fact-v">{m.value}</p>
            <p className="b-arch-fact-t">{m.title}</p>
            <p className="b-arch-fact-d">{m.body}</p>
          </div>
        ))}
      </section>
    </>
  );
}

function ArchLearning({ onTeach }: { onTeach: () => void }) {
  const [step, setStep] = useState<string>('recall');
  const last = LEARNING_STEPS.length - 1;
  return (
    <section className="b-arch-panel b-arch-split">
      <SectionHead eyebrow="How it learns" title="Learning happens after the fact">
        <p className="b-arch-lede">Nothing about you is trained into a model. Learning here means writing things down and reading them back.</p>
        <p className="b-arch-lede">In the background the scheduler runs the same loop without you: summaries, and the research you asked for. It uses the same provider as your conversations.</p>
        <button type="button" className="b-arch-cta b-arch-cta--small" onClick={onTeach}>Teach it something directly</button>
      </SectionHead>
      <div className="b-arch-list">
        {LEARNING_STEPS.map((s, i) => {
          const on = s.key === step;
          return (
            <button
              key={s.key}
              type="button"
              className={`b-arch-step${on ? ' on' : ''}${on || i === last ? ' lit' : ''}`}
              aria-expanded={on}
              onClick={() => setStep(s.key)}
            >
              <span className="b-arch-step-n">{i + 1}</span>
              <span className="b-arch-step-main">
                <span className="b-arch-step-t">{s.title}</span>
                <span className="b-arch-step-d">{s.body}</span>
                {on ? <span className="b-arch-step-ex">{s.example}</span> : null}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function ArchSphere({ technical }: { technical: boolean }) {
  // A demonstration, so it takes the picked state instead of the bus.
  const [state, setState] = useState<QuickSphereState>('idle');
  const cur = SPHERE_STATES.find((s) => s.state === state) ?? SPHERE_STATES[0];
  return (
    <section className="b-arch-panel b-arch-sphere">
      <div className="b-arch-sphere-stage">
        <div className="b-arch-sphere-canvas">
          <VeilSphere state={state} count={SPHERE.bandCount} bg="#fffdfa" label={`The sphere, showing ${cur.name}`} />
        </div>
        <span className="b-arch-sphere-chip" aria-live="polite"><i style={{ background: sphereStateColor(cur.state) }} />{cur.name}</span>
      </div>
      <div className="b-arch-list">
        <SectionHead eyebrow="The sphere" title="It isn’t decoration">
          <p className="b-arch-lede">
            {SPHERE.bandCount.toLocaleString('en-US')} points, drawn on your machine every frame. Its shape is the one honest read-out of what Atlas is doing, readable from across the room. Pick a state to see it.
          </p>
        </SectionHead>
        {SPHERE_STATES.map((s) => (
          <button
            key={s.state}
            type="button"
            className={`b-arch-state${s.state === state ? ' on' : ''}`}
            aria-pressed={s.state === state}
            onClick={() => setState(s.state)}
          >
            <i style={{ background: sphereStateColor(s.state) }} />
            <span className="b-arch-state-n">{s.name}</span>
            <span className="b-arch-state-d">{s.body}</span>
          </button>
        ))}
        {technical ? <p className="b-arch-mono">{sphereTechLine(SPHERE.bandCount, SPHERE.miniCount)}</p> : null}
      </div>
    </section>
  );
}

export default AtlasArchitecture;