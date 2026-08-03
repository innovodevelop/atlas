/**
 * Reference page for the Atlas sphere, on /atlas-architecture.
 *
 * REWRITTEN because the renderer it documented no longer exists. This page
 * described the three.js sphere (`src/components/atlas/`): six WakeWord states,
 * a GLSL fragment shader, "GPU Particle System", "Web Audio API", and a table
 * of `sphereConfig` size presets. That tree was deleted, so every one of those
 * statements became false — including the caption under the live sphere, which
 * claimed WebGL and custom GLSL shaders while a canvas-2D renderer painted six
 * inches above it.
 *
 * Everything here is now read from `src/lib/atlasSphere.ts`. If that file
 * changes, this page is wrong until it is edited — it is prose, not a binding.
 */
import { motion } from 'framer-motion';
import {
  Sparkles, Ear, Brain, MessageCircle, Cog, CheckCircle2, AlertTriangle,
  MicOff, Sunrise, Wind, Palette, Volume2, Gauge, Code, Layers, Accessibility,
} from 'lucide-react';
import { AtlasSphereCanvas } from '@/components/atlas-ui/AtlasSphereCanvas';
import { STATES, type SphereState } from '@/lib/atlasSphere';
import { ATLAS_STATES } from '@/hooks/useAtlasPresence';

interface StateDoc {
  icon: React.ElementType;
  color: string;
  trigger: string;
  behavior: string;
}

/**
 * Ten states, keyed off the renderer's own `STATES` export so this list cannot
 * silently drift out of sync with what the renderer implements. Reachability is
 * read from `ATLAS_STATES` for the same reason.
 */
const STATE_DOCS: Record<SphereState, StateDoc> = {
  idle: {
    icon: Sparkles, color: 'blue', trigger: 'default',
    behavior: 'Slow spin (0.0006) with a 3% breath on a 0.16 Hz cycle.',
  },
  listening: {
    icon: Ear, color: 'cyan', trigger: 'wake word',
    behavior: 'Concentric pressure waves travelling outward, brighter overall.',
  },
  thinking: {
    icon: Brain, color: 'violet', trigger: 'query sent',
    behavior: 'Vertical shear by latitude — the shell braids slowly against itself.',
  },
  speaking: {
    icon: MessageCircle, color: 'lavender', trigger: 'response',
    behavior: 'Eight amplitude bands, tightest at the equator.',
  },
  working: {
    icon: Cog, color: 'primary', trigger: 'agent run',
    behavior: '72% of the shell migrates into a spinning torus.',
  },
  success: {
    icon: CheckCircle2, color: 'cyan', trigger: 'run completed',
    behavior: 'Half the particles peel outward and fade; the rest pulse gently.',
  },
  alert: {
    icon: AlertTriangle, color: 'primary', trigger: 'run failed',
    behavior: 'Tight double pulse with horizontal jitter, tinted red.',
  },
  muted: {
    icon: MicOff, color: 'slate', trigger: 'mic off',
    behavior: 'Barely moving, contracted, fully desaturated.',
  },
  waking: {
    icon: Sunrise, color: 'slate', trigger: 'cut',
    behavior: 'Fly-in from beyond the frame. Cut: a 1.6s intro only delays first paint.',
  },
  dissolving: {
    icon: Wind, color: 'slate', trigger: 'cut',
    behavior: 'Scatter and fade. Cut: a desktop app is quit, not logged out.',
  },
};

const SphereDocumentation = () => {
  const colorClasses: Record<string, { bg: string; border: string; text: string }> = {
    slate: { bg: 'bg-slate-500/10', border: 'border-slate-500/30', text: 'text-slate-400' },
    blue: { bg: 'bg-blue-500/10', border: 'border-blue-500/30', text: 'text-blue-400' },
    primary: { bg: 'bg-primary/10', border: 'border-primary/30', text: 'text-primary' },
    cyan: { bg: 'bg-cyan-500/10', border: 'border-cyan-500/30', text: 'text-cyan-400' },
    violet: { bg: 'bg-violet-500/10', border: 'border-violet-500/30', text: 'text-violet-400' },
    lavender: { bg: 'bg-purple-500/10', border: 'border-purple-500/30', text: 'text-purple-400' },
  };

  const technicalFeatures = [
    {
      title: 'Bucketed paths, not per-particle draws',
      icon: Sparkles,
      description:
        'Particles are quantised into 8 depth × 3 shade × 11 alpha buckets and each bucket is '
        + 'filled once, so a 26 000-particle cloud costs ~264 draw calls rather than 26 000.',
      details: ['264 Path2D per frame', 'One fill per bucket', '~0.84 ms/frame on Apple silicon'],
    },
    {
      title: 'Two formations, one cloud',
      icon: Layers,
      description:
        'Every particle owns both a sphere home and a field home, so nothing is created or '
        + 'destroyed when the formation changes — the cloud re-forms along a bowed, staggered arc.',
      details: ['morph 1 = sphere, 0 = field', 'Half-offset hex lattice', 'Latitude → longitude unroll'],
    },
    {
      title: 'Audio envelope as an input',
      icon: Volume2,
      description:
        'The renderer takes amp and pulse as plain numbers. There is no Web Audio graph here: the '
        + 'music surface feeds them from the native music:level event, and with no signal the '
        + 'sphere simply sits at amp 0.',
      details: ['amp / pulse opts', 'Fed by the Rust audio sink', 'Zero signal = a still sphere'],
    },
    {
      title: 'Reduced motion is honoured',
      icon: Accessibility,
      description:
        'Under prefers-reduced-motion the loop does not run at all. The sphere settles to the '
        + 'sphere formation, the morph does not animate and spin is zero — it repaints only when '
        + 'the state changes, and it follows the OS setting live.',
      details: ['Live matchMedia listener', 'Repaint on change only', 'Morph frozen at 1'],
    },
  ];

  return (
    <div className="space-y-8">
      {/* Live Sphere Demo */}
      <motion.div
        className="backdrop-blur-xl bg-background/30 border border-border/30 rounded-2xl p-6"
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
      >
        <div className="flex items-center gap-2 mb-4">
          <Sparkles className="w-5 h-5 text-primary" />
          <h3 className="text-lg font-semibold">Live Sphere</h3>
        </div>
        <div className="flex items-center justify-center py-8">
          <div className="w-[300px] h-[300px]">
            <AtlasSphereCanvas state="idle" />
          </div>
        </div>
        <p className="text-sm text-muted-foreground text-center">
          The sphere above is live, and it is drawn on a 2D canvas — no WebGL, no
          shaders, no GPU context. It is the same renderer the dashboard, Home,
          Core, Teach and the login screen use; there is only one.
        </p>
        <p className="text-sm text-muted-foreground text-center mt-2">
          The gallery at <code>/atlas-sphere</code> is the tuning surface — every
          state, the sphere/field morph and the particle controls.
        </p>
      </motion.div>

      {/* State Cards */}
      <div>
        <div className="flex items-center gap-2 mb-4">
          <Palette className="w-5 h-5 text-cyan-400" />
          <h3 className="text-lg font-semibold">{STATES.length} States</h3>
        </div>
        <p className="text-sm text-muted-foreground mb-4">
          The renderer implements all {STATES.length}. Two are marked cut: they are
          drawn correctly but nothing in the product triggers them.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {STATES.map((state, index) => {
            const doc = STATE_DOCS[state];
            const colors = colorClasses[doc.color];
            const Icon = doc.icon;
            const reachable = (ATLAS_STATES as readonly string[]).includes(state);

            return (
              <motion.div
                key={state}
                className={`backdrop-blur-xl border rounded-xl p-4 ${colors.bg} ${colors.border}`}
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: index * 0.05 }}
                whileHover={{ scale: 1.02 }}
                style={{ opacity: reachable ? 1 : 0.66 }}
              >
                <div className="flex items-center gap-3 mb-3">
                  <div className={`p-2 rounded-lg ${colors.bg} ${colors.text}`}>
                    <Icon className="w-4 h-4" />
                  </div>
                  <div>
                    <h4 className="font-medium capitalize">{state}</h4>
                  </div>
                </div>
                <p className="text-sm text-muted-foreground mb-2">
                  Trigger: {doc.trigger}
                </p>
                <p className="text-xs text-muted-foreground/70 italic">{doc.behavior}</p>
              </motion.div>
            );
          })}
        </div>
      </div>

      {/* Technical Features */}
      <div>
        <div className="flex items-center gap-2 mb-4">
          <Code className="w-5 h-5 text-emerald-400" />
          <h3 className="text-lg font-semibold">Technical Implementation</h3>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {technicalFeatures.map((feature, index) => {
            const Icon = feature.icon;
            return (
              <motion.div
                key={feature.title}
                className="backdrop-blur-xl bg-background/30 border border-border/30 rounded-xl p-5"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: index * 0.08 }}
              >
                <div className="flex items-center gap-3 mb-3">
                  <div className="p-2 rounded-lg bg-primary/10 text-primary">
                    <Icon className="w-4 h-4" />
                  </div>
                  <h4 className="font-medium">{feature.title}</h4>
                </div>
                <p className="text-sm text-muted-foreground mb-3">{feature.description}</p>
                <div className="flex flex-wrap gap-2">
                  {feature.details.map((detail) => (
                    <span
                      key={detail}
                      className="text-xs px-2 py-1 rounded-full bg-muted/30 text-muted-foreground"
                    >
                      {detail}
                    </span>
                  ))}
                </div>
              </motion.div>
            );
          })}
        </div>
      </div>

      {/* Code excerpt — the field's alpha, which is the one formula the design
          handoff's own README states incorrectly. Kept verbatim from
          src/lib/atlasSphere.ts so the page cannot describe maths the renderer
          does not run. */}
      <motion.div
        className="backdrop-blur-xl bg-background/30 border border-border/30 rounded-2xl p-6"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.4 }}
      >
        <div className="flex items-center gap-2 mb-4">
          <Code className="w-5 h-5 text-primary" />
          <h3 className="text-lg font-semibold">Field alpha — src/lib/atlasSphere.ts</h3>
        </div>
        <pre className="bg-background/50 rounded-lg p-4 text-xs overflow-x-auto">
          <code className="text-muted-foreground">{`// Cubic-weighted square. The crest² the handoff's README quotes is not
// the same curve: it overstates alpha by up to ~2.5x at low crest and
// makes the field read flat.
export function crestAlpha(crest: number): number {
  return 0.045 + 0.95 * (crest * crest * (0.4 + 0.6 * crest));
}

// edge fades the rim, aSoft is the colour-softness term.
export function fieldAlpha(wv, edge, amp, aSoft = 1) {
  return edge * crestAlpha(wv * 0.5 + 0.5) * (0.58 + amp * 0.7) * aSoft;
}`}</code>
        </pre>
      </motion.div>

      {/* Sizing */}
      <motion.div
        className="backdrop-blur-xl bg-background/30 border border-border/30 rounded-2xl p-6"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.5 }}
      >
        <div className="flex items-center gap-2 mb-4">
          <Gauge className="w-5 h-5 text-amber-400" />
          <h3 className="text-lg font-semibold">Sizing</h3>
        </div>
        <p className="text-sm text-muted-foreground mb-4">
          There is no size-preset table any more. The canvas fills its parent box,
          re-reads its own client size on every paint and re-allocates the backing
          store when that changes. The sphere radius follows the <em>short</em> edge
          and the centre is a fraction of each axis, so a wide canvas centres
          correctly instead of pushing the sphere off the bottom.
        </p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            { name: 'dashboard', size: '.orbwrapB', use: 'Greeting band' },
            { name: 'home', size: '.homeorb', use: 'Voice landing' },
            { name: 'core', size: '.coreorb', use: 'Atlas Core hero' },
            { name: 'login', size: '.authorbcv', use: 'Full-bleed, off-centre' },
          ].map((preset) => (
            <div
              key={preset.name}
              className="text-center p-3 rounded-lg bg-muted/20"
            >
              <div className="font-mono text-sm text-primary">{preset.name}</div>
              <div className="text-xs text-muted-foreground font-mono">{preset.size}</div>
              <div className="text-xs text-muted-foreground/70">{preset.use}</div>
            </div>
          ))}
        </div>
      </motion.div>
    </div>
  );
};

export default SphereDocumentation;
