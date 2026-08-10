import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Cpu, Mail, Mic, MicOff, Sparkles, Settings, Home, CornerUpLeft } from 'lucide-react';
import { Dock, type DockItem } from '@/components/atlas-ui/primitives';
import { useAuth } from '@/hooks/useAuth';
import { useUserProfile } from '@/hooks/useUserProfile';
import { useWeather } from '@/hooks/useWeather';
import { useCalendarEvents } from '@/hooks/useCalendarEvents';
import { useUnifiedChat } from '@/hooks/useUnifiedChat';
import { useVoiceSession } from '@/hooks/useVoiceSession';
import { useAtlasSettings } from '@/hooks/useAtlasSettings';
import { toVoiceSettings } from '@/lib/voiceTuning';
import { useAgentRuns } from '@/hooks/useAgentRuns';
import { useAtlasPresence } from '@/hooks/useAtlasPresence';
import { presenceLabel, isVoiceActive } from '@/lib/presenceBridge';
import { getActiveWakePhrases } from '@/lib/wakeWord';
import { AtlasSphereCanvas } from '@/components/atlas-ui/AtlasSphereCanvas';
import { localClient as supabase } from '@/integrations/local/localClient';
import {
  greetingPhrase, collectSalience, shouldGreet, loadGreetingMemo, saveGreetingMemo,
  type GreetingDecision,
} from '@/lib/greetingGate';
import { useBandNarration, type BandContent } from './useBandNarration';
import { useStreamingTTS } from '@/hooks/useStreamingTTS';
import { getBrainEndpoint } from '@/lib/brainClient';
import {
  AtlasWeatherCard, AtlasCalendarCard, AtlasTasksCard,
  AtlasStocksCard, AtlasInboxCard, AtlasBriefingCard,
} from '@/components/atlas-ui/AtlasCards';
import { ProactiveInsight } from '@/components/atlas-ui/ProactiveInsight';
import {
  AtlasAirQualityCard, AtlasNowPlayingCard, AtlasActivityCard, AtlasWorldClockCard,
} from '@/components/atlas-ui/AtlasExtraCards';
import { AtmosphereCanvas } from '@/components/atlas-ui/AtmosphereCanvas';
import { AtlasDrawer } from '@/components/atlas-ui/AtlasDrawer';
import { AtlasExpanded } from '@/components/atlas-ui/AtlasExpanded';
import { AtlasSettings, type SettingsTab } from './AtlasSettings';
import { useAccountDockItem } from '@/components/atlas-ui/useAccountDockItem';

/**
 * Registration data. Mirrored in `src/surfaces.ts`, which is what the router,
 * the dock and the account menu are built from; `surfaces.test.ts` fails if the
 * two ever disagree.
 *
 * The registry entry carries `aliases: ['/dashboard']` — one page, two paths —
 * and `eager: true`: this is the default route, so it must not depend on a
 * runtime chunk fetch that could fail in the webview and leave a blank window.
 */
export const surface = {
  path: '/',
  label: 'Dashboard',
  icon: 'Home',
  entry: 'dock' as const,
  mock: false,
  edition: 'consumer' as const,
};

export type AtlasExpandedKey = 'weather' | 'calendar' | 'tasks' | 'stocks' | 'email' | 'news' | 'music' | null;

/**
 * Run `commit` after `ms` — but never later than the user's next sign of life.
 *
 * A plain setTimeout is not safe for anything that gates interaction. WKWebView
 * throttles timers hard when the window is not key, so a transition that
 * disables pointer events "for 340ms" can stay disabled indefinitely if the
 * user switches away and back. That is exactly how the dashboard ended up
 * scrollable but completely unclickable.
 *
 * So we race the timer against the first pointer/key/focus/visibility event
 * that arrives once the duration has actually elapsed (wall-clock, not timer
 * ticks). Whichever fires first commits, once.
 */
function commitAfter(ms: number, commit: () => void): void {
  const start = Date.now();
  const WAKE = ['pointerdown', 'keydown', 'focus', 'visibilitychange'] as const;
  let done = false;

  const finish = () => {
    if (done) return;
    done = true;
    window.clearTimeout(timer);
    WAKE.forEach((e) => window.removeEventListener(e, onWake, true));
    commit();
  };
  // Only rescue AFTER the animation would have finished, so an early click
  // during the transition does not cut the motion short.
  const onWake = () => { if (Date.now() - start >= ms) finish(); };

  const timer = window.setTimeout(finish, ms);
  WAKE.forEach((e) => window.addEventListener(e, onWake, true));
}

const AtlasDashboard = () => {
  const navigate = useNavigate();
  const { user, session, loading: authLoading } = useAuth();
  const { profile } = useUserProfile();
  const { weather } = useWeather();
  const { events } = useCalendarEvents();

  const [drawerOpen, setDrawerOpen] = useState(false);
  // Full-screen widget system: the header + band stay mounted; only the grid
  // region swaps to the focused widget. `gridFolding` runs the staggered
  // fold-out before the focused view mounts; `viewExiting` runs the reverse.
  const [expanded, setExpanded] = useState<AtlasExpandedKey>(null);
  // Lets the account menu deep-link straight to Memory & Privacy, which
  // owns the account-deletion flow the privacy policy points users at.
  const [settingsTab, setSettingsTab] = useState<SettingsTab | undefined>();
  const [gridFolding, setGridFolding] = useState(false);
  const [viewExiting, setViewExiting] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [input, setInput] = useState('');

  // Text chat (drawer). Speech is entirely the gateway session's job now.
  const { messages, isLoading, sendMessage } = useUnifiedChat({
    enableMemory: true,
  });

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

  // Auth gate (same behavior as the current dashboard)
  useEffect(() => {
    if (!authLoading && !user) navigate('/auth');
  }, [user, authLoading, navigate]);

  // Open a widget: fold the grid up into Atlas, then mount the focused view.
  //
  // commitAfter, not a bare setTimeout. Both of these transitions disable
  // interaction while they run (`.gridB.folding` sets pointer-events:none), and
  // WKWebView defers — occasionally drops — timers when the window is not key.
  // A single lost timer therefore left the entire card grid permanently
  // unclickable with no error and nothing on screen to explain it.
  const openWidget = useCallback((key: Exclude<AtlasExpandedKey, null>) => {
    setGridFolding(true);
    commitAfter(340, () => { setExpanded(key); setGridFolding(false); });
  }, []);

  // Close: slide the focused view out, then bring the grid back (folds in on remount).
  const closeWidget = useCallback(() => {
    setExpanded((cur) => {
      if (!cur) return cur;
      setViewExiting(true);
      commitAfter(300, () => { setExpanded(null); setViewExiting(false); });
      return cur;
    });
  }, []);

  // Esc closes drawer / settings / focused widget
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setDrawerOpen(false); setSettingsOpen(false); closeWidget(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closeWidget]);

  const send = useCallback(() => {
    const v = input.trim();
    if (!v) return;
    setInput('');
    void sendMessage(v);
  }, [input, sendMessage]);

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
   * Stage 2 + the voice. THIS IS THE HALF THAT WAS MISSING: the gate has always
   * decided whether to speak, but nothing ever called `speak()`, so Atlas has
   * never made a sound on its own.
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
    try {
      await speak(line, undefined, undefined, toVoiceSettings(atlasSettings));
    } catch {
      /* no voice gateway (browser, or gateway down) — the written greeting stands */
    }
  }, [session?.access_token, profile?.timezone, speak, atlasSettings]);
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

  // Home-state band content; the narration hook swaps to per-widget copy when a
  // widget is focused, animating the directional swap.
  //
  // When the gate says nothing needs saying, this is exactly the band that
  // shipped: greeting, calendar count, weather. When it says something does,
  // the subline carries the reason — which, until the brain's generated
  // sentence lands, IS what Atlas has to say, built from real rows.
  const home = useMemo<BandContent>(() => ({
    lead: greetingPrefix,
    accent: `${name}.`,
    subline: greeting?.speak
      // The generated sentence when it lands, the gate's own reason until then.
      // Both are grounded in real rows — the brain refuses to answer at all if
      // it cannot cite one — so the swap never trades truth for polish.
      ? (spokenLine ?? greeting.reason)
      : [
        eventCount > 0 ? `${eventCount} ${eventCount === 1 ? 'event' : 'events'} today` : 'Nothing on your calendar',
        `${weather.location} · ${weather.condition}`,
      ].join(' · '),
    metaBig: `${Math.round(weather.temp)}°`,
    metaSmall: `${weather.location} · ${weather.condition}`,
  }), [greetingPrefix, name, greeting, spokenLine, eventCount, weather.location, weather.condition, weather.temp]);
  const { content: band, swapping } = useBandNarration(expanded, home);

  // Sphere presence: four of the six previously-dead states now have real
  // triggers. `working` from an executing run, `success` from one that just
  // finished, `alert` from one that failed, `muted` from the new mic gate.
  const { runs, activeRun } = useAgentRuns(10);
  const lastDone = useMemo(() => {
    const done = runs.filter((r) => r.status === 'completed' && r.finished_at);
    return done.length ? Date.parse(done[0].finished_at as string) : null;
  }, [runs]);
  const lastFault = useMemo(() => {
    const failed = runs.filter((r) => r.status === 'failed' && r.finished_at);
    return failed.length ? Date.parse(failed[0].finished_at as string) : null;
  }, [runs]);
  const presence = useAtlasPresence({
    voiceState: effectiveAtlasState,
    muted,
    runActive: !!activeRun,
    runCompletedAt: lastDone,
    faultAt: lastFault,
  });

  // The one thing in the app allowed to be orange.
  const voiceOn = isVoiceActive(presence);

  // Shared with /mail. Here it opens Settings as an OVERLAY — a modal over your
  // own desk is the right feel on the dashboard, and it is what keeps the
  // menu's deep-link-to-a-tab behaviour. Mail, which has no overlay, passes a
  // callback that routes to /settings instead.
  const openSettings = useCallback(
    (tab?: 'memory') => { setSettingsTab(tab); setSettingsOpen(true); },
    [],
  );
  const accountItem = useAccountDockItem(openSettings);

  // One dock definition, shared shape with /mail. `onClick` beats `to`, which
  // is what lets Home mean "close the focused widget" here and "navigate" there.
  const dockItems = useMemo<DockItem[]>(() => [
    { id: 'home', label: 'Home', icon: <Home className="i16" />,
      onClick: () => { if (expanded) closeWidget(); else navigate('/'); } },
    { id: 'core', label: 'Core', icon: <Cpu className="i16" />, to: '/atlas-core' },
    // The inbox card is a glance; supervising what Atlas does with mail needs
    // the full three-pane route.
    { id: 'mail', label: 'Mail', icon: <Mail className="i16" />, to: '/mail' },
    { id: 'voice', label: 'Voice', icon: <Mic className="i16" />, kind: 'action',
      onClick: handleManualActivate, voiceActive: voiceOn },
    // The `muted` sphere state was specified with no way to reach it — the
    // audit's rule was to build the control before the visual.
    { id: 'mute', label: 'Mute', icon: <Mic className="i16" />, kind: 'toggle',
      pressed: muted, pressedIcon: <MicOff className="i16" />, pressedLabel: 'Unmute',
      tone: 'danger', onClick: toggleMute },
    { id: 'settings', label: 'Settings', icon: <Settings className="i16" />, kind: 'action',
      onClick: () => setSettingsOpen(true) },
    { id: 'chat', label: 'New chat', icon: <Sparkles className="i16" />, kind: 'cta',
      onClick: () => setDrawerOpen(true) },
    accountItem,
  ], [expanded, closeWidget, navigate, handleManualActivate, voiceOn, muted, toggleMute, accountItem]);

  return (
    <div className="page" data-screen-label="Atlas — Workshop">
      <div className="auro" />
      <AtmosphereCanvas />
      <div className="grain" />
      <ProactiveInsight />

      {/* The pill top bar is gone (2026-07-26 handoff): the greeting band IS the
          header now. What the bar carried moved rather than vanished — the
          wordmark's home action is the dock's Home item, and the listening
          indicator sits under the subline below, because it is the only text
          telling the user the wake phrase and that the microphone is live. */}
      <section className={`bandB${swapping ? ' swapping' : ''}`}>
        <div className="orbwrapB" onClick={() => setDrawerOpen(true)}>
          <div className="orbhalo" />
          {/* `presence` goes straight in now. It used to run through
              presenceToWebGL(), which folded eight states onto the six the
              three.js sphere could draw — and collapsed `success` and `alert`
              onto the same visual, so a failed agent run looked exactly like a
              finished one. This renderer implements all ten natively, so the
              lossy map is gone rather than reimplemented. */}
          <AtlasSphereCanvas className="sphcv" state={presence} />
        </div>
        <div>
          <h2
            className={`greetB${expanded ? ' returnable' : ''}`}
            onClick={expanded ? closeWidget : undefined}
            title={expanded ? 'Return to dashboard' : undefined}
          >{band.lead}<span className="accw">{band.accent}</span></h2>
          {/* The gate answers "why did Atlas just talk to me?" in `reason` — but
              it answers the quiet case too, and that half had nowhere to go.
              Hung off the home subline only: when a widget is focused this line
              narrates the widget, and a greeting reason there would be stale. */}
          <p className="gsubB" title={!expanded && greeting ? greeting.reason : undefined}>{band.subline}</p>
          {/* Relocated from the removed top bar. Kept as a live disclosure that
              the microphone is on and which phrase wakes it — dropping it with
              the header would have made an always-listening app say so
              nowhere. Still the manual-activate affordance. */}
          <button
            className={`bandlisten${voiceOn ? ' voiceon' : ''}`}
            onClick={muted ? toggleMute : handleManualActivate}
            title={muted ? 'Turn the microphone back on' : 'Speak to Atlas'}
          >
            <span className="eq"><span className="eqb" /><span className="eqb" /><span className="eqb" /><span className="eqb" /><span className="eqb" /></span>
            <span>{presenceLabel(presence, getActiveWakePhrases())}</span>
          </button>
        </div>
        <div className="bandmetaB">
          <p className="bmvB tnum">{band.metaBig}</p>
          <p className="bmlB">{band.metaSmall}</p>
        </div>
      </section>

      {/* Bottom dock. Icon-only at rest with `title` tooltips; only the current
          screen carries a label (README §7). Both dock copies — here and in
          /mail — are now the same component fed different items. */}
      <Dock items={dockItems} current="home" />

      {/* Grid region: shows the widget grid, OR the focused widget — the header
          and band above stay mounted either way (design Change 1). */}
      {!expanded ? (
        <main className={`gridB${gridFolding ? ' folding' : ''}`}>
          <AtlasWeatherCard onOpen={() => openWidget('weather')} />
          <AtlasCalendarCard onOpen={() => openWidget('calendar')} />
          <AtlasTasksCard onOpen={() => openWidget('tasks')} />
          <AtlasStocksCard onOpen={() => openWidget('stocks')} />
          <AtlasInboxCard onOpen={() => openWidget('email')} />
          <AtlasBriefingCard onOpen={() => openWidget('news')} />
          <AtlasAirQualityCard />
          <AtlasNowPlayingCard onOpen={() => openWidget('music')} />
          <AtlasActivityCard />
          <AtlasWorldClockCard />
        </main>
      ) : (
        <div className={`focusview${viewExiting ? ' exiting' : ''}`}>
          <button className="retbar" onClick={closeWidget} aria-label="Return to dashboard">
            <CornerUpLeft className="i16" />Tap the title or press Esc to return
          </button>
          <AtlasExpanded
            which={expanded}
            onClose={closeWidget}
            onOpenDrawer={() => { closeWidget(); setDrawerOpen(true); }}
            sphereState={effectiveAtlasState}
            audioLevel={audioLevel}
          />
        </div>
      )}

      <AtlasDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        messages={messages}
        thinking={isLoading}
        stateLabel={isLoading ? 'thinking' : 'idle'}
        input={input}
        onInput={setInput}
        onSend={send}
      />

      {settingsOpen && (
        <AtlasSettings
          initialTab={settingsTab}
          onClose={() => { setSettingsOpen(false); setSettingsTab(undefined); }}
        />
      )}
    </div>
  );
};

export default AtlasDashboard;
