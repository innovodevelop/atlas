/**
 * The Beta System Status — `/system-status` while the beta_ui flag is on
 * (Beta redesign phase 6, `Atlas System Status Beta.dc.html`).
 *
 * The health headline with the sphere (success when every probe passes,
 * alert when one fails, working while re-checking), four tiles, the battery
 * rings for this Mac and its Bluetooth devices, the services with latency bars
 * from the checks this Mac made (kept across reloads), what Atlas takes on
 * disk, and a Recently feed of errors, actions, repairs and installs.
 *
 * Where each figure comes from — nothing is invented:
 *   Brain, Voice, Reasoning  the brain's health route (`/admin/system/health`);
 *                            Reasoning is the AI provider, checked by the brain
 *                            without spending tokens.
 *   Mail                     `mail_accounts`, as the sync left it.
 *   Home Assistant           `system_probe_home_assistant`, a timed GET of the
 *                            linked bridge, once a minute while this is open.
 *   Uptime                   `system_app_history`: since this version first ran.
 *   Model calls              the brain's model-call ledger (`/admin/model-calls`).
 *   Actions today            the `tool_calls` audit trail Rust writes.
 *   On this Mac              `system_storage`: bytes on disk, SQLite's own pages.
 * Calendar is not a row: calendars live on this Mac (`user_events`) and no
 * sync exists to check.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/hooks/useAuth';
import { adminGet, ADMIN_QUERY_OPTIONS, ADMIN_REFETCH_INTERVAL_MS } from '@/hooks/useAdminApi';
import { useErrorLogs, useInitiateRepair, useRepairAttempts, useResolveError, useScanErrors, type SystemHealthSnapshot } from '@/hooks/useSystemStatus';
import { useSystemVitals } from '@/hooks/useSystemVitals';
import { isTauri, localClient } from '@/integrations/local/localClient';
import { VeilSphere } from '@/components/atlas/VeilSphere';
import { AtlasIcon } from '@/components/atlas/AtlasIcon';
import {
  barsOf, batteryColour, batteryState, clockText, countText, countToday, deviceIcon, deviceLine, getProbeHistory, homeAssistantService, macLine,
  mailService, modelCallsTile, recentEvents, recordProbe, ringOffset, samplesCaption, serviceDesc, serviceDown, serviceMeta, sphereStateFor,
  storageBars, subscribeProbeHistory, summarise, uptimeText, valueText, versionUptime, withRoundTrip,
  type AppHistory, type HaProbe, type MailAccountRow, type ModelCallsToday, type ProbeService, type StorageReport, type ToolCallRow,
} from '@/lib/betaSystemStatus';
import { useBetaNavigate } from '@/lib/viewTransitions';
import { openTalk, setTalkAnchor } from '@/lib/talkBus';
import { isTyping } from './atlasHelpers';
import '@/styles/beta/systemStatus.css';

/** The brain's answer, its services in the richer shape the AI provider row carries, plus the measured round trip. */
type TimedHealth = Omit<SystemHealthSnapshot, 'services'> & { roundtrip_ms: number; services: ProbeService[] };

async function invokeCommand<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

/**
 * The Workshop's `useSystemHealth` hides how long the brain took to answer,
 * and the brain reports its own latency as 0. Same endpoint, same transport,
 * same cadence — plus the round trip, which is the one real latency figure
 * this window can measure for the brain. `refetchFresh` (Check again) asks the
 * brain to re-probe the AI provider instead of answering from its minute-long
 * cache.
 */
function useTimedHealth() {
  const fresh = useRef(false);
  const q = useQuery({
    queryKey: ['admin', 'system-health', 'timed'],
    queryFn: async (): Promise<TimedHealth> => {
      const f = fresh.current;
      fresh.current = false;
      const t0 = performance.now();
      const h = await adminGet<TimedHealth>(`/admin/system/health${f ? '?fresh=1' : ''}`);
      return { ...h, roundtrip_ms: Math.round(performance.now() - t0) };
    },
    staleTime: 5_000,
    refetchInterval: 10_000,
    ...ADMIN_QUERY_OPTIONS,
  });
  const { refetch } = q;
  const refetchFresh = useCallback(() => { fresh.current = true; return refetch(); }, [refetch]);
  return [q, refetchFresh] as const;
}

/**
 * Bytes on disk (row 79). Read once per visit and on Check again, never on a
 * timer: the page walk is proportional to the database, and sizes do not move
 * fast enough to be worth more.
 */
function useStorage() {
  return useQuery({
    queryKey: ['beta', 'system-storage'],
    enabled: isTauri(),
    queryFn: () => invokeCommand<StorageReport>('system_storage'),
    staleTime: 5 * 60_000,
  });
}

/** This app's version history (row 78). Recorded once per launch, so read once. */
function useAppHistory() {
  return useQuery({
    queryKey: ['beta', 'app-history'],
    enabled: isTauri(),
    queryFn: () => invokeCommand<AppHistory>('system_app_history'),
    staleTime: 10 * 60_000,
  });
}

/** The linked Home Assistant bridge, checked once a minute while this screen is open (row 75). */
function useHomeAssistantProbe(userId: string | null) {
  return useQuery({
    queryKey: ['beta', 'ha-probe', userId],
    enabled: isTauri() && !!userId,
    queryFn: () => invokeCommand<HaProbe>('system_probe_home_assistant', { userId }),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

/** The mailboxes as the sync left them (row 75); re-read every minute. */
function useMailAccounts(userId: string | null) {
  return useQuery({
    queryKey: ['beta', 'mail-accounts-status', userId],
    enabled: isTauri() && !!userId,
    queryFn: async (): Promise<MailAccountRow[]> => {
      const { data, error } = await localClient.from('mail_accounts').select('email_address, provider, status, last_error, last_synced_at').eq('user_id', userId!);
      if (error) throw new Error(error.message);
      return (data ?? []) as MailAccountRow[];
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

/** Today's model calls from the brain's ledger (rows 72, 77). */
function useModelCallsToday() {
  return useQuery({
    queryKey: ['beta', 'model-calls-today'],
    enabled: isTauri(),
    queryFn: () => adminGet<ModelCallsToday>('/admin/model-calls?days=1'),
    staleTime: 15_000,
    refetchInterval: ADMIN_REFETCH_INTERVAL_MS,
    ...ADMIN_QUERY_OPTIONS,
  });
}

/**
 * The user's tool calls — the audit trail Rust writes (control/audit.rs),
 * read like useToolCalls does. Rust writes it through the db_* commands, so
 * the `db:changed` event says when it moved and no poll is needed.
 */
function useToolCallRows(userId: string | null) {
  const qc = useQueryClient();
  const enabled = !!userId && isTauri();
  useEffect(() => {
    if (!enabled) return;
    const channel = localClient
      .channel('beta-system-status-tool-calls')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tool_calls' }, () => { void qc.invalidateQueries({ queryKey: ['beta', 'tool-calls'] }); })
      .subscribe();
    return () => { localClient.removeChannel(channel); };
  }, [enabled, qc]);
  return useQuery({
    queryKey: ['beta', 'tool-calls', userId],
    enabled,
    queryFn: async (): Promise<ToolCallRow[]> => {
      const { data, error } = await localClient.from('tool_calls').select('id, tool_name, status, created_at').eq('user_id', userId!).order('created_at', { ascending: false });
      if (error) throw new Error(error.message);
      return (data ?? []) as ToolCallRow[];
    },
    staleTime: 10_000,
  });
}

/** How long the sphere stays "working" at least, so a 30 ms answer still reads as a check. */
const MIN_CHECK_MS = 900;

const BetaSystemStatus = () => {
  const navigate = useBetaNavigate();
  const plainNavigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const qc = useQueryClient();
  const native = isTauri();
  const userId = user?.id ?? null;

  const [healthQ, refetchHealthFresh] = useTimedHealth();
  const errorsQ = useErrorLogs(50);
  const { repairs } = useRepairAttempts();
  const scan = useScanErrors();
  const resolveErr = useResolveError();
  const initRepair = useInitiateRepair();
  const vitals = useSystemVitals();
  const storageQ = useStorage();
  const appQ = useAppHistory();
  const haQ = useHomeAssistantProbe(userId);
  const mailQ = useMailAccounts(userId);
  const modelCallsQ = useModelCallsToday();
  const callsQ = useToolCallRows(userId);
  const history = useSyncExternalStore(subscribeProbeHistory, getProbeHistory, getProbeHistory);

  const [checking, setChecking] = useState(false);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [sphereEl, setSphereEl] = useState<HTMLButtonElement | null>(null);

  useEffect(() => { if (!authLoading && !user) plainNavigate('/auth'); }, [user, authLoading, plainNavigate]);
  // The hero sphere is this screen's talk entry point.
  useEffect(() => { setTalkAnchor(sphereEl); return () => setTalkAnchor(null); }, [sphereEl]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (!isTyping(e.target) && e.key === 'Escape') navigate('/'); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate]);

  // The brain's answer carries one probe per service; the sparklines need the
  // run of them. Every answer is recorded once, keyed on when it arrived; the
  // local checks (mail, Home Assistant) run on their own clocks and record theirs.
  const health = healthQ.data ?? null;
  const brainServices = useMemo(() => (health ? withRoundTrip(health.services, health.roundtrip_ms) : null), [health]);
  const mail = useMemo(() => (mailQ.data ? mailService(mailQ.data, new Date(mailQ.dataUpdatedAt)) : null), [mailQ.data, mailQ.dataUpdatedAt]);
  const ha = useMemo(() => (haQ.data ? homeAssistantService(haQ.data, new Date(haQ.dataUpdatedAt)) : null), [haQ.data, haQ.dataUpdatedAt]);
  useEffect(() => {
    if (!brainServices || !healthQ.dataUpdatedAt) return;
    recordProbe(brainServices, healthQ.dataUpdatedAt);
    setCheckedAt(healthQ.dataUpdatedAt);
  }, [brainServices, healthQ.dataUpdatedAt]);
  useEffect(() => { if (mail && mailQ.dataUpdatedAt) recordProbe([mail], mailQ.dataUpdatedAt); }, [mail, mailQ.dataUpdatedAt]);
  useEffect(() => { if (ha && haQ.dataUpdatedAt) recordProbe([ha], haQ.dataUpdatedAt); }, [ha, haQ.dataUpdatedAt]);
  useEffect(() => { if (healthQ.errorUpdatedAt) setCheckedAt((t) => Math.max(t ?? 0, healthQ.errorUpdatedAt)); }, [healthQ.errorUpdatedAt]);

  /**
   * Check again: the brain's probes (with a fresh AI provider check), the
   * error scan, the local checks, the audit trail and the disk, all at once.
   * The local reads only run where they can — a query's refetch() ignores
   * `enabled`, and in the browser preview there is no database to ask.
   */
  const recheck = useCallback(async () => {
    if (checking) return;
    setChecking(true);
    const floor = new Promise<void>((r) => window.setTimeout(r, MIN_CHECK_MS));
    const local = native
      ? [storageQ.refetch(), modelCallsQ.refetch(), ...(userId ? [callsQ.refetch(), mailQ.refetch(), haQ.refetch()] : [])]
      : [];
    try {
      await Promise.allSettled([
        refetchHealthFresh(),
        scan.mutateAsync().then(() => errorsQ.refetch()),
        qc.invalidateQueries({ queryKey: ['admin', 'repair-attempts'] }),
        ...local,
        floor,
      ]);
    } finally {
      setChecking(false);
      setCheckedAt(Date.now());
    }
  }, [checking, native, userId, refetchHealthFresh, scan, errorsQ, qc, storageQ, modelCallsQ, callsQ, mailQ, haQ]);

  const services = useMemo(
    () => (brainServices ? [...brainServices, ...(mail ? [mail] : []), ...(ha ? [ha] : [])] : null),
    [brainServices, mail, ha],
  );
  const healthError = healthQ.error ? (healthQ.error as Error).message : null;
  const unresolved = health ? health.error_count_24h + health.warning_count_24h : 0;
  const summaryInput = { checking, loading: healthQ.isLoading, error: healthError, services, unresolvedErrors: unresolved };
  const sphereState = sphereStateFor(summaryInput);
  const { headline, sub } = summarise(summaryInput);

  // Tiles. Each one says where its number comes from, or why it has none.
  const now = new Date();
  const todayCalls = useMemo(() => countToday(callsQ.data ?? [], new Date()), [callsQ.data]);
  const failedToday = todayCalls.filter((c) => c.status === 'failed').length;
  const sinceUpdate = versionUptime(appQ.data ?? null, now);
  const modelTile = modelCallsTile(native, modelCallsQ.data ?? null, modelCallsQ.error ? (modelCallsQ.error as Error).message : null);
  const battery = vitals.battery;
  // In the app the first vitals read takes a moment; until it lands, "no
  // battery" would be a claim about the Mac rather than about the wait.
  const vitalsRead = vitals.fixture || vitals.at != null;
  const macText = vitalsRead ? macLine(battery) : 'This Mac · reading the battery…';
  const tiles = [
    sinceUpdate
      ? { k: 'Uptime', v: uptimeText(sinceUpdate.seconds), d: sinceUpdate.d, ink: true, stamp: false }
      : { k: 'Uptime', v: health ? uptimeText(health.uptime_seconds) : '—', d: health ? 'brain sidecar, since it started' : healthError ? 'brain not reachable' : 'reading…', ink: true, stamp: false },
    { k: 'Actions today', v: native && user ? countText(callsQ.data ? todayCalls.length : null) : '—', d: !native ? 'Only in the Mac app' : !user ? 'Sign in to count them' : callsQ.error ? 'Audit trail unreadable' : failedToday ? `${failedToday} failed` : 'none failed · from the audit trail', ink: false, stamp: false },
    { k: 'Model calls', v: modelTile.v, d: modelTile.d, ink: false, stamp: false },
    { k: 'Battery', v: battery ? `${battery.percent}%` : '—', d: vitalsRead ? `This Mac · ${batteryState(battery)}` : 'Reading…', ink: false, stamp: vitals.fixture },
  ];

  const devices = (vitals.bluetooth?.connected ?? []);
  const store = useMemo(() => (storageQ.data ? storageBars(storageQ.data) : []), [storageQ.data]);
  const recent = useMemo(
    () => recentEvents(errorsQ.errors, (callsQ.data ?? []).slice(0, 12), repairs, new Date(), 8, appQ.data?.history ?? []),
    [errorsQ.errors, callsQ.data, repairs, appQ.data],
  );
  const sampleCount = services ? Math.max(0, ...services.map((s) => (history[s.name] ?? []).length)) : 0;

  return (
    <div className="b-ss" data-screen-label="Beta — System status">
      <section className="b-ss-top">
        <div className="b-ss-hero" aria-label="Health">
          {/* The header sphere is this screen's talk entry point (the orb hides while it is registered). */}
          <button type="button" className="b-ss-sphere" ref={setSphereEl} onClick={() => openTalk()} title="Talk to Atlas · ⌥ Space" aria-label="Talk to Atlas" data-state={sphereState}>
            <VeilSphere size="panel" bg="#f1eeea" state={sphereState} />
          </button>
          <div className="b-ss-hero-text">
            <button type="button" className="b-ss-back" title="Back to Home · Esc" onClick={() => navigate('/')}>System · checked {clockText(checkedAt)}</button>
            <h1 className="b-ss-h1">{headline}</h1>
            <p className="b-ss-sub">{sub}</p>
            <button type="button" className="b-btn b-btn--ink b-ss-check" disabled={checking} onClick={() => void recheck()}>{checking ? 'Checking…' : 'Check again'}</button>
          </div>
        </div>
        <div className="b-ss-tiles" aria-label="Counters">
          {tiles.map((t) => (
            <div key={t.k} className={`b-ss-tile${t.ink ? ' b-ss-tile--ink' : ''}`}>
              <span className="b-ss-tile-k">{t.k}{t.stamp ? <span className="b-ss-stamp">Sample</span> : null}</span>
              <span className="b-ss-tile-v b-num">{t.v}</span>
              <span className="b-ss-tile-d">{t.d}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="b-ss-devices" aria-label="Devices">
        <div className="b-ss-dev">
          <div className="b-ss-ring">
            <svg viewBox="0 0 54 54" aria-hidden>
              <circle cx="27" cy="27" r="23" fill="none" stroke="#f1eeea" strokeWidth="5" />
              <circle cx="27" cy="27" r="23" fill="none" stroke={batteryColour(battery?.percent ?? null, battery?.charging)} strokeWidth="5" strokeLinecap="round" strokeDasharray="144.5" strokeDashoffset={ringOffset(battery?.percent ?? null)} />
            </svg>
            <span className="b-ss-dev-ico"><AtlasIcon name="mac" size={18} weight={1.5} /></span>
          </div>
          <span className="b-ss-dev-text"><b>{vitals.fixture ? 'MacBook (sample)' : 'This Mac'}</b><span>{macText}{vitals.wifi?.connected && vitals.wifi.ssid ? ` · ${vitals.wifi.ssid}` : ''}</span></span>
        </div>
        {devices.map((d, i) => (
          <div key={`${d.name}-${i}`} className="b-ss-dev">
            <div className="b-ss-ring">
              <svg viewBox="0 0 54 54" aria-hidden>
                <circle cx="27" cy="27" r="23" fill="none" stroke="#f1eeea" strokeWidth="5" />
                <circle cx="27" cy="27" r="23" fill="none" stroke={batteryColour(d.battery_percent)} strokeWidth="5" strokeLinecap="round" strokeDasharray="144.5" strokeDashoffset={ringOffset(d.battery_percent)} />
              </svg>
              <span className="b-ss-dev-ico"><AtlasIcon name={deviceIcon(d.kind, d.name)} size={18} weight={1.5} /></span>
            </div>
            <span className="b-ss-dev-text"><b>{d.name}</b><span>{deviceLine(d.kind, d.battery_percent)}</span></span>
          </div>
        ))}
        {native && vitals.bluetooth === null ? <div className="b-ss-dev"><span className="b-ss-dev-text"><b>Bluetooth</b><span>Reading connected devices…</span></span></div> : null}
        {native && vitals.bluetooth && devices.length === 0 ? <div className="b-ss-dev"><span className="b-ss-dev-text"><b>{vitals.bluetooth.on ? 'No Bluetooth devices' : 'Bluetooth off'}</b><span>{vitals.bluetooth.on ? 'Nothing connected right now' : 'Turn it on in the menu bar'}</span></span></div> : null}
        {vitals.fixture ? <p className="b-ss-devices-note"><span className="b-ss-stamp">Sample</span>These are sample devices — the browser preview cannot see this Mac.</p> : null}
      </section>

      <div className="b-ss-two">
        <section className="b-ss-services" aria-label="Services">
          <span className="b-ss-h2">Services</span>
          {services ? services.map((s) => {
            const bad = serviceDown(s);
            const meta = serviceMeta(s.name);
            const bars = barsOf(history[s.name] ?? []);
            return (
              <div key={s.name} className="b-ss-svc">
                <span className={`b-ss-dot${bad ? ' b-ss-dot--bad' : s.idle ? ' b-ss-dot--idle' : ''}`} />
                <span className="b-ss-svc-text"><b>{meta.label}</b><span title={serviceDesc(s)}>{serviceDesc(s)}</span></span>
                <span className="b-ss-bars" aria-label={`${meta.label} latency, last ${bars.filter((b) => b.h).length} checks`}>
                  {bars.map((b, i) => <span key={i} style={{ height: b.h ?? '0%', background: b.c }} />)}
                </span>
                <span className={`b-ss-svc-v${bad ? ' bad' : ''}`}>{valueText(s)}</span>
              </div>
            );
          }) : (
            <div className="b-ss-empty">{healthError ?? 'Reading the brain’s probes…'}</div>
          )}
          {services ? <p className="b-ss-note">{samplesCaption(sampleCount)}</p> : null}
        </section>

        <div className="b-ss-side">
          <section className="b-ss-mac" aria-label="On this Mac">
            <span className="b-ss-h2">On this Mac</span>
            <span className="b-ss-mac-sub">
              Bytes on disk{storageQ.data ? ` · measured ${clockText(new Date(storageQ.data.measured_at).getTime())}` : ''} · memory, mail and the audit trail are parts of atlas.db
            </span>
            {!native ? (
              <span className="b-ss-mac-empty">Only in the Mac app. The browser preview has no disk to measure.</span>
            ) : storageQ.error ? (
              <span className="b-ss-mac-empty">Could not measure: {(storageQ.error as Error).message}</span>
            ) : store.length ? (
              <>
                {store.map((s) => (
                  <div key={s.k} className="b-ss-store" title={s.title}>
                    <span>{s.k}</span>
                    <span className="b-ss-store-bar"><span style={{ width: s.w, background: s.c }} /></span>
                    <span className="b-ss-store-v">{s.v}</span>
                  </div>
                ))}
                {storageQ.data?.parts_error ? <span className="b-ss-mac-empty">Memory, mail and the audit trail could not be split out: {storageQ.data.parts_error}</span> : null}
                {storageQ.data && !storageQ.data.models ? <span className="b-ss-mac-empty">No model files were found beside the app to measure.</span> : null}
              </>
            ) : (
              <span className="b-ss-mac-empty">Measuring…</span>
            )}
          </section>

          <section className="b-ss-recent" aria-label="Recently">
            <span className="b-ss-recent-t">Recently</span>
            {recent.length ? recent.map((e) => (
              <div key={e.id} className="b-ss-ev">
                <span className="b-ss-ev-t">{e.t}</span>
                <span className="b-ss-ev-dot" style={{ background: e.c }} />
                <span className="b-ss-ev-m">{e.m}</span>
                {e.errorId ? (
                  <span className="b-ss-ev-actions">
                    <button type="button" className="b-btn b-btn--card b-btn--row" disabled={resolveErr.isPending} onClick={() => resolveErr.mutate(e.errorId!)}>Resolve</button>
                    <button type="button" className="b-btn b-btn--tinted b-btn--row" disabled={initRepair.isPending} onClick={() => initRepair.mutate(e.errorId!)}>Repair</button>
                  </span>
                ) : null}
              </div>
            )) : (
              <div className="b-ss-empty">
                {errorsQ.error ? `Could not read the error log: ${errorsQ.error.message}` : errorsQ.isLoading ? 'Reading…' : native ? 'Nothing yet. Errors, actions, repairs and updates show up here.' : 'Errors, actions, repairs and updates show up here in the Mac app.'}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
};

export default BetaSystemStatus;
