import { describe, expect, test } from 'bun:test';
import {
  decodeSpeakers, fallbackNote, outLabel, outNote, ringMessage, ringOptions, speakersNote, type SpeakerList,
} from './betaClockSpeakers';

const LIST: SpeakerList = {
  linked: true,
  bridgeState: 'connected',
  speakers: [
    { id: 'd1', name: 'Bedroom speaker', room: 'Bedroom', available: true },
    { id: 'd2', name: 'Kitchen', room: null, available: false },
  ],
};

describe('decoding clock_speakers', () => {
  test('keeps well-formed speakers and drops the rest', () => {
    const out = decodeSpeakers({
      linked: true,
      bridgeState: 'connected',
      speakers: [
        { id: 'd1', name: ' Bedroom ', room: 'Bedroom', available: true },
        { id: 'd2', name: 'Kitchen', room: '  ', available: false },
        { id: '', name: 'No id' },
        { id: 'd3' },
        'junk',
      ],
    });
    expect(out.speakers).toEqual([
      { id: 'd1', name: 'Bedroom', room: 'Bedroom', available: true },
      { id: 'd2', name: 'Kitchen', room: null, available: false },
    ]);
    expect(out.linked).toBe(true);
  });
  test('anything else is no bridge and no speakers', () => {
    expect(decodeSpeakers(null)).toEqual({ linked: false, bridgeState: null, speakers: [] });
    expect(decodeSpeakers({ speakers: 'x' }).speakers).toEqual([]);
  });
});

describe('the Ring on choices', () => {
  test('This Mac first, then each speaker with its room or why it may not answer', () => {
    const opts = ringOptions(LIST, null);
    expect(opts.map((o) => o.label)).toEqual(['This Mac', 'Bedroom speaker', 'Kitchen']);
    expect(opts[0].target).toBeNull();
    expect(opts[1]).toMatchObject({ target: { id: 'd1', name: 'Bedroom speaker' }, sub: 'Bedroom', missing: false });
    expect(opts[2].sub).toBe('not answering');
  });
  test('a saved speaker the mirror lost stays, marked, rather than turning into This Mac', () => {
    const opts = ringOptions(LIST, { id: 'gone', name: 'Old speaker' });
    expect(opts[opts.length - 1]).toEqual({ target: { id: 'gone', name: 'Old speaker' }, label: 'Old speaker', sub: 'no longer in Home Assistant', missing: true });
  });
  test('before the list arrives the saved speaker is still there and picked', () => {
    const opts = ringOptions(null, { id: 'd1', name: 'Bedroom speaker' });
    expect(opts.map((o) => o.target?.id ?? null)).toEqual([null, 'd1']);
    expect(opts[1].missing).toBe(false);
    expect(ringOptions(null, null)).toHaveLength(1);
  });
});

describe('what the editor and the dialog say', () => {
  test('why only This Mac is offered', () => {
    expect(speakersNote(null, false, null)).toContain('Mac app');
    expect(speakersNote(null, true, 'boom')).toBe('Atlas could not list your speakers: boom');
    expect(speakersNote(null, true, null)).toBeNull();
    expect(speakersNote({ linked: false, bridgeState: null, speakers: [] }, true, null)).toContain('Link Home Assistant');
    expect(speakersNote({ linked: true, bridgeState: 'connected', speakers: [] }, true, null)).toContain('no media players');
    expect(speakersNote({ ...LIST, bridgeState: 'unreachable' }, true, null)).toContain('not answering');
    expect(speakersNote(LIST, true, null)).toBeNull();
  });
  test('where it rings, and what leaves the Mac', () => {
    expect(outLabel({ ringOn: null })).toBe('This Mac');
    expect(outLabel({})).toBe('This Mac');
    expect(outLabel({ ringOn: { id: 'd1', name: 'Bedroom' } })).toBe('Bedroom');
    expect(outNote(null)).toContain('this Mac');
    const note = outNote({ id: 'd1', name: 'Bedroom' });
    expect(note).toContain('Home Assistant');
    expect(note).toContain('rings on this Mac instead');
  });
  test('the spoken line and the fallback note', () => {
    expect(ringMessage({ label: 'Gym', time: '06:45' })).toBe('Gym. It is 06:45.');
    expect(ringMessage({ label: '  ', time: '07:00' })).toBe('Alarm. It is 07:00.');
    expect(fallbackNote('Bedroom', 'Atlas could not reach Home Assistant on the network.')).toBe(
      'Bedroom didn’t answer (Atlas could not reach Home Assistant on the network), so it is ringing on this Mac.',
    );
  });
});
