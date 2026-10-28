/**
 * The Beta Entry screens' decisions — sign in, sign up, forgot password and
 * the onboarding flow (`Atlas Entry Beta.dc.html`) — pure and tested here,
 * rendered by BetaAuth.tsx and BetaOnboarding.tsx.
 *
 * Everything a test should be able to pin without React lives here: the order
 * of the credential questions, Atlas's line for each, what counts as a usable
 * answer, which words the status line may claim, and the summary the welcome
 * step draws from the consent record. The screens only hold state and call
 * the auth client.
 */
import type { PermissionId } from '@/lib/atlasPermissions';

/* ---- sign in / sign up ------------------------------------------------- */

export type EntryMode = 'signin' | 'signup';
export type FieldKey = 'name' | 'email' | 'password';
/**
 * `forgot` collects an address and asks for a reset link; `sent` is its
 * deliberately ambiguous acknowledgement. `done` is a sign-in that stuck.
 */
export type AuthStage = 'start' | 'field' | 'forgot' | 'sent' | 'done';

export const FIELD_ORDER: Record<EntryMode, readonly FieldKey[]> = {
  signin: ['email', 'password'],
  signup: ['name', 'email', 'password'],
};

export const PLACEHOLDER: Record<FieldKey, string> = {
  email: 'your email',
  password: 'password',
  name: 'your first name',
};

export const GREETING = 'Hey, I’m Atlas. Have we met before?';

/** The longest name kept: enough for any real one, short enough for a headline. */
export const MAX_NAME = 40;

/**
 * What to call someone, from their answer to "What should I call you?".
 *
 * The whole answer, not its first word: the question asks what to call
 * them, so "Mads Peter" is the answer and "Mads" would be Atlas deciding
 * otherwise. Only the noise goes — runs of whitespace, and the full stop
 * dictation leaves at the end of a sentence.
 */
export function callName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').replace(/[.,!?;:]+$/, '').slice(0, MAX_NAME).trim();
}

/** Atlas's question for a credential, in the design's words. */
export function promptFor(mode: EntryMode, key: FieldKey, name: string): string {
  if (mode === 'signin') return key === 'email' ? 'Welcome back. What’s your email?' : 'And your password?';
  if (key === 'name') return 'Lovely. What should I call you?';
  if (key === 'email') {
    const n = callName(name);
    return `Nice to meet you${n ? `, ${n}` : ''}. What’s your email?`;
  }
  return 'Now pick a password to keep it safe.';
}

export const EMAIL_RE = /^\S+@\S+\.\S+$/;
export const MIN_PASSWORD = 8;

/**
 * What stops an answer from being sent. Returns the error line, or null.
 *
 * Only the checks the design makes: empty, the shape of an email, and a new
 * password shorter than eight characters. A sign-in password is never
 * length-checked — the account decides, not this screen.
 */
export function validateField(key: FieldKey, value: string, mode: EntryMode): string | null {
  const v = value.trim();
  if (!v) return 'This one can’t be empty.';
  if (key === 'email' && !EMAIL_RE.test(v)) return 'That doesn’t look like an email address.';
  if (key === 'password' && mode === 'signup' && v.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  return null;
}

export function fieldType(key: FieldKey): 'password' | 'email' | 'text' {
  return key === 'password' ? 'password' : key === 'email' ? 'email' : 'text';
}

export function autocompleteFor(key: FieldKey, mode: EntryMode): string {
  if (key === 'password') return mode === 'signin' ? 'current-password' : 'new-password';
  return key === 'name' ? 'given-name' : 'email';
}

/** The label on the pill's action button. */
export function nextLabel(stage: 'field' | 'forgot', key: FieldKey, mode: EntryMode, submitting: boolean): string {
  if (submitting) return stage === 'forgot' ? 'Sending…' : 'One moment…';
  if (stage === 'forgot') return 'Send me a link →';
  if (key === 'password') return mode === 'signin' ? 'Sign in' : 'Create account';
  return 'Next';
}

/**
 * What Atlas says about a refused attempt.
 *
 * The account server answers "Invalid email or password." for both a wrong
 * address and a wrong password, deliberately (telling them apart is how an
 * attacker learns which emails have accounts), so the sign-in line blames
 * neither. An unreachable server is not a rejected credential, and saying
 * "that didn't match" about our own outage would blame the user for it. A
 * refused sign-up had nothing to match against at all, so it points at the
 * server's own reason, which is shown under the field.
 */
export function spokenForAuthError(error: string, mode: EntryMode = 'signin'): string {
  if (/reach the account server/i.test(error)) return 'I couldn’t reach the account server. Want to try again?';
  if (mode === 'signup') return 'I couldn’t create that account. The reason is just below.';
  return 'That didn’t match what I have. Want to try again?';
}

/**
 * Where a signed-in user goes next: consent first on a Mac that has never
 * answered it (the record is per Mac, not per account), Home otherwise.
 */
export function afterSignInPath(onboarded: boolean): '/' | '/permissions' {
  return onboarded ? '/' : '/permissions';
}

/** The last button of a sign-in says where it goes. */
export function enterLabel(onboarded: boolean): string {
  return onboarded ? 'Enter Atlas →' : 'Continue →';
}

/** Answers already given, shown as chips while the next one is typed (sign-up only). */
export function trailFor(mode: EntryMode, key: FieldKey, vals: Record<FieldKey, string>): Array<{ k: string; v: string }> {
  if (mode !== 'signup' || key === 'name') return [];
  const out: Array<{ k: string; v: string }> = [];
  const name = callName(vals.name);
  if (name) out.push({ k: 'Name', v: name });
  if (key === 'password' && vals.email.trim()) out.push({ k: 'Email', v: vals.email.trim() });
  return out;
}

/**
 * THE RULE: never listen while a password is on screen.
 *
 * Transcription is not local — audio goes to ElevenLabs (useLoginVoice). The
 * microphone control only exists in the answer pill, so the opening choice
 * and the two closing stages have nothing to listen for either.
 */
export function micAllowed(stage: AuthStage, key: FieldKey | null): boolean {
  if (stage === 'forgot') return true;
  return stage === 'field' && key !== null && key !== 'password';
}

export type MicState = 'off' | 'starting' | 'listening' | 'denied' | 'unavailable';

/**
 * The status line under the headline. Each branch is a claim the code can
 * back — the Workshop screen used to say "speak to me" on steps where
 * nothing was listening, and this exists so that cannot happen again.
 */
export function authSubline(stage: AuthStage, micBlocked: boolean, mic: MicState): string {
  switch (stage) {
    case 'done': return 'Everything is ready.';
    case 'sent': return 'Check your inbox.';
    case 'start': return 'Tell me where to begin.';
    default: break;
  }
  if (micBlocked) return 'Type this one. I stop listening for passwords.';
  switch (mic) {
    case 'listening': return 'I’m listening, or just type.';
    case 'starting': return 'One moment — turning the microphone on.';
    case 'denied': return 'No microphone, no problem. Typing works just as well.';
    // Distinct from `denied` on purpose: this one is OUR fault (no sidecar,
    // or the token mint failed), and "no problem" about our own failure
    // would be the app shrugging at its own bug.
    case 'unavailable': return 'I can’t hear you right now — please type instead.';
    default: return 'Type it, or tap the microphone.';
  }
}

export function authEyebrow(stage: AuthStage, mode: EntryMode | null): string {
  if (stage === 'start') return 'Atlas';
  if (mode === 'signup' && stage === 'field') return 'Create your account';
  return 'Sign in';
}

/**
 * The sphere on the sign-in screen, from what is actually happening.
 *
 * The design shows `speaking` while a line types, but only with its voice
 * switched on. Here `speaking` is the voice actually playing (the Voice pill
 * on and audio coming out), never a line merely typing — a typed line is not
 * Atlas speaking and the sphere does not pretend it is. Listening is the open
 * microphone, thinking is the account server answering, and otherwise the
 * sphere follows the state bus (undefined).
 */
export function authSphereState(micListening: boolean, submitting: boolean, speaking = false): 'listening' | 'thinking' | 'speaking' | undefined {
  if (micListening) return 'listening';
  if (submitting) return 'thinking';
  if (speaking) return 'speaking';
  return undefined;
}

/**
 * THE OTHER RULE: Atlas never speaks on the password step.
 *
 * Its question there ("And your password?"), and anything it says about a
 * refused password, stays typed even with the Voice pill on — the step is the
 * one where a voice in the room tells everyone nearby what the person is
 * about to type. The microphone rule is `micAllowed`; this is its twin for
 * the speaker.
 */
export function lineSpeakable(stage: AuthStage, key: FieldKey | null): boolean {
  return !(stage === 'field' && key === 'password');
}

/* ---- the typewriter --------------------------------------------------- */

/** Characters per tick and the tick, from the design's `say()`. */
export const TYPE_STEP = 2;
export const TYPE_MS = 28;

/** How much of a line is on screen after `tick` ticks. */
export function typedLength(total: number, tick: number, step = TYPE_STEP): number {
  return Math.max(0, Math.min(total, tick * step));
}

/* ---- onboarding -------------------------------------------------------- */

export type OnboardingStage = 'intro' | 'perms' | 'asking' | 'welcome';

export const ONBOARDING_STEPS = ['Intro', 'Permissions', 'Welcome'] as const;

export function stepIndex(stage: OnboardingStage): number {
  return stage === 'intro' ? 0 : stage === 'welcome' ? 2 : 1;
}

/**
 * The onboarding sphere: working while macOS is being asked (a real call is
 * in flight), speaking while the voice actually plays, the state bus
 * otherwise. Not `speaking` merely because a line types (see authSphereState).
 */
export function onboardingSphereState(stage: OnboardingStage, speaking = false): 'working' | 'speaking' | undefined {
  if (stage === 'asking') return 'working';
  return speaking ? 'speaking' : undefined;
}

const WORDS = ['none', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

/** Small counts as words, the way the design writes them ("Three things"). */
export function countWord(n: number, capital = false): string {
  const w = n >= 0 && n < WORDS.length ? WORDS[n] : String(n);
  return capital ? w.charAt(0).toUpperCase() + w.slice(1) : w;
}

/**
 * "Two of these make macOS ask you. Two are just Atlas settings." — but
 * counted from the real capability list, so the sentence stays true if the
 * list changes.
 */
export function permsSubline(osCount: number, total: number): string {
  const app = Math.max(0, total - osCount);
  const os = osCount === 0
    ? 'None of these need macOS.'
    : osCount === 1
      ? 'One of these makes macOS ask you.'
      : `${countWord(osCount, true)} of these make macOS ask you.`;
  if (app === 0) return os;
  const rest = app === 1 ? 'One is just an Atlas setting.' : `${countWord(app, true)} are just Atlas settings.`;
  return `${os} ${rest}`;
}

/** The intro's third row: who asks for what. */
export function introAskLine(osCount: number): string {
  if (osCount === 0) return 'Nothing here needs macOS’s permission — these are all Atlas settings.';
  if (osCount === 1) return 'macOS asks you itself for the one that needs its permission.';
  return `macOS asks you itself for the ${countWord(osCount)} that need its permission.`;
}

/**
 * What the system dialog will say, so the screen can narrate it. Only the
 * two capabilities that really produce a macOS prompt have a verb; the
 * others never reach the system, so they never show the card.
 */
export function askVerb(id: PermissionId): string {
  if (id === 'microphone') return 'access the microphone';
  if (id === 'notifications') return 'send you notifications';
  return '';
}

export function welcomeLine(name: string | null | undefined): string {
  const n = callName(name ?? '');
  return `Welcome${n ? `, ${n}` : ''}. I’m ready when you are.`;
}

export function permsButton(anyOn: boolean): string {
  return anyOn ? 'Continue' : 'Continue without any';
}

export type SummaryTone = 'on' | 'off' | 'denied';

export interface SummaryRow {
  id: PermissionId;
  title: string;
  value: string;
  tone: SummaryTone;
}

/**
 * The welcome step's rows. "Declined in macOS" is only ever written from a
 * real refusal (`granted[id] === false`), never inferred.
 */
export function summaryRows(
  perms: ReadonlyArray<{ id: PermissionId; title: string; osPrompt: boolean }>,
  choices: Partial<Record<PermissionId, boolean>>,
  granted: Partial<Record<PermissionId, boolean>>,
): SummaryRow[] {
  return perms.map((p) => {
    const on = !!choices[p.id];
    const denied = p.osPrompt && on && granted[p.id] === false;
    return {
      id: p.id,
      title: p.title,
      value: denied ? 'Declined in macOS' : on ? 'On' : 'Off',
      tone: denied ? 'denied' : on ? 'on' : 'off',
    };
  });
}
