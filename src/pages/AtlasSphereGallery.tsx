/**
 * Atlas Sphere — state gallery and tuning editor.
 *
 * An internal QA surface, not a user feature: it is how you see every sphere
 * state at once and tune the particle look, in the same way /atlas-architecture
 * is a reference page rather than something on the dock.
 *
 * It used to exist to settle a decision — canvas vs WebGL — and mounted both
 * renderers side by side to be judged by eye. THAT DECISION IS MADE. The
 * three.js sphere, its ~1 MB chunk and the lossy eight-states-onto-six bridge
 * that fed it are deleted; this canvas renderer serves every surface in the
 * app. So the comparison mount is gone and this page has one job left: be the
 * only place the renderer's ~20 options can be driven.
 *
 * The two states the audit cut (`waking`, `dissolving`) are still shown, marked
 * as unreachable, because this is the page where you would judge whether they
 * are worth reviving.
 *
 * WHY THE PREVIEW IS WIDE. The field formation (`morph < 1`) is full-bleed and
 * sized to the canvas aspect — on the old fixed 400x400 stage it was cropped on
 * two sides and the morph could not honestly be judged. The preview is a wide
 * box on purpose, which also means this page exercises the renderer's
 * non-square geometry rather than only its square path.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, RotateCcw, Sun, Moon } from 'lucide-react';
import { AtlasSphereCanvas } from '@/components/atlas-ui/AtlasSphereCanvas';
import { PRESET, STATES, type RGB, type SphereOpts, type SphereState } from '@/lib/atlasSphere';
import { ATLAS_STATES } from '@/hooks/useAtlasPresence';
import { Button, Card, Panel } from '@/components/atlas-ui/primitives';

/**
 * Registration data. Mirrored in `src/surfaces.ts`, which is what the router,
 * the dock and the account menu are built from; `surfaces.test.ts` fails if the
 * two ever disagree.
 *
 * Admin, and `devOnly` on top of that — the registry entry preserves the
 * `import.meta.env.DEV` gate the account menu applied by hand. Twenty raw
 * renderer sliders are a tuning instrument; in a shipped build this stays
 * URL-only on purpose.
 */
export const surface = {
  path: '/atlas-sphere',
  label: 'Sphere gallery',
  icon: 'Orbit',
  entry: 'menu' as const,
  mock: false,
  edition: 'admin' as const,
};

type EditorKey =
  | 'count' | 'dens' | 'size' | 'soft' | 'whiten' | 'alphaGain'
  | 'morph' | 'amp' | 'pulse' | 'fieldSpread' | 'sphereFrac'
  | 'radius' | 'cx' | 'cy' | 'glow' | 'maxDpr';

type EditorValues = Record<EditorKey, number>;

/**
 * NOTE ON `glow`: the renderer defaults it to 0.15 dark / 0.07 light. The
 * editor always sends a value, so the dark toggle no longer changes the glow on
 * THIS PAGE. That is a property of having a slider for it, not a renderer
 * change — the app's mounts pass no `glow` and keep the state-aware default.
 */
const DEFAULTS: EditorValues = {
  ...PRESET,
  whiten: 0,
  alphaGain: 1,
  morph: 1,
  amp: 0.3,
  pulse: 0,
  fieldSpread: 1.06,
  sphereFrac: 1,
  radius: 0.44,
  cx: 0.5,
  cy: 0.5,
  glow: 0.07,
  maxDpr: 1.5,
};

interface RowDef {
  k: EditorKey;
  group: 'cloud' | 'formation' | 'frame';
  label: string;
  hint: string;
  min: number;
  max: number;
  step: number;
  fmt: (v: number) => string;
}

const f2 = (v: number) => v.toFixed(2);

const ROWS: RowDef[] = [
  { k: 'count', group: 'cloud', label: 'Particle amount', hint: 'total points in the cloud', min: 1500, max: 36000, step: 500, fmt: (v) => `${(v / 1000).toFixed(1)}k` },
  { k: 'dens', group: 'cloud', label: 'Particle density', hint: 'shell vs volume distribution', min: 0.15, max: 1, step: 0.01, fmt: f2 },
  { k: 'size', group: 'cloud', label: 'Particle size', hint: 'dot scale multiplier', min: 0.3, max: 3, step: 0.05, fmt: (v) => `x${v.toFixed(2)}` },
  { k: 'soft', group: 'cloud', label: 'Colour softness', hint: '0 hard · 10 pale haze', min: 0, max: 10, step: 1, fmt: (v) => `${v} / 10` },
  { k: 'whiten', group: 'cloud', label: 'Whiten', hint: 'blend every shade toward white', min: 0, max: 1, step: 0.02, fmt: f2 },
  { k: 'alphaGain', group: 'cloud', label: 'Alpha gain', hint: 'multiplies every particle alpha', min: 0.2, max: 2, step: 0.05, fmt: (v) => `x${v.toFixed(2)}` },

  { k: 'morph', group: 'formation', label: 'Morph', hint: '1 sphere · 0 field · between = in transit', min: 0, max: 1, step: 0.01, fmt: f2 },
  { k: 'amp', group: 'formation', label: 'Wave amplitude', hint: 'field crest strength — mostly alpha, barely position', min: 0, max: 1, step: 0.01, fmt: f2 },
  { k: 'pulse', group: 'formation', label: 'Pulse', hint: 'radial swell on the field', min: 0, max: 1, step: 0.01, fmt: f2 },
  { k: 'fieldSpread', group: 'formation', label: 'Field spread', hint: 'field size as a fraction of the canvas', min: 0.5, max: 1.6, step: 0.01, fmt: f2 },
  { k: 'sphereFrac', group: 'formation', label: 'Sphere fraction', hint: 'the rest fade out on the way in', min: 0.2, max: 1, step: 0.01, fmt: f2 },

  { k: 'radius', group: 'frame', label: 'Radius', hint: 'fraction of the SHORT edge', min: 0.15, max: 0.8, step: 0.01, fmt: f2 },
  { k: 'cx', group: 'frame', label: 'Centre X', hint: 'fraction of width', min: 0, max: 1, step: 0.01, fmt: f2 },
  { k: 'cy', group: 'frame', label: 'Centre Y', hint: 'fraction of height', min: 0, max: 1, step: 0.01, fmt: f2 },
  { k: 'glow', group: 'frame', label: 'Glow', hint: 'backdrop glow alpha · 0 disables', min: 0, max: 0.5, step: 0.01, fmt: f2 },
  { k: 'maxDpr', group: 'frame', label: 'Max DPR', hint: 'backing-store density cap', min: 0.5, max: 3, step: 0.1, fmt: (v) => `x${v.toFixed(1)}` },
];

const GROUPS: { id: RowDef['group']; title: string; blurb: string }[] = [
  { id: 'cloud', title: 'Cloud', blurb: 'How many dots there are and what they look like.' },
  { id: 'formation', title: 'Formation', blurb: 'Sphere, field, and the transit between them.' },
  { id: 'frame', title: 'Frame', blurb: 'Where the sphere sits on a canvas of any aspect.' },
];

/**
 * Palette overrides. `null` means "use the state tint", which is what every app
 * surface does. The named ones stand in for an artwork palette — the shape the
 * music player hands in from AtlasCover — so the palette path can be judged
 * here without a Spotify session.
 */
const PALETTES: { id: string; label: string; value: RGB[] | null }[] = [
  { id: 'state', label: 'State tint', value: null },
  { id: 'paper', label: 'Paper', value: [[186, 206, 252], [230, 239, 255], [255, 253, 250]] },
  { id: 'ember', label: 'Ember', value: [[92, 34, 20], [214, 104, 42], [255, 216, 170]] },
  { id: 'moss', label: 'Moss', value: [[18, 48, 40], [64, 148, 118], [206, 240, 220]] },
];

const STORE_KEY = 'atlas.sphere.editor.v2';

/**
 * Developer tuning, not user data — hence localStorage rather than the app DB.
 * The key is v2: v1 held four values, and a v1 blob would leave every new
 * option at its default anyway, so the rename avoids a half-restored editor.
 */
function loadEditor(): EditorValues {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<EditorValues>) };
  } catch { /* corrupt or unavailable — fall through to the shipped preset */ }
  return { ...DEFAULTS };
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

/** Morph presets — the three readings worth checking at a glance. */
const MORPH_STOPS: { label: string; v: number }[] = [
  { label: 'Sphere', v: 1 },
  { label: 'Transit', v: 0.5 },
  { label: 'Field', v: 0 },
];

export default function AtlasSphereGallery() {
  const [hero, setHero] = useState<SphereState>('idle');
  const [dark, setDark] = useState(false);
  const [palId, setPalId] = useState('state');
  const [adaptive, setAdaptive] = useState(false);
  const [ed, setEd] = useState<EditorValues>(loadEditor);

  // Mirrored to a ref so the render loop reads live values without waiting on a
  // React commit — the same reason the handoff keeps a plain field.
  const edRef = useRef<EditorValues>(ed);
  edRef.current = ed;

  // Sliders are UNCONTROLLED: their value is set once via ref and read from the
  // DOM on input. Re-rendering them from state on every change destroys the
  // drag gesture — the handoff flags this as a bug it actually hit.
  const inputs = useRef<Partial<Record<EditorKey, HTMLInputElement | null>>>({});

  const [readout, setReadout] = useState<EditorValues>(ed);

  useEffect(() => {
    const id = window.setTimeout(() => {
      try { localStorage.setItem(STORE_KEY, JSON.stringify(ed)); } catch { /* ignore */ }
    }, 260);
    return () => window.clearTimeout(id);
  }, [ed]);

  const onSlide = useCallback(() => {
    const next = { ...edRef.current };
    for (const row of ROWS) {
      const el = inputs.current[row.k];
      if (el) next[row.k] = Number(el.value);
    }
    edRef.current = next;
    setReadout(next);
    setEd(next);
  }, []);

  /** Write values to both the DOM sliders and state — Reset and the morph chips. */
  const put = useCallback((patch: Partial<EditorValues>) => {
    const next = { ...edRef.current, ...patch };
    for (const k of Object.keys(patch) as EditorKey[]) {
      const el = inputs.current[k];
      if (el) el.value = String(next[k]);
    }
    edRef.current = next;
    setReadout(next);
    setEd(next);
  }, []);

  const reset = useCallback(() => put({ ...DEFAULTS }), [put]);

  const palette = PALETTES.find((p) => p.id === palId)?.value ?? null;

  /** The opts every mount on this page shares. */
  const opts = useMemo<SphereOpts>(() => ({
    count: ed.count,
    dens: ed.dens,
    size: ed.size,
    // `soft` is a 0-10 integer in the renderer's contract; the slider steps by
    // 1 but a restored localStorage blob could hold anything.
    soft: Math.round(ed.soft),
    whiten: ed.whiten,
    alphaGain: ed.alphaGain,
    morph: ed.morph,
    amp: ed.amp,
    pulse: ed.pulse,
    fieldSpread: ed.fieldSpread,
    sphereFrac: ed.sphereFrac,
    radius: ed.radius,
    cx: ed.cx,
    cy: ed.cy,
    glow: ed.glow,
    maxDpr: ed.maxDpr,
    dark,
    palette,
  }), [ed, dark, palette]);

  return (
    <div className="page" data-screen-label="Atlas — Sphere">
      <div className="auro" />
      <div className="grain" />

      <section className="bandB" style={{ alignItems: 'center' }}>
        <div style={{ width: 224, height: 224, flexShrink: 0 }}>
          <AtlasSphereCanvas state={hero} {...opts} />
        </div>
        <div>
          <h2 className="greetB">The sphere, <span className="accw">every state.</span></h2>
          <p className="gsubB">
            One renderer, ten states, two formations. This page is the only place
            the renderer&rsquo;s options are exposed — the app&rsquo;s own mounts pass a
            state and take the defaults.
          </p>
          <Link to="/dashboard" className="bandlisten" style={{ textDecoration: 'none' }}>
            <ArrowLeft className="i14" /><span>Back to dashboard</span>
          </Link>
        </div>
      </section>

      <div style={{ maxWidth: 1680, margin: '0 auto', padding: '0 28px 120px' }}>
        {/* State chips */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
          {STATES.map((s) => {
            const reachable = (ATLAS_STATES as readonly string[]).includes(s);
            return (
              <Button
                key={s}
                size="sm"
                variant={hero === s ? 'ink' : 'ghost'}
                onClick={() => setHero(s)}
                style={{ color: hero === s ? undefined : reachable ? undefined : 'var(--ink3)', opacity: reachable ? 1 : 0.6 }}
                title={reachable ? DESCRIPTIONS[s].trigger : 'Cut — no trigger in the product'}
              >
                <span>{s}</span>
                {!reachable && <span style={{ fontSize: 10, letterSpacing: '.1em' }}>CUT</span>}
              </Button>
            );
          })}
          <Button size="sm" icon={dark ? <Sun className="i14" /> : <Moon className="i14" />} onClick={() => setDark((d) => !d)}>
            {dark ? 'Light cards' : 'Dark cards'}
          </Button>
        </div>

        {/* Formation + palette chips — the fast readings, above the sliders. */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 20, alignItems: 'center' }}>
          <span style={{ fontSize: 11, letterSpacing: '.13em', textTransform: 'uppercase', color: 'var(--ink3)' }}>Formation</span>
          {MORPH_STOPS.map((m) => (
            <Button
              key={m.label}
              size="sm"
              variant={Math.abs(readout.morph - m.v) < 0.005 ? 'ink' : 'ghost'}
              onClick={() => put({ morph: m.v })}
            >
              {m.label}
            </Button>
          ))}
          <span style={{ width: 18 }} />
          <span style={{ fontSize: 11, letterSpacing: '.13em', textTransform: 'uppercase', color: 'var(--ink3)' }}>Palette</span>
          {PALETTES.map((p) => (
            <Button key={p.id} size="sm" variant={palId === p.id ? 'ink' : 'ghost'} onClick={() => setPalId(p.id)}>
              {p.label}
            </Button>
          ))}
          <span style={{ width: 18 }} />
          <Button
            size="sm"
            variant={adaptive ? 'ink' : 'ghost'}
            onClick={() => setAdaptive((a) => !a)}
            title="Let the renderer thin the FIELD draw when a frame costs more than 15 ms. Never applies at morph 1."
          >
            Adaptive {adaptive ? 'on' : 'off'}
          </Button>
        </div>

        {/* Editor */}
        <Panel style={{ padding: '24px 28px', borderRadius: 'var(--r-editor)', marginBottom: 22 }}>
          {/* Wide on purpose — see the note at the top of this file. */}
          <div style={{ width: '100%', height: 340, marginBottom: 22 }}>
            <AtlasSphereCanvas state={hero} adaptive={adaptive} {...opts} />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(380px,1fr))', gap: 26 }}>
            {GROUPS.map((g) => (
              <div key={g.id}>
                <p style={{ margin: '0 0 2px', fontSize: 11, letterSpacing: '.13em', textTransform: 'uppercase', color: 'var(--ink3)' }}>
                  {g.title}
                </p>
                <p style={{ margin: '0 0 10px', fontSize: 12, color: 'var(--ink3)' }}>{g.blurb}</p>
                {ROWS.filter((r) => r.group === g.id).map((row) => (
                  <div key={row.k} className="row0" style={{ gap: 14 }}>
                    <div style={{ width: 168, flexShrink: 0 }}>
                      <p style={{ margin: 0, fontSize: 13.5, fontWeight: 500 }}>{row.label}</p>
                      <p style={{ margin: '2px 0 0', fontSize: 11.5, color: 'var(--ink3)' }}>{row.hint}</p>
                    </div>
                    <input
                      ref={(el) => { inputs.current[row.k] = el; }}
                      type="range"
                      min={row.min} max={row.max} step={row.step}
                      defaultValue={ed[row.k]}
                      onInput={onSlide}
                      aria-label={row.label}
                      style={{ flex: 1, accentColor: 'var(--acc)' }}
                    />
                    <span className="tnum" style={{ width: 74, textAlign: 'right', fontSize: 13 }}>{row.fmt(readout[row.k])}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>

          <div className="row0" style={{ gap: 14, marginTop: 8 }}>
            <p style={{ margin: 0, fontSize: 12, color: 'var(--ink3)' }}>
              Values persist to localStorage on this machine only. Nothing here reaches the
              app&rsquo;s mounts — they pass a state and take the renderer&rsquo;s defaults.
            </p>
            <Button size="sm" icon={<RotateCcw className="i14" />} style={{ marginLeft: 'auto' }} onClick={reset}>Reset</Button>
          </div>
        </Panel>

        {/* Card grid — 30% of the editor's count, per the handoff, so ten spheres
            stay smooth. Measured: 104k particles across the page is 13% of the
            frame budget on Apple silicon. */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(330px,1fr))', gap: 16 }}>
          {STATES.map((s) => {
            const d = DESCRIPTIONS[s];
            return (
              <Card
                key={s}
                size="s"
                skin={dark ? 'ink' : 'glass'}
                onOpen={() => setHero(s)}
                style={{ textAlign: 'left', opacity: d.live ? 1 : 0.66 }}
              >
                <div style={{ height: 236, padding: '10px 0' }}>
                  <AtlasSphereCanvas state={s} {...opts} countScale={0.3} />
                </div>
                <div style={{ padding: '0 18px 18px', color: dark ? 'var(--dkf)' : 'var(--ink)' }}>
                  <p style={{ margin: 0, fontSize: 18, fontWeight: 600, letterSpacing: '-.02em' }}>{s}</p>
                  <p style={{ margin: '4px 0 0', fontSize: 11, letterSpacing: '.13em', textTransform: 'uppercase', color: d.live ? 'var(--acc-text)' : 'var(--red)' }}>
                    {d.trigger}
                  </p>
                  <p style={{ margin: '8px 0 0', fontSize: 13, color: dark ? 'rgba(249,247,244,.7)' : 'var(--ink2)' }}>{d.text}</p>
                </div>
              </Card>
            );
          })}
        </div>
      </div>
    </div>
  );
}
