/**
 * Turning what the sign-in screen HEARD into what it should do.
 *
 * Pure, and extracted from Auth.tsx for the reason the rest of this codebase
 * extracts pure functions (see greetingGate.ts, resolvePresence): the component
 * cannot be imported by a test without dragging in React, the router and the
 * ElevenLabs client, and these two decisions are exactly the part worth pinning.
 *
 * Neither function submits anything. A transcript is a guess; both results land
 * in a visible field the user still has to confirm.
 */

export type LoginIntent = 'signin' | 'signup';

/**
 * A spoken answer to "Have we met before?".
 *
 * NO is tested FIRST on purpose: "no, we're just meeting" and "yes, we've met"
 * both contain "met", so a yes-first order sends new users to a sign-in form
 * that can only ever reject them — and the failure reads as a broken account
 * rather than as a misheard answer.
 *
 * Anything unrecognised returns null, and the screen says it didn't catch that
 * rather than picking a branch. Guessing is worse than asking here: the two
 * branches lead to different forms.
 */
const NO_RE = /\b(no|nope|nah|new|never|first|just meeting|sign ?up|register|create)\b/i;
const YES_RE = /\b(yes|yeah|yep|yup|we have|we've met|met|before|sign ?in|log ?in|login)\b/i;

export function intentFromSpeech(text: string): LoginIntent | null {
  if (NO_RE.test(text)) return 'signup';
  if (YES_RE.test(text)) return 'signin';
  return null;
}

/**
 * A dictated email address.
 *
 * Best-effort by nature — transcription returns prose, and people say "at" and
 * "dot" — so the result goes into a visible, editable field and is never
 * submitted on the user's behalf. Both shapes are handled because the model
 * often punctuates an address correctly on its own.
 */
export function emailFromSpeech(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+at\s+/g, '@')
    .replace(/\s+dot\s+/g, '.')
    .replace(/\s+underscore\s+/g, '_')
    .replace(/\s+(?:dash|hyphen|minus)\s+/g, '-')
    .replace(/\s+/g, '')
    .replace(/[.,!?;:]+$/, '');
}
