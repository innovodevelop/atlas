/**
 * The Beta System Status — `/system-status` while the beta_ui flag is on
 * (Beta redesign phase 6, `Atlas System Status Beta.dc.html`).
 *
 * The health headline with the sphere (success when every probe passes,
 * alert when one fails, working while re-checking), four tiles, the battery
 * rings for this Mac and its Bluetooth devices, the two services the brain
 * probes with latency bars from this session's checks, what is in atlas.db,
 * and a Recently feed of errors, actions and repairs. Everything comes from
 * the Workshop page's hooks (`useSystemStatus`), the vitals command the top
 * bar uses, the `tool_calls` audit trail and `db_info`; nothing is invented.
 *
 * Where the design shows a figure Atlas has no source for, the tile says so:
 * model calls read the app's own `atlas_usage_history` counter, which nothing
 * has written since the brain moved on-device, and "On this Mac" shows rows
 * per table because no command measures bytes yet.
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/hooks/useAuth';
import { adminGet, ADMIN_QUERY_OPTIONS } from '@/hooks/useAdminApi';
import { useErrorLogs, useInitiateRepair, useRepairAttempts, useResolveError, useScanErrors, type SystemHealthSnapshot } from '@/hooks/useSystemStatus';
import { useSystemVitals } from '@/hooks/useSystemVitals';
import { isTauri, localClient } from '@/integrations/local/localClient';
import { VeilSphere } from '@/components/atlas/VeilSphere';
import { AtlasIcon } from '@/components/atlas/AtlasIcon';
import {
  barsOf, batteryColour, batteryState, clockText, countText, countToday, dayKey, deviceIcon, deviceLine, getProbeHistory, latencyText, macLine,
  recentEvents, recordProbe, ringOffset, samplesCaption, serviceDown, serviceMeta, sphereStateFor, storageBars, subscribeProbeHistory,
  summarise, sumUsage, uptimeText, withRoundTrip, type TableInfo, type ToolCallRow, type UsageRow,
} from '@/lib/betaSystemStatus';
import { useBetaNavigate } from '@/lib/viewTransitions';
import { openTalk, setTalkAnchor } from '@/lib/talkBus';
import { isTyping } from './atlasHelpers';
import '@/styles/beta/systemStatus.css';

type TimedHealth = SystemHealthSnapshot & { roundtrip_ms: number };

/**
 * The Workshop's `useSystemHealth` hides how long the brain took to answer,
 * and the brain reports its own latency as 0. Same endpoint, same transport,
 * same cadence — plus the round trip, which is the one real latency figure
 * this window can measure for the brain.
 */
function useTimedHealth() {
  return useQuery({
    queryKey: ['admin', 'system-health', 'timed'],
    queryFn: async (): Promise<TimedHealth> => {
      const t0 = performance.now();
      const h = await adminGet<SystemHealthSnapshot>('/admin/system/health');
      return { ...h, roundtrip_ms: Math.round(performance.now() - t0) };
    },
    staleTime: 5_000,
    refetchInterval: 10_000,
    ...ADMIN_QUERY_OPTIONS,
  });
}

/**
 * Every table in atlas.db with its row count — the only "on this Mac" measure
 * a command gives. Read once per visit and on Re-check, never on a timer:
 * `db_info` is a synchronous command that holds the database lock while it
 * counts every table, and row counts do not move fast enough to be worth it.
 */
function useDbTables() {
  return useQuery({
    queryKey: ['beta', 'db-tables'],
    enabled: isTauri(),
    queryFn: async (): Promise<TableInfo[]> => {
      const { invoke } = await import('@tauri-apps/api/core');
      return invoke<TableInfo[]>('db_info');
    },
    staleTime: 5 * 60_000,
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

/**
 * Today's row per provider in the app's model-call counter table. Nothing
 * writes it at the moment (see the header), so it is read once per visit and
 * on Re-check rather than polled.
 */
function useUsageToday(day: string) {
  return useQuery({
    queryKey: ['beta', 'usage-today', day],
    enabled: isTauri(),
    queryFn: async (): Promise<UsageRow[]> => {
      const { data, error } = await localClient.from('atlas_usage_history').select('provider, total_calls, failed_calls').eq('date', day);
      if (error) throw new Error(error.message);
      return (data ?? []) as UsageRow[];
    },
    staleTime: 60_000,
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

  const healthQ = useTimedHealth();
  const errorsQ = useErrorLogs(50);
  const { repairs } = useRepairAttempts();
  const scan = useScanErrors();
  const resolveErr = useResolveError();
  const initRepair = useInitiateRepair();
  const vitals = useSystemVitals();
  const tablesQ = useDbTables();
  const callsQ = useToolCallRows(user?.id ?? null);
  const today = dayKey(new Date());
  const usageQ = useUsageToday(today);
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

  // The brain's answer carries one probe; the sparklines need the run of them.
  // Every successful poll is recorded once, keyed on when it arrived.
  const health = healthQ.data ?? null;
  const services = useMemo(() => (health ? withRoundTrip(health.services, health.roundtrip_ms) : null), [health]);
  useEffect(() => {
    if (!services || !healthQ.dataUpdatedAt) return;
    recordProbe(services, healthQ.dataUpdatedAt);
    setCheckedAt(healthQ.dataUpdatedAt);
  }, [services, healthQ.dataUpdatedAt]);
  useEffect(() => { if (healthQ.errorUpdatedAt) setCheckedAt((t) => Math.max(t ?? 0, healthQ.errorUpdatedAt)); }, [healthQ.errorUpdatedAt]);

  /**
   * Re-check: the brain's probes, the error scan, the audit trail, the
   * database, all at once. The local reads only run where they can — a
   * query's refetch() ignores `enabled`, and in the browser preview there is
   * no database to ask.
   */
  const recheck = useCallback(async () => {
    if (checking) return;
    setChecking(true);
    const floor = new Promise<void>((r) => window.setTimeout(r, MIN_CHECK_MS));
    const local = native ? [tablesQ.refetch(), usageQ.refetch(), ...(user ? [callsQ.refetch()] : [])] : [];
    try {
      await Promise.allSettled([
        healthQ.refetch(),
        scan.mutateAsync().then(() => errorsQ.refetch()),
        qc.invalidateQueries({ queryKey: ['admin', 'repair-attempts'] }),
        ...local,
        floor,
      ]);
    } finally {
      setChecking(false);
      setCheckedAt(Date.now());
    }
  }, [checking, native, user, healthQ, scan, errorsQ, qc, tablesQ, callsQ, usageQ]);

  const healthError = healthQ.error ? (healthQ.error as Error).message : null;
  const unresolved = health ? health.error_count_24h + health.warning_count_24h : 0;
  const summaryInput = { checking, loading: healthQ.isLoading, error: healthError, services, unresolvedErrors: unresolved };
  const sphereState = sphereStateFor(summaryInput);
  const { headline, sub } = summarise(summaryInput);

  // Tiles. Each one says where its number comes from, or why it has none.
  const todayCalls = useMemo(() => countToday(callsQ.data ?? [], new Date()), [callsQ.data]);
  const failedToday = todayCalls.filter((c) => c.status === 'failed').length;
  const usage = useMemo(() => sumUsage(usageQ.data ?? []), [usageQ.data]);
  const battery = vitals.battery;
  // In the app the first vitals read takes a moment; until it lands, "no
  // battery" would be a claim about the Mac rather than about the wait.
  const vitalsRead = vitals.fixture || vitals.at != null;
  const macText = vitalsRead ? macLine(battery) : 'This Mac · reading the battery…';
  const tiles = [
    { k: 'Uptime', v: health ? uptimeText(health.uptime_seconds) : '—', d: health ? 'brain sidecar, since it started' : healthError ? 'brain not reachable' : 'reading…', ink: true, stamp: false },
    { k: 'Actions today', v: native && user ? countText(callsQ.data ? todayCalls.length : null) : '—', d: !native ? 'Only in the Mac app' : !user ? 'Sign in to count them' : callsQ.error ? 'Audit trail unreadable' : failedToday ? `${failedToday} failed` : 'none failed · from the audit trail', ink: false, stamp: false },
    { k: 'Model calls', v: native && usage ? countText(usage.total) : '—', d: !native ? 'Only in the Mac app' : usage ? `${usage.failed} failed · ${usage.providers} ${usage.providers === 1 ? 'provider' : 'providers'}` : 'No counter records model calls yet', ink: false, stamp: false },
    { k: 'Battery', v: battery ? `${battery.percent}%` : '—', d: vitalsRead ? `This Mac · ${batteryState(battery)}` : 'Reading…', ink: false, stamp: vitals.fixture },
  ];

  const devices = (vitals.bluetooth?.connected ?? []);
  const store = useMemo(() => storageBars(tablesQ.data ?? []), [tablesQ.data]);
  const recent = useMemo(
    () => recentEvents(errorsQ.errors, (callsQ.data ?? []).slice(0, 12), repairs, new Date()),
    [errorsQ.errors, callsQ.data, repairs],
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
                <span className={`b-ss-dot${bad ? ' b-ss-dot--bad' : ''}`} />
                <span className="b-ss-svc-text"><b>{meta.label}</b><span>{bad && s.error ? `${meta.desc} · ${s.error}` : meta.desc}</span></span>
                <span className="b-ss-bars" aria-label={`${meta.label} latency, last ${bars.filter((b) => b.h).length} checks`}>
                  {bars.map((b, i) => <span key={i} style={{ height: b.h ?? '0%', background: b.c }} />)}
                </span>
                <span className={`b-ss-svc-v${bad ? ' bad' : ''}`}>{latencyText(s.latency_ms, !bad)}</span>
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
            <span className="b-ss-mac-sub">atlas.db by table · rows, not bytes — no command measures disk yet</span>
            {!native ? (
              <span className="b-ss-mac-empty">Only in the Mac app. The browser preview has no database to look at.</span>
            ) : tablesQ.error ? (
              <span className="b-ss-mac-empty">Could not read atlas.db: {(tablesQ.error as Error).message}</span>
            ) : store.length ? store.map((s) => (
              <div key={s.k} className="b-ss-store">
                <span>{s.k}</span>
                <span className="b-ss-store-bar"><span style={{ width: s.w, background: s.c }} /></span>
                <span className="b-ss-store-v">{s.v}</span>
              </div>
            )) : (
              <span className="b-ss-mac-empty">{tablesQ.isLoading ? 'Counting rows…' : 'The database is empty.'}</span>
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
                {errorsQ.error ? `Could not read the error log: ${errorsQ.error.message}` : errorsQ.isLoading ? 'Reading…' : native ? 'Nothing yet. Errors, actions and repairs show up here.' : 'Errors, actions and repairs show up here in the Mac app.'}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
};

export default BetaSystemStatus;
