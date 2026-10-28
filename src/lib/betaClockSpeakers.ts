/**
 * "Ring on" (`Atlas Clock Beta.dc.html`, the alarm editor): This Mac plus the
 * Home Assistant speakers the smart-home mirror knows, and what each choice
 * means at ring time.
 *
 * The list comes from `clock_speakers` (src-tauri/src/clock.rs), a read of the
 * local mirror — nothing is asked of the bridge to draw it. At ring time the
 * store asks `clock_ring_speaker` to speak the alarm through Home Assistant's
 * own text-to-speech, and rings this Mac instead when that fails. Pure: the
 * decoding, the options and every sentence the editor and the dialog show.
 */
import type { Alarm, RingTarget } from './betaClock';

export interface Speaker {
  id: string;
  name: string;
  room: string | null;
  /** Home Assistant reported it reachable on its last word. */
  available: boolean;
}

export interface SpeakerList {
  /** A Home Assistant bridge has been linked on this Mac. */
  linked: boolean;
  /** `connected`, `unreachable`, `unauthorised`… — the bridge row's state. */
  bridgeState: string | null;
  speakers: Speaker[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** `clock_speakers`'s answer, read defensively: anything malformed is no speaker. */
export function decodeSpeakers(raw: unknown): SpeakerList {
  if (!isRecord(raw)) return { linked: false, bridgeState: null, speakers: [] };
  const speakers = Array.isArray(raw.speakers)
    ? raw.speakers.filter(isRecord).flatMap((s): Speaker[] => {
        const id = typeof s.id === 'string' ? s.id : '';
        const name = typeof s.name === 'string' ? s.name.trim() : '';
        if (!id || !name) return [];
        return [{ id, name, room: typeof s.room === 'string' && s.room.trim() ? s.room.trim() : null, available: s.available !== false }];
      })
    : [];
  return { linked: raw.linked === true, bridgeState: typeof raw.bridgeState === 'string' ? raw.bridgeState : null, speakers };
}

export interface RingOption {
  /** null is This Mac. */
  target: RingTarget | null;
  label: string;
  /** A second line: the room, or why the choice may not answer. */
  sub: string | null;
  /** The saved choice is no longer in the mirror. Still shown so it can be seen and changed. */
  missing: boolean;
}

/**
 * This Mac, then each speaker; a saved speaker the mirror no longer has stays
 * in the list, marked, so the editor never silently swaps it for This Mac.
 */
export function ringOptions(list: SpeakerList | null, current: RingTarget | null): RingOption[] {
  const mac: RingOption = { target: null, label: 'This Mac', sub: null, missing: false };
  const speakers = (list?.speakers ?? []).map<RingOption>((s) => ({
    target: { id: s.id, name: s.name },
    label: s.name,
    sub: s.available ? s.room : `${s.room ? `${s.room} · ` : ''}not answering`,
    missing: false,
  }));
  const known = current && speakers.some((o) => o.target?.id === current.id);
  const gone: RingOption[] = current && list && !known
    ? [{ target: current, label: current.name, sub: 'no longer in Home Assistant', missing: true }]
    : [];
  return [mac, ...speakers, ...gone];
}

/** Why the editor offers only This Mac, or null when speakers are listed. */
export function speakersNote(list: SpeakerList | null, native: boolean, error: string | null): string | null {
  if (!native) return 'Home Assistant speakers can be chosen in the Atlas Mac app.';
  if (error) return `Atlas could not list your speakers: ${error}`;
  if (!list) return null;
  if (!list.linked) return 'Link Home Assistant on the Smart Home screen and its speakers can ring alarms too.';
  if (!list.speakers.length) return 'Home Assistant reports no media players, so alarms ring on this Mac.';
  if (list.bridgeState && list.bridgeState !== 'connected') return 'Home Assistant is not answering right now; an alarm set to a speaker rings on this Mac until it does.';
  return null;
}

/** Where an alarm rings, for its row: "This Mac" or the speaker's name. */
export function outLabel(alarm: Pick<Alarm, 'ringOn'>): string {
  return alarm.ringOn?.name ?? 'This Mac';
}

/** The line under "Ring on", for the choice in the editor. Says what leaves the Mac. */
export function outNote(target: RingTarget | null): string {
  if (!target) return 'Rings on this Mac’s speakers, at the system volume, and posts a notification.';
  return `Rings through ${target.name} via Home Assistant, which speaks the alarm’s label and time with its own text-to-speech; if that engine is a cloud one, the words go there too. If the speaker doesn’t answer, it rings on this Mac instead.`;
}

/** What the speaker says: the label, then the time. */
export function ringMessage(alarm: Pick<Alarm, 'label' | 'time'>): string {
  const label = alarm.label.trim() || 'Alarm';
  return `${label}. It is ${alarm.time}.`;
}

/** The dialog's line when the speaker failed and the Mac rang instead. */
export function fallbackNote(speaker: string, reason: string): string {
  const why = reason.trim().replace(/\.$/, '');
  return `${speaker} didn’t answer (${why}), so it is ringing on this Mac.`;
}
