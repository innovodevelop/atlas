import { describe, expect, test } from 'bun:test';
import {
  STOP_KEY, boardNote, countdown, departureNote, departuresHeadline, hhmm, kindOf, parseDepartures, parseStops,
  readSavedStop, routeFromQuestion, sameStop, transitApiError, transitErrorCopy, transitPlan, writeSavedStop,
} from './transit';

describe('transitPlan', () => {
  test('dormant until the key, then the stop, then the board', () => {
    expect(transitPlan('unavailable', null, null)).toBe('unavailable');
    expect(transitPlan('loading', null, null)).toBe('checking');
    expect(transitPlan('needs-key', { name: 'Nørreport St.' }, null)).toBe('needs-key');
    expect(transitPlan('ready', null, null)).toBe('pick-stop');
    expect(transitPlan('ready', { name: 'Nørreport St.' }, null)).toBe('board');
    expect(transitPlan('ready', { name: 'Nørreport St.' }, 'Nørreport')).toBe('board');
    expect(transitPlan('ready', { name: 'Nørreport St.' }, 'Aarhus H')).toBe('pick-stop');
  });
  test('sameStop', () => {
    expect(sameStop('København H', 'København')).toBe(true);
    expect(sameStop('Lund C', 'lund')).toBe(true);
    expect(sameStop('Nørreport St.', 'Østerport')).toBe(false);
    expect(sameStop('St.', 'H')).toBe(false);
  });
});

const NOW = new Date(2026, 9, 28, 14, 10, 0);

/** The shape `departureBoard?format=json` answers with (HAFAS ReST 2.x). */
const BOARD = {
  Departure: [
    { name: 'Re 4529', type: 'ST', direction: 'Lund C', time: '14:22:00', date: '2026-10-28', rtTime: '14:28:00', rtDate: '2026-10-28', track: '2', rtTrack: '2', ProductAtStop: { name: 'Re 4529', catOut: 'Re', catOutL: 'Regionaltog' } },
    { name: 'Re 4531', type: 'ST', direction: 'Kalmar C', time: '14:42:00', date: '2026-10-28', track: '2', ProductAtStop: { catOut: 'Re', catOutL: 'Regionaltog' } },
    { name: 'Bus 5C', type: 'ST', direction: 'Husum Torv', time: '14:15', date: '2026-10-28', ProductAtStop: { catOut: 'Bus', catOutL: 'Bybus' } },
    { name: 'Re 4527', type: 'ST', direction: 'Lund C', time: '14:02:00', date: '2026-10-28', track: '1' },
    { name: 'M2', direction: 'Lufthavnen', time: '14:30', date: '2026-10-28', cancelled: true, ProductAtStop: { catOut: 'M', catOutL: 'Metro' } },
    { name: 'broken', time: 'soon' },
  ],
};

describe('parseDepartures', () => {
  const deps = parseDepartures(BOARD, NOW);
  test('soonest first, without what has left or cannot be read', () => {
    expect(deps.map((d) => d.planned)).toEqual(['14:15', '14:22', '14:30', '14:42']);
  });
  test('reads realtime delay, track and kind', () => {
    const re = deps.find((d) => d.line === 'Re 4529')!;
    expect(re.delayMin).toBe(6);
    expect(re.expected).toBe('14:28');
    expect(re.track).toBe('2');
    expect(re.kind).toBe('train');
    expect(deps.find((d) => d.line === 'Bus 5C')!.kind).toBe('bus');
    expect(deps.find((d) => d.line === 'M2')!.kind).toBe('metro');
    expect(deps.find((d) => d.line === 'M2')!.cancelled).toBe(true);
  });
  test('a lone object and the XML-style wrapper both read', () => {
    expect(parseDepartures({ Departure: BOARD.Departure[1] }, NOW)).toHaveLength(1);
    expect(parseDepartures({ DepartureBoard: { Departure: [BOARD.Departure[1]] } }, NOW)).toHaveLength(1);
    expect(parseDepartures(null, NOW)).toEqual([]);
    expect(parseDepartures({ errorCode: 'API_AUTH' }, NOW)).toEqual([]);
  });
  test('a changed track is flagged', () => {
    const [d] = parseDepartures({ Departure: { name: 'IC 123', time: '14:20', date: '2026-10-28', track: '3', rtTrack: '5' } }, NOW);
    expect(d.trackChanged).toBe(true);
    expect(d.track).toBe('5');
    expect(departureNote(d)).toBe('On time · now from platform 5');
  });
});

describe('parseStops', () => {
  test('reads location.name, stops only, de-duplicated', () => {
    const json = {
      stopLocationOrCoordLocation: [
        { StopLocation: { id: 'A=1@O=Nørreport St.@L=8600646@', extId: '8600646', name: 'Nørreport St.' } },
        { CoordLocation: { id: 'A=2@O=Nørreport 1', name: 'Nørreport 1' } },
        { StopLocation: { id: 'A=1@O=Nørreport St.@L=8600646@', extId: '8600646', name: 'Nørreport St.' } },
        { StopLocation: { id: 'A=1@O=Nørreport St. (Metro)@L=8603307@', extId: 8603307, name: 'Nørreport St. (Metro)' } },
      ],
    };
    expect(parseStops(json)).toEqual([
      { id: 'A=1@O=Nørreport St.@L=8600646@', extId: '8600646', name: 'Nørreport St.' },
      { id: 'A=1@O=Nørreport St. (Metro)@L=8603307@', extId: '8603307', name: 'Nørreport St. (Metro)' },
    ]);
    expect(parseStops({ LocationList: { StopLocation: { id: 'x', name: 'Roskilde St.' } } })).toHaveLength(1);
    expect(parseStops('nope')).toEqual([]);
  });
});

describe('routeFromQuestion', () => {
  test('reads to and from', () => {
    expect(routeFromQuestion('When’s the next train to Lund?')).toEqual({ from: null, to: 'Lund' });
    expect(routeFromQuestion('next bus from Nørreport St. to Lund C')).toEqual({ from: 'Nørreport St', to: 'Lund C' });
    expect(routeFromQuestion('Next departures from Roskilde St.')).toEqual({ from: 'Roskilde St', to: null });
  });
  test('needs a capitalised place name', () => {
    expect(routeFromQuestion('how long does it take to get to Lund?').to).toBe('Lund');
    expect(routeFromQuestion('when do I need to leave?')).toEqual({ from: null, to: null });
  });
});

describe('what the screen says', () => {
  const deps = parseDepartures(BOARD, NOW);
  test('the headline comes from the first departure that runs', () => {
    expect(departuresHeadline(deps, 'Nørreport St.')).toBe('The next bus leaves Nørreport St. at 14:15.');
    const trains = deps.filter((d) => d.kind === 'train');
    expect(departuresHeadline(trains, 'Nørreport St.', 'Lund')).toBe('The next train to Lund leaves Nørreport St. at 14:22 from platform 2, six minutes late.');
    expect(departuresHeadline([], 'Nørreport St.', 'Lund')).toBe('Nothing leaves Nørreport St. for Lund in the next two hours.');
  });
  test('the note names a late or cancelled first departure', () => {
    const trains = deps.filter((d) => d.kind === 'train');
    expect(boardNote(trains)).toBe('The 14:22 is six minutes late; the 14:42 after it is on time.');
    expect(boardNote(deps)).toBeNull();
    expect(boardNote([])).toBeNull();
  });
  test('countdowns', () => {
    expect(countdown({ at: NOW.getTime() + 8 * 60000 }, NOW)).toBe('in 8 min');
    expect(countdown({ at: NOW.getTime() - 1000 }, NOW)).toBe('now');
    expect(countdown({ at: NOW.getTime() + 65 * 60000 }, NOW)).toBe('in 1 h 5 min');
  });
  test('departure notes', () => {
    const re = deps.find((d) => d.line === 'Re 4529')!;
    expect(departureNote(re)).toBe('6 min late · 14:28');
    expect(departureNote(deps.find((d) => d.cancelled)!)).toBe('Cancelled');
  });
});

describe('small readers', () => {
  test('hhmm', () => {
    expect(hhmm('9:05:00')).toBe('09:05');
    expect(hhmm('25:00')).toBeNull();
    expect(hhmm(undefined)).toBeNull();
  });
  test('kindOf', () => {
    expect(kindOf('S-tog', 'S')).toBe('train');
    expect(kindOf('Letbane')).toBe('tram');
    expect(kindOf('Færge')).toBe('ferry');
    expect(kindOf(null)).toBe('other');
  });
  test('API errors and Rust errors become plain lines', () => {
    expect(transitApiError({ errorCode: 'API_AUTH', errorText: 'access denied' })).toBe('Rejseplanen did not accept this access ID.');
    expect(transitApiError({ Departure: [] })).toBeNull();
    expect(transitErrorCopy('Rejseplanen: provider returned HTTP 403')).toMatch(/did not accept/);
    expect(transitErrorCopy('no access ID')).toMatch(/Add your Rejseplanen access ID/);
    expect(transitErrorCopy('provider unreachable (Dns)')).toMatch(/could not be reached/);
  });
});

describe('the saved stop', () => {
  function memory() {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); }, m };
  }
  test('round-trips and rejects junk', () => {
    const kv = memory();
    expect(readSavedStop(kv)).toBeNull();
    writeSavedStop({ id: 'A=1@O=X', extId: null, name: 'X' }, kv);
    expect(readSavedStop(kv)).toEqual({ id: 'A=1@O=X', extId: null, name: 'X' });
    kv.m.set(STOP_KEY, '{"id":1}');
    expect(readSavedStop(kv)).toBeNull();
    writeSavedStop(null, kv);
    expect(kv.m.has(STOP_KEY)).toBe(false);
  });
});
