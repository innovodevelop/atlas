/**
 * The six device affordances.
 *
 * Every one of them is a real, focusable control: the design's slider is an
 * invisible `<input type="range">` over a drawn track (so the keyboard works,
 * which a div-with-a-drag-handler would not), the switch is a `<button
 * role="switch">`, and the segmented control is a row of `aria-pressed`
 * buttons. `border:none` is declared on each of them in smartHome.css rather
 * than left to the global reset, per README §1.1.
 *
 * `status` is the honest one: a device that only reports gets a pill saying so,
 * not a disabled switch — a greyed-out switch reads as broken hardware.
 */
import { Minus, Plus } from 'lucide-react';
import { Button } from '@/components/atlas-ui/primitives';
import type { SmartDevice } from '@/lib/mocks/smartHome';
import {
  SEGMENT_LABELS, deviceOn, devicePct, deviceReadout, isLampKind,
} from './deviceGlyph';

/** The design's four warm/cool swatches for colour-capable strips. */
export const SWATCHES = ['#ffb765', '#fff1d6', '#8fb6ff', '#e08fb0'];

interface SwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  small?: boolean;
  disabled?: boolean;
}

export const Switch = ({ checked, onChange, label, small, disabled }: SwitchProps) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={label}
    disabled={disabled}
    className={`sh-switch${small ? ' sh-switch-sm' : ''}`}
    onClick={() => onChange(!checked)}
  >
    <span className="sh-switch-knob" />
  </button>
);

interface SliderProps {
  device: SmartDevice;
  onChange: (value: number) => void;
}

const Slider = ({ device, onChange }: SliderProps) => {
  const pct = devicePct(device);
  return (
    <span className="sh-slider">
      <span className="sh-slider-track">
        <span
          className="sh-slider-fill"
          data-warm={isLampKind(device.kind)}
          style={{ width: `${pct}%` }}
        />
      </span>
      {/* The knob is 18px, so its centre has to walk back across its own width
          as the fill approaches 100% — the design's `pct * 0.18` offset. */}
      <span className="sh-slider-thumb" style={{ left: `calc(${pct}% - ${(pct * 0.18).toFixed(1)}px)` }} />
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={Math.round(pct)}
        aria-label={`${device.name} level`}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </span>
  );
};

interface DeviceControlProps {
  device: SmartDevice;
  onValue: (value: number) => void;
  onColour: (colour: string) => void;
}

/** Picks the affordance from `device.control`. One switch, six branches. */
export const DeviceControl = ({ device, onValue, onColour }: DeviceControlProps) => {
  switch (device.control) {
    case 'slider':
      return <Slider device={device} onChange={onValue} />;

    case 'colour':
      return (
        <>
          <Slider device={device} onChange={onValue} />
          <span className="sh-swatches">
            {SWATCHES.map((c) => (
              <button
                key={c}
                type="button"
                className="sh-swatch"
                style={{ background: c }}
                aria-pressed={(device.colour ?? SWATCHES[0]) === c}
                aria-label={`${device.name} colour ${c}`}
                onClick={() => onColour(c)}
              />
            ))}
          </span>
        </>
      );

    // The design repeats the readout beside the switch. Both card layouts here
    // already print it in the header row and again as the affordance word
    // ("Powered on"), so a third copy is noise — the switch stands alone.
    case 'toggle':
      return (
        <span className="sh-stepper" style={{ justifyContent: 'flex-end' }}>
          <Switch
            checked={deviceOn(device)}
            label={device.name}
            small
            onChange={(next) => onValue(next ? 1 : 0)}
          />
        </span>
      );

    case 'stepper':
      return (
        <span className="sh-stepper">
          <Button
            size="icon"
            variant="text"
            aria-label={`Lower ${device.name}`}
            icon={<Minus className="i16" />}
            onClick={() => onValue(Math.round((device.value - 0.5) * 10) / 10)}
          />
          <span className="sh-stepper-val tnum">{deviceReadout(device)}</span>
          <Button
            size="icon"
            variant="text"
            aria-label={`Raise ${device.name}`}
            icon={<Plus className="i16" />}
            onClick={() => onValue(Math.round((device.value + 0.5) * 10) / 10)}
          />
        </span>
      );

    case 'segmented':
      return (
        <span className="sh-seg">
          {SEGMENT_LABELS.map((label, i) => (
            <button
              key={label}
              type="button"
              className="sh-seg-btn"
              aria-pressed={Math.round(device.value) === i}
              onClick={() => onValue(i)}
            >
              {label}
            </button>
          ))}
        </span>
      );

    case 'status':
    default:
      return <span className="sh-statuspill">No control · reports only</span>;
  }
};
