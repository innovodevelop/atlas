/**
 * Atlas Model Lab — `/model-lab`.
 *
 * Model routing and comparison, from the handoff file `Atlas Model Lab.dc.html`.
 *
 * ABOUT THAT FILE. Its markup is a 3D asset lab: a wall of smart-home device
 * meshes, a geometry/material/texture editor and a clay body model, all drawn
 * on canvas by the prototype-only `atlas-models.js`. The bundle's own README
 * (§6) names the same file "Model routing / comparison surface", and §8 lists
 * `atlas-models.js` under "do NOT port". Both cannot be built. This surface
 * takes the file's CHROME — the admin eyebrow, the 34px Hanken headline, the
 * header tab pills, the recessed stage, the 1fr/380px editor split, the 4-up
 * strip, the 18px label-and-readout control cards — and fills it with the
 * routing table, because that is the surface the README says this is and the
 * only one the app has data for. The discrepancy is called out in the report
 * rather than resolved silently.
 *
 * WHAT IS REAL AND WHAT IS MIRRORED (also stated on screen, in the footer):
 *
 *   Routing / Compare  — transcribed from `supabase/functions/_shared/*` at
 *                        build time. Compile-time constants in a Deno/Bun
 *                        module that the webview cannot import; `src/lib/mocks/
 *                        modelLab.ts` is the transcription and says so.
 *   Providers          — live: `brain_ai_status` + `atlas_brain_info` (Tauri),
 *                        `atlas_provider_status`, `atlas_usage_history`.
 *
 * THE HONEST PART THIS SURFACE EXISTS FOR: on the Bedrock lane this AWS account
 * cannot invoke the frontier tier. Sonnet 5, Opus 4.8 and Opus 5 all return
 * AccessDeniedException, so `claude-opus-5` resolves to
 * `eu.anthropic.claude-opus-4-6-v1`, and Fable 5 has no EU profile at all. A
 * model lab that listed those five names as if they were callable would be
 * lying in the most expensive possible place, so the substitution is the
 * headline fact on every card, not a footnote.
 *
 * NAVIGATION. The clickable headline and Esc are the only way back, both
 * one level at a time: detail → wall → route. There is no back link in the
 * header (the app's rule), and no dock is rendered here — the wiring pass owns
 * that.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ModelWall } from '@/components/atlas-ui/modelLab/ModelWall';
import { ModelDetail } from '@/components/atlas-ui/modelLab/ModelDetail';
import { CompareView } from '@/components/atlas-ui/modelLab/CompareView';
import { ProvidersView } from '@/components/atlas-ui/modelLab/ProvidersView';
import { activeLane, useModelLabRuntime } from '@/components/atlas-ui/modelLab/useModelLabRuntime';
import { SOURCES, tierById } from '@/lib/mocks/modelLab';
import '@/styles/surfaces/modelLab.css';

/** Registered by the wiring pass; this file does not touch the router. */
export const surface: {
  path: string;
  label: string;
  icon: string;
  entry: 'dock' | 'menu';
  mock: boolean;
} = {
  path: '/model-lab',
  label: 'Model Lab',
  icon: 'FlaskConical',
  // The handoff's own eyebrow reads "Model lab · admin". It is an inspection
  // surface for one person, not one of the five things Atlas is for, so it
  // belongs in the account menu rather than in the dock.
  entry: 'menu',
  // The routing table is a build-time transcription of the gateway source, not
  // a live read. The Providers tab is real. `true` is the honest answer for the
  // page as a whole.
  mock: true,
};

type Tab = 'routing' | 'compare' | 'providers';

const TABS: { key: Tab; label: string }[] = [
  { key: 'routing', label: 'Routing' },
  { key: 'compare', label: 'Compare' },
  { key: 'providers', label: 'Providers' },
];

/** True when a keystroke belongs to whatever the user is typing into. */
const isTyping = (target: EventTarget | null): boolean => {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
};

const AtlasModelLab = () => {
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>('routing');
  const [selected, setSelected] = useState<string | null>(null);
  /** Survives the walk back to the wall, so the card you left is still marked. */
  const [recent, setRecent] = useState<string | null>(null);
  const [cmpA, setCmpA] = useState<string | null>('claude-opus-5');
  const [cmpB, setCmpB] = useState<string | null>('claude-sonnet-5');

  // One hook for the whole page rather than one per view: it is two Tauri IPC
  // calls, and mounting it twice would double them for a value that cannot
  // change without an app relaunch.
  const runtime = useModelLabRuntime();
  const lane = activeLane(runtime.status);

  const tier = selected ? tierById(selected) : undefined;

  /**
   * One level at a time, and the same function for the headline and for Esc.
   * `navigate(-1)` on a cold launch straight onto /model-lab is a no-op in
   * React Router, so the fallback is explicit — the same shape
   * `AtlasSettingsRoute` uses.
   */
  const back = useCallback(() => {
    if (tab === 'routing' && selected) { setSelected(null); return; }
    if (tab !== 'routing') { setTab('routing'); return; }
    if (window.history.length > 1) navigate(-1);
    else navigate('/');
  }, [tab, selected, navigate]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (isTyping(e.target)) { (e.target as HTMLElement).blur(); return; }
      back();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [back]);

  const { eyebrow, title, sub } = useMemo(() => {
    if (tab === 'compare') {
      return {
        eyebrow: 'Model lab · compare',
        title: 'Two tiers, side by side',
        sub: 'Routing facts only. Price, context window and latency are not recorded anywhere in this repo, so they are absent rather than estimated.',
      };
    }
    if (tab === 'providers') {
      return {
        eyebrow: 'Model lab · providers',
        title: 'What is actually running',
        sub: 'The only live tab: which lane the brain was spawned on, which keys exist, and the two health tables — including the fact that nothing writes to them.',
      };
    }
    if (tier) {
      return {
        eyebrow: `Model lab · ${tier.id}`,
        title: `${tier.label} routing`,
        sub: `${tier.blurb} Below: the id a call site asks for, the tier it collapses to, and what each lane actually invokes.`,
      };
    }
    return {
      eyebrow: 'Model lab · admin',
      title: 'Every model, one wall',
      sub: 'Five tiers, two lanes. On Bedrock this account cannot invoke the frontier models, so three of the five resolve to something older — each card shows what it really calls.',
    };
  }, [tab, tier]);

  return (
    <div className="page ml-page" data-screen-label="Atlas — Model lab">
      <div className="ml-wash" aria-hidden />

      <header className="ml-band">
        <div className="ml-band-text">
          <p className="ml-eyebrow">{eyebrow}</p>
          {/* The headline IS the back control (app rule: no header back link). */}
          <h1 className="ml-title">
            <button type="button" className="ml-titlebtn" onClick={back} title="Back — Esc">
              {title}
            </button>
          </h1>
          <p className="ml-sub">{sub}</p>
        </div>

        <div className="ml-tabs" role="tablist" aria-label="Model lab views">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              id={`ml-tab-${t.key}`}
              aria-selected={tab === t.key}
              aria-controls="ml-panel"
              className={`ml-tab${tab === t.key ? ' ml-tab-on' : ''}`}
              onClick={() => { setTab(t.key); if (t.key !== 'routing') setSelected(null); }}
            >
              {t.label}
            </button>
          ))}
        </div>
      </header>

      <main className="ml-main">
        {/* A tablist needs a panel that names its tab, or the roles are a lie to
            a screen reader. The footer sits outside it — it describes the page,
            not the view. */}
        <div id="ml-panel" role="tabpanel" aria-labelledby={`ml-tab-${tab}`} tabIndex={-1}>
          {tab === 'routing' && !tier && (
            <ModelWall
              lane={lane}
              recent={recent}
              onOpen={(id) => { setSelected(id); setRecent(id); }}
            />
          )}
          {tab === 'routing' && tier && <ModelDetail tier={tier} lane={lane} />}
          {tab === 'compare' && (
            <CompareView
              a={cmpA}
              b={cmpB}
              onPick={(slot, id) => (slot === 'a' ? setCmpA(id) : setCmpB(id))}
            />
          )}
          {tab === 'providers' && <ProvidersView runtime={runtime} />}
        </div>

        <footer className="ml-foot">
          <p className="ml-foot-lead">
            Routing and comparison are transcribed from the gateway source at build time — not read from a
            live registry, because there is none to read. If these files change and the transcription does
            not, this page is wrong:
          </p>
          <ul className="ml-foot-list">
            {SOURCES.map((s) => (
              <li key={s.path}>
                <code className="ml-inline-id">{s.path}</code>
                <span>{s.what}</span>
              </li>
            ))}
          </ul>
        </footer>
      </main>
    </div>
  );
};

export default AtlasModelLab;
