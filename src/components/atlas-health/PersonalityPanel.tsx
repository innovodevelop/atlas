import { RefreshCw, RotateCcw, Sparkles } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { usePersonality, type Traits } from '@/hooks/usePersonality';

// Personality controls (Phase 4) — the honesty surface for Atlas's learned
// communication style. The brain drifts these five dials slowly from real
// conversations; this panel makes that inspectable and overridable instead of
// mysterious. Sliders persist debounced via usePersonality; the learned lexicon
// is shown read-only so the user can see exactly what Atlas picked up.

const TRAIT_META: { key: keyof Traits; label: string; description: string; low: string; high: string }[] = [
  {
    key: 'warmth',
    label: 'Warmth',
    description: 'How caring and encouraging Atlas is with you.',
    low: 'Matter-of-fact',
    high: 'Very warm',
  },
  {
    key: 'playfulness',
    label: 'Playfulness',
    description: 'How much humor Atlas mixes in — light jokes, teasing, the odd pun. Atlas tones this down on its own when the moment is serious.',
    low: 'Strictly serious',
    high: 'Playful',
  },
  {
    key: 'formality',
    label: 'Formality',
    description: 'How Atlas talks — relaxed and casual, or polished and professional.',
    low: 'Casual',
    high: 'Formal',
  },
  {
    key: 'verbosity',
    label: 'Detail',
    description: 'How much Atlas says — quick and to the point, or thorough with context.',
    low: 'Brief',
    high: 'Detailed',
  },
  {
    key: 'directness',
    label: 'Directness',
    description: 'How Atlas gives opinions — gentle suggestions, or straight answers.',
    low: 'Gentle',
    high: 'Direct',
  },
];

export function PersonalityPanel() {
  const { traits, lexicon, isLoading, loadError, isSaving, setTrait, reset } = usePersonality();
  const lexiconEntries = Object.entries(lexicon);

  return (
    <div className="col gap16">
      <div className="fx ac jb">
        <div>
          <h3 className="t14 fw6 fx ac gap8" style={{ color: 'hsl(240 30% 20%)', marginBottom: 6 }}>
            <Sparkles className="i16" />How Atlas talks to you
          </h3>
          <p className="fs12 m0" style={{ color: 'hsl(240 20% 50%)', lineHeight: 1.5 }}>
            Atlas adjusts these slowly on its own as it learns what works for you — a small nudge at a time,
            never a leap. Move a slider to override; your setting always wins and applies from the next reply.
            Everything here is stored locally on this Mac.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={reset} disabled={isLoading || isSaving || !!loadError}>
          {isSaving ? <RefreshCw className="w-4 h-4 mr-2 animate-spin" /> : <RotateCcw className="w-4 h-4 mr-2" />}
          Reset to defaults
        </Button>
      </div>

      {loadError && (
        <div className="gpanel fs12" style={{ padding: 14, color: 'hsl(240 20% 50%)' }}>{loadError}</div>
      )}

      {!loadError && (
        <div className="col" style={{ gap: 14, opacity: isLoading ? 0.5 : 1 }}>
          {TRAIT_META.map((t) => (
            <div className="gpanel col" key={t.key} style={{ padding: '12px 14px', gap: 8 }}>
              <div>
                <p className="t14 fw6 m0" style={{ color: 'hsl(240 30% 20%)' }}>{t.label}</p>
                <p className="fs12 m0" style={{ color: 'hsl(240 20% 50%)', lineHeight: 1.5 }}>{t.description}</p>
              </div>
              <div className="fx ac" style={{ gap: 12 }}>
                <span className="fs12" style={{ color: 'hsl(240 20% 60%)', width: 92, textAlign: 'right' }}>{t.low}</span>
                <Slider
                  value={[Math.round(traits[t.key] * 100)]}
                  onValueChange={(v) => setTrait(t.key, (v[0] ?? 50) / 100)}
                  min={0}
                  max={100}
                  step={1}
                  disabled={isLoading}
                  aria-label={t.label}
                />
                <span className="fs12" style={{ color: 'hsl(240 20% 60%)', width: 92 }}>{t.high}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {!loadError && (
        <div className="gpanel col" style={{ padding: 14, gap: 8 }}>
          <div>
            <h4 className="t14 fw6 m0" style={{ color: 'hsl(240 30% 20%)', marginBottom: 4 }}>Words Atlas has picked up</h4>
            <p className="fs12 m0" style={{ color: 'hsl(240 20% 50%)', lineHeight: 1.5 }}>
              Nicknames and in-jokes Atlas learned from your conversations. Read-only here — use Memory &amp; Privacy
              to remove anything Atlas shouldn't keep.
            </p>
          </div>
          {lexiconEntries.length === 0 ? (
            <p className="fs12 m0" style={{ color: 'hsl(240 20% 60%)' }}>
              Nothing yet — Atlas picks these up naturally as you chat.
            </p>
          ) : (
            <div className="fx" style={{ flexWrap: 'wrap', gap: 6 }}>
              {lexiconEntries.map(([term, meaning]) => (
                <Badge variant="outline" className="fs12" key={term} title={meaning}>
                  {term} — {meaning}
                </Badge>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default PersonalityPanel;
