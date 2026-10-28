/**
 * The ringing alarm (`Atlas Clock Beta.dc.html`, the alertdialog): the time,
 * the label, Snooze 9 min and Stop.
 *
 * The Beta shell mounts this on every screen, because an alarm rings wherever
 * the user is — on Mail, the chime and the notification go out, and this is
 * where it is stopped. Mounting it is also what starts the clock store for
 * the run (`bootClock`), so saved alarms ring without Clock having been
 * opened first. It subscribes to the ringing alarm only, so it never makes
 * the store tick.
 *
 * Esc does nothing here on purpose: the design asks for a choice, and the
 * page's own Esc (back to Home) checks for a ringing alarm first.
 */
import { useEffect, useRef } from 'react';
import { AtlasIcon } from '@/components/atlas/AtlasIcon';
import { SNOOZE_MINUTES } from '@/lib/betaClock';
import { bootClock, snoozeRinging, stopRinging, useClockRinging } from '@/lib/betaClockStore';
import '@/styles/beta/clock.css';

export default function ClockRinging() {
  const ringing = useClockRinging();
  const stopRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => { bootClock(); }, []);
  useEffect(() => { if (ringing) stopRef.current?.focus(); }, [ringing]);

  if (!ringing) return null;
  const { plan, test } = ringing;
  return (
    <div className="b-ck-ringing" role="alertdialog" aria-modal="true" aria-label={`Alarm: ${plan.alarm.label || 'Alarm'} at ${plan.alarm.time}`}>
      <div className="b-ck-ringcard">
        <AtlasIcon name="alarm" size={34} weight={1.5} />
        <span className="t">{plan.alarm.time}</span>
        <span className="l">{plan.alarm.label || 'Alarm'}</span>
        <span className="o">{test ? 'Test ring on this Mac' : 'Ringing on this Mac'}</span>
        <div className="b-ck-ringacts">
          {test ? null : <button type="button" className="snooze" onClick={snoozeRinging}>Snooze {SNOOZE_MINUTES} min</button>}
          <button type="button" className="stop" ref={stopRef} onClick={stopRinging}>Stop</button>
        </div>
      </div>
    </div>
  );
}
