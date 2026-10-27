/**
 * The tall Stage band — the top of the Beta Home (§03 Stage band, and the
 * "Now stage" section of `Atlas Dashboard Beta.dc.html`).
 *
 * Sphere (the talk entry point) · date eyebrow, greeting, one line of
 * context, suggested asks · the focus card: the next calendar event with
 * one primary and one secondary action, and what comes after it.
 *
 * Everything here is the user's: the greeting from the Home session's gate,
 * the context line from real counts, the asks built from today's calendar
 * and mail, the focus card from `useCalendarEvents`. The reading of the day
 * itself is in src/lib/stageFocus.ts, where it is tested.
 */
import { useEffect, useRef } from 'react';
import { VeilSphere } from '../VeilSphere';
import { openTalk, setTalkAnchor } from '@/lib/talkBus';
import { openExternal } from '@/components/atlas-ui/answerViews/openExternal';
import {
  contextLine, eventDuration, eventTime, focusEvent, focusIn, focusPhase, joinUrl, stageDate, suggestedAsks, thenEvents, todaysEvents,
} from '@/lib/stageFocus';
import type { HomeSession } from '@/hooks/useHomeSession';
import type { CalendarEvent } from '@/hooks/useCalendarEvents';

export interface StageBandProps {
  session: HomeSession;
  /** Unanswered mail, for the asks and the context line. */
  needsYou: number;
  tasksOpen: number;
  onOpenCalendar: () => void;
  onPush: (e: CalendarEvent, minutes: number) => void;
  /** 'Compact' | 'Balanced' | 'Generous' — the sphere's share of the band. */
  atlasSize?: 'Compact' | 'Balanced' | 'Generous';
  /** Grid and Centred layouts use the short band: sphere and greeting only. */
  variant?: 'tall' | 'short' | 'centred';
}

export function StageBand({ session, needsYou, tasksOpen, onOpenCalendar, onPush, atlasSize = 'Balanced', variant = 'tall' }: StageBandProps) {
  const now = Date.now();
  const { events, home, weather } = session;
  const sphereRef = useRef<HTMLDivElement | null>(null);
  // This band's sphere is the talk entry point: the orb hides while it is on
  // screen and the panel anchors beside it.
  useEffect(() => {
    setTalkAnchor(sphereRef.current);
    return () => setTalkAnchor(null);
  }, []);

  const todays = todaysEvents(events, now);
  const focus = focusEvent(todays, now);
  const then = thenEvents(todays, focus);
  const asks = suggestedAsks(todays, now, needsYou);
  const link = joinUrl(focus);
  const words = `${home.lead}${home.accent}`.trim().split(/\s+/);
  const weatherBit = weather ? `${Math.round(weather.temp)}° and ${weather.condition.toLowerCase()}` : null;
  const context = contextLine({ events: todays.length, needsYou, tasksOpen, weather: weatherBit });
  const tall = variant === 'tall';

  return (
    <section className={`b-band b-band--${tall ? 'tall' : 'short'} b-stage b-stage--${variant} b-stage--${atlasSize.toLowerCase()}`} aria-label="Right now">
      <div className="b-band-sphere" ref={sphereRef}>
        <VeilSphere size={tall ? 'band' : 'short'} bg="#f1eeea" />
        <button type="button" className="b-stage-talk" title="Talk to Atlas · ⌥ Space" aria-label="Talk to Atlas" onClick={() => openTalk()} />
      </div>
      <div className="b-stage-greet">
        <span className="b-eyebrow">{stageDate(now)}</span>
        <h1 className="b-greeting">
          {words.map((w, i) => <span key={`${i}-${w}`} className="b-greet-word" style={{ animationDelay: `${i * 60}ms` }}>{w}</span>)}
        </h1>
        <p className="b-intro">{context}</p>
        <div className="b-stage-asks">
          {asks.map((a) => (
            <button type="button" key={a.q} className="b-chip b-chip--card" onClick={() => openTalk(a.q)}>{a.t}</button>
          ))}
        </div>
      </div>
      {tall ? (
        <div className="b-focus" onClick={onOpenCalendar} role="button" tabIndex={0} title="Open Calendar"
          onKeyDown={(e) => { if (e.key === 'Enter') onOpenCalendar(); }}>
          <div className="b-focus-main">
            <span className="b-focus-head"><span className="b-card-title">Now in focus</span><span className="bw-meta">Today · {todays.length} {todays.length === 1 ? 'event' : 'events'}</span></span>
            {focus ? (
              <>
                <span className="b-focus-time"><span className="b-focus-clock b-num">{eventTime(focus)}</span><span className="b-focus-in">{focusIn(focus, now)}</span></span>
                <span className="b-focus-name">{focus.title}{focus.location && !link ? <span className="b-focus-where"> · {focus.location}</span> : null}</span>
                {eventDuration(focus) ? <span className="b-focus-sub">{eventDuration(focus)}{link ? ' · video call' : ''}</span> : null}
                <span className="b-focus-actions" onClick={(e) => e.stopPropagation()}>
                  {link ? (
                    <button type="button" className="b-btn b-btn--primary" onClick={() => void openExternal(link)}>Join</button>
                  ) : (
                    <button type="button" className="b-btn b-btn--primary" onClick={onOpenCalendar}>Open</button>
                  )}
                  {focusPhase(focus, now) !== 'done' ? (
                    <button type="button" className="b-btn" onClick={() => onPush(focus, 15)}>Push 15 min</button>
                  ) : null}
                </span>
              </>
            ) : (
              <>
                <span className="b-focus-time"><span className="b-focus-clock">Free</span></span>
                <span className="b-focus-name">Nothing scheduled today</span>
                <span className="b-focus-actions" onClick={(e) => e.stopPropagation()}>
                  <button type="button" className="b-btn b-btn--primary" onClick={onOpenCalendar}>Open Calendar</button>
                  <button type="button" className="b-btn" onClick={() => openTalk('What should I do with a free day?')}>Ask Atlas</button>
                </span>
              </>
            )}
          </div>
          {then.length ? (
            <div className="b-focus-then">
              <span className="b-eyebrow">Then</span>
              {then.map((e) => (
                <span className="b-focus-then-row" key={e.id}><span className="b-num">{eventTime(e)}</span><span>{e.title}</span></span>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
