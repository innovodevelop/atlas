/**
 * Whether Atlas speaks out loud on the pre-account screens.
 *
 * Lives here rather than in the profile because the screens that need it — the
 * sign-in conversation and the consent screen that follows it — both run before
 * there is an account to hang a setting on. It is one key, read by both, so a
 * user who silences Atlas while typing their password does not get spoken at
 * again ten seconds later on the permissions screen.
 *
 * Default ON: Atlas is a voice-first product and the first screens are where
 * that should be true rather than promised. It is still a SETTING, because
 * these screens also run in shared offices, and a laptop announcing "And your
 * password?" out loud is a good way to make somebody close the app.
 */
const KEY = 'atlas-auth-voice';

export function isVoiceOn(): boolean {
  try {
    return localStorage.getItem(KEY) !== 'off';
  } catch {
    // Private mode / blocked storage: fall back to the default rather than to
    // silence, so the product's default behaviour doesn't depend on quota.
    return true;
  }
}

export function setVoiceOn(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off');
  } catch {
    /* the choice won't survive a relaunch; it still applies to this session */
  }
}
