/**
 * The Beta Model Lab — `/model-lab` while the beta_ui flag is on (Beta
 * redesign phase 5, `Atlas Model Lab Beta.dc.html`).
 *
 * The ink hero (sphere in its ring, the lane eyebrow, the headline that is the
 * back control, the count of tiers that are not what they say), the view tabs
 * and the lane switch, then one of four bodies: the routing wall, a tier's
 * detail, every tier compared, and the providers with their rules and usage.
 *
 * What is read from where — the same split the Workshop page draws, stated in
 * the footer so nobody has to read this comment to know it:
 *   Routing, detail, Compare  — `src/lib/mocks/modelLab.ts`, the build-time
 *                               transcription of the gateway source. The
 *                               webview cannot import those Deno/Bun modules.
 *   The live lane, the keys   — `brain_ai_status` + `atlas_brain_info` (Tauri),
 *                               via the Workshop's `useModelLabRuntime`.
 *   Usage and latency         — `atlas_usage_history` / `atlas_provider_status`,
 *                               read once (`useModelLabReadings`). Per model,
 *                               nothing is recorded, so the design's per-model
 *                               bars become per-provider lines, or an empty
 *                               state that says nothing has been recorded.
 *
 * The lane switch is a lens, as in the design: it shows how every tier
 * resolves on that lane. It does not change `atlas_ai_provider` — the live
 * lane is marked LIVE and only changes when the stored preference does.
 *
 * Esc walks back one level at a time (detail → the view → Routing → Home),
 * and the headline does the same.
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { activeLane, useModelLabRuntime, type ModelLabRuntime } from '@/components/atlas-ui/modelLab/useModelLabRuntime';
import { useModelLabReadings, type ModelLabReadings } from '@/hooks/useModelLabReadings';
import { OPUS5_RECHECK_ON, SOURCES, TIERS, UNKNOWN_ID_FALLBACK, VERIFIED_ON, tierById } from '@/lib/mocks/modelLab';
import {
  GATEWAY_RULES, LANES, LANE_LABEL, compareRows, dayLabel, detailOf, factsOf, invokedOn, isBad, isUnmapped, laneFacts, laneInfo,
  laneName, laneStatus, latencyOf, namedOn, substitutedCount, tagOf, usageByProvider, usd, type Lane,
} from '@/lib/betaModelLab';
import { VeilSphere } from '@/components/atlas/VeilSphere';
import { useBetaNavigate } from '@/lib/viewTransitions';
import { openTalk, setTalkAnchor } from '@/lib/talkBus';
import { isTyping } from './atlasHelpers';
import '@/styles/beta/modelLab.css';

type View = 'routing' | 'compare' | 'providers';

const VIEWS: ReadonlyArray<{ k: View; l: string; title: string }> = [
  { k: 'routing', l: 'Routing', title: 'Model routing' },
  { k: 'compare', l: 'Compare', title: 'Compare tiers' },
  { k: 'providers', l: 'Providers', title: 'Providers' },
];

const BetaModelLab = () => {
  const navigate = useBetaNavigate();
  // One runtime read for the whole page (two Tauri IPC calls); the views take it as data.
  const runtime = useModelLabRuntime();
  const readings = useModelLabReadings();
  const live = activeLane(runtime.status);

  const [view, setView] = useState<View>('routing');
  const [open, setOpen] = useState<string | null>(null);
  // Until someone picks a lane, the lens follows the live one; with no
  // readable runtime it shows Bedrock, the lane with the substitutions.
  const [picked, setPicked] = useState<Lane | null>(null);
  const lane: Lane = picked ?? live ?? 'bedrock';
  const [sphereEl, setSphereEl] = useState<HTMLButtonElement | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const lastOpened = useRef<string | null>(null);

  // The hero sphere is this screen's talk entry point: registered as the
  // anchor, the floating orb hides, so the sphere itself opens the panel.
  useEffect(() => { setTalkAnchor(sphereEl); return () => setTalkAnchor(null); }, [sphereEl]);

  const back = useCallback(() => {
    if (open) { setOpen(null); return; }
    if (view !== 'routing') { setView('routing'); return; }
    navigate('/');
  }, [open, view, navigate]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTyping(e.target)) { (e.target as HTMLElement).blur(); return; }
      back();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [back]);

  // Walking back from a detail puts focus on the card or column you left, so
  // a keyboard reader does not land at the top of five identical buttons.
  useEffect(() => {
    if (open || !lastOpened.current) return;
    const id = lastOpened.current;
    lastOpened.current = null;
    const el = rootRef.current?.querySelector<HTMLElement>(`[data-k="${CSS.escape(id)}"]`);
    el?.focus();
  }, [open, view]);

  const openTier = useCallback((id: string) => {
    lastOpened.current = id;
    setOpen(id);
    window.scrollTo({ top: 0, behavior: 'auto' });
  }, []);

  const pickView = (k: View) => { lastOpened.current = null; setView(k); setOpen(null); };

  const tier = open ? tierById(open) : undefined;
  const subN = substitutedCount(lane);
  const title = tier ? tier.label : VIEWS.find((v) => v.k === view)?.title ?? 'Model routing';
  const subline = tier
    ? tier.blurb
    : lane === 'bedrock'
      ? 'On Bedrock this account can’t invoke the frontier tier. Every substitution is shown as the headline fact, not a footnote.'
      : 'On the first-party lane every tier passes through unchanged. Switch to Bedrock to see the substitutions.';
  const brainRunning = runtime.brain ? runtime.brain.running : null;
  const fallback = tierById(UNKNOWN_ID_FALLBACK)?.label ?? UNKNOWN_ID_FALLBACK;

  /** Why no lane is marked live, when none is. */
  const laneNote = live
    ? null
    : !runtime.available
      ? 'The running lane lives in the Mac’s Keychain, which a browser can’t read, so no lane is marked live.'
      : runtime.loading
        ? 'Reading which lane the brain runs on…'
        : runtime.error
          ? `The running lane couldn’t be read: ${runtime.error}`
          : 'The running lane couldn’t be read.';

  return (
    <div className="b-ml" ref={rootRef} data-screen-label={`Beta — Model Lab · ${tier ? tier.label : VIEWS.find((v) => v.k === view)?.l}`}>
      <header className="b-ml-hero" data-beta-tone="ink">
        <div className="b-ml-sphere">
          <svg viewBox="0 0 170 170" aria-hidden>
            <circle cx="85" cy="85" r="82" fill="none" stroke="rgba(249,247,244,.16)" strokeWidth="1" />
            <path d="M85 0V14M85 156V170M0 85H14M156 85H170" stroke="rgba(249,247,244,.38)" strokeWidth="1.4" />
          </svg>
          <button type="button" className="b-ml-sphere-in" ref={setSphereEl} aria-label="Talk to Atlas" title="Talk to Atlas · ⌥ Space" onClick={() => openTalk()}>
            <VeilSphere size="panel" ink bg="#1e1e24" alpha={0.75} />
          </button>
        </div>
        <div className="b-ml-hero-text">
          <span className="b-ml-eyebrow">model-lab · admin · lane {laneName(lane)}</span>
          <h1 className="b-ml-h1"><button type="button" title="Back · Esc" onClick={back}>{title}</button></h1>
          <p className={`b-ml-sub ${subN ? 'warn' : 'ok'}`}>{subline}</p>
        </div>
        <div className="b-ml-count">
          <span className="b-ml-count-n">{subN}</span>
          <span className="b-ml-count-l">{subN ? `of ${TIERS.length} tiers not what they say` : 'tiers substituted'}</span>
        </div>
      </header>

      <div className="b-ml-bar">
        <div className="b-ml-views" role="tablist" aria-label="Model lab">
          {VIEWS.map((v) => {
            const on = view === v.k && !tier;
            return (
              <button type="button" key={v.k} id={`b-ml-tab-${v.k}`} role="tab" aria-selected={on} aria-controls="b-ml-panel" className={on ? 'on' : ''} onClick={() => pickView(v.k)}>
                {v.l}
              </button>
            );
          })}
        </div>
        <span className="b-ml-spacer" />
        <div className="b-ml-lanebox">
          <span className="b-ml-lane-l" id="b-ml-lane-l">Lane</span>
          <div className="b-ml-lanes" role="radiogroup" aria-labelledby="b-ml-lane-l">
            {LANES.map((k) => (
              <button type="button" key={k} role="radio" aria-checked={lane === k} className={lane === k ? 'on' : ''} title={laneInfo(k).host} onClick={() => setPicked(k)}>
                {LANE_LABEL[k]}
                {live === k ? <span className={`b-ml-live${brainRunning ? '' : ' off'}`}>{brainRunning ? 'LIVE' : 'SELECTED'}</span> : null}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div id="b-ml-panel" role="tabpanel" aria-labelledby={`b-ml-tab-${view}`} className="b-ml-panel">
        {tier ? <TierDetailView tierId={tier.id} lane={lane} />
          : view === 'routing' ? (
            <>
              <div className="b-ml-wall">
                {TIERS.map((t) => {
                  const tag = tagOf(t, lane);
                  const bad = isBad(t, lane);
                  const ink = lane === 'bedrock' && isUnmapped(t);
                  return (
                    <button type="button" key={t.id} data-k={t.id} className={`b-ml-tier${ink ? ' ink' : ''}`} onClick={() => openTier(t.id)} aria-label={`${t.label}: ${tag.label}. Open routing detail`}>
                      <span className="b-ml-tier-top">
                        <span className="b-ml-tier-band">{t.band}{t.isDefault ? ' · default' : ''}</span>
                        <span className={`b-ml-tag b-ml-tag--${tag.tone}`}>{tag.label}</span>
                      </span>
                      <span className="b-ml-tier-name">{t.label}</span>
                      <span className="b-ml-tier-ids">
                        <span className="b-ml-k">Named</span>
                        <span className={`b-ml-id${bad ? ' struck' : ''}`}>{namedOn(t, lane)}</span>
                        <span className="b-ml-k b-ml-k--gap">Actually invoked</span>
                        <span className="b-ml-id strong">{invokedOn(t, lane)}</span>
                      </span>
                      <span className="b-ml-tier-blurb">{t.blurb}</span>
                    </button>
                  );
                })}
              </div>
              <section className="b-ml-notes" aria-label="Routing notes">
                <span><b>Unknown ids</b> land on {fallback} silently. A typo in a model id is invisible.</span>
                <span><b>Verified</b> by signed InvokeModel on {dayLabel(VERIFIED_ON)}; Opus 5 re-checked as root on {dayLabel(OPUS5_RECHECK_ON, false)}.</span>
                {laneNote ? (
                  <span>
                    <b>Lane</b> {laneNote}
                    {runtime.error ? <> <button type="button" className="b-ml-link" onClick={runtime.reload}>Try again</button></> : null}
                  </span>
                ) : null}
              </section>
            </>
          ) : view === 'compare' ? (
            <CompareView lane={lane} onOpen={openTier} />
          ) : (
            <ProvidersView runtime={runtime} readings={readings} live={live} brainRunning={brainRunning} />
          )}
      </div>

      <p className="b-ml-foot">
        Routing and Compare are transcribed from the gateway source at build time
        ({SOURCES.map((s, i) => <Fragment key={s.path}>{i ? ', ' : ''}<code title={s.what}>{s.path.split('/').pop()}</code></Fragment>)});
        the webview can’t import it. Providers are read live from the Keychain and the brain sidecar, usage and latency from the app’s own tables. Nothing here is a guess.
      </p>
    </div>
  );
};

function TierDetailView({ tierId, lane }: { tierId: string; lane: Lane }) {
  const t = tierById(tierId);
  if (!t) return null;
  const d = detailOf(t, lane);
  return (
    <div className="b-ml-detail">
      <section className={`b-ml-dhero${d.bad ? ' ink' : ''}`} aria-label={`${t.label} on ${LANE_LABEL[lane]}`}>
        <span className="b-ml-kicker">{d.kicker}</span>
        <p className="b-ml-headline">{d.headline}</p>
        <div className="b-ml-tiles">
          <div><p>Named</p><p className={`b-ml-tile-id${d.bad ? ' struck' : ''}`}>{d.named}</p></div>
          <div><p>Invoked</p><p className="b-ml-tile-id">{d.invoked}</p></div>
        </div>
        <p className="b-ml-dnote">{d.note}</p>
      </section>
      <div className="b-ml-dside">
        <section className="b-ml-facts" aria-label="Facts">
          <p className="b-ml-h">Facts</p>
          {factsOf(t).map((f) => (
            <div key={f.k} className="b-ml-fact">
              <span>{f.k}</span>
              <span className={`${f.mono ? 'mono' : ''}${f.warn ? ' warn' : ''}`}>{f.v}</span>
            </div>
          ))}
        </section>
        <section className="b-ml-caps" aria-label="Capabilities">
          <span>Capabilities</span>
          <p>{t.capabilities.note}</p>
        </section>
      </div>
    </div>
  );
}

function CompareView({ lane, onOpen }: { lane: Lane; onOpen: (id: string) => void }) {
  const rows = useMemo(() => compareRows(lane), [lane]);
  return (
    <>
      <section className="b-ml-cmp nosb" aria-label={`Every tier on ${LANE_LABEL[lane]}`}>
        <div className="b-ml-cmp-grid" style={{ gridTemplateColumns: `170px repeat(${TIERS.length}, minmax(170px, 1fr))` }}>
          <span />
          {TIERS.map((t) => (
            <button type="button" key={t.id} data-k={t.id} className="b-ml-cmp-head" onClick={() => onOpen(t.id)} title={`Open ${t.label}`}>
              <span>{t.label}</span>
              <span>{t.band}</span>
            </button>
          ))}
          {rows.map((r) => (
            <Fragment key={r.k}>
              <span className="b-ml-cmp-k">{r.k}</span>
              {r.cells.map((c, i) => <span key={TIERS[i].id} className={`b-ml-cmp-c${c.mono ? ' mono' : ''}${c.warn ? ' warn' : ''}`}>{c.v}</span>)}
            </Fragment>
          ))}
        </div>
      </section>
      <p className="b-ml-cmp-note">
        Routing facts only. Price per token, context window and latency per tier aren’t recorded anywhere Atlas can read, so the table has no row for them rather than an estimate.
      </p>
    </>
  );
}

function ProvidersView({ runtime, readings, live, brainRunning }: {
  runtime: ModelLabRuntime;
  readings: ModelLabReadings;
  live: Lane | null;
  brainRunning: boolean | null;
}) {
  const usage = useMemo(() => usageByProvider(readings.usage), [readings.usage]);
  return (
    <>
      <div className="b-ml-lanecards">
        {LANES.map((k) => {
          const selected = live === k;
          const keyPresent = runtime.status ? (k === 'anthropic' ? runtime.status.anthropic : runtime.status.bedrock) : null;
          const st = laneStatus({ available: runtime.available, loading: runtime.loading, keyPresent, selected, brainRunning });
          const facts = laneFacts(k, readings.available ? latencyOf(k, readings.health) : 'readable in the desktop app');
          if (selected) {
            facts.push({ k: 'Brain sidecar', v: brainRunning === null ? 'unknown' : brainRunning ? 'running' : 'not running' });
            if (runtime.brain?.integrity_error) facts.push({ k: 'Integrity', v: runtime.brain.integrity_error });
          }
          return (
            <section key={k} className={`b-ml-lanecard${selected ? ' ink' : ''}`} aria-label={`${LANE_LABEL[k]} lane`}>
              <div className="b-ml-lanecard-head">
                <span className="b-ml-lanecard-t">{LANE_LABEL[k]}{selected ? ' · selected' : ''}</span>
                <span className={`b-ml-st b-ml-st--${st.tone}`}><i />{st.text}</span>
              </div>
              <p className="b-ml-lanecard-d">{laneInfo(k).detail}</p>
              {facts.map((f) => (
                <div key={f.k} className="b-ml-lanefact"><span>{f.k}</span><span>{f.v}</span></div>
              ))}
            </section>
          );
        })}
      </div>

      {!runtime.available ? (
        <p className="b-ml-alert">The active lane and the key inventory live in the macOS Keychain and the brain sidecar. A browser can see neither, so this reports nothing rather than reporting “no key”.</p>
      ) : runtime.error ? (
        <p className="b-ml-alert">
          Couldn’t read the runtime: {runtime.error}{' '}
          <button type="button" className="b-ml-link" onClick={runtime.reload}>Try again</button>
        </p>
      ) : null}

      <section className="b-ml-rules" aria-label="Gateway rules">
        <p className="b-ml-h">Gateway rules</p>
        {GATEWAY_RULES.map((r) => (
          <div key={r.t} className="b-ml-rule"><span>{r.t}</span><span>{r.b}</span></div>
        ))}
      </section>

      <section className="b-ml-usage" aria-label="Usage, last 30 days">
        <div className="b-ml-usage-head">
          <p className="b-ml-h">Usage, last 30 days</p>
          <span>{readings.available ? 'per provider · atlas_usage_history' : 'desktop app only'}</span>
        </div>
        {!readings.available ? (
          <div className="b-ml-empty">Usage lives in the desktop app’s database. A browser can’t read it, so nothing here says zero.</div>
        ) : readings.usageLoading ? (
          <div className="b-ml-empty">Reading atlas_usage_history…</div>
        ) : readings.usageError ? (
          <div className="b-ml-empty">
            Couldn’t read usage: {readings.usageError}{' '}
            <button type="button" className="b-ml-link" onClick={readings.reload}>Try again</button>
          </div>
        ) : !usage.lines.length ? (
          <div className="b-ml-empty">
            <b>Nothing recorded yet.</b> atlas_usage_history has no rows for the last thirty days, and Atlas doesn’t record calls per model, so there is no cost to show and none is estimated.
          </div>
        ) : (
          <>
            {usage.lines.map((u) => (
              <div key={u.provider} className="b-ml-use">
                <span className="b-ml-use-t">{u.label}</span>
                <span className="b-ml-use-bar"><i style={{ width: `${Math.round(u.share * 100)}%`, background: u.colour }} /></span>
                <span className="b-ml-use-v">{u.value}</span>
              </div>
            ))}
            <p className="b-ml-use-foot">
              {usd(usage.cost)} estimated across {usage.days} {usage.days === 1 ? 'day' : 'days'} with rows. Recorded per provider, never per model, so no tier can be priced from it.
            </p>
          </>
        )}
      </section>
    </>
  );
}

export default BetaModelLab;
