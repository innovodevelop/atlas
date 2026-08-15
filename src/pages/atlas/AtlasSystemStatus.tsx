import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Activity, Radio, RefreshCw, Search, CheckCircle, Wrench } from 'lucide-react';
import { Panel, Empty, Button } from '@/components/atlas-ui/primitives';
import { useAuth } from '@/hooks/useAuth';
import {
  useSystemHealth,
  useErrorLogs,
  useRepairAttempts,
  useResolveError,
  useInitiateRepair,
  useScanErrors,
  type ErrorLogEntry,
} from '@/hooks/useSystemStatus';
import '@/styles/surfaces/systemStatus.css';

export const surface = {
  path: '/system-status',
  label: 'System status',
  icon: 'Activity',
  entry: 'menu' as const,
  mock: false,
  edition: 'admin' as const,
};

function healthLevel(score: number): 'healthy' | 'degraded' | 'down' {
  if (score >= 80) return 'healthy';
  if (score >= 40) return 'degraded';
  return 'down';
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export default function AtlasSystemStatus() {
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();

  useEffect(() => {
    if (!authLoading && !user) navigate('/auth');
  }, [user, authLoading, navigate]);

  const { health, isLoading: healthLoading, error: healthError } = useSystemHealth();
  const { errors, isLoading: errorsLoading, error: errorsErr } = useErrorLogs();
  const { repairs, isLoading: repairsLoading } = useRepairAttempts();
  const resolveErr = useResolveError();
  const initRepair = useInitiateRepair();
  const scan = useScanErrors();

  const level = health ? healthLevel(health.health_score) : 'healthy';

  return (
    <div className="ss-surface">
      <header className="ss-header">
        <button className="ss-back" onClick={() => navigate(-1)} aria-label="Back">
          <Activity className="i20" />
          <h1 className="ss-title">System Status</h1>
        </button>
        <p className="ss-eyebrow">admin</p>
        <Button variant="ghost" size="sm" onClick={() => scan.mutate()} loading={scan.isPending}>
          <Search className="i14" />
          Scan
        </Button>
        <span className="ss-live"><Radio className="i12" /> Live</span>
      </header>

      {healthError ? (
        <Empty size="block" status="error" title="Health check failed" body={healthError.message} />
      ) : healthLoading ? (
        <Empty size="block" status="stale" body="Loading system health…" />
      ) : health && (
        <div className="ss-health-bar">
          <div className="ss-health-row">
            <span className="ss-health-score" data-level={level}>{health.health_score}</span>
            <div className="ss-health-meta">
              <span className="ss-health-label">Health Score</span>
              <span className="ss-health-sub">
                {health.error_count_24h} errors · {health.warning_count_24h} warnings (24h) · uptime {Math.floor(health.uptime_seconds / 3600)}h {Math.floor((health.uptime_seconds % 3600) / 60)}m
              </span>
            </div>
          </div>
          <div className="ss-meter">
            <div
              className="ss-meter-fill"
              data-level={level}
              style={{ width: `${health.health_score}%` }}
            />
          </div>
          <div className="ss-services">
            {health.services.map(svc => (
              <div key={svc.name} className="ss-service">
                <span className="ss-service-dot" data-status={svc.status} />
                <span className="ss-service-name">{svc.name}</span>
                {svc.latency_ms !== null && (
                  <span className="ss-service-latency">{svc.latency_ms}ms</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="ss-layout">
        <Panel title="Error Log" tone="panel">
          {errorsErr ? (
            <Empty size="block" status="error" title="Couldn't load errors" body={errorsErr.message} />
          ) : errorsLoading ? (
            <Empty size="block" status="stale" body="Loading error log…" />
          ) : errors.length === 0 ? (
            <Empty
              size="block"
              icon={<CheckCircle className="i20" />}
              title="No errors"
              body="All systems operational. No unresolved errors in the last 24 hours."
            />
          ) : (
            <div className="ss-errors">
              {errors.map((err: ErrorLogEntry) => (
                <div key={err.id} className={`ss-error-row ${err.resolved ? 'ss-error-resolved' : ''}`}>
                  <span className="ss-error-sev" data-sev={err.severity} />
                  <div className="ss-error-body">
                    <div className="ss-error-msg">{err.error_message}</div>
                    <div className="ss-error-type">{err.error_type}</div>
                  </div>
                  <span className="ss-error-time">{relativeTime(err.created_at)}</span>
                  {!err.resolved && (
                    <div className="ss-error-actions">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => resolveErr.mutate(err.id)}
                        loading={resolveErr.isPending}
                        aria-label="Resolve"
                      >
                        <CheckCircle className="i12" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => initRepair.mutate(err.id)}
                        loading={initRepair.isPending}
                        aria-label="Auto-repair"
                      >
                        <Wrench className="i12" />
                      </Button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </Panel>

        <Panel title="Self-Repair Pipeline" tone="panel">
          {repairsLoading ? (
            <Empty size="block" status="stale" body="Loading repairs…" />
          ) : repairs.length === 0 ? (
            <Empty
              size="block"
              icon={<Wrench className="i20" />}
              title="No repairs"
              body="Initiated repairs will appear here. Click the wrench on an error to start an autonomous audit."
            />
          ) : (
            <div className="ss-repairs">
              {repairs.map(r => (
                <div key={r.id} className="ss-repair-card">
                  <div className="ss-repair-header">
                    <span className="ss-repair-status" data-status={r.status}>{r.status}</span>
                    {r.test_passed !== null && (
                      <span className={`ss-repair-badge ${r.test_passed ? 'ss-badge-pass' : 'ss-badge-fail'}`}>
                        {r.test_passed ? 'tests pass' : 'tests fail'}
                      </span>
                    )}
                  </div>
                  {r.diagnosis && (
                    <div className="ss-repair-diag">{r.diagnosis.slice(0, 300)}{r.diagnosis.length > 300 ? '…' : ''}</div>
                  )}
                  {r.affected_files.length > 0 && (
                    <div className="ss-repair-files">
                      {r.affected_files.map(f => <code key={f} className="ss-repair-file">{f}</code>)}
                    </div>
                  )}
                  {r.proposed_fix && (
                    <details className="ss-repair-diff">
                      <summary>Proposed fix (diff)</summary>
                      <pre>{r.proposed_fix}</pre>
                    </details>
                  )}
                  {r.test_result && (
                    <div className="ss-repair-diag ss-repair-test">{r.test_result.slice(0, 200)}</div>
                  )}
                  <div className="ss-repair-time">{relativeTime(r.created_at)}</div>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
