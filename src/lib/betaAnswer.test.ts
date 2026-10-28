import { describe, expect, test } from 'bun:test';
import {
  classify, departuresFrom, headlineOf, initials, numbersGrounded, parseComparison, parsePersonCard, personFromQuestion,
  personStats, questionFrom, relDay,
} from './betaAnswer';

const NOW = new Date(2026, 9, 28, 14, 0, 0);

describe('departuresFrom', () => {
  test('only the widget\'s explicit flag opens the board', () => {
    expect(departuresFrom({ departures: true })).toBe(true);
    expect(departuresFrom({ departures: 'yes' })).toBe(false);
    expect(departuresFrom(null)).toBe(false);
  });
});

describe('relDay', () => {
  test('today, yesterday, a weekday, then a date', () => {
    expect(relDay(new Date(2026, 9, 28, 8, 2).toISOString(), NOW, true)).toBe('Today, 08:02');
    expect(relDay(new Date(2026, 9, 27, 9).toISOString(), NOW)).toBe('Yesterday');
    expect(relDay(new Date(2026, 9, 29, 9).toISOString(), NOW)).toBe('Tomorrow');
    expect(relDay(new Date(2026, 9, 23, 9).toISOString(), NOW)).toBe('Friday');
    expect(relDay(new Date(2026, 9, 18, 9).toISOString(), NOW)).toBe('18 Oct');
    expect(relDay('nonsense', NOW)).toBe('');
    expect(relDay(null, NOW)).toBe('');
  });
});

describe('parseComparison', () => {
  const source = 'Compare the two flats. Nørrebro costs 2,050 a month with 4 rooms and a 12 min bike ride; Vesterbro is 1,850 with 3 rooms and 27 min.';
  const good = {
    items: [{ name: 'Nørrebro', note: 'Guldbergsgade' }, { name: 'Vesterbro' }],
    rows: [
      { attribute: 'Rent', values: ['€2,050 /mo', '€1,850 /mo'], best: 1 },
      { attribute: 'Rooms', values: ['4', '3'], best: 0 },
      { attribute: 'Commute', values: ['12 min by bike', '27 min'], best: 0 },
    ],
    pick: 0,
    verdict: 'Nørrebro fits you better: the shorter commute and the fourth room.',
  };
  test('a valid comparison comes through', () => {
    const c = parseComparison(good, source)!;
    expect(c.items.map((i) => i.name)).toEqual(['Nørrebro', 'Vesterbro']);
    expect(c.rows).toHaveLength(3);
    expect(c.rows[0].best).toBe(1);
    expect(c.pick).toBe(0);
    expect(c.items[0].note).toBe('Guldbergsgade');
  });
  test('rows with figures the answer never stated are dropped', () => {
    const c = parseComparison({ ...good, rows: [...good.rows, { attribute: 'Energy label', values: ['C (142 kWh)', 'B'], best: 1 }] }, source)!;
    expect(c.rows.map((r) => r.attribute)).toEqual(['Rent', 'Rooms', 'Commute']);
  });
  test('bad shapes fall back to the composed answer', () => {
    expect(parseComparison(null, source)).toBeNull();
    expect(parseComparison('{"items":[]}', source)).toBeNull();
    expect(parseComparison({ ...good, items: [{ name: 'Only one' }] }, source)).toBeNull();
    expect(parseComparison({ ...good, items: [{ name: 'Same' }, { name: 'same' }] }, source)).toBeNull();
    expect(parseComparison({ ...good, rows: [{ attribute: 'Rent', values: ['€2,050'] }] }, source)).toBeNull();
    expect(parseComparison({ ...good, verdict: '' }, source)).toBeNull();
    expect(parseComparison({ ...good, verdict: 'Nørrebro saves you 7 hours a week.' }, source)).toBeNull();
  });
  test('out-of-range indices become "no pick"', () => {
    const c = parseComparison({ ...good, pick: 5, rows: [{ ...good.rows[0], best: -1 }] }, source)!;
    expect(c.pick).toBeNull();
    expect(c.rows[0].best).toBeNull();
  });
});

describe('numbersGrounded', () => {
  test('every figure must appear in the source', () => {
    expect(numbersGrounded('€2,050', 'rent 2050 a month')).toBe(true);
    expect(numbersGrounded('2050', 'rent 2,050 a month')).toBe(true);
    expect(numbersGrounded('Move-in 1 Dec', 'moving on 1 December')).toBe(true);
    expect(numbersGrounded('86 / 100', 'no scores here')).toBe(false);
    expect(numbersGrounded('South-west', '')).toBe(true);
  });
});

describe('personFromQuestion', () => {
  test('reads the name the question is about', () => {
    expect(personFromQuestion('What do I know about Priya Raman?')).toBe('Priya Raman');
    expect(personFromQuestion('Who is Anders?')).toBe('Anders');
    expect(personFromQuestion('tell me about Søren Ægidius')).toBe('Søren Ægidius');
    expect(personFromQuestion('What do I know about priya@raman.studio?')).toBe('priya@raman.studio');
  });
  test('names nobody when there is no name', () => {
    expect(personFromQuestion('tell me about the weather')).toBeNull();
    expect(personFromQuestion('Explain the EU AI Act')).toBeNull();
    expect(personFromQuestion('Tell me about The Long And Winding Road Ahead')).toBeNull();
  });
});

describe('parsePersonCard', () => {
  const raw = {
    found: true,
    name: 'Priya Raman',
    address: 'priya@raman.studio',
    emails: 48,
    threads: 9,
    meetings: 6,
    lastContact: new Date(2026, 9, 28, 9).toISOString(),
    nextMeeting: { title: 'Offsite planning', start: new Date(2026, 10, 3, 10).toISOString(), location: null },
    recent: [
      { kind: 'mail-in', at: new Date(2026, 9, 28, 9).toISOString(), title: 'Offsite dates', sub: '12 or 19 Nov?', threadId: 't1' },
      { kind: 'bogus', at: 'x', title: 'dropped' },
    ],
  };
  test('reads the card and drops what does not validate', () => {
    const c = parsePersonCard(raw)!;
    expect(c.name).toBe('Priya Raman');
    expect(c.recent).toHaveLength(1);
    expect(c.nextMeeting?.title).toBe('Offsite planning');
    expect(personStats(c, NOW)).toEqual([{ k: 'Emails', v: '48' }, { k: 'Meetings', v: '6' }, { k: 'Last contact', v: 'Today' }]);
  });
  test('nobody found is null', () => {
    expect(parsePersonCard({ found: false })).toBeNull();
    expect(parsePersonCard({ found: true })).toBeNull();
    expect(parsePersonCard(null)).toBeNull();
  });
  test('initials', () => {
    expect(initials('Priya Raman')).toBe('PR');
    expect(initials('priya.raman@x.dk')).toBe('PR');
    expect(initials('')).toBe('?');
  });
});

describe('classify', () => {
  test('routes the design\'s six asks', () => {
    expect(classify('Do I need an umbrella tomorrow?')).toBe('weather');
    expect(classify('How much did I spend on food this month?')).toBe('money');
    expect(classify('When’s the next train to Lund?')).toBe('travel');
    expect(classify('Compare the two flats we’re looking at')).toBe('compare');
    expect(classify('What do I know about Priya Raman?')).toBe('person');
    expect(classify('Explain the EU AI Act in two minutes')).toBe('explain');
  });
  test('falls back to the explainer', () => {
    expect(classify('How do heat pumps work?')).toBe('explain');
  });
});

describe('headlineOf', () => {
  test('takes the first sentence without markdown', () => {
    expect(headlineOf('**Yes, take one.** It rains from 15:00.\n\n- more')).toBe('Yes, take one.');
    expect(headlineOf('# Heading\nThe act sorts AI by risk, and most of it applies from August 2026. More text.')).toBe('Heading The act sorts AI by risk, and most of it applies from August 2026.');
  });
  test('clips a long first sentence', () => {
    const long = `${'word '.repeat(60)}end.`;
    expect(headlineOf(long).length).toBeLessThanOrEqual(140);
    expect(headlineOf(long).endsWith('…')).toBe(true);
    expect(headlineOf('')).toBe('');
  });
});

describe('questionFrom', () => {
  test('prefers the query string, then router state', () => {
    expect(questionFrom('?q=Do+I+need+an+umbrella%3F', null)).toBe('Do I need an umbrella?');
    expect(questionFrom('', { q: ' hi ' })).toBe('hi');
    expect(questionFrom('?x=1', { other: 1 })).toBeNull();
  });
});
