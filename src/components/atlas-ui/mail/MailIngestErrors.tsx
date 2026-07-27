import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { isTauri } from '@/integrations/local/localClient';
import { getToken } from '@/lib/authClient';
import { fullTime } from './mailFormat';

/**
 * Mail the worker could not store (`mail_ingest_errors`, contract §4.3 / §8.3).
 *
 * This is the one surface whose entire purpose is "a message was lost, here is
 * which one". It therefore renders *nothing* when the list is empty — a
 * permanently visible "0 ingest errors" panel is exactly how a real one stops
 * being read — and a full-width red block the moment it is not.
 *
 * It invokes the Tauri command directly instead of going through useAtlasMail.
 * Everything the hook centralises (one atlas.db reader, one optimistic-write
 * path, one audit writer) applies to rows Atlas owns; these rows live only on
 * the worker, have no local mirror, and this is a read with no side effects.
 */

/**
 * The row shape is defined in the atlas-mail worker repo, which is not in this
 * tree, and `mail_ingest_errors` is a verbatim passthrough of whatever
 * /api/ingest-errors returns. So every field is probed rather than assumed, and
 * a row nothing matches is printed as raw JSON: on a "we lost your mail" screen
 * showing a payload we do not understand beats showing an empty bullet.
 */
type IngestErrorRow = Record<string, unknown>;

function pick(row: IngestErrorRow, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number') return String(value);
  }
  return null;
}

interface MailIngestErrorsProps {
  /** Re-checks whenever a sync completes; the list only changes at ingest time. */
  lastSyncedAt: string | null;
}

export const MailIngestErrors = ({ lastSyncedAt }: MailIngestErrorsProps) => {
  const [rows, setRows] = useState<IngestErrorRow[]>([]);
  const [checkFailed, setCheckFailed] = useState<string | null>(null);

  useEffect(() => {
    // Browser dev server: no Tauri bridge to call. Stay silent rather than
    // reporting a failure that is really just "not the desktop app".
    if (!isTauri()) return;
    // Same for the moment before sign-in resolves — the route is redirecting to
    // /auth anyway, and an unauthenticated 401 is not news about lost mail.
    const token = getToken();
    if (!token) return;
    let cancelled = false;
    void (async () => {
      try {
        const core = await import('@tauri-apps/api/core');
        const res = await core.invoke<{ errors?: unknown }>('mail_ingest_errors', { token });
        if (cancelled) return;
        setRows(Array.isArray(res?.errors) ? (res.errors as IngestErrorRow[]) : []);
        setCheckFailed(null);
      } catch (e) {
        if (cancelled) return;
        // "We could not look" is not "nothing was lost", and rendering nothing
        // here would assert the second one.
        setCheckFailed(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [lastSyncedAt]);

  if (checkFailed) {
    return (
      <div className="mail-notice mail-notice-warn" role="status">
        <AlertTriangle className="i14" aria-hidden />
        <div>
          <p>Atlas could not check for mail the mailbox failed to store: {checkFailed}</p>
        </div>
      </div>
    );
  }

  if (rows.length === 0) return null;

  const one = rows.length === 1;
  return (
    <div className="mail-notice mail-notice-error" role="alert">
      <AlertTriangle className="i14" aria-hidden />
      <div>
        <p>
          <strong>{rows.length} incoming message{one ? '' : 's'} could not be stored.</strong>{' '}
          {one ? 'It is' : 'They are'} not in the list below and no sync will bring{' '}
          {one ? 'it' : 'them'} back.
        </p>
        <ul>
          {rows.map((row, i) => {
            const subject = pick(row, 'subject');
            const from = pick(row, 'from_address', 'from', 'sender');
            const at = pick(row, 'received_at', 'created_at', 'ts', 'at');
            const reason = pick(row, 'reason', 'error', 'detail', 'message');
            const recognised = subject || from || at || reason;
            return (
              <li key={pick(row, 'id', 'message_id') ?? `ingest-${i}`}>
                {recognised ? (
                  <>
                    <span>{subject || '(no subject)'}</span>
                    {from && <span className="mail-muted"> · {from}</span>}
                    {at && <span className="mail-muted"> · {fullTime(at) || at}</span>}
                    {reason && <span className="mail-muted"> · {reason}</span>}
                  </>
                ) : (
                  <code>{JSON.stringify(row)}</code>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
};
