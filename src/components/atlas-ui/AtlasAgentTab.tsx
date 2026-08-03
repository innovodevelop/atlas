import { useEffect, useMemo, useState } from 'react';
import {
  Bot, AlertTriangle, Plus, Trash2, Power, PowerOff, Pencil, Clock,
  Play, Wrench, ChevronDown, ChevronUp, ListTree, X, Check,
} from 'lucide-react';
import { useAgents, type Agent, type AgentFormData } from '@/hooks/useAgents';
import { useApprovals } from '@/hooks/useApprovals';
import { useSchedules } from '@/hooks/useSchedules';
import { useToolCalls } from '@/hooks/useToolCalls';
import { useAgentRuns } from '@/hooks/useAgentRuns';
import { useAuth } from '@/hooks/useAuth';
import { SignedOut } from './SignedOut';
import { Button, Empty, Panel, Row } from './primitives';

/**
 * Atlas Core → Agent.
 *
 * T4 part 2, the absorb pass. Four capabilities that existed ONLY inside the
 * unlinked `/atlas-core-legacy` tree now live on the one Agent surface the app
 * actually links to:
 *
 *   - agent create / edit / delete / activate   (was AgentConfigPanel)
 *   - schedules: toggle, run now, delete        (was SchedulesPanel)
 *   - the last 20 tool calls with their args    (was ToolCallsPanel)
 *   - the run timeline, plus cancel             (was LiveRunTimeline + AgentRunsPanel)
 *
 * T4 part 3 added a fifth as the legacy tree was deleted:
 *
 *   - approve / reject-with-reason              (was ApprovalsQueuePanel)
 *
 * Before this the tab was two read-only lists (`AtlasCoreTabs.tsx:86-106`):
 * agents you could look at but not make, and approvals you could see but not
 * grant. Those lists are still here — they are the tab's summary — but every
 * write path the legacy tree owned is now reachable.
 *
 * THREE DECISIONS the audit asked for before implementation, made here:
 *
 * 1. NO MODAL. The legacy panels used shadcn `dialog` + `alert-dialog`; T1 ships
 *    no modal primitive and adding one for a create form and two confirms is a
 *    bigger commitment than the surface needs. Creating and editing happen in an
 *    inline form inside the panel; deleting uses the two-click confirm already
 *    proven in Settings (`AtlasSettings.tsx:265-285`, the Spotify disconnect).
 *    One less focus trap to get wrong, and the destructive copy stays visible
 *    next to the thing it destroys.
 *
 * 2. NO shadcn FORM CONTROLS. T1 has no select/checkbox/textarea/switch, so the
 *    form uses native elements on the existing borderless `.field` class. A
 *    native `<select>` is also the only control here that is keyboard- and
 *    VoiceOver-correct for free.
 *
 * 3. HONEST MODEL NAMES. `MODEL_OPTIONS` in the legacy panel offered
 *    `openai/gpt-5*` and `google/gemini-2.5-*`. Those are the gateway's *logical*
 *    ids and they do still resolve — `mapModelToClaude`
 *    (supabase/functions/_shared/claudeAdapter.ts:28-35) maps every one of them
 *    onto a Claude tier — but naming a model Atlas does not run, in a form whose
 *    whole job is choosing a model, is a lie with a working code path behind it.
 *    The options are the three tiers the adapter actually reaches, which it
 *    passes through unchanged (`:40`). `useAgents.DEFAULT_MODELS` was corrected
 *    in the same pass so the default and the menu agree.
 *
 * WHAT THE EMPTY STATES MEAN. Nothing in the local stack writes `runs`,
 * `run_steps`, `tool_calls` or `schedules` — the agent orchestrator is not
 * built, so these four tables are populated by nothing but this UI. Every panel
 * below therefore says what is missing rather than showing a plausible row: the
 * legacy panels' "No tool calls yet" was true but incurious. `<Empty>` here
 * names the reason.
 */

const MODEL_OPTIONS = [
  { value: 'claude-haiku-4-5', label: 'Haiku 4.5 — fastest, cheapest' },
  { value: 'claude-sonnet-5', label: 'Sonnet 5 — balanced' },
  { value: 'claude-opus-4-8', label: 'Opus 4.8 — deepest reasoning' },
];

const fmtAgo = (iso?: string | null) => {
  if (!iso) return 'never';
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: 12, fontWeight: 600,
  color: 'var(--ink2)', marginBottom: 6,
};

// ---------------------------------------------------------------------------
// Agents — create / edit / delete / activate
// ---------------------------------------------------------------------------

function AgentForm({
  initial, tools, riskyDefaults, busy, onCancel, onSubmit,
}: {
  initial?: Agent;
  tools: string[];
  riskyDefaults: string[];
  busy: boolean;
  onCancel: () => void;
  onSubmit: (data: AgentFormData) => void;
}) {
  const [form, setForm] = useState<AgentFormData>(() => ({
    name: initial?.name ?? '',
    description: initial?.description ?? '',
    system_prompt: initial?.system_prompt ?? 'You are a helpful assistant.',
    model_config_json: initial?.model_config_json ?? {
      planner: 'claude-opus-4-8', worker: 'claude-sonnet-5', reasoner: 'claude-opus-4-8',
    },
    enabled_tools_json: initial?.enabled_tools_json ?? tools.filter((t) => !riskyDefaults.includes(t)),
    risky_tools_json: initial?.risky_tools_json ?? riskyDefaults,
    max_steps: initial?.max_steps ?? 20,
    daily_budget_limit: initial?.daily_budget_limit ?? 5,
    is_active: initial?.is_active ?? true,
  }));

  const setModel = (tier: 'planner' | 'worker' | 'reasoner', value: string) =>
    setForm((f) => ({ ...f, model_config_json: { ...f.model_config_json, [tier]: value } }));

  const toggleTool = (tool: string) =>
    setForm((f) => {
      const on = (f.enabled_tools_json ?? []).includes(tool);
      return {
        ...f,
        enabled_tools_json: on
          ? (f.enabled_tools_json ?? []).filter((t) => t !== tool)
          : [...(f.enabled_tools_json ?? []), tool],
      };
    });

  const valid = form.name.trim().length > 0 && form.system_prompt.trim().length > 0;

  return (
    <div className="col gap16" style={{ paddingTop: 12 }}>
      <div>
        <label style={labelStyle} htmlFor="agent-name">Name</label>
        <input
          id="agent-name"
          className="field"
          value={form.name}
          placeholder="Inbox triage"
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
        />
      </div>

      <div>
        <label style={labelStyle} htmlFor="agent-desc">Description</label>
        <input
          id="agent-desc"
          className="field"
          value={form.description ?? ''}
          placeholder="What this agent is for"
          onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
        />
      </div>

      <div>
        <label style={labelStyle} htmlFor="agent-prompt">System prompt</label>
        <textarea
          id="agent-prompt"
          className="field"
          rows={4}
          style={{ resize: 'vertical', borderRadius: 14 }}
          value={form.system_prompt}
          onChange={(e) => setForm((f) => ({ ...f, system_prompt: e.target.value }))}
        />
      </div>

      <div className="fx gap12" style={{ flexWrap: 'wrap' }}>
        {(['planner', 'worker', 'reasoner'] as const).map((tier) => (
          <div key={tier} style={{ flex: '1 1 180px', minWidth: 0 }}>
            <label style={labelStyle} htmlFor={`agent-${tier}`}>
              <span style={{ textTransform: 'capitalize' }}>{tier}</span> model
            </label>
            <select
              id={`agent-${tier}`}
              className="field"
              value={form.model_config_json?.[tier] ?? ''}
              onChange={(e) => setModel(tier, e.target.value)}
            >
              {MODEL_OPTIONS.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
          </div>
        ))}
      </div>

      <div className="fx gap12" style={{ flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 160px' }}>
          <label style={labelStyle} htmlFor="agent-steps">Max steps per run</label>
          <input
            id="agent-steps"
            className="field tnum"
            type="number"
            min={1}
            max={200}
            value={form.max_steps ?? 20}
            onChange={(e) => setForm((f) => ({ ...f, max_steps: Number(e.target.value) || 1 }))}
          />
        </div>
        <div style={{ flex: '1 1 160px' }}>
          <label style={labelStyle} htmlFor="agent-budget">Daily budget (USD)</label>
          <input
            id="agent-budget"
            className="field tnum"
            type="number"
            min={0}
            step={0.5}
            value={form.daily_budget_limit ?? 5}
            onChange={(e) => setForm((f) => ({ ...f, daily_budget_limit: Number(e.target.value) || 0 }))}
          />
        </div>
      </div>

      <div>
        <p style={labelStyle}>Tools</p>
        <div className="fx gap8" style={{ flexWrap: 'wrap' }}>
          {tools.map((tool) => {
            const on = (form.enabled_tools_json ?? []).includes(tool);
            const risky = (form.risky_tools_json ?? []).includes(tool);
            return (
              <label
                key={tool}
                className="fx ac gap6 fs12"
                style={{
                  padding: '7px 11px', borderRadius: 999, cursor: 'pointer',
                  background: on ? 'var(--wash)' : 'var(--rz)',
                  color: on ? 'var(--acc-text)' : 'var(--ink2)',
                }}
              >
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => toggleTool(tool)}
                  style={{ accentColor: 'var(--acc)' }}
                />
                <span>{tool}</span>
                {/* Risky tools are the ones that go to the approvals queue.
                    Marking them in the picker is the only place the user is
                    told which choices will interrupt them later. */}
                {risky && <AlertTriangle className="i12" aria-label="needs approval" />}
              </label>
            );
          })}
        </div>
      </div>

      <div className="fx ac gap8">
        <Button variant="primary" size="sm" loading={busy} disabled={!valid} onClick={() => onSubmit(form)}>
          {initial ? 'Save changes' : 'Create agent'}
        </Button>
        <Button size="sm" onClick={onCancel} disabled={busy}>Cancel</Button>
        {!valid && <span className="fs12" style={{ color: 'var(--ink3)' }}>Name and system prompt are required.</span>}
      </div>
    </div>
  );
}

function AgentsPanel() {
  const {
    agents, isLoading, createAgent, updateAgent, deleteAgent, toggleAgent,
    availableTools, defaultRiskyTools,
  } = useAgents();

  // `null` = no form; `'new'` = create; an id = edit that agent. One piece of
  // state instead of the legacy panel's four booleans.
  const [editing, setEditing] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const editingAgent = editing && editing !== 'new' ? agents.find((a) => a.id === editing) : undefined;

  const submit = async (data: AgentFormData) => {
    setBusy(true);
    setError(null);
    try {
      if (editingAgent) await updateAgent(editingAgent.id, data);
      else await createAgent(data);
      setEditing(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the agent.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      await deleteAgent(id);
      setConfirmDelete(null);
      if (editing === id) setEditing(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not delete the agent.');
    } finally {
      setBusy(false);
    }
  };

  // `toggleAgent` rejects like every other write here (useAgents throws on any
  // local-DB error). Firing it bare left the row showing the old state, said
  // nothing, and escaped to window.onunhandledrejection — which the packaged
  // webview's crash reporter watches.
  const toggle = async (id: string, next: boolean) => {
    setError(null);
    try {
      await toggleAgent(id, next);
    } catch (e) {
      setError(e instanceof Error ? e.message : `Could not ${next ? 'activate' : 'pause'} the agent.`);
    }
  };

  return (
    <Panel
      icon={<Bot className="i16" />}
      title="Agents"
      action={
        editing === null ? (
          <Button size="sm" variant="primary" icon={<Plus className="i14" />} onClick={() => setEditing('new')}>
            New
          </Button>
        ) : undefined
      }
    >
      {agents.map((a) => (
        <div key={a.id}>
          <Row
            lead={<span className="kbico"><Bot className="i16" /></span>}
            title={a.name}
            meta={`${a.is_active ? 'active' : 'paused'} · ${a.max_steps} steps · $${a.daily_budget_limit}/day · ${(a.enabled_tools_json ?? []).length} tools`}
            trail={
              <span className="fx ac gap6">
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={a.is_active ? `Pause ${a.name}` : `Activate ${a.name}`}
                  title={a.is_active ? 'Pause' : 'Activate'}
                  onClick={() => void toggle(a.id, !a.is_active)}
                >
                  {a.is_active ? <Power className="i14" /> : <PowerOff className="i14" />}
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={`Edit ${a.name}`}
                  title="Edit"
                  onClick={() => { setConfirmDelete(null); setEditing(a.id); }}
                >
                  <Pencil className="i14" />
                </Button>
                <Button
                  size="icon"
                  variant="danger"
                  aria-label={`Delete ${a.name}`}
                  title="Delete"
                  onClick={() => setConfirmDelete(a.id)}
                >
                  <Trash2 className="i14" />
                </Button>
              </span>
            }
          />

          {/* Two-click confirm rather than an alert-dialog. Deleting an agent
              cascades its runs (db_schema.sql: runs.agent_id ON DELETE
              CASCADE), so the copy says so instead of asking "are you sure". */}
          {confirmDelete === a.id && (
            <Panel tone="recessed" pad="sm" className="col gap10">
              <p className="fs12 m0" style={{ color: 'var(--ink2)', lineHeight: 1.5 }}>
                Deleting <strong>{a.name}</strong> also deletes its run history and step log. Its schedules stop firing. This cannot be undone.
              </p>
              <div className="fx ac gap8">
                <Button variant="danger" size="sm" loading={busy} icon={<Trash2 className="i14" />} onClick={() => void remove(a.id)}>
                  Delete agent
                </Button>
                <Button size="sm" onClick={() => setConfirmDelete(null)} disabled={busy}>Keep it</Button>
              </div>
            </Panel>
          )}

          {editing === a.id && (
            <AgentForm
              initial={a}
              tools={availableTools}
              riskyDefaults={defaultRiskyTools}
              busy={busy}
              onCancel={() => setEditing(null)}
              onSubmit={submit}
            />
          )}
        </div>
      ))}

      {isLoading && <Empty body="Loading agents…" />}
      {!isLoading && agents.length === 0 && editing === null && (
        <Empty
          size="block"
          title="No agents yet"
          body="An agent is a named goal with its own model tiers, tool list and daily budget. Create one to give Atlas something it can run on its own."
          icon={<Bot className="i20" />}
          status="resting"
          action={{ label: 'Create the first agent', onClick: () => setEditing('new') }}
        />
      )}

      {editing === 'new' && (
        <AgentForm
          tools={availableTools}
          riskyDefaults={defaultRiskyTools}
          busy={busy}
          onCancel={() => setEditing(null)}
          onSubmit={submit}
        />
      )}

      {error && <p className="fs12" style={{ color: 'var(--negative)' }}>{error}</p>}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Approvals — A7, absorbed in T4 part 3 (the deletion pass)
//
// The read-only list was already here; the WRITE half lived only in
// `atlas-health/ApprovalsQueuePanel`, which part 3 deletes. `useApprovals`
// exposes `approveRequest`/`rejectRequest` and is otherwise live, so deleting
// that panel without this would have left Atlas able to SHOW a risky action
// waiting on consent and never able to grant or refuse one — the highest-
// severity capability loss in the tree.
//
// Reject takes a mandatory reason (the hook's signature requires it, and the
// reason is what the agent gets told), so rejecting opens the inline confirm
// rather than firing on one click. Approving is one click: it is the
// non-destructive direction and the row already states what it is approving.
// ---------------------------------------------------------------------------

function ApprovalsPanel() {
  const { approvals, approveRequest, rejectRequest } = useApprovals();
  const pending = (approvals ?? []).filter((a) => a.status === 'pending');
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const act = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id);
    setError(null);
    try { await fn(); } catch (e) {
      setError(e instanceof Error ? e.message : 'That did not go through.');
    } finally { setBusy(null); }
  };

  return (
    <Panel icon={<AlertTriangle className="i16" />} title={`Needs approval · ${pending.length}`}>
      {pending.map((a) => (
        <div key={a.id}>
          <Row
            lead={<span className="kbico"><AlertTriangle className="i16" /></span>}
            title={a.action_summary}
            meta={`${a.risk_level || 'review'} · ${fmtAgo(a.created_at)}`}
            trail={
              <span className="fx ac gap6">
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={`Approve: ${a.action_summary}`}
                  title="Approve"
                  loading={busy === a.id && rejecting !== a.id}
                  onClick={() => void act(a.id, () => approveRequest(a.id))}
                >
                  <Check className="i14" />
                </Button>
                <Button
                  size="icon"
                  variant="danger"
                  aria-label={`Reject: ${a.action_summary}`}
                  title="Reject"
                  onClick={() => { setRejecting(a.id); setReason(''); }}
                >
                  <X className="i14" />
                </Button>
              </span>
            }
          />
          {rejecting === a.id && (
            <Panel tone="recessed" pad="sm" className="col gap10">
              <p className="fs12 m0" style={{ color: 'var(--ink2)', lineHeight: 1.5 }}>
                Why are you refusing this? The agent is told the reason, so it can
                pick a different route instead of retrying the same one.
              </p>
              <textarea
                className="field"
                rows={2}
                value={reason}
                aria-label="Reason for rejecting"
                placeholder="Not this account / too broad / do it manually…"
                onChange={(e) => setReason(e.target.value)}
              />
              <div className="fx ac gap8">
                <Button
                  variant="danger" size="sm" icon={<X className="i14" />}
                  disabled={!reason.trim()}
                  loading={busy === a.id}
                  onClick={() => void act(a.id, async () => {
                    await rejectRequest(a.id, reason.trim());
                    setRejecting(null);
                    setReason('');
                  })}
                >
                  Reject
                </Button>
                <Button size="sm" onClick={() => setRejecting(null)}>Cancel</Button>
              </div>
            </Panel>
          )}
        </div>
      ))}
      {pending.length === 0 && <Empty body="Nothing waiting on you." status="resting" />}
      {error && <p className="fs12" style={{ color: 'var(--negative)' }}>{error}</p>}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------

function SchedulesPanel() {
  const { schedules, isLoading, toggleSchedule, runNow, deleteSchedule } = useSchedules();
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const act = async (id: string, fn: () => Promise<unknown>) => {
    setRunning(id);
    setError(null);
    try { await fn(); } catch (e) {
      setError(e instanceof Error ? e.message : 'That did not work.');
    } finally { setRunning(null); }
  };

  return (
    <Panel icon={<Clock className="i16" />} title="Schedules">
      {schedules.map((s) => (
        <div key={s.id}>
          <Row
            lead={<span className="kbico"><Clock className="i16" /></span>}
            title={s.name}
            meta={`${s.agent?.name ?? 'unassigned agent'} · ${s.cron_expression} · ${s.enabled ? 'enabled' : 'paused'} · last run ${fmtAgo(s.last_run_at)}${s.last_run_status ? ` (${s.last_run_status})` : ''}`}
            trail={
              <span className="fx ac gap6">
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={s.enabled ? `Pause ${s.name}` : `Enable ${s.name}`}
                  title={s.enabled ? 'Pause' : 'Enable'}
                  onClick={() => void act(s.id, () => toggleSchedule(s.id, !s.enabled))}
                >
                  {s.enabled ? <Power className="i14" /> : <PowerOff className="i14" />}
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={`Run ${s.name} now`}
                  title="Run now"
                  loading={running === s.id}
                  onClick={() => void act(s.id, () => runNow(s.id))}
                >
                  <Play className="i14" />
                </Button>
                <Button
                  size="icon"
                  variant="danger"
                  aria-label={`Delete ${s.name}`}
                  title="Delete"
                  onClick={() => setConfirmDelete(s.id)}
                >
                  <Trash2 className="i14" />
                </Button>
              </span>
            }
          />
          {confirmDelete === s.id && (
            <Panel tone="recessed" pad="sm" className="col gap10">
              <p className="fs12 m0" style={{ color: 'var(--ink2)', lineHeight: 1.5 }}>
                Delete <strong>{s.name}</strong>? Runs it already created are kept; it simply stops firing.
              </p>
              <div className="fx ac gap8">
                <Button
                  variant="danger" size="sm" icon={<Trash2 className="i14" />}
                  loading={running === s.id}
                  onClick={() => void act(s.id, async () => { await deleteSchedule(s.id); setConfirmDelete(null); })}
                >
                  Delete schedule
                </Button>
                <Button size="sm" onClick={() => setConfirmDelete(null)}>Keep it</Button>
              </div>
            </Panel>
          )}
        </div>
      ))}

      {isLoading && <Empty body="Loading schedules…" />}
      {/* Honest about the missing half: `useSchedules` can insert (`:92` creates
          a run) but there has never been a create-schedule UI anywhere in the
          app, legacy tree included. Saying "none yet" and stopping would imply
          a button exists somewhere. */}
      {!isLoading && schedules.length === 0 && (
        <Empty
          size="block"
          title="No schedules"
          body="Schedules run an agent on a cron expression. Atlas has no UI for creating one yet — the legacy screen this tab absorbed could only list, pause, run and delete them."
          icon={<Clock className="i20" />}
          status="resting"
        />
      )}
      {error && <p className="fs12" style={{ color: 'var(--negative)' }}>{error}</p>}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Tool calls
// ---------------------------------------------------------------------------

function ToolCallsPanel() {
  const { toolCalls, isLoading } = useToolCalls(20);
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <Panel icon={<Wrench className="i16" />} title={`Tool calls · ${toolCalls.length}`}>
      {toolCalls.map((tc) => {
        const open = expanded === tc.id;
        return (
          <div key={tc.id}>
            <Row
              onSelect={() => setExpanded(open ? null : tc.id)}
              selected={open}
              lead={<span className="kbico"><Wrench className="i16" /></span>}
              title={
                <span className="fx ac gap8">
                  {tc.tool_name}
                  {tc.requires_approval && <AlertTriangle className="i12" aria-label="required approval" />}
                </span>
              }
              meta={`${tc.status} · ${fmtAgo(tc.created_at)}${tc.cost_estimate ? ` · $${tc.cost_estimate.toFixed(4)}` : ''}`}
              trail={open ? <ChevronUp className="i16" /> : <ChevronDown className="i16" />}
            />
            {open && (
              <Panel tone="recessed" pad="sm" className="col gap10">
                <div>
                  <p className="fs12 m0" style={{ color: 'var(--ink3)', marginBottom: 4 }}>Arguments</p>
                  <pre className="fs12 m0" style={{ maxHeight: 140, overflow: 'auto', whiteSpace: 'pre-wrap', color: 'var(--ink2)' }}>
                    {JSON.stringify(tc.args_json, null, 2)}
                  </pre>
                </div>
                {tc.result_json != null && (
                  <div>
                    <p className="fs12 m0" style={{ color: 'var(--ink3)', marginBottom: 4 }}>Result</p>
                    <pre className="fs12 m0" style={{ maxHeight: 140, overflow: 'auto', whiteSpace: 'pre-wrap', color: 'var(--ink2)' }}>
                      {JSON.stringify(tc.result_json, null, 2)}
                    </pre>
                  </div>
                )}
                {tc.error_message && (
                  <p className="fs12 m0" style={{ color: 'var(--negative)' }}>{tc.error_message}</p>
                )}
              </Panel>
            )}
          </div>
        );
      })}

      {isLoading && <Empty body="Loading tool calls…" />}
      {!isLoading && toolCalls.length === 0 && (
        <Empty
          size="block"
          title="No tool calls"
          body="Every tool an agent reaches for is logged here with its arguments and result. Nothing has run yet."
          icon={<Wrench className="i20" />}
          status="resting"
        />
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Run timeline
// ---------------------------------------------------------------------------

const STEP_LABEL: Record<string, string> = {
  planning: 'Plan', thinking: 'Think', tool_call: 'Tool call',
  tool_result: 'Tool result', response: 'Respond', verification: 'Verify', error: 'Error',
};

function RunTimelinePanel() {
  const { runs, activeRun, runSteps, isLoading, fetchRunSteps, cancelRun } = useAgentRuns(10);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Follow the active run unless the user has picked one explicitly.
  const runId = selectedId ?? activeRun?.id ?? runs[0]?.id ?? null;
  const run = useMemo(() => runs.find((r) => r.id === runId) ?? null, [runs, runId]);

  useEffect(() => {
    if (runId) void fetchRunSteps(runId);
  }, [runId, fetchRunSteps]);

  const live = run?.status === 'running' || run?.status === 'pending';
  const tokens = run ? run.tokens_planner + run.tokens_worker + run.tokens_reasoner : 0;

  return (
    <Panel
      icon={<ListTree className="i16" />}
      title="Run timeline"
      action={
        run && live ? (
          <Button size="sm" variant="danger" icon={<X className="i14" />} onClick={() => void cancelRun(run.id)}>
            Cancel run
          </Button>
        ) : undefined
      }
    >
      {runs.length > 0 && (
        <select
          className="field"
          style={{ marginBottom: 12 }}
          aria-label="Choose a run"
          value={runId ?? ''}
          onChange={(e) => setSelectedId(e.target.value)}
        >
          {runs.map((r) => (
            <option key={r.id} value={r.id}>
              {r.status} · {r.agent?.name ?? 'agent'} · {r.goal_text.slice(0, 60)}
            </option>
          ))}
        </select>
      )}

      {run && (
        <Row
          lead={<span className="kbico"><Bot className="i16" /></span>}
          title={run.goal_text}
          meta={`${run.status} · started ${fmtAgo(run.started_at ?? run.created_at)} · ${tokens.toLocaleString()} tokens${run.cost_estimate ? ` · $${run.cost_estimate.toFixed(4)}` : ''}`}
        />
      )}

      {runSteps.map((s) => (
        <Row
          key={s.id}
          density="compact"
          lead={<span className="tnum" style={{ color: 'var(--ink3)' }}>{s.step_index + 1}</span>}
          leadWidth={28}
          title={STEP_LABEL[s.kind] ?? s.kind}
          meta={[
            s.model_used ?? undefined,
            s.model_tier ?? undefined,
            s.tokens_used ? `${s.tokens_used.toLocaleString()} tokens` : undefined,
            s.finished_at ? undefined : 'in progress',
          ].filter(Boolean).join(' · ')}
        />
      ))}

      {isLoading && <Empty body="Loading runs…" />}
      {!isLoading && runs.length === 0 && (
        <Empty
          size="block"
          title="No runs"
          body="A run is one agent working a goal, step by step. Atlas has no orchestrator writing runs yet, so this stays empty until an agent is actually executed."
          icon={<ListTree className="i20" />}
          status="resting"
        />
      )}
      {!isLoading && run && runSteps.length === 0 && (
        <Empty body="This run recorded no steps." />
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------

export function AgentTab() {
  const { user, loading } = useAuth();

  // `/atlas-core` is not auth-gated. Signed out, every hook on this tab now
  // resolves without querying (the fix for the permanent spinner), so each
  // panel would confidently render "No agents yet" / "No runs" / "Nothing
  // waiting on you" about tables it never read — and offer a Create button that
  // throws `Not authenticated`. One honest notice instead of five false ones.
  if (!loading && !user) return <SignedOut what="Agents, schedules, tool calls and runs" />;

  return (
    <div className="coregrid">
      <AgentsPanel />
      <ApprovalsPanel />
      <SchedulesPanel />
      <ToolCallsPanel />
      <RunTimelinePanel />
    </div>
  );
}
