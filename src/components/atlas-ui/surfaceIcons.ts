/**
 * Icon names in the surface registry, resolved to components.
 *
 * `SurfaceMeta.icon` is a STRING (a lucide export name) on purpose: the
 * registry is imported by things that must not drag an icon library in — the
 * anti-staleness test, the route table, `surfaceByPath`. Exactly one consumer
 * needs to draw the icon, so exactly one module holds the mapping.
 *
 * Explicit imports, not `lucide-react`'s dynamic map: a dynamic lookup defeats
 * tree-shaking and would pull all ~1500 icons into the bundle.
 *
 * This table must match the registry in BOTH directions, and
 * `src/editionSplit.test.ts` asserts it does — a name here that no surface uses
 * is dead weight in every bundle, and a name missing here is a menu row drawn
 * with the fallback glyph.
 */
import type { ComponentType } from 'react';
import {
  CircleDot, Compass, Cpu, FlaskConical, GitBranch, GraduationCap, HeartPulse,
  Home, Landmark, Layers, LayoutGrid, LogIn, Mail, Mic, Monitor, Network, Orbit,
  Palette, Settings, ShieldCheck, Sparkles, TestTube2,
} from 'lucide-react';

export type IconComponent = ComponentType<{ className?: string }>;

export const SURFACE_ICONS: Readonly<Record<string, IconComponent>> = {
  Compass, Cpu, FlaskConical, GitBranch, GraduationCap, HeartPulse,
  Home, Landmark, Layers, LayoutGrid, LogIn, Mail, Mic, Monitor, Network, Orbit,
  Palette, Settings, ShieldCheck, Sparkles, TestTube2,
};

/**
 * Resolves a `SurfaceMeta.icon`, falling back to a neutral mark rather than
 * rendering `undefined` as a component — a missing icon must not be the reason
 * a user cannot reach Settings. The test above is what keeps the fallback
 * theoretical.
 */
export const surfaceIcon = (name: string): IconComponent => SURFACE_ICONS[name] ?? CircleDot;
