import type { CSSProperties } from 'react';
import { Button } from '@/components/atlas-ui/primitives';
import { ClayBody } from './ClayBody';
import type { ClayMode, ClayReading, ClayRegion, HealthSnapshot } from '@/lib/mocks/health';
import { activeRegions, isClayReadable, isSignalActive } from '@/lib/mocks/health';

/**
 * The hero: a clay figure shaded by the selected reading.
 *
 * The card is NOT a `<Card>`. `<Card>` is a header-plus-body composition with
 * padding on both, and this is a single full-bleed canvas with its own furniture
 * floating over it — the same reason `<Panel>` is documented as wrong for mail's
 * scrolling panes. It reuses the card FILL and radius from `.cardB` via
 * `health.css` and nothing else.
 *
 * WHAT IT REFUSES TO DRAW:
 *  - a pin whose signal is off — the pin disappears, it does not grey out with
 *    the last value still legible;
 *  - a verdict for a reading whose required signals are missing — the verdict is
 *    replaced by what is needed to produce one;
 *  - a shaded region with nothing behind it — `<ClayBody>` gets the live region
 *    set and paints the rest as plain clay.
 */
interface HealthClayCardProps {
  snapshot: HealthSnapshot;
  mode: ClayMode;
  onMode: (mode: ClayMode) => void;
  isMock: boolean;
}

const REGION_LABEL: Record<Exclude<ClayRegion, 'whole'>, string> = {
  head: 'head', chest: 'torso', arms: 'arms', legs: 'legs',
};

export const HealthClayCard = ({ snapshot, mode, onMode, isMock }: HealthClayCardProps) => {
  const reading = snapshot.clay.find((c) => c.mode === mode) ?? snapshot.clay[0];
  const readable = reading ? isClayReadable(snapshot, reading) : false;
  const regions = activeRegions(snapshot);
  const liveSignals = snapshot.signals.filter((g) => isSignalActive(snapshot, g.id));

  const pins = reading
    ? reading.hotspots.filter((h) => h.signalIds.every((id) => isSignalActive(snapshot, id)))
    : [];

  const missing = reading
    ? reading.requires
        .filter((id) => !isSignalActive(snapshot, id))
        .map((id) => snapshot.signals.find((g) => g.id === id)?.name ?? id)
    : [];

  const shadedList = Array.from(regions).map((r) => REGION_LABEL[r]);

  return (
    <section className="hl-clay hl-c5 hl-r4" aria-label="Your body today">
      <ClayBody className="hl-claycanvas" mode={mode} regions={regions} shaded={readable} />

      <header className="hl-claytop">
        <p className="hl-claylabel">Your body today</p>
        {isMock && <span className="hl-stamp hl-stamp-clay">Sample</span>}
        <span className="hl-claysrc">
          {liveSignals.length > 0
            ? `Modelled from ${liveSignals.length} signal${liveSignals.length === 1 ? '' : 's'}${reading && readable ? ` · ${reading.source}` : ''}`
            : 'Modelled from nothing — every signal is off'}
        </span>
      </header>

      {pins.length > 0 && (
        <div className="hl-pins" aria-hidden>
          {pins.map((h) => (
            <span
              key={h.id}
              className={`hl-pin hl-cat-${h.category}`}
              style={{
                left: `${h.x * 100}%`,
                top: `${h.y * 100}%`,
                '--hl-beat': `${h.beat}s`,
              } as CSSProperties}
            >
              <span className="hl-pindot" />
              <span className="hl-pinbox">
                <span className="hl-pinlabel">{h.label}</span>
                <span className="hl-pinval tnum">{h.value}</span>
              </span>
            </span>
          ))}
        </div>
      )}

      <footer className="hl-claybottom">
        <div className="hl-claytext">
          {readable && reading ? (
            <>
              <p className="hl-clayverdict">{reading.verdict}</p>
              <p className="hl-claynote">
                {reading.note}
                {shadedList.length > 0 && shadedList.length < 4 && (
                  <> Only the {shadedList.join(', ')} carry colour — nothing else has a live signal.</>
                )}
              </p>
            </>
          ) : (
            <>
              <p className="hl-clayverdict hl-clayverdict-quiet">Not enough signal to read this.</p>
              <p className="hl-claynote">
                {missing.length > 0
                  ? `${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} off, so the figure stays plain clay rather than guessing at a shape nothing measured.`
                  : 'Nothing is feeding the model right now.'}
              </p>
            </>
          )}
        </div>
        <div className="hl-claymodes">
          {snapshot.clay.map((c) => (
            <Button
              key={c.mode}
              size="sm"
              variant={c.mode === mode ? 'ink' : 'ghost'}
              aria-pressed={c.mode === mode}
              onClick={() => onMode(c.mode)}
            >
              {c.label}
            </Button>
          ))}
        </div>
      </footer>
    </section>
  );
};
