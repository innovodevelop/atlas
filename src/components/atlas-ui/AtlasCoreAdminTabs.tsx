/**
 * The Atlas Core tabs that only Lighthouse shows.
 *
 * WHY THIS FILE EXISTS AT ALL. `visibleTabs()` in AtlasCoreScreen keeps Live,
 * Agent and Learning out of the consumer tab strip. That hides the UI and does
 * nothing about the code: while these two lived in AtlasCoreTabs.tsx as plain
 * function declarations, Rollup pulled them — and `useAtlasProviderStatus`,
 * and the string `atlas_provider_status` — into the consumer AtlasCoreScreen
 * chunk, where nothing could ever render them. Unreachable operator telemetry
 * is still shipped operator telemetry.
 *
 * So they live behind an `import()` that only the admin branch of a folded
 * ternary names (see AtlasCoreTabs.tsx), which is the same device
 * ADMIN_LOADERS uses in surfaces.ts. `src/editionSplit.test.ts` asserts the
 * strings are absent from `dist/` and present in `dist-admin/`.
 */
import { CheckCircle2, Database, BookOpen, Radio, Zap } from 'lucide-react';
import { useAtlasLearning } from '@/hooks/useAtlasLearning';
import { useAtlasProviderStatus } from '@/hooks/useAtlasProviderStatus';
import { Empty, Panel, Row } from './primitives';
import { fmtAgo } from './coreTabsShared';

export function LiveTab() {
  const { providers } = useAtlasProviderStatus();
  const rows = providers ?? [];
  return (
    <div className="coregrid">
      <Panel icon={<Radio className="i16" />} title="Live connections">
        {rows.map((p: { provider: string; status?: string; is_available?: boolean }) => {
          const ok = p.is_available ?? p.status === 'active';
          return (
            <Row
              key={p.provider}
              lead={<span className="flowdot" style={{ color: ok ? 'var(--grn)' : 'var(--red)' }}><CheckCircle2 className="i16" /></span>}
              title={<span style={{ textTransform: 'capitalize' }}>{p.provider}</span>}
              meta={ok ? 'connected' : (p.status || 'offline')}
              trail={<span className="flowbar" style={{ width: 120 }}><span className="flowfill" style={{ display: 'block', height: '100%', background: ok ? 'var(--grn)' : 'var(--red)', width: ok ? '99%' : '20%' }} /></span>}
            />
          );
        })}
        {rows.length === 0 && <Empty body="No providers reporting." />}
      </Panel>
      <Panel icon={<Zap className="i16" />} title="Ambient">
        <Row lead={<span className="kbico"><Radio className="i16" /></span>} title={'Listening for "Hey Atlas"'} meta="wake word · ambient" />
      </Panel>
    </div>
  );
}

export function LearningTab() {
  const { validationLogs, learningMetrics } = useAtlasLearning();
  const logs = (validationLogs ?? []).slice(0, 6);
  const m = learningMetrics;
  return (
    <div className="coregrid">
      <Panel icon={<Zap className="i16" />} title="Learning metrics">
        <Row
          lead={<span className="flowdot" style={{ color: 'var(--grn)' }}><CheckCircle2 className="i16" /></span>}
          title="Validation success"
          meta={`${m.successRate}% pass`}
          trail={<span className="flowbar" style={{ width: 120 }}><span className="flowfill" style={{ display: 'block', height: '100%', background: 'var(--grn)', width: `${m.successRate}%` }} /></span>}
        />
        <Row lead={<span className="flowdot"><Database className="i16" /></span>} title="Knowledge velocity" meta={`${m.knowledgeVelocity}/period`} />
        <Row lead={<span className="flowdot"><BookOpen className="i16" /></span>} title="Queue depth" meta={`${m.queueDepth} queued`} />
      </Panel>
      <Panel icon={<CheckCircle2 className="i16" />} title="Recent validations">
        {logs.map((v: { id: string; verdict: string; created_at: string; grounding?: string }) => (
          <Row
            key={v.id}
            lead={<span className={`errsev ${v.verdict === 'valid' ? 'sev-i' : v.verdict === 'fake' ? 'sev-e' : 'sev-w'}`} />}
            title={<span style={{ textTransform: 'capitalize' }}>{v.verdict}{v.grounding ? ` · ${v.grounding}` : ''}</span>}
            meta={fmtAgo(v.created_at)}
          />
        ))}
        {logs.length === 0 && <Empty body="No validations yet." />}
      </Panel>
    </div>
  );
}
