/**
 * Atlas Sphere — state gallery and tuning editor.
 *
 * An internal QA surface, not a user feature: it is how you see all the sphere
 * states at once and tune the particle look, in the same way /atlas-architecture
 * is a reference page rather than something on the dock.
 *
 * Its real job right now is to settle the open decision from
 * docs/design-sync/2026-07-26-audit-sphere-mail-header.md §P0-1: the handoff
 * proposes replacing the WebGL sphere (three.js, ~1 MB of the bundle) with this
 * canvas renderer but never says so. The header here mounts BOTH at the same
 * size, on the same state, side by side — so the choice can be made by looking
 * rather than by argument.
 *
 * The two states the audit cut (`waking`, `dissolving`) are still shown, marked
 * as unreachable, because this is the page where you would judge whether they
 * are worth reviving.
 *
 * OPEN FINDING (2026-07-26): the WebGL sphere renders NOTHING here, and not for
 * a want of trying — its canvas has a live, unlost WebGL context, a 448x448
 * buffer, 224x224 CSS box, opacity 1 and visibility visible, mounted inside the
 * dashboard's own .orbwrapB/.orbcvB wrapper. So it is not a sizing or class
 * problem. It could not be compared against the dashboard because that route is
 * behind auth. Two possibilities, and they matter very differently:
 *   a) it needs an ancestor or provider only the dashboard supplies, or
 *   b) it does not render on the dashboard either — a shipped visual bug.
 * Log in and look at the dashboard before reading anything into the empty box
 * below. If (b), the canvas/WebGL decision answers itself.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, RotateCcw, Sun, Moon } from 'lucide-react';
import { AtlasSphereCanvas } from '@/components/atlas/AtlasSphereCanvas';
import { AtlasSphereLazy as WebGLSphere } from '@/components/atlas/AtlasSphereLazy';
import { presenceToWebGL } from '@/components/atlas/presenceBridge';
import { PRESET, STATES, type SphereState } from '@/lib/atlasSphere';
import { ATLAS_STATES, type AtlasPresenceState } from '@/hooks/useAtlasPresence';

interface EditorValues { count: number; dens: number; size: number; soft: number }

const STORE_KEY = 'atlas.sphere.editor.v1';

/** Developer tuning, not user data — hence localStorage rather than the app DB. */
function loadEditor(): EditorValues {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return { ...PRESET, ...(JSON.parse(raw) as Partial<EditorValues>) };
  } catch { /* corrupt or unavailable — fall through to the shipped preset */ }
  return { ...PRESET };
}

const DESCRIPTIONS: Record<SphereState, { trigger: string; text: string; live: boolean }> = {
  idle:       { trigger: 'default',        text: 'Slow spin with a 3% breath.', live: true },
  listening:  { trigger: 'wake word',      text: 'Concentric pressure waves, brighter.', live: true },
  thinking:   { trigger: 'query sent',     text: 'Vertical shear by latitude — a slow braid.', live: true },
  speaking:   { trigger: 'response',       text: 'Eight amplitude bands, tightest at the equator.', live: true },
  working:    { trigger: 'agent run',      text: '72% of the shell migrates into a spinning torus.', live: true },
  success:    { trigger: 'run completed',  text: 'Half the particles peel outward and fade.', live: true },
  alert:      { trigger: 'run failed',     text: 'Tight double pulse with horizontal jitter.', live: true },
  muted:      { trigger: 'mic off',        text: 'Barely moving, contracted, fully desaturated.', live: true },
  waking:     { trigger: 'cut',            text: 'Fly-in from beyond the frame. Cut: a 1.6s intro only delays first paint.', live: false },
  dissolving: { trigger: 'cut',            text: 'Scatter and fade. Cut: a desktop app is quit, not logged out.', live: false },
};

export default function AtlasSphereGallery() {
  const [hero, setHero] = useState<SphereState>('idle');
  const [dark, setDark] = useState(false);
  const [ed, setEd] = useState<EditorValues>(loadEditor);

  // Mirrored to a ref so the render loop reads live values without waiting on a
  // React commit — the same reason the handoff keeps a plain field.
  const edRef = useRef<EditorValues>(ed);
  edRef.current = ed;

  // Sliders are UNCONTROLLED: their value is set once via ref and read from the
  // DOM on input. Re-rendering them from state on every change destroys the
  // drag gesture — the handoff flags this as a bug it actually hit.
  const countRef = useRef<HTMLInputElement | null>(null);
  const densRef = useRef<HTMLInputElement | null>(null);
  const sizeRef = useRef<HTMLInputElement | null>(null);

  const [readout, setReadout] = useState<EditorValues>(ed);

  useEffect(() => {
    const id = window.setTimeout(() => {
      try { localStorage.setItem(STORE_KEY, JSON.stringify(ed)); } catch { /* ignore */ }
    }, 260);
    return () => window.clearTimeout(id);
  }, [ed]);

  const onSlide = useCallback(() => {
    const next: EditorValues = {
      count: Number(countRef.current?.value ?? PRESET.count),
      dens: Number(densRef.current?.value ?? PRESET.dens),
      size: Number(sizeRef.current?.value ?? PRESET.size),
      soft: edRef.current.soft,
    };
    edRef.current = next;
    setReadout(next);
    setEd(next);
  }, []);

  const reset = useCallback(() => {
    const p = { ...PRESET };
    if (countRef.current) countRef.current.value = String(p.count);
    if (densRef.current) densRef.current.value = String(p.dens);
    if (sizeRef.current) sizeRef.current.value = String(p.size);
    edRef.current = p; setReadout(p); setEd(p);
  }, []);

  const bump = useCallback((d: number) => {
    setEd((cur) => {
      const next = { ...cur, soft: Math.max(0, Math.min(10, cur.soft + d)) };
      edRef.current = next; setReadout(next); return next;
    });
  }, []);

  const live = (ATLAS_STATES as readonly string[]).includes(hero);

  return (
    <div className="page" data-screen-label="Atlas — Sphere">
      <div className="auro" />
      <div className="grain" />

      <section className="bandB" style={{ alignItems: 'center' }}>
        {/* Both renderers, same size, same state — the comparison this page exists for. */}
        <div style={{ display: 'flex', gap: 18, alignItems: 'center', flexShrink: 0 }}>
          <figure style={{ margin: 0, textAlign: 'center' }}>
            <AtlasSphereCanvas px={224} state={hero} dark={dark} {...ed} />
            <figcaption style={{ fontSize: 11, letterSpacing: '.13em', textTransform: 'uppercase', color: 'var(--ink3)' }}>canvas</figcaption>
          </figure>
          <figure style={{ margin: 0, textAlign: 'center' }}>
            {/* Same wrapper + className the dashboard uses, so this is the
                WebGL sphere in its known-good configuration rather than a
                variant of it. */}
            <div className="orbwrapB">
              <WebGLSphere
                state={live ? presenceToWebGL(hero as AtlasPresenceState) : 'passive'}
                audioLevel={0}
                context="dashboard"
                className="orbcvB"
              />
            </div>
            <figcaption style={{ fontSize: 11, letterSpacing: '.13em', textTransform: 'uppercase', color: 'var(--ink3)' }}>
              webgl · three.js
              {/* Honest label: an empty box here is a known open question, not a
                  verdict on the renderer. */}
              <span style={{ display: 'block', textTransform: 'none', letterSpacing: 0, color: 'var(--red)', fontSize: 10, marginTop: 2 }}>
                blank here — see file header
              </span>
            </figcaption>
          </figure>
        </div>
        <div>
          <h2 className="greetB">The sphere, <span className="accw">every state.</span></h2>
          <p className="gsubB">
            Both renderers on the same state. The canvas one implements all ten natively;
            the WebGL one maps onto six, which is why <code>success</code> and <code>alert</code> look
            alike there.
          </p>
          <Link to="/dashboard" className="bandlisten" style={{ textDecoration: 'none' }}>
            <ArrowLeft className="i14" /><span>Back to dashboard</span>
          </Link>
        </div>
      </section>

      <div style={{ maxWidth: 1680, margin: '0 auto', padding: '0 28px 120px' }}>
        {/* State chips */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 20 }}>
          {STATES.map((s) => {
            const reachable = (ATLAS_STATES as readonly string[]).includes(s);
            return (
              <button
                key={s}
                onClick={() => setHero(s)}
                className="bandlisten"
                style={{
                  marginTop: 0,
                  background: hero === s ? 'var(--ink)' : undefined,
                  color: hero === s ? 'var(--dkf)' : reachable ? undefined : 'var(--ink3)',
                  opacity: reachable ? 1 : 0.6,
                }}
                title={reachable ? DESCRIPTIONS[s].trigger : 'Cut — no trigger in the product'}
              >
                <span>{s}</span>
                {!reachable && <span style={{ fontSize: 10, letterSpacing: '.1em' }}>CUT</span>}
              </button>
            );
          })}
          <button className="bandlisten" style={{ marginTop: 0 }} onClick={() => setDark((d) => !d)}>
            {dark ? <Sun className="i14" /> : <Moon className="i14" />}
            <span>{dark ? 'Light cards' : 'Dark cards'}</span>
          </button>
        </div>

        {/* Editor */}
        <div className="gpanel" style={{ padding: '24px 28px', borderRadius: 30, marginBottom: 22 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,420px) minmax(0,1fr)', gap: 26, alignItems: 'center' }}>
            <div style={{ display: 'flex', justifyContent: 'center' }}>
              {/* True particle count here; the cards below run at 30%. */}
              <AtlasSphereCanvas px={400} state={hero} dark={dark} {...ed} />
            </div>
            <div>
              {([
                { k: 'count', label: 'Particle amount', hint: 'total points in the cloud', ref: countRef, min: 1500, max: 36000, step: 500, val: readout.count, show: `${(readout.count / 1000).toFixed(1)}k` },
                { k: 'dens', label: 'Particle density', hint: 'shell vs volume distribution', ref: densRef, min: 0.15, max: 1, step: 0.01, val: readout.dens, show: readout.dens.toFixed(2) },
                { k: 'size', label: 'Particle size', hint: 'dot scale multiplier', ref: sizeRef, min: 0.3, max: 3, step: 0.05, val: readout.size, show: `×${readout.size.toFixed(2)}` },
              ] as const).map((row) => (
                <div key={row.k} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '13px 0', borderBottom: '1px solid var(--rz)' }}>
                  <div style={{ width: 180, flexShrink: 0 }}>
                    <p style={{ margin: 0, fontSize: 13.5, fontWeight: 500 }}>{row.label}</p>
                    <p style={{ margin: '2px 0 0', fontSize: 11.5, color: 'var(--ink3)' }}>{row.hint}</p>
                  </div>
                  <input
                    ref={row.ref as React.RefObject<HTMLInputElement>}
                    type="range"
                    min={row.min} max={row.max} step={row.step}
                    defaultValue={row.val}
                    onInput={onSlide}
                    style={{ flex: 1, accentColor: 'var(--acc)' }}
                  />
                  <span className="tnum" style={{ width: 78, textAlign: 'right', fontSize: 13 }}>{row.show}</span>
                </div>
              ))}
              <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '13px 0' }}>
                <div style={{ width: 180, flexShrink: 0 }}>
                  <p style={{ margin: 0, fontSize: 13.5, fontWeight: 500 }}>Colour softness</p>
                  <p style={{ margin: '2px 0 0', fontSize: 11.5, color: 'var(--ink3)' }}>0 hard · 10 pale haze</p>
                </div>
                <button className="bandlisten" style={{ marginTop: 0 }} onClick={() => bump(-1)}>−</button>
                <span className="tnum" style={{ width: 52, textAlign: 'center', fontSize: 13 }}>{readout.soft} / 10</span>
                <button className="bandlisten" style={{ marginTop: 0 }} onClick={() => bump(1)}>+</button>
                <button className="bandlisten" style={{ marginTop: 0, marginLeft: 'auto' }} onClick={reset}>
                  <RotateCcw className="i14" /><span>Reset</span>
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Card grid — 30% of the editor's count, per the handoff, so ten spheres
            stay smooth. Measured: 104k particles across the page is 13% of the
            frame budget on Apple silicon. */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(330px,1fr))', gap: 16 }}>
          {STATES.map((s) => {
            const d = DESCRIPTIONS[s];
            return (
              <button
                key={s}
                onClick={() => setHero(s)}
                style={{
                  textAlign: 'left', border: 'none', cursor: 'pointer', padding: 0,
                  borderRadius: 26, overflow: 'hidden',
                  background: dark ? 'var(--dark-card)' : 'rgba(var(--surface-rgb),.72)',
                  opacity: d.live ? 1 : 0.66,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'center', padding: '10px 0' }}>
                  <AtlasSphereCanvas px={236} state={s} dark={dark} {...ed} countScale={0.3} />
                </div>
                <div style={{ padding: '0 18px 18px', color: dark ? 'var(--dkf)' : 'var(--ink)' }}>
                  <p style={{ margin: 0, fontSize: 18, fontWeight: 600, letterSpacing: '-.02em' }}>{s}</p>
                  <p style={{ margin: '4px 0 0', fontSize: 11, letterSpacing: '.13em', textTransform: 'uppercase', color: d.live ? 'var(--acc-text)' : 'var(--red)' }}>
                    {d.trigger}
                  </p>
                  <p style={{ margin: '8px 0 0', fontSize: 13, color: dark ? 'rgba(249,247,244,.7)' : 'var(--ink2)' }}>{d.text}</p>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
