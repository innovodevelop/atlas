import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { MailAuditEvent } from '@/types/mail';
import { fullTime } from './mailFormat';

/**
 * The local, append-only record of what Atlas did to this thread.
 *
 * The copy is "Logged on this Mac" and not the handoff's "Atlas keeps the record":
 * the table lives in atlas.db, nothing is uploaded, and anyone with a SQLite client
 * can rewrite it. Claiming custodial authority we do not have would be the one
 * place this screen overstates the product (audit §2.3.1).
 */
export const MailAuditTrail = ({ events }: { events: MailAuditEvent[] }) => {
  const [open, setOpen] = useState(false);

  return (
    <section className="mail-audit">
      <button
        type="button"
        className="mail-audit-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <ChevronDown className="i14" aria-hidden /> : <ChevronRight className="i14" aria-hidden />}
        <span>Logged on this Mac</span>
        <span className="mail-muted tnum">{events.length}</span>
      </button>

      {open && (
        events.length === 0 ? (
          <p className="mail-muted">Nothing logged for this thread yet.</p>
        ) : (
          <ol>
            {events.map((e) => (
              <li key={e.seq} className="mail-audit-item">
                <span className="mail-audit-actor">{e.actor}</span>
                <span>{e.action.replace(/_/g, ' ')}</span>
                <span className="mail-muted">{e.detail}</span>
                {/* Provenance is only set on drafting events, and only ever with the
                    real values the brain returned — there is no constant to fall back on. */}
                {e.model && <span className="mail-muted">{e.model}{e.prompt_version ? ` · ${e.prompt_version}` : ''}</span>}
                <time className="mail-audit-ts tnum" dateTime={e.ts}>{fullTime(e.ts)}</time>
              </li>
            ))}
          </ol>
        )
      )}
    </section>
  );
};
