import { Brain, Power, PowerOff } from 'lucide-react';
import { useAtlasProviderStatus } from '@/hooks/useAtlasProviderStatus';
import { Button, Empty, Panel, Row } from './primitives';

/**
 * The autonomous-learning master switch.
 *
 * WHY THIS EXISTS AGAIN. `LearningControlPanel` lived in the unlinked
 * `/atlas-core-legacy` tree and was deleted with it. It was the ONLY caller of
 * `useAtlasProviderStatus.toggleLearning`, and the only UI anywhere that read or
 * wrote `learning_mode`, `max_topics_per_session` and `max_research_depth`.
 *
 * That made it the one deleted capability with an ongoing consequence rather
 * than a cosmetic one:
 *
 *   - `learning_enabled` seeds to 1 on every fresh install
 *     (src-tauri/src/db_schema.sql:636, services/atlas-brain/src/localDb.ts:341).
 *   - The Rust scheduler POSTs `/proactive/cycle` on a timer
 *     (src-tauri/src/scheduler.rs:44).
 *   - The brain short-circuits that cycle ONLY when `learning_enabled` is 0
 *     (services/atlas-brain/src/proactive.ts:219-221).
 *
 * So background reasoning is on by default, spends real API budget, and — with
 * the panel gone — could be stopped only by hand-editing SQLite. It is back,
 * and it lives in Settings → Budget & AI because the cost is what makes it
 * urgent. It sits ABOVE the analytics fold on purpose: a control that stops
 * spending is not a detail you go looking for.
 *
 * Related but separate: the "Proactive digest" consent on the permissions
 * screen records what the user *agreed* to; this is the runtime switch the
 * brain actually reads. They are not yet wired to each other — saying so is
 * better than implying a link that is not there.
 */

const MODES = [
  { value: 'disabled', label: 'Disabled — never research on its own' },
  { value: 'on_demand', label: 'On demand — only when you ask' },
  { value: 'scheduled', label: 'Scheduled — on the background timer' },
] as const;

const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: 12, fontWeight: 600,
  color: 'var(--ink2)', marginBottom: 6,
};

export function AtlasLearningControl() {
  const {
    settings, isLoading, learningEnabled, learningMode,
    toggleLearning, updateSettings, isToggling, isUpdating,
  } = useAtlasProviderStatus();

  const busy = isToggling || isUpdating;

  return (
    <Panel
      icon={<Brain className="i16" />}
      title="Autonomous learning"
      action={
        settings ? (
          <Button
            size="sm"
            variant={learningEnabled ? 'danger' : 'primary'}
            icon={learningEnabled ? <PowerOff className="i14" /> : <Power className="i14" />}
            loading={busy}
            onClick={() => toggleLearning(!learningEnabled)}
          >
            {learningEnabled ? 'Turn off' : 'Turn on'}
          </Button>
        ) : undefined
      }
    >
      <p className="fs12" style={{ color: 'var(--ink2)', lineHeight: 1.5, marginBottom: 12 }}>
        When this is on, Atlas researches and writes insights on a background timer without being
        asked — which costs API budget and sends a summary of recent memories for reasoning. It is
        on by default on a new install. Turning it off stops the background cycle entirely; you can
        still ask Atlas anything directly.
      </p>

      {isLoading && !settings && <Empty body="Reading system settings…" />}

      {!isLoading && !settings && (
        <Empty
          size="block"
          title="Settings unavailable"
          body="Atlas could not read its system settings. Autonomous learning runs in the desktop app — in a browser there is no local database to read."
          icon={<Brain className="i20" />}
          status="stale"
        />
      )}

      {settings && (
        <>
          <Row
            lead={<span className="kbico">{learningEnabled ? <Power className="i16" /> : <PowerOff className="i16" />}</span>}
            title={learningEnabled ? 'Running on its own' : 'Off — Atlas only responds when asked'}
            meta={
              learningEnabled
                ? 'The background cycle may start research and spend budget without you.'
                : 'The scheduler still ticks, but every cycle returns immediately.'
            }
          />

          <div style={{ paddingTop: 12 }}>
            <label style={labelStyle} htmlFor="learning-mode">When it may run</label>
            <select
              id="learning-mode"
              className="field"
              value={learningMode}
              disabled={busy}
              onChange={(e) => updateSettings({ learning_mode: e.target.value as typeof learningMode })}
            >
              {MODES.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
          </div>

          <div className="fx gap12" style={{ flexWrap: 'wrap', paddingTop: 12 }}>
            <div style={{ flex: '1 1 160px' }}>
              <label style={labelStyle} htmlFor="learning-topics">Topics per session</label>
              <input
                id="learning-topics"
                className="field tnum"
                type="number"
                min={1}
                max={20}
                disabled={busy}
                value={settings.max_topics_per_session ?? 3}
                onChange={(e) =>
                  updateSettings({ max_topics_per_session: Math.max(1, Number(e.target.value) || 1) })
                }
              />
            </div>
            <div style={{ flex: '1 1 160px' }}>
              <label style={labelStyle} htmlFor="learning-depth">Research depth</label>
              <input
                id="learning-depth"
                className="field tnum"
                type="number"
                min={1}
                max={5}
                disabled={busy}
                value={settings.max_research_depth ?? 2}
                onChange={(e) =>
                  updateSettings({ max_research_depth: Math.max(1, Number(e.target.value) || 1) })
                }
              />
            </div>
          </div>
          <p className="fs12" style={{ color: 'var(--ink3)', marginTop: 10, marginBottom: 0 }}>
            Both caps bound one background session: how many topics it may pick up, and how many
            follow-up levels it may chase from each. Lower is cheaper.
          </p>
        </>
      )}
    </Panel>
  );
}

export default AtlasLearningControl;
