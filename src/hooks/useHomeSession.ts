/**
 * The Home session — everything Atlas does the moment Home is on screen,
 * shared by the Workshop dashboard and the Beta Home so the two can never
 * greet differently or disagree about the sphere's state.
 *
 * Lifted out of AtlasDashboard.tsx in the Beta redesign (phase 2), text and
 * reasoning intact:
 *
 *   - the duplex voice loop (`useVoiceSession`): capture, VAD barge-in,
 *     streamed TTS playback
 *   - the greeting gate, stage 1 (WHETHER Atlas speaks) and stage 2 (what it
 *     says, from the brain, with the gate's own reason as the fallback)
 *   - presence: the sphere's state from the voice state, agent runs and the
 *     mute gate, published to the state bus for every sphere and the top bar
 *   - the microphone owner: the Talk panel's mic button asks this session to
 *     start a turn
 *   - the written band: greeting prefix, name, subline, weather meta
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { useUserProfile } from '@/hooks/useUserProfile';
import { useWeather } from '@/hooks/useWeather';
import { useCalendarEvents } from '@/hooks/useCalendarEvents';
import { useVoiceSession } from '@/hooks/useVoiceSession';
import { useAtlasSettings } from '@/hooks/useAtlasSettings';
import { toVoiceSettings } from '@/lib/voiceTuning';
import { useAgentRuns } from '@/hooks/useAgentRuns';
import { useAtlasPresence, type AtlasPresenceState } from '@/hooks/useAtlasPresence';
import { onVoiceRequest, publishAtlasState } from '@/lib/atlasStateBus';
import { isVoiceActive } from '@/lib/presenceBridge';
import { localClient as supabase } from '@/integrations/local/localClient';
import {
  greetingPhrase, collectSalience, shouldGreet, loadGreetingMemo, saveGreetingMemo,
  type GreetingDecision,
} from '@/lib/greetingGate';
import { useStreamingTTS } from '@/hooks/useStreamingTTS';
import { getBrainEndpoint } from '@/lib/brainClient';
import type { BandContent } from '@/pages/atlas/useBandNarration';

export interface HomeSessionOptions {
  /** The Beta Home's "Spoken greeting: Never" setting. Default: speak. */
  spokenGreeting?: boolean;
}

export function useHomeSession({ spokenGreeting = true }: HomeSessionOptions = {}) {
  const navigate = useNavigate();
  const { user, session, loading: authLoading } = useAuth();
  const { profile } = useUserProfile();
  const { weather } = useWeather();
  const { events } = useCalendarEvents();

  // Duplex voice loop via the local gateway (WS-B): capture, VAD barge-in,
  // streamed TTS playback — one hook, same AIState contract as before.
  const { settings: atlasSettings } = useAtlasSettings();
  // The one-shot player for the spoken greeting. Separate from useVoiceSession
  // below, which owns the duplex conversation loop — this only ever speaks at
  // launch, when the loop is idle.
  const { speak } = useStreamingTTS();
  const {
    audioLevel, effectiveAtlasState,
    handleManualActivate, muted, toggleMute,
  } = useVoiceSession({
    voiceId: atlasSettings.voiceId,
    ttsModelId: atlasSettings.ttsModel,
    voiceSettings: toVoiceSettings(atlasSettings),
  });

  // Auth gate (same behaviour as the dashboard has always had).
  useEffect(() => {
    if (!authLoading && !user) navigate('/auth');
  }, [user, authLoading, navigate]);

  const name = profile?.nickname || profile?.first_name || profile?.display_name || 'there';
  // The user's zone, not the machine's. greetingPhrase implements the brain's
  // own time-of-day boundaries, so the written greeting and the spoken one can
  // no longer name different times of day (src/lib/greetingGate.ts explains
  // which clock won and why). Computed inline like the helper it replaces —
  // this is a synchronous string, and the band must never wait for anything.
  const greetingPrefix = `${greetingPhrase(Date.now(), profile?.timezone)}, `;
  const eventCount = events.length;

  // --- The greeting gate (stage 1: WHETHER Atlas speaks) --------------------
  //
  // Two salience sources have no hook on this page: unspoken digest insights
  // and Atlas's own error log. Read once at launch rather than mounting
  // useAtlasHealth/useProactiveAI here — the first would add a 30-second poller
  // to the dashboard for a launch-time decision, and the second CONSUMES the
  // rows it reads (it marks them spoken), which would race the ProactiveInsight
  // banner and swallow insights the user never sees. Mail alerts come along in
  // the same round trip for the same reason.
  const [salienceRows, setSalienceRows] = useState<{
    mailAlerts: Array<{ alert_type?: string; title?: string; created_at?: string }>;
    insights: Array<{ title?: string; priority?: number; created_at?: string }>;
    unresolvedErrors: number;
  } | null>(null);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    void (async () => {
      const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      // `resolved`/`is_spoken` compare against 0, not false: the local shim
      // compares raw SQLite rows where booleans are stored as 0/1, so eq(false)
      // matches nothing (see useProactiveAI's note).
      const [alertsRes, insightsRes, errorsRes] = await Promise.all([
        supabase.from('mail_alerts').select('alert_type, title, created_at')
          .eq('acknowledged', 0).order('created_at', { ascending: false }).limit(20),
        supabase.from('ai_insights').select('title, priority, created_at')
          .eq('user_id', user.id).eq('is_spoken', 0)
          .order('created_at', { ascending: false }).limit(10),
        supabase.from('atlas_error_logs').select('*', { count: 'exact', head: true })
          .gte('created_at', dayAgo).eq('resolved', 0),
      ]);
      if (cancelled) return;
      setSalienceRows({
        mailAlerts: (alertsRes.data as Array<{ alert_type?: string; title?: string; created_at?: string }>) ?? [],
        insights: (insightsRes.data as Array<{ title?: string; priority?: number; created_at?: string }>) ?? [],
        unresolvedErrors: errorsRes.count ?? 0,
      });
    })().catch(() => {
      // A salience read that fails must still let the gate run — the morning
      // greeting does not depend on any of these, and silence caused by an
      // unreadable table would be the worst possible failure mode.
      if (!cancelled) setSalienceRows({ mailAlerts: [], insights: [], unresolvedErrors: 0 });
    });
    return () => { cancelled = true; };
  }, [user]);

  // The decision. Re-evaluated as data lands, and frozen the moment it turns
  // into a yes — so it can only ever go silent → speaking, never back, and the
  // band cannot retract something it already said.
  const [greeting, setGreeting] = useState<GreetingDecision | null>(null);
  /** The brain's generated sentence, once it lands. Null = stage 1 is all we have. */
  const [spokenLine, setSpokenLine] = useState<string | null>(null);

  /**
   * Stage 2 + the voice. The gate has always decided whether to speak, but for
   * a long time nothing called `speak()`, so Atlas never made a sound on its own.
   *
   * `fallback` is the gate's own `reason` — built entirely from real rows, so
   * it is safe to say out loud even if the brain is unreachable. That ordering
   * matters: Atlas would rather say something true and plain than wait for
   * something eloquent that may never come.
   *
   * TTS only works in the PACKAGED app (getVoiceEndpoint returns null outside
   * Tauri), so in the browser this silently does nothing and the written
   * greeting is unaffected.
   */
  const speakGreeting = useCallback(async (fallback: string) => {
    let line = fallback;
    try {
      const brain = await getBrainEndpoint();
      if (brain && session?.access_token) {
        const res = await fetch(`${brain.baseUrl}/greeting`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${session.access_token}`,
            'x-sidecar-token': brain.token,
          },
          body: JSON.stringify({ timeZone: profile?.timezone ?? null }),
        });
        const data = (await res.json().catch(() => null)) as { ok?: boolean; greeting?: string } | null;
        // The endpoint refuses rather than invents — it returns ok:false when it
        // cannot ground the sentence in a real row. Honour that refusal instead
        // of reaching for whatever string came back.
        if (res.ok && data?.ok === true && typeof data.greeting === 'string' && data.greeting.trim()) {
          line = data.greeting.trim();
          setSpokenLine(line);
        }
      }
    } catch {
      /* unreachable brain: keep the deterministic line */
    }
    if (!spokenGreeting) return;
    try {
      await speak(line, undefined, undefined, toVoiceSettings(atlasSettings));
    } catch {
      /* no voice gateway (browser, or gateway down) — the written greeting stands */
    }
  }, [session?.access_token, profile?.timezone, speak, atlasSettings, spokenGreeting]);
  // A ref, not the state above: the latch must not be an effect dependency, or
  // storing the decision would retrigger the effect that produced it.
  const hasSpoken = useRef(false);
  useEffect(() => {
    if (hasSpoken.current) return;
    if (!user || !salienceRows) return;
    const now = Date.now();
    const memo = loadGreetingMemo(user.id);
    const decision = shouldGreet({
      now,
      timeZone: profile?.timezone,
      lastGreetedAt: memo?.at ?? null,
      muted,
      signals: collectSalience({
        now,
        timeZone: profile?.timezone,
        events,
        mailAlerts: salienceRows.mailAlerts,
        insights: salienceRows.insights,
        unresolvedErrors: salienceRows.unresolvedErrors,
        errorsAtLastGreeting: memo?.errorCount ?? null,
      }),
    });
    // Identity-stable: an unchanged decision must not re-render the band.
    setGreeting((prev) => (
      prev && prev.speak === decision.speak && prev.reason === decision.reason ? prev : decision
    ));
    // The memo is written only when Atlas actually opens its mouth. Recording a
    // greeting that never happened would spend the morning on silence.
    if (decision.speak) {
      hasSpoken.current = true;
      saveGreetingMemo({ userId: user.id, at: now, errorCount: salienceRows.unresolvedErrors });
      // STAGE 2, and the moment Atlas actually opens its mouth.
      //
      // Fired here rather than in its own effect because this is the ONE place
      // that knows the gate just said yes AND has already latched, so it cannot
      // run twice. Deliberately not awaited: the band is already rendered from
      // `decision.reason`, and blocking first paint on a network call is the
      // thing the two-stage design exists to avoid. The generated sentence
      // swaps in when it arrives, or never — either way the screen is correct.
      void speakGreeting(decision.reason);
    }
  }, [user, salienceRows, profile?.timezone, muted, events, speakGreeting]);

  // Home-state band content. When the gate says nothing needs saying, this is
  // exactly the band that shipped: greeting, calendar count, weather. When it
  // says something does, the subline carries the reason — which, until the
  // brain's generated sentence lands, IS what Atlas has to say, built from
  // real rows.
  const home = useMemo<BandContent>(() => ({
    lead: greetingPrefix,
    accent: `${name}.`,
    subline: greeting?.speak
      ? (spokenLine ?? greeting.reason)
      : [
        eventCount > 0 ? `${eventCount} ${eventCount === 1 ? 'event' : 'events'} today` : 'Nothing on your calendar',
        `${weather.location} · ${weather.condition}`,
      ].join(' · '),
    metaBig: `${Math.round(weather.temp)}°`,
    metaSmall: `${weather.location} · ${weather.condition}`,
  }), [greetingPrefix, name, greeting, spokenLine, eventCount, weather.location, weather.condition, weather.temp]);

  // Sphere presence: four of the six previously-dead states have real
  // triggers. `working` from an executing run, `success` from one that just
  // finished, `alert` from one that failed, `muted` from the mic gate.
  const { runs, activeRun } = useAgentRuns(10);
  const lastDone = useMemo(() => {
    const done = runs.filter((r) => r.status === 'completed' && r.finished_at);
    return done.length ? Date.parse(done[0].finished_at as string) : null;
  }, [runs]);
  const lastFault = useMemo(() => {
    const failed = runs.filter((r) => r.status === 'failed' && r.finished_at);
    return failed.length ? Date.parse(failed[0].finished_at as string) : null;
  }, [runs]);
  const presence: AtlasPresenceState = useAtlasPresence({
    voiceState: effectiveAtlasState,
    muted,
    runActive: !!activeRun,
    runCompletedAt: lastDone,
    faultAt: lastFault,
  });

  // The one thing in the Workshop app allowed to be orange.
  const voiceOn = isVoiceActive(presence);

  // The state bus: every sphere, the Beta top bar and the Talk panel read
  // Atlas's state from it, and this is where the real signals (voice gateway,
  // agent runs, mute) enter. The Talk panel's mic button asks this screen to
  // start a turn through the same bus.
  useEffect(() => { publishAtlasState(presence, 'presence'); }, [presence]);
  useEffect(() => onVoiceRequest(handleManualActivate), [handleManualActivate]);

  return {
    user, session, profile, weather, events, name,
    greetingPrefix, greeting, spokenLine, home,
    presence, voiceOn, effectiveAtlasState, audioLevel,
    muted, toggleMute, handleManualActivate,
  };
}

export type HomeSession = ReturnType<typeof useHomeSession>;
