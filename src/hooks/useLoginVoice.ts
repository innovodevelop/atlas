/**
 * Voice INPUT on the sign-in screen — the half that was missing when Atlas
 * started speaking there.
 *
 * Why it can exist before an account: the gateway's `/scribe-token` route is
 * guarded by the per-launch SIDECAR_TOKEN only (voice-gateway/src/index.ts:162),
 * exactly like `/tts`. The duplex `/ws` path is the one that demands an account
 * JWT (`hello` → decodeJwt), which is why `useVoiceSession` stays dormant when
 * signed out and cannot be reused here.
 *
 * ── The rule this hook exists to enforce ──────────────────────────────────
 * Transcription is NOT local. Audio goes to ElevenLabs' realtime scribe. A
 * sign-in screen collects a password, so "listen to whatever the user says on
 * this screen" would mean streaming someone's password to a third party — the
 * single worst place in the product to be careless with a microphone.
 *
 * So listening is gated by `allowed`, the caller passes false on the password
 * step, and this hook treats a revoked `allowed` as an immediate hard stop
 * rather than as a request to stop soon. `loginVoice.test.ts` pins the caller's
 * side of that; the effect below pins this side.
 *
 * The microphone grant is captured HERE, on a click, with Atlas having just
 * said what it is for — which is the whole point of moving consent into the
 * login flow. `requestPermission('microphone')` is reused rather than calling
 * getUserMedia directly, so the answer lands in the same consent record that
 * `/permissions` reads and nothing has to remember to write it twice.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useScribe, type CommitStrategy } from '@elevenlabs/react';
import { getVoiceEndpoint } from '@/lib/voiceClient';
import { requestPermission } from '@/lib/atlasPermissions';

export type LoginVoiceState =
  /** Never switched on. The mic is untouched. */
  | 'off'
  /** Waiting on the OS prompt / the gateway. */
  | 'starting'
  /** Connected and transcribing. */
  | 'listening'
  /** The user or macOS said no. Typing still works; we do not nag. */
  | 'denied'
  /** No gateway (browser preview) or the token mint failed. */
  | 'unavailable';

export interface UseLoginVoiceResult {
  state: LoginVoiceState;
  /** Live text while the user is mid-sentence — render it, don't submit it. */
  partial: string;
  /** Ask for the mic (first time) and start listening. Safe to call twice. */
  enable: () => Promise<void>;
  /** Stop listening and release the microphone. */
  disable: () => void;
}

export function useLoginVoice(opts: {
  /**
   * Whether this step may be listened to at all. FALSE ON THE PASSWORD STEP —
   * see the header. Flipping this to false stops capture immediately.
   */
  allowed: boolean;
  /** A completed utterance. Called only while `allowed` was true. */
  onTranscript: (text: string) => void;
}): UseLoginVoiceResult {
  const [state, setState] = useState<LoginVoiceState>('off');
  const [partial, setPartial] = useState('');

  // The caller re-creates `onTranscript` on most renders; reading it from a ref
  // keeps `enable`/`disable` identity-stable so the guard effect below fires on
  // `allowed` changing and nothing else.
  const optsRef = useRef(opts);
  optsRef.current = opts;

  // Whether the user has ever switched voice input on. Survives step changes,
  // so moving off the password field resumes listening instead of making the
  // user click the microphone again for every question.
  const wantedRef = useRef(false);

  const scribe = useScribe({
    modelId: 'scribe_v2_realtime',
    commitStrategy: 'vad' as CommitStrategy,
    languageCode: 'en',
    onPartialTranscript: (data) => {
      if (!optsRef.current.allowed) return;
      setPartial(data.text ?? '');
    },
    onCommittedTranscript: (data) => {
      // Belt and braces with the effect below: a final transcript can land in
      // the same tick as the step changing to `password`, and it must not be
      // delivered to a field that is now a secret.
      if (!optsRef.current.allowed) return;
      const text = (data.text ?? '').trim();
      setPartial('');
      if (text) optsRef.current.onTranscript(text);
    },
  });

  const scribeRef = useRef(scribe);
  scribeRef.current = scribe;

  const disable = useCallback(() => {
    wantedRef.current = false;
    setPartial('');
    try {
      scribeRef.current.disconnect();
    } catch {
      /* already gone */
    }
    setState((s) => (s === 'listening' || s === 'starting' ? 'off' : s));
  }, []);

  const enable = useCallback(async () => {
    if (!optsRef.current.allowed) return;
    if (scribeRef.current.isConnected) return;
    wantedRef.current = true;
    setState('starting');

    // 1. Consent. This is the OS prompt, fired from a click, moments after
    //    Atlas explained out loud what it wants the microphone for.
    const granted = await requestPermission('microphone');
    if (!granted) {
      wantedRef.current = false;
      setState('denied');
      return;
    }

    // 2. A single-use scribe token from the local gateway.
    const voice = await getVoiceEndpoint();
    if (!voice) {
      // Browser preview: no sidecar, so no transcription. The mic grant we just
      // collected is still real and still recorded — it is the part that has to
      // survive to the dashboard.
      wantedRef.current = false;
      setState('unavailable');
      return;
    }
    try {
      const res = await fetch(`${voice.baseUrl}/scribe-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-sidecar-token': voice.token },
        body: JSON.stringify({}),
      });
      const data = (await res.json().catch(() => null)) as { token?: string } | null;
      if (!res.ok || !data?.token) throw new Error('no token');

      // The step can have changed to `password` while we were awaiting the OS
      // prompt and two network round-trips. Check again before opening a
      // microphone stream — this is the race the `allowed` flag exists for.
      if (!optsRef.current.allowed || !wantedRef.current) {
        setState('off');
        return;
      }

      await scribeRef.current.connect({
        token: data.token,
        microphone: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      setState(scribeRef.current.isConnected ? 'listening' : 'unavailable');
    } catch {
      wantedRef.current = false;
      setState('unavailable');
    }
  }, []);

  /**
   * The hard stop. When the conversation reaches the password step, capture
   * ends in the same commit that renders the field — not after a round-trip,
   * not "on the next transcript".
   */
  useEffect(() => {
    if (opts.allowed) return;
    setPartial('');
    try {
      scribeRef.current.disconnect();
    } catch {
      /* not connected */
    }
    // `wantedRef` is deliberately untouched: the user still wants voice, this
    // one step just refuses to use it. `resume` below picks it back up.
    setState((s) => (s === 'listening' || s === 'starting' ? 'off' : s));
  }, [opts.allowed]);

  /** Coming off the password step: resume if the user had switched voice on. */
  useEffect(() => {
    if (!opts.allowed || !wantedRef.current || scribeRef.current.isConnected) return;
    void enable();
  }, [opts.allowed, enable]);

  // Never leave a microphone open behind a navigation.
  useEffect(() => () => {
    try {
      scribeRef.current.disconnect();
    } catch {
      /* not connected */
    }
  }, []);

  return { state, partial, enable, disable };
}
