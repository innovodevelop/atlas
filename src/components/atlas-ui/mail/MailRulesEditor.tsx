import { useState } from 'react';
import { AlertTriangle, ArrowDown, ArrowUp, Plus, Trash2, X } from 'lucide-react';
import type { MailAccount, MailAutonomyMode, MailRule, MailRuleAction, MailRulePredicate } from '@/types/mail';

// Props are the contract in docs/design-sync/2026-07-27-mail-contract.md §6.3.
export interface MailRulesEditorProps {
  rules: MailRule[];
  accounts: MailAccount[];
  busy: boolean;
  onSave: (rule: Omit<MailRule, 'id'> & { id?: string }) => Promise<MailRule>;
  onDelete: (ruleId: string) => Promise<void>;
  onReorder: (orderedIds: string[]) => Promise<void>;
  onSetAutonomy: (accountId: string, mode: MailAutonomyMode, opts?: { confirmed?: boolean }) => Promise<void>;
  onClose: () => void;
}

const RULE_ACTIONS: MailRuleAction[] = ['approve', 'draft', 'escalate', 'snooze', 'handoff', 'handle'];

const emptyForm = (): {
  id?: string;
  label: string;
  account_id: string | null;
  action: MailRuleAction;
  from_contains: string;
  subject_contains: string;
  body_contains: string;
  mailbox: string;
  has_attachments: boolean;
  unread_only: boolean;
  enabled: boolean;
} => ({
  label: '',
  account_id: null,
  action: 'draft',
  from_contains: '',
  subject_contains: '',
  body_contains: '',
  mailbox: '',
  has_attachments: false,
  unread_only: false,
  enabled: true,
});

/** Summarise a predicate for the rule list row — every present field is an AND. */
function describePredicate(p: MailRulePredicate): string {
  const parts: string[] = [];
  if (p.from_contains) parts.push(`from contains “${p.from_contains}”`);
  if (p.subject_contains) parts.push(`subject contains “${p.subject_contains}”`);
  if (p.body_contains) parts.push(`body contains “${p.body_contains}”`);
  if (p.mailbox) parts.push(`mailbox = ${p.mailbox}`);
  if (p.has_attachments) parts.push('has attachments');
  if (p.unread_only) parts.push('unread only');
  return parts.length ? parts.join(' · ') : 'matches every thread';
}

function buildPredicate(form: ReturnType<typeof emptyForm>): MailRulePredicate {
  const p: MailRulePredicate = {};
  if (form.from_contains.trim()) p.from_contains = form.from_contains.trim();
  if (form.subject_contains.trim()) p.subject_contains = form.subject_contains.trim();
  if (form.body_contains.trim()) p.body_contains = form.body_contains.trim();
  if (form.mailbox.trim()) p.mailbox = form.mailbox.trim();
  if (form.has_attachments) p.has_attachments = true;
  if (form.unread_only) p.unread_only = true;
  return p;
}

export function MailRulesEditor({ rules, accounts, busy, onSave, onDelete, onReorder, onSetAutonomy, onClose }: MailRulesEditorProps) {
  const [form, setForm] = useState(emptyForm());
  const [autonomyDraft, setAutonomyDraft] = useState<Record<string, MailAutonomyMode>>({});
  const [confirmingAccount, setConfirmingAccount] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // A rule save that fails must SAY so. Previously `submit` had try/finally with
  // no catch and was fired as `void submit()`, so a rejection vanished into an
  // unhandled promise: the form kept its contents and the user was left to infer
  // from the absence of a reset that something might not have worked.
  const [saveError, setSaveError] = useState<string | null>(null);

  const sorted = [...rules].sort((a, b) => a.position - b.position);

  const resetForm = () => setForm(emptyForm());

  const editRule = (rule: MailRule) => {
    setForm({
      id: rule.id,
      label: rule.label,
      account_id: rule.account_id,
      action: rule.action,
      from_contains: rule.predicate.from_contains ?? '',
      subject_contains: rule.predicate.subject_contains ?? '',
      body_contains: rule.predicate.body_contains ?? '',
      mailbox: rule.predicate.mailbox ?? '',
      has_attachments: rule.predicate.has_attachments ?? false,
      unread_only: rule.predicate.unread_only ?? false,
      enabled: rule.enabled,
    });
  };

  const submit = async () => {
    if (!form.label.trim()) return;
    setSaving(true);
    setSaveError(null);
    try {
      await onSave({
        id: form.id,
        account_id: form.account_id,
        label: form.label.trim(),
        predicate: buildPredicate(form),
        action: form.action,
        action_config: {},
        enabled: form.enabled,
        position: form.id ? (rules.find((r) => r.id === form.id)?.position ?? sorted.length) : sorted.length,
      });
      resetForm();
    } catch (e) {
      // Keep the form populated so the user's work is not lost on a failure.
      setSaveError(e instanceof Error ? e.message : 'Could not save this rule.');
    } finally {
      setSaving(false);
    }
  };

  const move = (index: number, dir: -1 | 1) => {
    const target = index + dir;
    if (target < 0 || target >= sorted.length) return;
    const ids = sorted.map((r) => r.id);
    [ids[index], ids[target]] = [ids[target], ids[index]];
    void onReorder(ids);
  };

  const applyAutonomy = (accountId: string, mode: MailAutonomyMode) => {
    if (mode === 'autonomous') {
      // 'autonomous' is never a default and never inherited — the hook itself
      // rejects without confirmed:true, but asking here is what turns that
      // guard into an actual deliberate choice instead of a rejected request.
      setConfirmingAccount(accountId);
      setAutonomyDraft((prev) => ({ ...prev, [accountId]: mode }));
      return;
    }
    setConfirmingAccount(null);
    void onSetAutonomy(accountId, mode);
  };

  return (
    <div className="mail-rules">
      <div className="mail-pane-head">
        <h2>Mail rules</h2>
        <button type="button" onClick={onClose} aria-label="Close rules editor">
          <X size={16} aria-hidden />
        </button>
      </div>

      {accounts.map((account) => {
        const pendingMode = autonomyDraft[account.id] ?? account.autonomy_mode;
        return (
          <div key={account.id} className="mail-rules-autonomy">
            <div>
              <strong>{account.email_address}</strong>
              <p className="mail-muted">Autonomy: {account.autonomy_mode}</p>
            </div>
            <select
              value={pendingMode}
              disabled={busy}
              onChange={(e) => applyAutonomy(account.id, e.target.value as MailAutonomyMode)}
            >
              <option value="approve_all">Approve all — Atlas never sends unsupervised</option>
              <option value="conditional">Conditional — rules decide, high-risk still needs approval</option>
              <option value="autonomous">Autonomous — Atlas sends without review</option>
            </select>

            {confirmingAccount === account.id && (
              <div className="mail-rules-autonomy-warn">
                <AlertTriangle size={16} aria-hidden />
                <div>
                  <p>
                    Autonomous mode lets Atlas send mail from {account.email_address} without your review. This is
                    the highest-risk setting in the product and only takes effect if you confirm it here.
                  </p>
                  <div className="mail-compose-actions">
                    <button
                      type="button"
                      className="mail-danger"
                      disabled={busy}
                      onClick={() => {
                        setConfirmingAccount(null);
                        void onSetAutonomy(account.id, 'autonomous', { confirmed: true });
                      }}
                    >
                      Confirm autonomous
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setConfirmingAccount(null);
                        setAutonomyDraft((prev) => ({ ...prev, [account.id]: account.autonomy_mode }));
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        );
      })}

      <div>
        {sorted.length === 0 && <p className="mail-muted">No rules yet — every thread stays in triage until you add one.</p>}
        {sorted.map((rule, i) => (
          <div key={rule.id} className="mail-rules-row">
            {/* CONTRACT-GAP: no §6.4 class exists for the reorder buttons — using
               an unprefixed name (mail-rules-row itself covers layout/spacing). */}
            <div className="rules-order">
              <button type="button" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move rule up">
                <ArrowUp size={13} aria-hidden />
              </button>
              <button type="button" disabled={i === sorted.length - 1} onClick={() => move(i, 1)} aria-label="Move rule down">
                <ArrowDown size={13} aria-hidden />
              </button>
            </div>
            <div>
              <strong>{rule.label}</strong>{' '}
              {!rule.enabled && <span className="mail-muted">(disabled)</span>}
              <p className="mail-muted">
                {describePredicate(rule.predicate)} → {rule.action}
                {rule.account_id ? '' : ' · all mailboxes'}
              </p>
            </div>
            <div className="mail-compose-actions">
              <button type="button" onClick={() => editRule(rule)}>
                Edit
              </button>
              <button type="button" className="mail-danger" disabled={busy} onClick={() => void onDelete(rule.id)}>
                <Trash2 size={13} aria-hidden />
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="mail-rules-form">
        <h3>{form.id ? 'Edit rule' : 'New rule'}</h3>
        <input placeholder="Label" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />
        <select
          value={form.account_id ?? ''}
          onChange={(e) => setForm({ ...form, account_id: e.target.value || null })}
        >
          <option value="">All mailboxes</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.email_address}
            </option>
          ))}
        </select>
        <input
          placeholder="From contains…"
          value={form.from_contains}
          onChange={(e) => setForm({ ...form, from_contains: e.target.value })}
        />
        <input
          placeholder="Subject contains…"
          value={form.subject_contains}
          onChange={(e) => setForm({ ...form, subject_contains: e.target.value })}
        />
        <input
          placeholder="Body contains…"
          value={form.body_contains}
          onChange={(e) => setForm({ ...form, body_contains: e.target.value })}
        />
        <label>
          <input
            type="checkbox"
            checked={form.has_attachments}
            onChange={(e) => setForm({ ...form, has_attachments: e.target.checked })}
          />
          Has attachments
        </label>
        <label>
          <input
            type="checkbox"
            checked={form.unread_only}
            onChange={(e) => setForm({ ...form, unread_only: e.target.checked })}
          />
          Unread only
        </label>
        <select value={form.action} onChange={(e) => setForm({ ...form, action: e.target.value as MailRuleAction })}>
          {RULE_ACTIONS.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <label>
          <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
          Enabled
        </label>
        {saveError && (
          <p className="mail-notice mail-notice-error" role="alert">
            <AlertTriangle className="i14" aria-hidden /> {saveError}
          </p>
        )}
        <div className="mail-compose-actions">
          <button type="button" disabled={!form.label.trim() || busy || saving} onClick={() => void submit()}>
            <Plus size={14} aria-hidden /> {form.id ? 'Save changes' : 'Add rule'}
          </button>
          {form.id && (
            <button type="button" onClick={resetForm}>
              Cancel edit
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
