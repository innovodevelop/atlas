// The capabilities Atlas asks for, and the honest description of each.
//
// EVERY string here is read by a user deciding what to allow, so each claim is
// grounded in what the code actually does — checked against:
//   - mic:           src/hooks/useVoiceSession.ts (navigator.mediaDevices.getUserMedia)
//   - notifications: @tauri-apps/plugin-notification (mail alerts, proactive insights)
//   - live data:     src-tauri/src/datafetch.rs (weather / stocks / news)
//   - reasoning:     src-tauri/src/lib.rs spawn_atlas_brain + _shared/aiGateway.ts
//   - proactive:     src-tauri/src/scheduler.rs (ticks the brain's /proactive/cycle)
//
// The reasoning entry deliberately does NOT say "everything stays on your Mac".
// That would be false: chat turns (which carry the web-search tool) go to
// Anthropic in the US, and background work goes to Amazon Bedrock in the EU.
// Your memories and files stay local; the prompts derived from them do not.

export type PermissionId = 'microphone' | 'notifications' | 'liveData' | 'proactive';

export interface AtlasPermission {
  id: PermissionId;
  /** Short label, sentence case — this is a name, not a heading. */
  title: string;
  /** One line, Atlas's voice, describing what it UNLOCKS (not what it takes). */
  blurb: string;
  /** What genuinely stops working if it stays off. Honest, not a scare tactic. */
  withoutIt: string;
  /** Whether macOS itself will show a prompt when this is switched on. */
  osPrompt: boolean;
  /** Optional capabilities default OFF — the privacy-respecting default. */
  defaultOn: boolean;
}

export const ATLAS_PERMISSIONS: AtlasPermission[] = [
  {
    id: 'microphone',
    title: 'Microphone',
    blurb: 'So we can just talk, instead of you typing everything.',
    withoutIt: 'Voice conversations are unavailable. Typing works exactly as well.',
    osPrompt: true,
    defaultOn: true,
  },
  {
    id: 'notifications',
    title: 'Notifications',
    blurb: 'So I can tell you when something actually matters — not for the sake of it.',
    withoutIt: 'Alerts appear inside Atlas only, when you open it.',
    osPrompt: true,
    defaultOn: true,
  },
  {
    id: 'liveData',
    title: 'Live data',
    blurb: 'Weather, markets and news on your dashboard, fetched as you look at them.',
    withoutIt: 'Those cards stay empty. Nothing else changes.',
    osPrompt: false,
    defaultOn: true,
  },
  {
    id: 'proactive',
    title: 'Proactive digest',
    blurb:
      'I look over your recent notes and days on a schedule and surface what seems worth your attention.',
    withoutIt: 'I only ever respond when you ask. Nothing runs on its own.',
    osPrompt: false,
    // Deliberately OFF by default: this is the one capability that acts without
    // you asking, and it sends a summary of recent memories for reasoning.
    defaultOn: false,
  },
];

/** localStorage key: the record that onboarding has been answered. */
export const ONBOARDING_KEY = 'atlas.onboarding.v1';

export interface OnboardingRecord {
  completedAt: string;
  choices: Record<PermissionId, boolean>;
}

export function readOnboarding(): OnboardingRecord | null {
  try {
    const raw = localStorage.getItem(ONBOARDING_KEY);
    return raw ? (JSON.parse(raw) as OnboardingRecord) : null;
  } catch {
    return null;
  }
}

export function writeOnboarding(choices: Record<PermissionId, boolean>) {
  try {
    localStorage.setItem(
      ONBOARDING_KEY,
      JSON.stringify({ completedAt: new Date().toISOString(), choices }),
    );
  } catch {
    /* a full/blocked localStorage must not break the flow — worst case we ask again */
  }
}

/**
 * The microphone answer, recorded on its own.
 *
 * DELIBERATELY NOT part of `OnboardingRecord`. The onboarding gate is a
 * presence check — `Auth.tsx` sends you to `/permissions` when `readOnboarding()`
 * returns null — so writing a partial record from the sign-in screen would skip
 * the consent screen entirely and silently default the other three capabilities
 * to whatever happened to be in the object. The mic is now asked for earlier
 * than the rest, so it needs somewhere of its own to be remembered.
 *
 * `granted: false` is worth storing too: it means the user was asked and said
 * no (or macOS did), which is why `/permissions` can show the switch off with
 * "not granted" instead of cheerfully defaulting it back on.
 */
export const MIC_CONSENT_KEY = 'atlas.mic.v1';

export interface MicConsent {
  askedAt: string;
  granted: boolean;
}

export function readMicConsent(): MicConsent | null {
  try {
    const raw = localStorage.getItem(MIC_CONSENT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<MicConsent>;
    // A hand-edited or half-written value must read as "never asked" rather
    // than as a grant — the safe direction for a microphone.
    return typeof parsed?.granted === 'boolean'
      ? { askedAt: String(parsed.askedAt ?? ''), granted: parsed.granted }
      : null;
  } catch {
    return null;
  }
}

export function writeMicConsent(granted: boolean): void {
  try {
    localStorage.setItem(
      MIC_CONSENT_KEY,
      JSON.stringify({ askedAt: new Date().toISOString(), granted }),
    );
  } catch {
    /* a full/blocked localStorage costs us a second ask, nothing more */
  }
}

/**
 * Trigger the REAL OS prompt for a capability. Returns whether it ended up
 * granted. Never reports success it did not observe: an unavailable API returns
 * false rather than pretending, so the UI cannot show a granted state that
 * macOS does not agree with.
 */
export async function requestPermission(id: PermissionId): Promise<boolean> {
  if (id === 'microphone') {
    // The ONE place the mic is asked for, so it is also the one place the
    // answer is recorded — the sign-in screen and this screen can't drift.
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // We only wanted the grant — release the device immediately so no
      // recording indicator lingers after onboarding.
      stream.getTracks().forEach((t) => t.stop());
      writeMicConsent(true);
      return true;
    } catch {
      writeMicConsent(false);
      return false;
    }
  }

  if (id === 'notifications') {
    try {
      const { isPermissionGranted, requestPermission: ask } = await import(
        '@tauri-apps/plugin-notification'
      );
      if (await isPermissionGranted()) return true;
      return (await ask()) === 'granted';
    } catch {
      // Plain web (dev server) has no Tauri plugin — fall back to the web API.
      try {
        if (typeof Notification === 'undefined') return false;
        return (await Notification.requestPermission()) === 'granted';
      } catch {
        return false;
      }
    }
  }

  // liveData and proactive are app-side switches, not OS grants — honouring
  // them is the app's job, so there is nothing to ask the system for.
  return true;
}
