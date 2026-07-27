import { AlertTriangle, Info, X } from 'lucide-react';
import { MailIngestErrors } from './MailIngestErrors';

/**
 * Route-level notices, rendered above the three panes.
 *
 * This used to live inside MailReadingPane, which meant a refusal was only
 * visible while a thread happened to be open: approve a send, press Esc, and
 * the "Sending requires the Workers Paid plan" rejection had nowhere to land.
 * The shell is the only place that is on screen in every pane state, so it is
 * the only correct home for it.
 *
 * Warnings and errors are separated on purpose. A sync warning ("1 thread
 * skipped: malformed participants") is a note about work that still completed;
 * a hard error is work that did not happen. Painting both red teaches the user
 * to ignore red.
 *
 * CONTRACT-GAP: §6.4's class list predates this surface and names nothing for a
 * route-level notice, so four names are added here — `mail-notices`,
 * `mail-notice`, `mail-notice-warn`, `mail-notice-error` — and styled in
 * mail.css. They need folding back into §6.4.
 */
interface MailNoticesProps {
  /** Last hard failure from the hook, already human-readable. Rendered verbatim. */
  error: string | null;
  /**
   * Last non-fatal note, already joined by the hook. Never styled as a failure.
   *
   * Singular and `string | null` to match `useAtlasMail` exactly. It was briefly
   * typed as `warnings: string[]` against a hook that exposes `warning`, which
   * compiled — the prop was optional on the reading side — and silently severed
   * the channel: sync warnings, failed background fetches and every
   * rules-engine warning rendered nowhere at all. Keep these names identical to
   * the hook's; a structural near-miss here is invisible to the compiler.
   */
  warning: string | null;
  /** Clears `error`. */
  onDismissError?: () => void;
  /** Clears `warning`. */
  onDismissWarning?: () => void;
  /** Re-checks the worker's ingest-error list whenever a sync completes. */
  lastSyncedAt: string | null;
}

export const MailNotices = ({
  error,
  warning,
  onDismissError,
  onDismissWarning,
  lastSyncedAt,
}: MailNoticesProps) => (
  // `:empty` hides the region in CSS, so nothing to report costs no vertical
  // space — the shell must not gain a permanent empty strip.
  <div className="mail-notices">
    <MailIngestErrors lastSyncedAt={lastSyncedAt} />

    {error && (
      <div className="mail-notice mail-notice-error" role="alert">
        <AlertTriangle className="i14" aria-hidden />
        <div><p>{error}</p></div>
        {onDismissError && (
          <button type="button" onClick={onDismissError} aria-label="Dismiss this error">
            <X className="i14" aria-hidden />
          </button>
        )}
      </div>
    )}

    {warning && (
      <div className="mail-notice mail-notice-warn" role="status">
        <Info className="i14" aria-hidden />
        <div><p>{warning}</p></div>
        {onDismissWarning && (
          <button type="button" onClick={onDismissWarning} aria-label="Dismiss this notice">
            <X className="i14" aria-hidden />
          </button>
        )}
      </div>
    )}
  </div>
);
