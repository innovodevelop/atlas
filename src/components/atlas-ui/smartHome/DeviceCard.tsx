/**
 * A device, the way the rooms view draws it: stage, name, readout, the
 * device's own words, an at-a-glance affordance, then the control.
 *
 * THE STAGE IS NOT THE DESIGN'S. The design fills a 208px well with a canvas
 * model from `atlas-models.js`, which README §8 lists under "do not port", and
 * nothing in this app can render a device model. What is here instead is a
 * recessed well (darker than the card, per the paper scale) with the device's
 * glyph and a halo whose strength follows the device's own value. It reads as
 * a designed stage without claiming to be a picture of the user's hardware.
 *
 * The lamp disc, padlock and power symbol below the name ARE the design's,
 * drawn with gradients and inset box-shadows. §1.1 keeps illustration strokes:
 * a padlock shackle is a drawing, not an element border.
 */
import { Card } from '@/components/atlas-ui/primitives';
import type { SmartDevice } from '@/lib/mocks/smartHome';
import { DeviceControl } from './DeviceControls';
import {
  deviceGlyph, deviceOn, devicePct, deviceReadout, isLampKind, isLockKind,
} from './deviceGlyph';

const lampFill = (v: number) =>
  `radial-gradient(circle at 38% 34%,rgba(255,247,222,${(0.25 + (v / 100) * 0.75).toFixed(2)}),`
  + `rgba(255,183,101,${(0.2 + (v / 100) * 0.8).toFixed(2)}))`;

const lampGlow = (v: number) =>
  `0 0 ${Math.round(3 + v * 0.26)}px rgba(255,186,104,${(0.15 + (v / 100) * 0.7).toFixed(2)}),`
  + 'inset 0 0 0 1px rgba(30,30,36,.1)';

/** The at-a-glance state symbol. Three of them, picked the design's way. */
const Affordance = ({ device }: { device: SmartDevice }) => {
  const on = deviceOn(device);
  const pct = devicePct(device);

  if (isLampKind(device.kind)) {
    return (
      <div className="sh-affor">
        <span className="sh-lamp" style={{ background: lampFill(pct), boxShadow: lampGlow(pct) }} aria-hidden />
        <span className="sh-affor-lbl tnum">{Math.round(pct)}% brightness</span>
      </div>
    );
  }

  if (isLockKind(device.kind)) {
    const fg = on ? 'var(--grn-text)' : '#c2661a';
    return (
      <div className="sh-affor">
        <span className="sh-lock" style={{ background: on ? 'rgba(15,174,118,.14)' : 'rgba(194,102,26,.14)' }} aria-hidden>
          <span
            className="sh-lock-shackle"
            style={{
              top: on ? -9 : -13,
              left: on ? '50%' : '64%',
              transform: `translateX(-50%) rotate(${on ? 0 : -18}deg)`,
              boxShadow: `inset 0 2px 0 ${fg},inset 2px 0 0 ${fg},inset -2px 0 0 ${fg}`,
            }}
          />
          <span className="sh-lock-body" style={{ background: fg }} />
        </span>
        <span className="sh-affor-lbl">{on ? 'Secured' : 'Open'}</span>
      </div>
    );
  }

  if (device.control === 'toggle') {
    const fg = on ? 'var(--grn-text)' : 'var(--ink3)';
    return (
      <div className="sh-affor">
        <span
          className="sh-power"
          style={{ background: on ? 'rgba(15,174,118,.14)' : 'rgba(30,30,36,.05)' }}
          aria-hidden
        >
          <span className="sh-power-ring" style={{ boxShadow: `inset 0 0 0 2px ${fg}` }} />
          <span className="sh-power-stem" style={{ background: fg }} />
        </span>
        <span className="sh-affor-lbl">{on ? 'Powered on' : 'Powered off'}</span>
      </div>
    );
  }

  return <div className="sh-affor" />;
};

export const DeviceStage = ({ device, compact }: { device: SmartDevice; compact?: boolean }) => {
  const Glyph = deviceGlyph(device.kind);
  const on = deviceOn(device);
  const pct = devicePct(device);
  const warm = isLampKind(device.kind);
  const haloOpacity = warm ? pct / 100 : on ? 0.55 : 0;

  return (
    <div className={compact ? 'sh-recent-stage' : 'sh-stage'} data-on={on} aria-hidden>
      <span
        className="sh-stage-halo"
        style={{
          opacity: haloOpacity,
          background: warm
            ? 'radial-gradient(closest-side,rgba(255,186,104,.6),transparent 72%)'
            : 'radial-gradient(closest-side,rgba(52,97,242,.26),transparent 72%)',
        }}
      />
      <Glyph className="sh-stage-glyph" strokeWidth={1.4} />
    </div>
  );
};

interface DeviceCardProps {
  device: SmartDevice;
  onValue: (value: number) => void;
  onColour: (colour: string) => void;
}

export const DeviceCard = ({ device, onValue, onColour }: DeviceCardProps) => (
  <Card size="s" skin="glass" className="sh-dev">
    <Card.Body>
      <DeviceStage device={device} />
      <div className="sh-dev-head">
        <span className="sh-dot" data-on={deviceOn(device)} aria-hidden />
        <p className="sh-dev-name">{device.name}</p>
        <span className="sh-dev-read tnum">{deviceReadout(device)}</span>
      </div>
      <p className="sh-dev-state">{device.state}</p>
      <Affordance device={device} />
      <div className="sh-ctrl">
        <DeviceControl device={device} onValue={onValue} onColour={onColour} />
      </div>
    </Card.Body>
  </Card>
);

/** The compact strip used by "Recently operated". Same data, no stage halo drama. */
export const RecentDeviceStrip = ({ device, onValue, onColour }: DeviceCardProps) => (
  <div className="sh-recent-item">
    <DeviceStage device={device} compact />
    <div className="sh-recent-body">
      <div className="sh-dev-head" style={{ marginTop: 0 }}>
        <span className="sh-dot" data-on={deviceOn(device)} aria-hidden />
        <p className="sh-dev-name">{device.name}</p>
        <span className="sh-dev-read tnum">{deviceReadout(device)}</span>
      </div>
      <p className="sh-dev-state">{device.state}</p>
      <p className="sh-recent-when">
        {device.roomName}
        {device.lastChanged ? ` · ${device.lastChanged}` : ''}
      </p>
      <div className="sh-ctrl">
        <DeviceControl device={device} onValue={onValue} onColour={onColour} />
      </div>
    </div>
  </div>
);
