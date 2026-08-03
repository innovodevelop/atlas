import { Watch, Plug, ShieldCheck, Waves, Info } from 'lucide-react';
import { Button, Empty, Panel, Row } from '@/components/atlas-ui/primitives';
import type { HealthSnapshot } from '@/lib/mocks/health';
import { isSignalActive } from '@/lib/mocks/health';

/**
 * The Sources view — where the health data would come from.
 *
 * This is the half of the surface that decides what the Body view is allowed to
 * say. Two of its four panels are LIVE and two are deliberately inert, and the
 * split is the honesty rule:
 *
 *  - SOURCES and SIGNALS are switchable, because flipping one has a visible,
 *    truthful consequence three feet away — turn Apple Watch off and its cards
 *    go to "Not measured", turn Workouts off and the figure's legs stop being
 *    shaded. Inside a labelled sample that is a demonstration, not a claim.
 *
 *  - PRIVACY and the two device actions (Sync now, Pair another device) are
 *    disabled with the reason written next to them. A privacy switch that
 *    constrains nothing, or a Sync button with nothing to sync, would be pure
 *    theatre — a control that reports a state the app cannot hold. That is the
 *    class of thing T4 spent a week deleting, and a "Sample data" label does
 *    not buy it back.
 */
interface HealthSourcesProps {
  snapshot: HealthSnapshot;
  isMock: boolean;
  onSource: (id: string, on: boolean) => void;
  onSignal: (id: string, on: boolean) => void;
}

/** Borderless toggle. `border:none` is declared in health.css, not omitted. */
const Switch = ({
  on, label, disabled, onChange,
}: { on: boolean; label: string; disabled?: boolean; onChange?: (next: boolean) => void }) => (
  <button
    type="button"
    role="switch"
    aria-checked={on}
    aria-label={label}
    disabled={disabled}
    className={`hl-switch${on ? ' hl-switch-on' : ''}`}
    onClick={onChange ? () => onChange(!on) : undefined}
  >
    <span className="hl-knob" />
  </button>
);

export const HealthSources = ({ snapshot, isMock, onSource, onSignal }: HealthSourcesProps) => {
  const { sources, signals, devices, privacy, primaryDevice } = snapshot;
  const liveSignals = signals.filter((g) => isSignalActive(snapshot, g.id)).length;

  return (
    <div className="hl-settings">
      <div className="hl-settings-col">
        <Panel className="hl-panel" title="Where your health data comes from" icon={<Waves className="i16" />}>
          <p className="hl-lede">
            Atlas reads, never writes. Each source can be paused on its own, and pausing one
            only removes it from the model — the history stays on your device.
          </p>
          {sources.length === 0 ? (
            <Empty
              size="block"
              icon={<Plug className="i20" />}
              title="No source connected"
              body="Atlas has nothing to read. Connect Apple Health, a wearable, or import a lab panel and this list fills in."
            />
          ) : (
            <div className="hl-list">
              {sources.map((s) => (
                <Row
                  key={s.id}
                  className="hl-listrow"
                  title={s.name}
                  meta={s.meta}
                  trail={
                    <>
                      <span className={`hl-state${s.enabled ? '' : ' hl-state-off'}`}>{s.state}</span>
                      <Switch
                        on={s.enabled}
                        label={`${s.name} — read this source`}
                        onChange={(next) => onSource(s.id, next)}
                      />
                    </>
                  }
                />
              ))}
            </div>
          )}
        </Panel>

        <Panel className="hl-panel" title="What the model uses" icon={<Info className="i16" />}>
          <p className="hl-lede">
            The figure is built from these signals. Turn one off and the model stops shading
            that region — it never guesses a value it has not measured.
          </p>
          {signals.length === 0 ? (
            <Empty size="inline" status="stale" title="No signals." body="Nothing is feeding the model." />
          ) : (
            <>
              <div className="hl-signals">
                {signals.map((g) => {
                  const active = isSignalActive(snapshot, g.id);
                  const source = sources.find((s) => s.id === g.sourceId);
                  const blockedBySource = g.enabled && !active;
                  return (
                    <button
                      key={g.id}
                      type="button"
                      role="switch"
                      aria-checked={active}
                      className={`hl-signal${active ? ' hl-signal-on' : ''}`}
                      onClick={() => onSignal(g.id, !g.enabled)}
                    >
                      <span className="hl-signal-head">
                        <span className="hl-dot" aria-hidden />
                        <span className="hl-signal-name">{g.name}</span>
                        <span className="hl-signal-region">{g.region}</span>
                      </span>
                      <span className="hl-signal-note">
                        {blockedBySource
                          ? `Off because ${source ? source.name : 'its source'} is paused.`
                          : g.note}
                      </span>
                    </button>
                  );
                })}
              </div>
              {liveSignals === 0 && (
                <Empty
                  size="inline"
                  status="stale"
                  title="Nothing is shading the figure."
                  body="Every signal is off, so the model is plain clay and the Body view can only show what needs no signal."
                />
              )}
            </>
          )}
        </Panel>
      </div>

      <div className="hl-settings-col">
        {/* The one ink surface on the page — the design gives devices their own
            dark card, and it is the anchor the rest of the column reads against. */}
        <Panel tone="ink" className="hl-devices" pad="lg">
          <p className="hl-inklabel">Devices</p>
          {primaryDevice ? (
            <>
              <h3 className="hl-inktitle">{primaryDevice.name}</h3>
              <p className="hl-inkbody">{primaryDevice.blurb}</p>
              <div className="hl-inktile">
                <span className="hl-dot hl-dot-live" aria-hidden />
                <span className="hl-inktile-text">
                  <span className="hl-inktile-title">{primaryDevice.syncedLabel}</span>
                  <span className="hl-inktile-meta tnum">{primaryDevice.batteryLabel}</span>
                </span>
                <Button variant="ghost" size="sm" className="hl-inkbtn" disabled>
                  Sync now
                </Button>
              </div>
              <p className="hl-inknote">
                Sync is disabled: there is no health integration behind this screen yet, so
                there is nothing for it to pull.
              </p>
            </>
          ) : (
            <>
              <h3 className="hl-inktitle">No device paired</h3>
              <p className="hl-inkbody">
                Atlas can read a watch, a scale or a chest strap. Nothing is paired, so nothing
                is streaming.
              </p>
            </>
          )}

          {devices.length === 0 ? (
            <p className="hl-inknote">No other devices.</p>
          ) : (
            <div className="hl-list hl-list-ink">
              {devices.map((d) => (
                <Row
                  key={d.id}
                  className="hl-listrow"
                  title={d.name}
                  meta={d.meta}
                  trail={<span className={`hl-state${d.live ? ' hl-state-live' : ' hl-state-off'}`}>{d.state}</span>}
                />
              ))}
            </div>
          )}

          <Button variant="ghost" className="hl-inkbtn hl-inkbtn-wide" icon={<Watch className="i16" />} disabled>
            Pair another device
          </Button>
          <p className="hl-inknote">
            Pairing needs the HealthKit bridge Atlas has not shipped. The button is here
            because the design places it here — it is not wired to anything.
          </p>
        </Panel>

        <Panel className="hl-panel" title="Privacy" icon={<ShieldCheck className="i16" />}>
          <p className="hl-lede">
            {isMock
              ? 'These four rules arrive with the health integration. They are shown so the shape is reviewable and they are disabled because there is no pipeline for them to constrain — nothing about you is being read today.'
              : 'How far your health data is allowed to travel.'}
          </p>
          {privacy.length === 0 ? (
            <Empty size="inline" status="stale" title="No rules yet." />
          ) : (
            <div className="hl-list">
              {privacy.map((p) => (
                <Row
                  key={p.id}
                  className="hl-listrow hl-listrow-off"
                  title={p.name}
                  meta={p.note}
                  trail={<Switch on={p.enabled} label={p.name} disabled />}
                />
              ))}
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
};
