import { Columns2, Scale } from 'lucide-react';
import { Empty, Panel } from '@/components/atlas-ui/primitives';
import { COMPARE_FIELDS, TIERS, tierById } from '@/lib/mocks/modelLab';
import { Note, SecLabel } from './parts';

/**
 * Two tiers, one column each, differences filled rather than outlined.
 *
 * WHAT IS NOT HERE, on purpose: price per token, context window, latency,
 * throughput, quality. None of those exists anywhere in this repo — not in the
 * adapters, not in the schema, not in a config file — so every one of them
 * would have to be typed in by hand from memory. The panel at the bottom says
 * that instead of showing a column of plausible numbers, because a comparison
 * table is exactly where an invented figure does the most damage: it is read as
 * a reason to choose.
 */
interface CompareViewProps {
  a: string | null;
  b: string | null;
  onPick: (slot: 'a' | 'b', id: string) => void;
}

export const CompareView = ({ a, b, onPick }: CompareViewProps) => {
  const left = a ? tierById(a) : undefined;
  const right = b ? tierById(b) : undefined;

  return (
    <div className="ml-compare">
      <div className="ml-picks">
        {(['a', 'b'] as const).map((slot) => {
          const current = slot === 'a' ? a : b;
          return (
            <div key={slot} className="ml-pick">
              <SecLabel>{slot === 'a' ? 'Column A' : 'Column B'}</SecLabel>
              <div className="ml-pick-row" role="group" aria-label={`Column ${slot.toUpperCase()} model`}>
                {TIERS.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    className={`ml-tab${current === t.id ? ' ml-tab-on' : ''}`}
                    aria-pressed={current === t.id}
                    onClick={() => onPick(slot, t.id)}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {!left || !right ? (
        <Empty
          size="section"
          icon={<Columns2 className="i20" />}
          title="Pick two tiers"
          body="Comparison needs both columns. Everything compared is transcribed from the gateway source, so the two columns always describe the same commit."
        />
      ) : (
        <div className="ml-cmp-scroll">
          <div className="ml-cmp">
            <div className="ml-cmp-head" role="row">
              <span className="ml-cmp-k" />
              <span className="ml-cmp-title">{left.label}</span>
              <span className="ml-cmp-title">{right.label}</span>
            </div>
            {COMPARE_FIELDS.map((f) => {
              const lv = f.read(left);
              const rv = f.read(right);
              const differs = lv !== rv;
              return (
                <div key={f.key} className={`ml-cmp-row${differs ? ' ml-cmp-row-diff' : ''}`} role="row">
                  <span className="ml-cmp-k">{f.label}</span>
                  <span className="ml-cmp-v">{lv}</span>
                  <span className="ml-cmp-v">{rv}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <Panel>
        <div className="ml-panel-head">
          <SecLabel>What this table cannot tell you</SecLabel>
          <Scale className="i16 ml-panel-ico" aria-hidden />
        </div>
        <Empty
          status="stale"
          body="Price per token, context window, latency and quality are not recorded anywhere in this repo. They are absent rather than estimated — a number invented here would be read as a reason to pick one tier over another."
        />
        <Note>
          The rows above are routing facts: which id a call collapses to, which profile it invokes, and
          what the adapter is allowed to send. Nothing here is a measurement of a model's behaviour.
        </Note>
      </Panel>
    </div>
  );
};
