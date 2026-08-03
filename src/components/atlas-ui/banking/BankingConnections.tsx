import { Landmark, Lock, ShieldCheck, Building2 } from 'lucide-react';
import { Button, Empty, Panel, Row } from '@/components/atlas-ui/primitives';
import type { BankingAccounts, BankingPolicy } from '@/lib/mocks/banking';

/**
 * Connections — the design's Settings view.
 *
 * This is the honest anchor of the whole surface, and the only place on it that
 * states real facts: the provider, the environment, and the five things Atlas
 * is and is not permitted to do with bank access. Everything ELSE here (the
 * institution list, the connected banks, the entity totals) is the same sample
 * fiction as the money grid and carries the same stamp.
 *
 * THREE CONTROLS THE DESIGN DRAWS AS LIVE ARE NOT LIVE HERE, deliberately:
 *
 *  1. The institution search and its "Add bank" button. There is no consent
 *     flow to start — the registration is sandbox-only — so both are `disabled`
 *     with the reason on screen. A search field that accepts a query and does
 *     nothing is worse than no field.
 *  2. The suggested-institution tiles. Same reason, same treatment, plus the
 *     sample stamp: the six names are design copy, not a real coverage list.
 *  3. The permission switches. `role="switch"` with `aria-disabled`, showing the
 *     policy rather than editing it, because nothing persists a change. "Move
 *     money" goes further and renders as a fixed NEVER pill with no switch at
 *     all: it is a product guarantee, not a preference, and drawing it as a
 *     toggle would imply it could be turned on.
 *
 * The `Renew` action on a consent that is about to expire is likewise inert and
 * disabled — renewal is the same consent flow that does not exist yet.
 */

interface BankingConnectionsProps {
  policy: BankingPolicy;
  /** `null` is the real day-one state: a live adapter with nothing connected. */
  accounts: BankingAccounts | null;
  /** Stamps the mock-sourced blocks. False once a real adapter is wired. */
  sample: boolean;
}

const KIND_LABEL: Record<string, string> = {
  personal: 'personal',
  joint: 'joint',
  business: 'business',
};

export const BankingConnections = ({ policy, accounts, sample }: BankingConnectionsProps) => (
  <div className="bank-connections">
    <section className="bank-conn-col">
      {/* ---- Provider status. Real. -------------------------------------- */}
      <Panel tone="wash" pad="lg" className="bank-provider">
        <p className="bank-eyebrow">Open banking</p>
        <h2 className="bank-h2">Connect a bank</h2>
        <p className="bank-lede">
          Atlas connects through your bank’s own consent screen. It receives read-only
          access to balances and transactions — never your credentials, and never
          permission to move money.
        </p>
        <div className="bank-provider-state">
          <span className="bank-provider-chip">
            <Lock className="i14" aria-hidden />
            {policy.provider} · {policy.environment}
          </span>
          <p className="bank-provider-reason">{policy.reason}</p>
        </div>

        <div className="bank-search" aria-hidden={false}>
          <input
            className="bank-search-input"
            placeholder="Search banks and card issuers"
            disabled
            aria-label="Search banks and card issuers"
          />
          <Button variant="primary" size="sm" disabled title={policy.reason}>Add bank</Button>
        </div>
      </Panel>

      {/* ---- Suggested institutions. Sample. ----------------------------- */}
      <Panel pad="lg">
        {/* The stamp is gated on there being something to stamp. An empty panel
            labelled "Sample" claims fiction it is not showing, which is its own
            small dishonesty. */}
        <div className="bank-panel-head">
          <p className="bank-eyebrow">Institutions</p>
          {sample && accounts && accounts.suggested.length > 0 && (
            <span className="bank-stamp">Sample</span>
          )}
        </div>
        {accounts && accounts.suggested.length > 0 ? (
          <>
            <div className="bank-tiles">
              {accounts.suggested.map((b) => (
                <button
                  key={b.id}
                  className="bank-tile"
                  disabled
                  title={policy.reason}
                >
                  <span className="bank-mark" style={{ background: b.mark }} aria-hidden>{b.initial}</span>
                  <span className="bank-tile-text">
                    <span className="bank-tile-name trunc">{b.name}</span>
                    <span className="bank-tile-meta trunc">{b.meta}</span>
                  </span>
                </button>
              ))}
            </div>
            <Empty body="Every tile is disabled: there is no consent flow to start while the registration is sandbox-only." />
          </>
        ) : (
          <Empty
            size="block"
            icon={<Landmark className="i20" />}
            title="No institution list"
            body="Coverage is published by the open-banking provider. Atlas will list what it can actually reach, once it can reach anything."
            status="stale"
          />
        )}
      </Panel>

      {/* ---- Connected banks. Sample. ------------------------------------ */}
      <Panel pad="lg">
        <div className="bank-panel-head">
          <p className="bank-eyebrow">Connected</p>
          {accounts && accounts.banks.length > 0 && (
            <span className="bank-panel-meta tnum">
              {accounts.banks.length} banks · {accounts.entities.length} entities
            </span>
          )}
          {sample && accounts && accounts.banks.length > 0 && <span className="bank-stamp">Sample</span>}
        </div>

        {accounts && accounts.banks.length > 0 ? (
          accounts.banks.map((b) => (
            <Row
              key={b.id}
              lead={<span className="bank-mark bank-mark-lg" style={{ background: b.mark }} aria-hidden>{b.initial}</span>}
              leadWidth={34}
              title={<>{b.name}<span className="bank-row-kind">{KIND_LABEL[b.kind]}</span></>}
              meta={b.accounts}
              trail={
                <>
                  <span className="bank-bank-figures">
                    <span className="bank-bank-balance tnum">{b.balance}</span>
                    <span className={`bank-bank-consent${b.consentDue ? ' due' : ''}`}>{b.consent}</span>
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled
                    title={policy.reason}
                  >
                    {b.consentDue ? 'Renew' : 'Manage'}
                  </Button>
                </>
              }
            />
          ))
        ) : (
          <Empty
            size="block"
            icon={<Landmark className="i20" />}
            title="No bank connected"
            body="Balances, cards, transactions and entities all come from an open-banking connection. Atlas has none, and cannot make one from this build."
            status="stale"
          />
        )}
      </Panel>
    </section>

    <section className="bank-conn-col">
      {/* ---- Entities. Sample, on the ink card. -------------------------- */}
      <Panel tone="ink" pad="lg">
        <p className="bank-eyebrow bank-eyebrow-ink">Entities</p>
        <h2 className="bank-h2 bank-h2-ink">Personal and business, kept apart</h2>
        <p className="bank-lede bank-lede-ink">
          Each entity has its own accounts, its own rules and its own view. Atlas never
          nets one against the other, and business figures stay out of personal answers.
        </p>
        {accounts && accounts.entities.length > 0 ? (
          <div className="bank-entities">
            {sample && <span className="bank-stamp bank-stamp-ink">Sample</span>}
            {accounts.entities.map((e) => (
              <div className="bank-entity" key={e.id}>
                <div className="bank-entity-main">
                  <p className="bank-entity-name trunc">{e.name}</p>
                  <p className="bank-entity-meta trunc">{e.meta}</p>
                </div>
                <span className="bank-entity-value tnum">{e.value}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="bank-empty-ink">
            <Building2 className="i16" aria-hidden />
            No entities yet. The first one is created when a bank is connected.
          </p>
        )}
      </Panel>

      {/* ---- Permissions. Real policy, read-only. ------------------------ */}
      <Panel pad="lg">
        <div className="bank-panel-head">
          <p className="bank-eyebrow">What Atlas may do</p>
          <span className="bank-panel-meta">
            <ShieldCheck className="i14" aria-hidden /> Read-only
          </span>
        </div>
        <div className="bank-perms">
          {policy.permissions.map((p) => (
            <div className="bank-perm" key={p.id}>
              <div className="bank-perm-main">
                <p className="bank-perm-name">{p.name}</p>
                <p className="bank-perm-note">{p.note}</p>
              </div>
              {p.locked ? (
                <span className="bank-perm-never">Never</span>
              ) : (
                <span
                  className={`bank-switch${p.enabled ? ' on' : ''}`}
                  role="switch"
                  aria-checked={p.enabled}
                  aria-disabled
                  aria-label={p.name}
                  title="Editable once a bank can be connected"
                >
                  <span className="bank-knob" />
                </span>
              )}
            </div>
          ))}
        </div>
        <Empty body="These are shown, not set. Nothing here persists until there is a connection to apply it to." />
      </Panel>
    </section>
  </div>
);
