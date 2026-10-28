import { describe, expect, test } from 'bun:test';
import { WIDGETS, WIDGET_BY_ID, type WidgetDef } from './betaHome';
import { ICON_PATHS } from '@/components/atlas/icons';
import {
  ATTENTION_IDLE, ATTENTION_RULE, CORE_WIDGETS, EMPTY_COPY, OFFLINE_COPY, SHEET_STATES, SIZE_CHOICES,
  ageLabel, briefingAttention, catalogPlan, cellsFor, dueAt, emptyCopy, gridColumnsFor, groupChips, groupOrder,
  inboxAttention, isCoreWidget, mailOffline, overdueTasks, sizeDim, sizesFor, skeletonBars, sourceVerdict,
  tasksAttention, todayAttention, tonesFor, watchAttention, weatherAttention, type SourceStatusLike,
} from './betaWidgetCatalog';
import type { CalendarEvent } from '@/hooks/useCalendarEvents';

const def = (id: string): WidgetDef => WIDGET_BY_ID.get(id)!;

describe('sizes and tones', () => {
  test('every size a widget offers, in S → XL order', () => {
    expect(sizesFor(def('watch'), 'all')).toEqual(['S', 'M', 'L', 'XL']);
    expect(sizesFor(def('weather'), 'all')).toEqual(['S', 'M', 'L']);
  });
  test('a picked size the widget does not offer draws nothing', () => {
    expect(sizesFor(def('weather'), 'XL')).toEqual([]);
    expect(sizesFor(def('watch'), 'XL')).toEqual(['XL']);
  });
  test('dims come from the grid spans', () => {
    expect(sizeDim('S')).toBe('2×1');
    expect(sizeDim('XL')).toBe('6×2');
    expect(SIZE_CHOICES.map((c) => c.id)).toEqual(['all', 'S', 'M', 'L', 'XL']);
  });
  test('both means paper then ink', () => {
    expect(tonesFor('both')).toEqual(['paper', 'ink']);
    expect(tonesFor('ink')).toEqual(['ink']);
  });
});

describe('the grid plan', () => {
  test('the design breakpoints', () => {
    expect(gridColumnsFor(1440)).toBe(12);
    expect(gridColumnsFor(1280)).toBe(12);
    expect(gridColumnsFor(1000)).toBe(6);
    expect(gridColumnsFor(375)).toBe(3);
  });
  test('one cell per widget × size × tone, spans clamped to the columns', () => {
    const cells = cellsFor([def('watch')], 'all', 'both', 3);
    expect(cells).toHaveLength(8);
    expect(cells.map((c) => c.key).slice(0, 2)).toEqual(['watch-S-paper', 'watch-S-ink']);
    const xl = cells.find((c) => c.size === 'XL')!;
    expect(xl.cols).toBe(3);
    expect(xl.rows).toBe(2);
    expect(cellsFor([def('watch')], 'XL', 'paper', 12)[0].cols).toBe(6);
  });
  test('groups keep catalog order and their counts add up', () => {
    const order = groupOrder();
    expect(order[0]).toBe(WIDGETS[0].group);
    expect(new Set(order).size).toBe(order.length);
    const chips = groupChips();
    expect(chips[0]).toEqual({ id: 'all', label: 'All', n: WIDGETS.length });
    expect(chips.slice(1).reduce((n, c) => n + c.n, 0)).toBe(WIDGETS.length);
  });
  test('the whole catalog draws every widget at every size it offers', () => {
    const plan = catalogPlan({ group: 'all', size: 'all', design: 'both', gridCols: 12 });
    const cells = plan.flatMap((s) => s.cells);
    const expected = WIDGETS.reduce((n, w) => n + w.sizes.length * 2, 0);
    expect(cells).toHaveLength(expected);
    expect(new Set(cells.map((c) => c.id)).size).toBe(WIDGETS.length);
  });
  test('a size only some widgets offer leaves only their groups', () => {
    const plan = catalogPlan({ group: 'all', size: 'XL', design: 'paper', gridCols: 12 });
    expect(plan.map((s) => s.group)).toEqual([def('watch').group]);
    expect(plan[0].widgets.map((w) => w.id)).toEqual(['watch']);
  });
  test('a group filter with nothing at that size is an empty plan, not an empty section', () => {
    expect(catalogPlan({ group: 'Day', size: 'XL', design: 'both', gridCols: 12 })).toEqual([]);
  });
  test('skeletons: a body for two rows, a line or two for one', () => {
    expect(skeletonBars('L').length).toBeGreaterThan(skeletonBars('S').length);
    expect(skeletonBars('M')).toEqual(skeletonBars('S'));
  });
});

describe('the sheet', () => {
  test('six core widgets, all on Home, in five states', () => {
    expect(CORE_WIDGETS).toHaveLength(6);
    for (const id of CORE_WIDGETS) expect(WIDGET_BY_ID.has(id)).toBe(true);
    expect(SHEET_STATES.map((s) => s.id)).toEqual(['loading', 'default', 'attention', 'empty', 'offline']);
    expect(SHEET_STATES.find((s) => s.id === 'default')!.preview).toBeUndefined();
    expect(isCoreWidget('weather')).toBe(true);
    expect(isCoreWidget('energy')).toBe(false);
  });
  test('every core widget has a rule, an idle line and offline copy', () => {
    for (const id of CORE_WIDGETS) {
      expect(ATTENTION_RULE[id].length).toBeGreaterThan(10);
      expect(ATTENTION_IDLE[id].length).toBeGreaterThan(10);
      expect(OFFLINE_COPY[id].text.length).toBeGreaterThan(5);
    }
    expect(OFFLINE_COPY.tasks.dim).toBe(false);
    expect(OFFLINE_COPY.weather.dim).toBe(true);
  });
  test('every widget has empty copy, and every route action is a path', () => {
    for (const w of WIDGETS) {
      expect(EMPTY_COPY[w.id]).toBeDefined();
      const a = EMPTY_COPY[w.id].action;
      if (a && 'route' in a) expect(a.route.startsWith('/')).toBe(true);
    }
    expect(emptyCopy('nope').title).toBe('No data yet');
  });
});

describe('attention from live data', () => {
  const at = (h: number, m = 0) => new Date(2026, 9, 28, h, m).getTime();
  const ev = (title: string, start: number, end?: number, location: string | null = null): CalendarEvent => ({
    id: title, title, description: null, start_time: new Date(start).toISOString(), end_time: end ? new Date(end).toISOString() : null,
    location, event_type: 'event', attendees: [], created_at: '', updated_at: '',
  });

  test('weather: the first wet hour on the card', () => {
    expect(weatherAttention([{ time: 'Now', icon: 'cloudy' }, { time: '3PM', icon: 'rainy' }])).toEqual({ text: 'Rain around 3PM', tone: 'blue', icon: 'rain' });
    expect(weatherAttention([{ time: 'Now', icon: 'thunderstorm' }])!.text).toBe('Storms now');
    expect(weatherAttention([{ time: 'Now', icon: 'sunny' }])).toBeNull();
  });
  test('today: ten minutes out, or on now, with the join link', () => {
    const e = ev('1:1 with Maya', at(11), at(11, 30), 'https://meet.example/abc');
    expect(todayAttention(e, at(10, 30))).toBeNull();
    const soon = todayAttention(e, at(10, 55))!;
    expect(soon.text).toBe('1:1 with Maya starts in 5 min');
    expect(soon.join).toBe('https://meet.example/abc');
    expect(todayAttention(e, at(11, 10))!.text).toBe('1:1 with Maya is on now');
    expect(todayAttention(e, at(12))).toBeNull();
    expect(todayAttention(null, at(12))).toBeNull();
  });
  test('tasks: a bare due date is a local day', () => {
    expect(new Date(dueAt('2026-10-27')).getHours()).toBe(0);
    expect(new Date(dueAt('2026-10-27')).getDate()).toBe(27);
    const now = at(14);
    const tasks = [
      { title: 'Renew passport', completed: false, due_date: '2026-10-27' },
      { title: 'Due today', completed: false, due_date: '2026-10-28' },
      { title: 'Done late', completed: true, due_date: '2026-10-01' },
      { title: 'Timed, earlier today', completed: false, due_date: new Date(at(9)).toISOString() },
      { title: 'No date', completed: false, due_date: null },
    ];
    expect(overdueTasks(tasks, now).map((t) => t.title)).toEqual(['Renew passport', 'Timed, earlier today']);
    expect(tasksAttention(tasks, now)).toEqual({ text: '2 tasks overdue', tone: 'red', icon: 'warning' });
    expect(tasksAttention([tasks[0]], now)!.text).toBe('Renew passport is overdue');
    expect(tasksAttention([tasks[1]], now)).toBeNull();
  });
  test('inbox, watchlist, briefing', () => {
    expect(inboxAttention([{ title: 'Old', acknowledged: true }, { title: 'Dana needs the embargo confirmed', acknowledged: false }])!.text).toBe('Dana needs the embargo confirmed');
    expect(inboxAttention([])).toBeNull();
    expect(watchAttention([{ symbol: 'AAPL', changePercent: 0.6 }, { symbol: 'NVDA', changePercent: 5.24 }, { symbol: 'MSFT', changePercent: -3.4 }])!.text).toBe('NVDA +5.2%, past ±3%');
    expect(watchAttention([{ symbol: 'MSFT', changePercent: -3.4 }])!.text).toBe('MSFT −3.4%, past ±3%');
    expect(watchAttention([{ symbol: 'AAPL', changePercent: 2.9 }])).toBeNull();
    expect(briefingAttention([{ title: 'Calm', trending: false }, { title: 'EU AI Act dates confirmed', trending: true }])!.text).toBe('Trending: EU AI Act dates confirmed');
    expect(briefingAttention([])).toBeNull();
  });
  test('every attention icon exists in the Precision set', () => {
    for (const a of [weatherAttention([{ time: 'Now', icon: 'rain' }]), tasksAttention([{ title: 'x', completed: false, due_date: '2000-01-01' }], Date.now()), inboxAttention([{ title: 'x', acknowledged: false }]), watchAttention([{ symbol: 'X', changePercent: 9 }]), briefingAttention([{ title: 'x', trending: true }])]) {
      expect(a!.icon in ICON_PATHS).toBe(true);
    }
  });
});

describe('offline and ages', () => {
  test('ageLabel', () => {
    expect(ageLabel(10_000)).toBe('just now');
    expect(ageLabel(4 * 60_000)).toBe('4 min ago');
    expect(ageLabel(3 * 3_600_000)).toBe('3 h ago');
    expect(ageLabel(50 * 3_600_000)).toBe('2 d ago');
    expect(ageLabel(-5)).toBe('just now');
  });
  test('mail offline uses the newest sync', () => {
    const now = Date.parse('2026-10-28T12:00:00Z');
    expect(mailOffline([{ last_synced_at: '2026-10-28T11:56:00Z' }, { last_synced_at: '2026-10-28T10:00:00Z' }], now)).toBe('mail sync paused · last synced 4 min ago');
    expect(mailOffline([{ last_synced_at: null }], now)).toBeNull();
    expect(mailOffline([], now)).toBeNull();
  });
});

describe('sourceVerdict', () => {
  const ready = (keys: SourceStatusLike['keys']): SourceStatusLike => ({ phase: 'ready', keys, reason: null });
  test('local sources need no key', () => {
    expect(sourceVerdict('tasks', ready({}), null)).toEqual({ tone: 'ready', text: 'Tasks on this Mac · no key needed' });
  });
  test('a missing key is said plainly', () => {
    expect(sourceVerdict('weather', ready({ openweather: false }), null).tone).toBe('failed');
    expect(sourceVerdict('weather', ready({ openweather: true }), null)).toEqual({ tone: 'ready', text: 'OpenWeather key on this Mac' });
  });
  test('not knowing is not the same as missing', () => {
    expect(sourceVerdict('watch', { phase: 'unknown', keys: {}, reason: 'browser' }, null)).toEqual({ tone: 'paused', text: 'Finnhub key: cannot tell from here', title: 'browser' });
    expect(sourceVerdict('briefing', ready({}), null).tone).toBe('paused');
    expect(sourceVerdict('briefing', { phase: 'loading', keys: {}, reason: null }, null).tone).toBe('syncing');
  });
  test('the mailbox', () => {
    expect(sourceVerdict('inbox', ready({}), true).text).toBe('Mailbox connected');
    expect(sourceVerdict('inbox', ready({}), false).tone).toBe('paused');
    expect(sourceVerdict('inbox', ready({}), null).tone).toBe('syncing');
  });
});
