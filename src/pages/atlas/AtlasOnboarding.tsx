/**
 * Atlas Onboarding — the first-run flow (`Atlas Onboarding.dc.html`).
 *
 * intro → permissions → asking → welcome, with spoken copy, on the band-header
 * chrome the rest of the app uses. Back-navigation is the clickable headline
 * plus Esc; there is no header link and no dock (the wiring pass owns that).
 *
 * ---------------------------------------------------------------------------
 * WHAT IS REAL HERE, AND WHAT THE DESIGN INVENTED
 * ---------------------------------------------------------------------------
 * The design's permission list is eight capabilities — microphone,
 * notifications, mail & calendar, smart home, health & watch, banking, location
 * and contacts — grouped CORE / YOUR APPS / CONTEXT, every one presented as a
 * grant the user is handing over. Atlas has FOUR capabilities
 * (`src/lib/atlasPermissions.ts`), and only two of them are grants at all:
 *
 *   microphone     real `getUserMedia` → macOS shows a prompt
 *   notifications  real `@tauri-apps/plugin-notification` → macOS shows a prompt
 *   liveData       an app-side switch. No OS call. Nothing is asked of macOS.
 *   proactive      an app-side switch. No OS call. Nothing is asked of macOS.
 *
 * So this screen binds the design's tile grid to those four, and the grouping
 * is derived from `osPrompt` rather than invented: "macOS permissions" for the
 * two that really produce a system dialog, "Atlas settings" for the two that do
 * not. The tag on each tile says which — because a screen that dresses an app
 * preference up as a system grant is lying about who is being asked.
 *
 * The design also marks the microphone "Required". It is not: Atlas types
 * perfectly well without it, and the existing flow lets you decline everything.
 * There is no required tile here.
 *
 * The welcome grid's fabricated metrics are dealt with in WelcomeGrid.tsx.
 *
 * ---------------------------------------------------------------------------
 * THE SPOKEN COPY
 * ---------------------------------------------------------------------------
 * `useAtlasSpeech` is the app's word-by-word reveal (and already honours
 * prefers-reduced-motion by landing the whole line at once). The design writes
 * a bespoke reaction line per permission; those are replaced by the capability's
 * own `blurb` (switched on) and `withoutIt` (switched off), which are the
 * strings the codebase has already vetted against what the code actually does.
 * Two copies of the same promise drift; one does not.
 */
import {
  useCallback, useEffect, useMemo, useRef, useState,
  // Aliased: the un-prefixed name would shadow the DOM `KeyboardEvent` that the
  // window-level Esc listener below is typed against.
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Brain, Globe, Mail, MessageCircle, Mic, ShieldAlert, ShieldCheck, Sparkles,
} from 'lucide-react';
import { Button, Empty, Panel } from '@/components/atlas-ui/primitives';
import { CapabilityTile, type CapabilityTileState } from '@/components/atlas-ui/onboarding/CapabilityTile';
import { OnboardingSphere } from '@/components/atlas-ui/onboarding/OnboardingSphere';
import { WelcomeGrid, type WelcomeFeature, type WelcomeFeatureState } from '@/components/atlas-ui/onboarding/WelcomeGrid';
import { useAtlasSpeech } from '@/hooks/useAtlasSpeech';
import {
  ATLAS_PERMISSIONS,
  readOnboarding,
  requestPermission,
  writeOnboarding,
  type AtlasPermission,
  type PermissionId,
} from '@/lib/atlasPermissions';
import type { SphereState } from '@/lib/atlasSphere';
import '@/styles/surfaces/onboarding.css';

export const surface = {
  path: '/onboarding',
  label: 'Onboarding',
  icon: 'ShieldCheck',
  // Not a dock item: this is a first-run flow, and on a return visit it is
  // "review what I allowed" — which is an account-menu errand, not a place you
  // live. The design's own "Replay intro" button is the same idea.
  entry: 'menu',
  // Bound to the real capability list, the real OS prompts and the real stored
  // consent record. Nothing on this surface is mocked.
  mock: false,
  edition: 'consumer',
} as const;

type Stage = 'intro' | 'permissions' | 'asking' | 'welcome';

const STEPS: Stage[] = ['intro', 'permissions', 'welcome'];
const stepIndex = (s: Stage) => (s === 'asking' ? 1 : STEPS.indexOf(s));

const CAP_ICON: Record<PermissionId, ReactNode> = {
  microphone: <Mic className="i14" />,
  notifications: <MessageCircle className="i14" />,
  liveData: <Globe className="i14" />,
  proactive: <Sparkles className="i14" />,
};

/** Blank choice map, used for "Not now" and as the seed when the list is empty. */
const noChoices = (): Record<PermissionId, boolean> =>
  Object.fromEntries(ATLAS_PERMISSIONS.map((p) => [p.id, false])) as Record<PermissionId, boolean>;

const AtlasOnboarding = () => {
  const navigate = useNavigate();
  const speech = useAtlasSpeech();

  // Read ONCE. Settings and the account menu make this a revisit surface, so it
  // has to open on the answers actually given — seeding from `defaultOn`
  // regardless would show the wrong state and then write it back on Continue,
  // silently revoking a consent the user had already granted.
  const [record] = useState(() => {
    try {
      return readOnboarding();
    } catch {
      return null;
    }
  });
  const revisiting = record !== null;

  const [stage, setStage] = useState<Stage>('intro');
  const [choices, setChoices] = useState<Record<PermissionId, boolean>>(() => {
    const stored = record?.choices as Partial<Record<PermissionId, boolean>> | undefined;
    return Object.fromEntries(
      ATLAS_PERMISSIONS.map((p) => [
        p.id,
        typeof stored?.[p.id] === 'boolean' ? stored[p.id] : p.defaultOn,
      ]),
    ) as Record<PermissionId, boolean>;
  });
  /** What the OS actually said. Only ever written from a real `requestPermission`. */
  const [granted, setGranted] = useState<Partial<Record<PermissionId, boolean>>>({});
  const [asking, setAsking] = useState<PermissionId | null>(null);
  /**
   * Whether the consent record survived a write→read round trip.
   * `writeOnboarding` swallows storage failures (deliberately — a blocked
   * localStorage must not break the flow), which means the flow cannot tell
   * whether it persisted anything. So this screen checks for itself rather than
   * telling the user "saved" on faith.
   */
  const [persisted, setPersisted] = useState<'unknown' | 'ok' | 'failed'>('unknown');

  const total = ATLAS_PERMISSIONS.length;
  const noCapabilities = total === 0;
  const osCount = useMemo(() => ATLAS_PERMISSIONS.filter((p) => p.osPrompt).length, []);
  const onCount = useMemo(
    () => ATLAS_PERMISSIONS.filter((p) => choices[p.id]).length,
    [choices],
  );
  const deniedList = useMemo(
    () => ATLAS_PERMISSIONS.filter((p) => granted[p.id] === false),
    [granted],
  );
  const liveCount = useMemo(
    () => ATLAS_PERMISSIONS.filter((p) => choices[p.id] && granted[p.id] !== false).length,
    [choices, granted],
  );

  /* ---- spoken script ---------------------------------------------------- */

  const LINES = useMemo(() => ({
    intro: revisiting
      ? "Here's what you allowed me. Change anything you like — nothing is locked in."
      : "Hi — I'm Atlas. Before we begin, let's agree on what I'm allowed to do.",
    permissions: noCapabilities
      ? "I could not read my own capability list, so there is nothing for you to decide here."
      : `Everything here is reversible. ${osCount} of the ${total} ask macOS for permission; the rest are switches inside Atlas.`,
    askingOs: "macOS will ask you to confirm. I'll take them one at a time.",
    askingNone: 'Nothing here needs macOS — I am just saving what you chose.',
    welcome: "We're set. Here's what that turns on.",
    welcomeNone: "Understood. I'll only ever act when you ask me to.",
  }), [revisiting, noCapabilities, osCount, total]);

  // Atlas opens the conversation. `speech.speak` is stable (useCallback), and
  // this deliberately runs once — re-speaking on every render would restart the
  // reveal forever.
  const spoke = useRef(false);
  useEffect(() => {
    if (spoke.current) return;
    spoke.current = true;
    speech.speak(LINES.intro);
  }, [LINES.intro, speech]);

  const goto = useCallback((next: Stage, line: string) => {
    setStage(next);
    speech.speak(line);
  }, [speech]);

  /* ---- navigation ------------------------------------------------------- */

  // Back is the previous stage, never an exit: consent is not skippable by
  // pressing Esc, so `intro` has nowhere to go and `asking` is frozen while a
  // system dialog is genuinely in flight.
  const back = useMemo(() => {
    if (stage === 'permissions') return () => goto('intro', LINES.intro);
    if (stage === 'welcome') return () => goto('permissions', LINES.permissions);
    return null;
  }, [stage, goto, LINES]);

  useEffect(() => {
    if (!back) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') back(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [back]);

  /* ---- choices ---------------------------------------------------------- */

  const toggle = useCallback((p: AtlasPermission) => {
    // Computed outside the updater on purpose: `speech.speak` is a side effect,
    // and React may call a state updater more than once.
    const next = !choices[p.id];
    setChoices((c) => ({ ...c, [p.id]: next }));
    // A previous refusal is no longer the current answer once the user switches
    // it again — the tile must not keep saying "not granted" while we re-ask.
    setGranted((g) => {
      if (!(p.id in g)) return g;
      const rest = { ...g };
      delete rest[p.id];
      return rest;
    });
    // The vetted string for whichever way it just went.
    speech.speak(next ? p.blurb : p.withoutIt);
  }, [choices, speech]);

  const applyPreset = useCallback((all: boolean) => {
    setChoices(
      Object.fromEntries(
        ATLAS_PERMISSIONS.map((p) => [p.id, all ? true : p.defaultOn]),
      ) as Record<PermissionId, boolean>,
    );
    setGranted({});
    speech.speak(
      all
        ? 'Everything, then — including the digest, which is the one that acts without you asking.'
        : 'The recommended set: useful, and nothing that runs on its own.',
    );
  }, [speech]);

  /**
   * Write the record and verify it came back. Returns whether it stuck.
   */
  const persist = useCallback((c: Record<PermissionId, boolean>) => {
    writeOnboarding(c);
    let ok = false;
    try {
      const back2 = readOnboarding();
      const stored = back2?.choices as Partial<Record<PermissionId, boolean>> | undefined;
      ok = !!back2 && ATLAS_PERMISSIONS.every((p) => stored?.[p.id] === c[p.id]);
    } catch {
      ok = false;
    }
    setPersisted(ok ? 'ok' : 'failed');
    return ok;
  }, []);

  /* ---- the ask ---------------------------------------------------------- */

  const confirm = useCallback(async () => {
    setStage('asking');
    const wantsOs = ATLAS_PERMISSIONS.some((p) => p.osPrompt && choices[p.id]);
    speech.speak(wantsOs ? LINES.askingOs : LINES.askingNone);

    // Sequential BY DESIGN: firing these in parallel stacks unexplained system
    // dialogs, which is the behaviour this whole screen exists to replace.
    const results: Partial<Record<PermissionId, boolean>> = {};
    for (const p of ATLAS_PERMISSIONS) {
      if (!choices[p.id]) continue;
      setAsking(p.id);
      results[p.id] = await requestPermission(p.id);
    }
    setAsking(null);
    setGranted(results);

    // What the user chose, not what we hoped they would.
    persist(choices);

    const anyLive = ATLAS_PERMISSIONS.some((p) => choices[p.id] && results[p.id] !== false);
    goto('welcome', anyLive ? LINES.welcome : LINES.welcomeNone);
  }, [choices, persist, goto, speech, LINES]);

  // "Not now" is an answer, not a cancel: on a first run it records a decline so
  // the onboarding gate stops asking. On a REVISIT it would wipe consents the
  // user came here only to look at, so it just leaves.
  const notNow = useCallback(() => {
    if (revisiting) { navigate('/'); return; }
    const none = noChoices();
    setChoices(none);
    setGranted({});
    persist(none);
    goto('welcome', LINES.welcomeNone);
  }, [revisiting, navigate, persist, goto, LINES.welcomeNone]);

  /* ---- band ------------------------------------------------------------- */

  const head = useMemo(() => {
    switch (stage) {
      case 'intro':
        return revisiting
          ? { lead: 'What you ', accent: 'allowed me.' }
          : { lead: "Hi — I'm ", accent: 'Atlas.' };
      case 'permissions':
        return { lead: 'What may I ', accent: 'look after?' };
      case 'asking':
        return { lead: 'Asking ', accent: 'macOS.' };
      default:
        return { lead: 'One assistant, ', accent: 'every surface.' };
    }
  }, [stage, revisiting]);

  const meta = useMemo(() => {
    switch (stage) {
      case 'intro':
        return { big: String(total), small: total === 1 ? 'thing to agree on' : 'things to agree on' };
      case 'permissions':
        return { big: `${onCount}/${total}`, small: 'switched on' };
      case 'asking':
        return { big: `${onCount}/${total}`, small: 'confirming' };
      default:
        return { big: `${liveCount}/${total}`, small: 'live' };
    }
  }, [stage, total, onCount, liveCount]);

  const orbState: SphereState =
    stage === 'asking' ? 'working'
      : speech.speaking ? 'speaking'
        : stage === 'welcome' ? 'idle'
          : 'listening';

  /* ---- welcome features ------------------------------------------------- */

  const byId = useMemo(
    () => Object.fromEntries(ATLAS_PERMISSIONS.map((p) => [p.id, p])) as Partial<Record<PermissionId, AtlasPermission>>,
    [],
  );

  const capState = useCallback((id: PermissionId): WelcomeFeatureState => {
    if (!byId[id]) return 'off';
    if (granted[id] === false) return 'denied';
    return choices[id] ? 'on' : 'off';
  }, [byId, choices, granted]);

  const capNote = useCallback((id: PermissionId, live: string): string => {
    const p = byId[id];
    if (!p) return 'This capability is not present in this build.';
    if (granted[id] === false) return `macOS refused this one. ${p.withoutIt}`;
    return choices[id] ? live : p.withoutIt;
  }, [byId, choices, granted]);

  const features = useMemo<WelcomeFeature[]>(() => {
    const capabilityFeatures: WelcomeFeature[] = [
      {
        id: 'microphone', name: 'Voice', span: 3, icon: <Mic className="i16" />,
        claim: 'Talk to Atlas instead of typing.',
        state: capState('microphone'),
        note: capNote('microphone', 'The microphone is granted — the mic in the dock starts a conversation.'),
      },
      {
        id: 'notifications', name: 'Notifications', span: 3, icon: <MessageCircle className="i16" />,
        claim: 'Told only when it actually matters.',
        state: capState('notifications'),
        note: capNote('notifications', 'Atlas can post a system notification when something needs you.'),
      },
      {
        id: 'liveData', name: 'Live data', span: 2, icon: <Globe className="i16" />,
        claim: 'Weather, markets and news, as you look at them.',
        state: capState('liveData'),
        note: capNote('liveData', 'Those dashboard cards fetch when you open them.'),
      },
      {
        id: 'proactive', name: 'Proactive digest', span: 2, icon: <Sparkles className="i16" />,
        claim: 'A look over your recent days, on a schedule.',
        state: capState('proactive'),
        note: capNote('proactive', 'Atlas runs its own pass and surfaces what it finds.'),
      },
    ];
    // A capability the build does not have is dropped rather than rendered as
    // "off" — "off" would claim the user declined something never offered.
    const gated = capabilityFeatures.filter((f) => !!byId[f.id as PermissionId]);

    // Two surfaces that exist and need no first-run permission at all. Included
    // because "what Atlas can do from day one" is otherwise misleadingly short —
    // and excluded from every count, because nothing was granted for them.
    const ungated: WelcomeFeature[] = [
      {
        id: 'mail', name: 'Mail', span: 2, state: 'neutral', icon: <Mail className="i16" />,
        claim: 'Triage and drafts you approve before they send.',
        note: 'Connect a mailbox in Mail and Atlas starts triaging. No permission is asked for here.',
      },
      {
        id: 'memory', name: 'Memory', span: 6, state: 'neutral', icon: <Brain className="i16" />,
        claim: 'Everything you tell Atlas is indexed on this Mac.',
        note: 'Local search over your own notes, with sqlite-vec and FTS5. No permission needed — the index never leaves this machine.',
      },
    ];

    return [...gated, ...ungated];
  }, [byId, capState, capNote]);

  const nothingLive = liveCount === 0;

  /* ---- render ----------------------------------------------------------- */

  // Space activates a <button> natively; this only adds it explicitly so the
  // affordance is identical however the control ends up being styled.
  const onHeadKey = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!back) return;
    if (e.key === ' ') { e.preventDefault(); back(); }
  };

  const hasNotice = persisted === 'failed' || deniedList.length > 0;
  const notices = !hasNotice ? null : (
    <div className="onb-notices">
      {persisted === 'failed' && (
        <p className="onb-notice onb-notice-warn">
          <ShieldAlert className="i16" aria-hidden />
          <span>
            This Mac would not let Atlas save your answers, so it will ask again next
            launch. Nothing you chose is lost for this session.
          </span>
        </p>
      )}
      {deniedList.length > 0 && (
        <p className="onb-notice onb-notice-warn">
          <ShieldAlert className="i16" aria-hidden />
          <span>
            macOS refused {deniedList.map((p) => p.title.toLowerCase()).join(' and ')}. Atlas
            cannot grant that for you — System Settings › Privacy &amp; Security is the only
            place it can change.
          </span>
        </p>
      )}
    </div>
  );

  return (
    <div className="page" data-screen-label="Atlas — Onboarding">
      <div className="auro" />
      <div className="onb-bloom" aria-hidden />
      <div className="grain" aria-hidden />

      <section className={`bandB onb-band onb-band-${stage}`}>
        <div className="onb-orbwrap">
          <div className="onb-halo" aria-hidden />
          <OnboardingSphere state={orbState} className="onb-orb" />
        </div>

        <div className="onb-bandtext">
          {/* Back-navigation IS the headline (plus Esc). No header link, per the
              surface chrome the rest of the app uses.

              The clickable form is a <button> INSIDE the <h2>, not `role="button"`
              on the heading itself: the dashboard's clickable `.greetB` is
              mouse-only, and putting the role on the h2 to fix that would delete
              the only heading this screen has. This keeps both. */}
          <h2 className={`greetB${back ? ' returnable' : ''}`}>
            {back ? (
              <button type="button" className="onb-back" onClick={back} onKeyDown={onHeadKey} title="Go back (Esc)">
                {head.lead}<span className="accw">{head.accent}</span>
              </button>
            ) : (
              <>{head.lead}<span className="accw">{head.accent}</span></>
            )}
          </h2>
          {/* The animated line is hidden from assistive tech and mirrored into a
              live region that only fires once the sentence has landed. A live
              region on the animation itself would announce the line one word at
              a time, every time — which is worse than not announcing it. */}
          <p className="gsubB onb-spoken" aria-hidden>
            {speech.words.map((w, i) => (
              <span key={i} className="awd">{w}{' '}</span>
            ))}
            {speech.speaking && <span className="onb-caret" />}
          </p>
          <p className="onb-sr" role="status">{speech.done ? speech.words.join(' ') : ''}</p>
        </div>

        <div className="bandmetaB">
          <p className="bmvB tnum">{meta.big}</p>
          <p className="bmlB">{meta.small}</p>
        </div>
      </section>

      {/* `key` replays the 0.8s page-entry animation per stage. `asking` maps
          onto `permissions` on purpose: it is the same panel with the tiles
          frozen, and remounting it mid-prompt would drop focus while a macOS
          dialog is on screen. */}
      <main
        key={stage === 'asking' ? 'permissions' : stage}
        className={`onb-stage${stage === 'intro' ? ' onb-stage-intro' : ''}`}
      >
        {stage !== 'intro' && (
          <ol className="onb-steps" aria-label="Onboarding progress">
            {STEPS.map((s, i) => (
              <li
                key={s}
                className={`onb-step${i === stepIndex(stage) ? ' onb-step-on' : i < stepIndex(stage) ? ' onb-step-done' : ''}`}
                aria-current={i === stepIndex(stage) ? 'step' : undefined}
              />
            ))}
          </ol>
        )}

        {stage === 'intro' && (
          <>
            <p className="onb-introsub">
              {noCapabilities
                ? 'There is nothing to agree on in this build.'
                : `${total} ${total === 1 ? 'question' : 'questions'}. Under a minute. Everything is reversible.`}
            </p>
            <Button
              variant="ink"
              onClick={() => goto('permissions', LINES.permissions)}
              disabled={!speech.done}
            >
              {revisiting ? 'Review what I allowed' : 'Begin'}
            </Button>
          </>
        )}

        {(stage === 'permissions' || stage === 'asking') && (
          <>
            {notices}
            <Panel className="onb-permpanel">
              {noCapabilities ? (
                // The missing data source, stated rather than papered over: this
                // is what the screen looks like if ATLAS_PERMISSIONS is empty.
                <Empty
                  size="section"
                  icon={<ShieldCheck className="i20" />}
                  title="No capabilities to review"
                  body="Atlas could not read its capability list, so there is nothing to grant or decline. The app still runs; you can review permissions later in Settings."
                  action={{ label: 'Open Settings', onClick: () => navigate('/settings'), variant: 'ghost' }}
                />
              ) : (
                <>
                  {(['os', 'app'] as const).map((kind) => {
                    const list = ATLAS_PERMISSIONS.filter((p) => (kind === 'os' ? p.osPrompt : !p.osPrompt));
                    if (list.length === 0) return null;
                    return (
                      <div key={kind}>
                        <p className="onb-group">
                          {kind === 'os' ? 'macOS permissions' : 'Atlas settings'}
                        </p>
                        <div className="onb-tiles">
                          {list.map((p) => {
                            const on = !!choices[p.id];
                            const tileState: CapabilityTileState =
                              asking === p.id ? 'asking'
                                : granted[p.id] === false ? 'denied'
                                  : on ? 'on' : 'off';
                            const tag =
                              tileState === 'asking' ? (p.osPrompt ? 'asking macOS' : 'saving')
                                : tileState === 'denied' ? 'not granted'
                                  : !on ? 'off'
                                    : p.osPrompt ? 'macOS will ask' : 'no system prompt';
                            return (
                              <CapabilityTile
                                key={p.id}
                                name={p.title}
                                why={on ? p.blurb : p.withoutIt}
                                tag={tag}
                                state={tileState}
                                icon={CAP_ICON[p.id]}
                                disabled={stage === 'asking'}
                                onToggle={() => toggle(p)}
                              />
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}

                  <div className="onb-foot">
                    <span className="onb-grant tnum">
                      {onCount} of {total} on · {osCount === 0
                        ? 'none need macOS'
                        : `${osCount} ${osCount === 1 ? 'asks' : 'ask'} macOS`}
                    </span>
                    <div className="onb-foot-actions">
                      <Button variant="ghost" size="sm" disabled={stage === 'asking'} onClick={() => applyPreset(false)}>
                        Recommended
                      </Button>
                      <Button variant="ghost" size="sm" disabled={stage === 'asking'} onClick={() => applyPreset(true)}>
                        Everything
                      </Button>
                      <Button variant="text" size="sm" disabled={stage === 'asking'} onClick={notNow}>
                        {revisiting ? 'Cancel' : 'Not now'}
                      </Button>
                      <Button
                        variant="ink"
                        loading={stage === 'asking'}
                        onClick={() => void confirm()}
                      >
                        {stage === 'asking' ? 'Confirming…' : 'Continue'}
                      </Button>
                    </div>
                  </div>
                </>
              )}
            </Panel>
            <p className="onb-fine">
              Reversible at any time in Settings · your notes and files stay on this Mac ·
              what Atlas sends for reasoning is set out in the Privacy Policy
            </p>
          </>
        )}

        {stage === 'welcome' && (
          <>
            {notices}
            {nothingLive && (
              <div className="onb-emptywrap">
                {/* Not an error — a legitimate answer, given its own designed state
                    rather than an empty grid. */}
                <Empty
                  size="block"
                  icon={<ShieldCheck className="i20" />}
                  title="Ask-only mode"
                  body="Nothing is switched on, so Atlas acts only when you ask it to. Every capability is waiting in Settings whenever you want one."
                  action={{ label: 'Open Settings', onClick: () => navigate('/settings'), variant: 'ghost' }}
                />
              </div>
            )}
            <WelcomeGrid features={features} />
            <div className="onb-welcomefoot">
              <span className="onb-summary tnum">
                {noCapabilities
                  ? 'No capabilities were reviewed.'
                  : `${liveCount} of ${total} live${persisted === 'ok' ? ' · saved' : ''} — adjust any time in Settings.`}
              </span>
              <Button variant="ink" onClick={() => navigate('/')}>Enter Atlas</Button>
            </div>
          </>
        )}
      </main>
    </div>
  );
};

export default AtlasOnboarding;
