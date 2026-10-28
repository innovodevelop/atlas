/**
 * Calendar — the day as a grid of hours with the events placed in it, the
 * week to switch days, the picked event's card with its actions, and the
 * free slots Atlas found.
 *
 * All of it is `useCalendarEvents`: the grid and headline are the day's real
 * events, Push and Delete write through `updateEvent` / `deleteEvent`, and
 * booking a slot is a real `addEvent` — the new block shows in the grid in
 * blue, its card opens, and the slot is gone because the time is taken. A
 * slot is offered for the open task Atlas would take first (`useTasks`), so
 * the block arrives named for the work it makes room for. The hook loads from
 * today forward, so earlier days in the week are not offered.
 */
import { useEffect, useMemo, useState } from 'react';
import { useCalendarEvents, type CalendarEvent } from '@/hooks/useCalendarEvents';
import { useTasks } from '@/hooks/useTasks';
import { VeilSphere } from '@/components/atlas/VeilSphere';
import { AtlasIcon } from '@/components/atlas/AtlasIcon';
import { openExternal } from '@/components/atlas-ui/answerViews/openExternal';
import type { RGB } from '@/lib/quickSphere';
import { eventDuration, eventTime, focusPhase, joinUrl } from '@/lib/stageFocus';
import {
  cardEvent, dayWindow, eventBox, eventsOnDay, fmtMinutes, focusTitle, freeSlots, meetingsHeadline, slotPlans, startOfDay,
  weekDays, type FreeSlot,
} from '@/lib/betaViews';
import { useTick } from './useTick';

/** Pixels per hour in the day grid (the design's HPX). */
const HPX = 64;
/** The card paper the now-line's sphere sits on. */
const CARD: RGB = [255, 253, 250];
const TIME = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const DATE = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' });

export function CalendarView() {
  const { events, addEvent, updateEvent, deleteEvent, isLoading, error } = useCalendarEvents();
  const { tasks } = useTasks();
  const now = useTick(30000);
  const today = startOfDay(now);
  const [dayStart, setDayStart] = useState(today);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [booking, setBooking] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const week = weekDays(now);
  const dayEvents = useMemo(() => eventsOnDay(events, dayStart), [events, dayStart]);
  const { startHour, endHour } = dayWindow(dayEvents, dayStart);
  const hours = endHour - startHour;
  const isToday = dayStart === today;
  const nowY = isToday ? Math.max(0, Math.min(hours, (now - dayStart) / 3600000 - startHour)) * HPX : null;
  const card = cardEvent(dayEvents, pickedId, now);
  const slots = freeSlots(dayEvents, dayStart, startHour, endHour, isToday ? now : dayStart + startHour * 3600000);
  const plans = slotPlans(slots.length, tasks, dayEvents.map((e) => e.title));
  const dateLabel = DATE.format(new Date(dayStart));

  // A fresh card means a fresh Delete: the confirmation never carries over,
  // and an armed Delete disarms itself if the second tap does not come.
  useEffect(() => { setConfirmDelete(false); }, [card?.id]);
  useEffect(() => {
    if (!confirmDelete) return;
    const t = window.setTimeout(() => setConfirmDelete(false), 3000);
    return () => window.clearTimeout(t);
  }, [confirmDelete]);

  const book = async (s: FreeSlot, i: number) => {
    const task = plans[i] ?? null;
    setBooking(s.start);
    try {
      const made = await addEvent({
        title: focusTitle(task),
        description: task ? `Time for the task "${task.title.trim()}", booked from the Calendar screen.` : 'Booked from the Calendar screen.',
        start_time: new Date(s.start),
        end_time: new Date(s.end),
        event_type: 'focus',
      });
      if (made) setPickedId(made.id);
    } finally {
      setBooking(null);
    }
  };
  const push = (e: CalendarEvent, minutes: number) => {
    const start = new Date(Date.parse(e.start_time) + minutes * 60000).toISOString();
    const end = e.end_time ? new Date(Date.parse(e.end_time) + minutes * 60000).toISOString() : null;
    void updateEvent(e.id, { start_time: start, end_time: end });
  };
  const remove = async (e: CalendarEvent) => {
    if (!confirmDelete) { setConfirmDelete(true); return; }
    setConfirmDelete(false);
    setPickedId(null);
    await deleteEvent(e.id);
  };

  const url = joinUrl(card);
  const cardDur = card ? eventDuration(card) : null;

  return (
    <div className="b-wv-two b-wv-two--start">
      <section className="b-wv-cal" aria-label="The day">
        <div className="b-wv-cal-head">
          <div className="b-wv-cal-title">
            <span className="b-wv-eyebrow">Calendar · {dateLabel}</span>
            <span className="b-wv-h1">{isLoading && !events.length ? 'Reading…' : meetingsHeadline(dayEvents)}</span>
          </div>
          <div className="b-wv-week" role="tablist" aria-label="This week">
            {week.map((d) => (
              <button
                key={d.dayStart}
                type="button"
                role="tab"
                aria-selected={d.dayStart === dayStart}
                className={`b-wv-day${d.dayStart === dayStart ? ' on' : ''}${d.today ? ' today' : ''}`}
                disabled={d.past}
                title={d.past ? 'Earlier days are not loaded' : DATE.format(new Date(d.dayStart))}
                onClick={() => { setDayStart(d.dayStart); setPickedId(null); }}
              >
                <span>{d.letter}</span><span className="b-wv-day-n">{d.number}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="b-wv-grid" style={{ height: hours * HPX }}>
          {Array.from({ length: hours + 1 }, (_, i) => (
            <span key={i} className="b-wv-hline" style={{ top: i * HPX }}><span className="b-num">{String(startHour + i).padStart(2, '0')}:00</span><i /></span>
          ))}
          {dayEvents.map((e) => {
            const box = eventBox(e, dayStart, startHour, HPX);
            const on = card?.id === e.id;
            const live = isToday && focusPhase(e, now) === 'now';
            const dur = eventDuration(e);
            return (
              <button
                key={e.id}
                type="button"
                className={`b-wv-ev${on ? ' on' : ''}${e.event_type === 'focus' ? ' focus' : ''}${live ? ' live' : ''}`}
                style={{ top: box.top, height: box.height }}
                onClick={() => setPickedId(e.id)}
                aria-pressed={on}
              >
                <span className="b-wv-ev-t">{e.title}</span>
                <span className="b-wv-ev-d">{eventTime(e)}{dur ? ` · ${dur}` : ''}{e.location ? ` · ${e.location}` : ''}</span>
              </button>
            );
          })}
          {nowY != null ? (
            <div className="b-wv-now" style={{ top: nowY }} aria-hidden>
              <div className="b-wv-now-sphere"><VeilSphere size="mini" count={1500} bg="transparent" tone={CARD} /></div>
            </div>
          ) : null}
          {!dayEvents.length && !isLoading ? <div className="b-wv-grid-empty">Nothing booked {isToday ? 'today' : 'this day'}.</div> : null}
        </div>
      </section>

      <aside className="b-wv-cal-side">
        <div className="b-wv-evcard">
          {card ? (
            <>
              <span className="b-wv-evcard-when">{eventTime(card)}{cardDur ? ` · ${cardDur}` : ''}{card.location ? ` · ${card.location}` : ''}</span>
              <span className="b-wv-evcard-t">{card.title}</span>
              <span className="b-wv-evcard-n">{card.description || 'No notes on this event.'}</span>
              {card.attendees.length ? (
                <div className="b-wv-evcard-people">{card.attendees.map((p) => <span key={p} className="b-wv-person">{p}</span>)}</div>
              ) : null}
              <div className="b-wv-evcard-actions">
                {url ? <button type="button" className="b-btn b-btn--paper" onClick={() => void openExternal(url)}><AtlasIcon name="open" size={16} />Join</button> : null}
                <button type="button" className="b-btn b-btn--onink" onClick={() => push(card, 15)}>Push 15 min</button>
                <button type="button" className={`b-btn b-btn--onink b-wv-evcard-del${confirmDelete ? ' arm' : ''}`} onClick={() => void remove(card)}>{confirmDelete ? 'Really delete?' : 'Delete'}</button>
              </div>
            </>
          ) : (
            <>
              <span className="b-wv-evcard-when">{dateLabel}</span>
              <span className="b-wv-evcard-t">{isLoading ? 'Reading your calendar…' : 'Nothing on this day'}</span>
              <span className="b-wv-evcard-n">Book a slot below and it lands here.</span>
            </>
          )}
        </div>
        <div className="b-wv-free">
          <span className="b-wv-free-t">Atlas found time</span>
          {slots.map((s, i) => {
            const task = plans[i];
            return (
              <button key={s.start} type="button" className="b-wv-slot" disabled={booking != null} onClick={() => void book(s, i)} title={`Book ${TIME.format(new Date(s.start))}–${TIME.format(new Date(s.end))}`}>
                <span className="b-wv-slot-time b-num">{TIME.format(new Date(s.start))}</span>
                <span className="b-wv-slot-l">{task ? `${fmtMinutes(s.minutes)} for ${task.title}` : `Focus block, ${fmtMinutes(s.minutes)}`}</span>
                <span className="b-wv-slot-act">{booking === s.start ? 'Booking…' : 'Book'}</span>
              </button>
            );
          })}
          {!slots.length ? <div className="b-wv-empty">{isToday ? 'No free half hour left in the day.' : 'The day is full.'}</div> : null}
          <span className="b-wv-free-note">Booking adds the block to your calendar. Pick it in the day to push or delete it.</span>
        </div>
        {error ? <p className="b-wv-err">{error}</p> : null}
      </aside>
    </div>
  );
}
