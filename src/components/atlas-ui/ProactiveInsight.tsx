/**
 * Surfaces proactive insights the brain's digest generated (ai_insights rows
 * with is_spoken = 0). Without this mounted the whole proactivity chain —
 * Rust scheduler → /proactive/cycle → ai_insights — writes rows nobody reads.
 *
 * useProactiveAI marks an insight spoken BEFORE handing it over, so a remount
 * cannot voice the same one twice; this component only owns presentation and
 * dismissal.
 */
import { useEffect, useState } from 'react';
import { Sparkles, X } from 'lucide-react';
import { useProactiveAI } from '@/hooks/useProactiveAI';

export function ProactiveInsight() {
  const insight = useProactiveAI();
  const [dismissed, setDismissed] = useState<string | null>(null);

  // A new insight replaces any dismissal from the previous one.
  useEffect(() => {
    if (insight?.id) setDismissed((d) => (d === insight.id ? d : null));
  }, [insight?.id]);

  if (!insight || dismissed === insight.id) return null;

  const body =
    typeof insight.content === 'string'
      ? insight.content
      : (insight.content as { summary?: string } | null)?.summary ?? '';

  return (
    <div className="proactive" role="status" aria-live="polite">
      <Sparkles size={15} className="proactive-icon" aria-hidden="true" />
      <div className="proactive-body">
        {insight.title && <strong className="proactive-title">{insight.title}</strong>}
        {body && <span className="proactive-text">{body}</span>}
      </div>
      <button
        type="button"
        className="proactive-close"
        onClick={() => setDismissed(insight.id)}
        aria-label="Dismiss"
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}
