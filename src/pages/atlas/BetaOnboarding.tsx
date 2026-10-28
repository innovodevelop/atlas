/**
 * The Beta onboarding — `/onboarding` and, through BetaPermissions.tsx,
 * `/permissions` while the beta_ui flag is on (Beta redesign phase 7,
 * `Atlas Entry Beta.dc.html`): intro → permissions → macOS asks → welcome,
 * on the Entry scene, after the Workshop's two first-run screens.
 *
 * What is real here is what was real in those two screens, and nothing the
 * design invented on top:
 *
 *   - the list is `ATLAS_PERMISSIONS` (four capabilities), grouped by
 *     `osPrompt`: the two that really make macOS show a dialog, and the two
 *     that are switches inside Atlas. The tag on each row says which, because
 *     dressing an app preference up as a system grant lies about who is asked.
 *   - the lines Atlas says when a switch flips are the capability's own
 *     `blurb` / `withoutIt`, the strings the codebase has vetted against what
 *     the code does — not the design's bespoke reactions (two copies of one
 *     promise drift).
 *   - "macOS asks" is the REAL prompt (`requestPermission`, sequential so the
 *     user can connect each dialog to its row). The design's card with its
 *     own Allow / Don't Allow buttons stood in for that dialog in a browser
 *     prototype; here the card only narrates what macOS is asking, and the
 *     answer is given in macOS's dialog, never in ours.
 *   - the record is `writeOnboarding`, read back to check it stuck, and "Not
 *     now" on a first run is an answer (decline everything, so the gate stops
 *     asking) while on a revisit it is a cancel.
 *
 * Atlas types its lines and, with the Voice pill on (off by default, the
 * same remembered choice as the sign-in), speaks them too. The sphere is the
 * talk entry point once there is an account to talk as.
 *
 * The welcome uses the name given at sign-up: handed over in the navigation
 * state on the way here, and read back from the local profile on a later
 * visit (src/lib/entryProfile.ts is what writes it).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { useUserProfile } from '@/hooks/useUserProfile';
import { useEntryVoice } from '@/hooks/useEntryVoice';
import {
  ATLAS_PERMISSIONS, readMicConsent, readOnboarding, requestPermission, writeOnboarding,
  type AtlasPermission, type PermissionId,
} from '@/lib/atlasPermissions';
import {
  ONBOARDING_STEPS, askVerb, countWord, introAskLine, onboardingSphereState, permsButton, permsSubline, stepIndex,
  summaryRows, welcomeLine, type OnboardingStage,
} from '@/lib/betaEntry';
import { openTalk } from '@/lib/talkBus';
import { useBetaNavigate } from '@/lib/viewTransitions';
import { AtlasIcon } from '@/components/atlas/AtlasIcon';
import { EntryScene, type EntryStep } from '@/components/atlas/entry/EntryScene';
import { useTypewriter } from '@/components/atlas/entry/useTypewriter';
import { isTyping } from './atlasHelpers';
import '@/styles/beta/entry.css';

export type EntryRoute = 'onboarding' | 'permissions';

/** Blank choice map, for "Not now". */
const noChoices = (): Record<PermissionId, boolean> =>
  Object.fromEntries(ATLAS_PERMISSIONS.map((p) => [p.id, false])) as Record<PermissionId, boolean>;

export function BetaOnboardingFlow({ route }: { route: EntryRoute }) {
  const navigate = useBetaNavigate();
  const location = useLocation();
  const { isAuthenticated } = useAuth();
  const { profile } = useUserProfile();
  // The sign-up screen passes the name along (its profile write may not have
  // landed yet); otherwise the profile's, in the order Home reads it.
  const handedOver = (location.state as { firstName?: string } | null)?.firstName;
  const firstName = handedOver || profile?.nickname || profile?.first_name || null;
  const { shown, target, typing, say: type } = useTypewriter();
  // The Voice pill (left-out row 30), off until turned on and remembered
  // from the sign-in screen. Onboarding has no password step, so every line
  // may be spoken; nothing the user types or chooses is.
  const voice = useEntryVoice();
  const { say: speak } = voice;
  const say = useCallback((line: string) => { type(line); speak(line); }, [type, speak]);

  // Read ONCE. Settings and the account menu make this a revisit surface, so
  // it has to open on the answers actually given — seeding from `defaultOn`
  // would show the wrong state and then write it back on Continue, silently
  // revoking a consent the user had already granted.
  const [record] = useState(() => { try { return readOnboarding(); } catch { return null; } });
  const revisiting = record !== null;
  // The microphone answer given on the sign-in screen, if there was one; the
  // stored record still wins where it exists.
  const [micConsent] = useState(() => readMicConsent());

  const [stage, setStage] = useState<OnboardingStage>('intro');
  const [choices, setChoices] = useState<Record<PermissionId, boolean>>(() => {
    const stored = record?.choices as Partial<Record<PermissionId, boolean>> | undefined;
    return Object.fromEntries(
      ATLAS_PERMISSIONS.map((p) => [
        p.id,
        typeof stored?.[p.id] === 'boolean'
          ? stored[p.id]
          : p.id === 'microphone' && micConsent ? micConsent.granted : p.defaultOn,
      ]),
    ) as Record<PermissionId, boolean>;
  });
  /** What the OS actually said. Only ever written from a real `requestPermission`. */
  const [granted, setGranted] = useState<Partial<Record<PermissionId, boolean>>>({});
  const [asking, setAsking] = useState<PermissionId | null>(null);
  /** The system prompts this confirm will raise, in order, for "1 of 2". */
  const [queue, setQueue] = useState<PermissionId[]>([]);
  /**
   * Whether the record survived a write→read round trip. `writeOnboarding`
   * swallows storage failures (a blocked localStorage must not break the
   * flow), so the screen checks for itself rather than saying "saved" on faith.
   */
  const [persisted, setPersisted] = useState<'unknown' | 'ok' | 'failed'>('unknown');

  const total = ATLAS_PERMISSIONS.length;
  const osCount = useMemo(() => ATLAS_PERMISSIONS.filter((p) => p.osPrompt).length, []);
  const anyOn = ATLAS_PERMISSIONS.some((p) => choices[p.id]);
  const liveCount = ATLAS_PERMISSIONS.filter((p) => choices[p.id] && granted[p.id] !== false).length;
  const deniedList = ATLAS_PERMISSIONS.filter((p) => granted[p.id] === false);

  const LINES = useMemo(() => ({
    intro: revisiting
      ? 'Here’s what you allowed me. Change anything you like — nothing is locked in.'
      : 'Before we start, here’s what I’d like to do. You decide.',
    perms: 'Switch on what you’re comfortable with.',
    askingOs: 'macOS will ask you now.',
    askingNone: 'Nothing here needs macOS — I’m just saving what you chose.',
    welcomeNone: 'Understood. I’ll only ever act when you ask me to.',
  }), [revisiting]);

  // Atlas opens the conversation. Both dependencies are fixed for the life of
  // the screen (`say` is stable, the record is read once), so this runs on
  // mount — and replays cleanly if React re-runs it, since `say` cancels
  // whatever was being typed first.
  useEffect(() => { say(LINES.intro); }, [say, LINES.intro]);

  const goto = useCallback((next: OnboardingStage, line: string) => {
    setStage(next);
    say(line);
  }, [say]);

  // Back is the previous stage, never an exit: consent is not skippable by
  // pressing Esc, so `intro` has nowhere to go and `asking` is frozen while a
  // system dialog is genuinely in flight.
  const back = useMemo(() => {
    if (stage === 'perms') return () => goto('intro', LINES.intro);
    if (stage === 'welcome') return () => goto('perms', LINES.perms);
    return null;
  }, [stage, goto, LINES]);

  useEffect(() => {
    if (!back) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !isTyping(e.target)) back(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [back]);

  /* ---- choices ---------------------------------------------------------- */

  const toggle = useCallback((p: AtlasPermission) => {
    // Computed outside the updater on purpose: `say` is a side effect, and
    // React may call a state updater more than once.
    const next = !choices[p.id];
    setChoices((c) => ({ ...c, [p.id]: next }));
    // A previous refusal is no longer the current answer once the switch
    // moves again — the row must not keep saying "not granted" while we re-ask.
    setGranted((g) => {
      if (!(p.id in g)) return g;
      const rest = { ...g };
      delete rest[p.id];
      return rest;
    });
    say(next ? p.blurb : p.withoutIt);
  }, [choices, say]);

  /** Write the record and verify it came back. */
  const persist = useCallback((c: Record<PermissionId, boolean>) => {
    writeOnboarding(c);
    let ok = false;
    try {
      const again = readOnboarding();
      const stored = again?.choices as Partial<Record<PermissionId, boolean>> | undefined;
      ok = !!again && ATLAS_PERMISSIONS.every((p) => stored?.[p.id] === c[p.id]);
    } catch {
      ok = false;
    }
    setPersisted(ok ? 'ok' : 'failed');
  }, []);

  /* ---- the ask ---------------------------------------------------------- */

  const confirm = useCallback(async () => {
    const q = ATLAS_PERMISSIONS.filter((p) => p.osPrompt && choices[p.id]).map((p) => p.id);
    setQueue(q);
    setGranted({});
    goto('asking', q.length ? LINES.askingOs : LINES.askingNone);

    // Sequential BY DESIGN: firing these in parallel stacks unexplained
    // system dialogs, which is the behaviour this screen exists to replace.
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
    goto('welcome', anyLive ? welcomeLine(firstName) : LINES.welcomeNone);
  }, [choices, goto, LINES, persist, firstName]);

  // "Not now" is an answer, not a cancel: on a first run it records a decline
  // so the onboarding gate stops asking. On a REVISIT it would wipe consents
  // the user came here only to look at, so it just leaves.
  const notNow = useCallback(() => {
    if (revisiting) { navigate('/'); return; }
    const none = noChoices();
    setChoices(none);
    setGranted({});
    persist(none);
    goto('welcome', LINES.welcomeNone);
  }, [revisiting, navigate, persist, goto, LINES.welcomeNone]);

  /* ---- render ----------------------------------------------------------- */

  const idx = stepIndex(stage);
  const steps: EntryStep[] = ONBOARDING_STEPS.map((label, i) => ({ label, state: i < idx ? 'done' : i === idx ? 'current' : 'todo' }));
  const introRows = [
    'I’ll tell you what I’d like to be able to do, and why.',
    'You switch on only what you’re comfortable with. Nothing is required.',
    introAskLine(osCount),
  ];
  const sub = stage === 'intro'
    ? (revisiting ? 'Everything here is reversible.' : `${countWord(introRows.length, true)} things, then you’re in.`)
    : stage === 'perms'
      ? permsSubline(osCount, total)
      : stage === 'asking'
        ? (queue.length ? 'macOS asks for the ones you switched on, one at a time.' : 'Saving what you chose.')
        : 'Here’s what you chose.';
  // Only a capability that really reaches macOS gets the card.
  const current = asking ? ATLAS_PERMISSIONS.find((p) => p.id === asking && p.osPrompt) : undefined;
  const rows = summaryRows(ATLAS_PERMISSIONS, choices, granted);
  const groups: Array<[string, AtlasPermission[]]> = [
    ['macOS permissions', ATLAS_PERMISSIONS.filter((p) => p.osPrompt)],
    ['Atlas settings', ATLAS_PERMISSIONS.filter((p) => !p.osPrompt)],
  ];

  return (
    <EntryScene
      variant="onboarding"
      screenLabel={route === 'permissions' ? 'Atlas Permissions — Beta' : 'Atlas Onboarding — Beta'}
      kicker="Setting up"
      // The design says voice stays on this Mac too. It does not: speech is
      // transcribed by ElevenLabs (useLoginVoice, the voice gateway), so the
      // line says so rather than promise what the code does not do.
      line="Your memories and documents stay on this Mac. What leaves it is the question you ask, with the few memories that help answer it — and your voice, while you speak, to be transcribed."
      sphereState={onboardingSphereState(stage, voice.playing)}
      voice={{ on: voice.on, onToggle: () => voice.toggle(target) }}
      onSphere={isAuthenticated ? () => openTalk() : undefined}
      steps={steps}
      eyebrow={`Step ${idx + 1} of ${ONBOARDING_STEPS.length}`}
      said={shown}
      target={target}
      typing={typing}
      sub={sub}
    >
      {stage === 'intro' && !typing ? (
        <div className="b-en-rows b-en-pop">
          {introRows.map((t, i) => (
            <div key={t} className="b-en-row"><span className="b-en-row-n">{i + 1}</span><span>{t}</span></div>
          ))}
          <button type="button" className="b-en-btn b-en-btn--blue b-en-cta" onClick={() => goto('perms', LINES.perms)}>
            {revisiting ? 'Review what I allowed' : 'Show me'}
          </button>
        </div>
      ) : null}

      {stage === 'perms' ? (
        <div className="b-en-perms b-en-pop">
          {total === 0 ? (
            // The missing data source, stated rather than papered over.
            <p className="b-en-notice">Atlas could not read its capability list, so there is nothing to grant or decline. The app still runs; permissions are in Settings.</p>
          ) : null}
          {groups.map(([label, items]) => items.length ? (
            <div key={label} className="b-en-group">
              <span className="b-en-group-l">{label}</span>
              {items.map((p) => {
                const on = !!choices[p.id];
                const denied = granted[p.id] === false;
                const tag = denied ? 'not granted' : p.osPrompt ? 'macOS will ask' : 'Atlas setting';
                return (
                  <button
                    key={p.id}
                    type="button"
                    role="switch"
                    aria-checked={on}
                    className={`b-en-perm${on ? ' on' : ''}`}
                    onClick={() => toggle(p)}
                  >
                    <span className="b-en-perm-text">
                      <span className="b-en-perm-title">
                        {p.title}
                        <span className={`b-en-tag${denied ? ' b-en-tag--denied' : p.osPrompt ? ' b-en-tag--os' : ''}`}>{tag}</span>
                      </span>
                      <span className="b-en-perm-line">{on ? p.blurb : p.withoutIt}</span>
                    </span>
                    <span className={`b-switch${on ? ' on' : ''}`} aria-hidden><span /></span>
                  </button>
                );
              })}
            </div>
          ) : null)}
          <div className="b-en-perms-foot">
            <button type="button" className="b-en-btn b-en-btn--blue" disabled={total === 0} onClick={() => void confirm()}>{permsButton(anyOn)}</button>
            <span className="b-en-fine">You can change any of these later in Settings.</span>
          </div>
          <div className="b-en-swaps">
            <button type="button" className="b-en-swap" onClick={() => back?.()}>Back</button>
            <button type="button" className="b-en-swap" onClick={notNow}>{revisiting ? 'Cancel' : 'Not now'}</button>
          </div>
        </div>
      ) : null}

      {stage === 'asking' ? (
        <div className="b-en-asking b-en-pop">
          {current ? (
            // Narration of the system dialog, not a copy of it: the Allow and
            // Don't Allow buttons are macOS's, and the answer is given there.
            <div className="b-en-dialog" role="status" aria-live="polite">
              <span className="b-en-dialog-k">macOS</span>
              <p className="b-en-dialog-t">“Atlas” would like to {askVerb(current.id)}.</p>
              <p className="b-en-dialog-b">{current.blurb}</p>
              <p className="b-en-dialog-wait"><AtlasIcon name="loading" size={14} className="b-en-spin" />Answer in the system dialog — Allow or Don’t Allow.</p>
            </div>
          ) : (
            <p className="b-en-fine b-en-wait"><AtlasIcon name="loading" size={14} className="b-en-spin" />Saving what you chose…</p>
          )}
          {current && queue.length > 1 ? <p className="b-en-fine">{queue.indexOf(current.id) + 1} of {queue.length}</p> : null}
        </div>
      ) : null}

      {stage === 'welcome' && !typing ? (
        <div className="b-en-rows b-en-pop">
          {persisted === 'failed' ? (
            <p className="b-en-notice">This Mac would not let Atlas save your answers, so it will ask again next launch. Nothing you chose is lost for this session.</p>
          ) : null}
          {deniedList.length ? (
            <p className="b-en-notice">
              macOS refused {deniedList.map((p) => p.title.toLowerCase()).join(' and ')}. Atlas cannot grant that for you — System Settings › Privacy &amp; Security is the only place it can change.
            </p>
          ) : null}
          {rows.map((r) => (
            <div key={r.id} className="b-en-sum"><span>{r.title}</span><span className={`b-en-sum-v b-en-sum-v--${r.tone}`}>{r.value}</span></div>
          ))}
          <p className="b-en-fine">
            {total === 0
              ? 'No capabilities were reviewed.'
              : liveCount === 0
                ? 'Nothing is switched on, so Atlas acts only when you ask it to. Every capability is waiting in Settings whenever you want one.'
                : `${liveCount} of ${total} live${persisted === 'ok' ? ' · saved' : ''} — adjust any time in Settings.`}
          </p>
          <div className="b-en-choices">
            <button type="button" className="b-en-btn b-en-btn--ink b-en-cta" onClick={() => navigate('/')}>Enter Atlas →</button>
            <button type="button" className="b-en-swap b-en-cta" onClick={() => back?.()}>Back</button>
          </div>
        </div>
      ) : null}
    </EntryScene>
  );
}

const BetaOnboarding = () => <BetaOnboardingFlow route="onboarding" />;

export default BetaOnboarding;
