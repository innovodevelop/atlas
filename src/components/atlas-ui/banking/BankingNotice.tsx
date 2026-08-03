import { AlertTriangle } from 'lucide-react';
import type { BankingPolicy } from '@/lib/mocks/banking';

/**
 * The sample-data treatment.
 *
 * Every other mock in this bundle can get away with a quiet label. Money cannot:
 * "€84,120" beside a bank's name is indistinguishable from a fact, and a user
 * who believes it may act on it. So the notice is:
 *
 *  - STANDING. Not a toast, not dismissible, not collapsed after first view. It
 *    sits above the grid in every state and scrolls with the page rather than
 *    being pinned, because a pinned bar is the one thing people learn to ignore.
 *  - SPECIFIC. It names the provider, the environment and the consequence, so
 *    the claim is falsifiable rather than a vague "demo mode".
 *  - AMBER, not red. The surface is not broken and nothing failed; the figures
 *    are simply not the user's. Red would be a lie in the other direction.
 *  - NOT ALONE. `<MoneyCard sample>` repeats the word on every tile. This banner
 *    covers the person who reads the page; the stamps cover the person who
 *    screenshots one card.
 *
 * The preview switch is a real control, not a fake one. It swaps between the
 * sample dataset and the state a real adapter genuinely returns on day one —
 * `accounts: null` — so the empty states are inspectable instead of being dead
 * code that nobody sees until the adapter lands. It changes what is rendered,
 * it says exactly what it does, and it persists nothing.
 */

export type BankingPreview = 'sample' | 'empty';

interface BankingNoticeProps {
  policy: BankingPolicy;
  preview: BankingPreview;
  onPreviewChange: (next: BankingPreview) => void;
}

const OPTIONS: Array<{ id: BankingPreview; label: string; hint: string }> = [
  { id: 'sample', label: 'Sample data', hint: 'Show the design’s placeholder figures' },
  { id: 'empty', label: 'No bank connected', hint: 'Show what this surface looks like with a real adapter and no connection' },
];

export const BankingNotice = ({ policy, preview, onPreviewChange }: BankingNoticeProps) => (
  <aside className="bank-notice" role="note" aria-label="Sample data notice">
    <span className="bank-notice-ico" aria-hidden><AlertTriangle className="i16" /></span>
    <div className="bank-notice-body">
      <p className="bank-notice-title">
        Sample data — none of these figures came from a bank
      </p>
      <p className="bank-notice-text">
        {policy.reason} Every number, account and card on this screen is placeholder
        copy from the design. Do not act on it.
      </p>
    </div>
    <div className="bank-notice-switch" role="group" aria-label="Preview state">
      {OPTIONS.map((o) => (
        <button
          key={o.id}
          className={`bank-seg${preview === o.id ? ' on' : ''}`}
          onClick={() => onPreviewChange(o.id)}
          aria-pressed={preview === o.id}
          title={o.hint}
        >
          {o.label}
        </button>
      ))}
    </div>
  </aside>
);
