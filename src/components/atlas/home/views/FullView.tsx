/**
 * The widget screens — what a Home widget opens into while the beta_ui flag
 * is on (Beta redesign phase 2/4, `Atlas Widget Screens Beta.dc.html`).
 *
 * BetaHome keeps the band above, the Back bar and Esc; this is the view
 * under them, one component per key. Weather, Calendar, Tasks, Briefing and
 * Focus are the design's screens on the app's real hooks (styles in
 * src/styles/beta/views.css, reading in src/lib/betaViews.ts and
 * src/lib/betaFocus.ts); Watchlist is the editable list in the Beta frame,
 * Currency the widget's pair and its month; Music wraps the Workshop body
 * until its own screen lands; Mail goes to `/mail`. The design's Podcast
 * screen has no source behind it, so it is not built here.
 */
import type { HomeViewKey } from '@/lib/betaHome';
import { WeatherView } from './WeatherView';
import { CalendarView } from './CalendarView';
import { TasksView } from './TasksView';
import { BriefingView } from './BriefingView';
import { StocksView } from './StocksView';
import { EmailView } from './EmailView';
import { MusicView } from './MusicView';
import { FocusView } from './FocusView';
import { CurrencyView } from './CurrencyView';
import '@/styles/beta/views.css';

export type FullViewKey = HomeViewKey;

export interface FullViewProps {
  which: FullViewKey;
  /** Back to the grid — the Back bar, Esc, and the views that hand off elsewhere. */
  onClose: () => void;
}

const LABEL: Record<FullViewKey, string> = {
  weather: 'Weather', calendar: 'Calendar', tasks: 'Tasks', stocks: 'Watchlist', email: 'Mail', news: 'Briefing', music: 'Music',
  focus: 'Focus', fx: 'Currency',
};

export function FullView({ which, onClose }: FullViewProps) {
  return (
    <div className={`b-wv b-wv--${which}`} data-screen-label={`Beta — ${LABEL[which]}`}>
      {which === 'weather' ? <WeatherView /> : null}
      {which === 'calendar' ? <CalendarView /> : null}
      {which === 'tasks' ? <TasksView /> : null}
      {which === 'news' ? <BriefingView /> : null}
      {which === 'stocks' ? <StocksView /> : null}
      {which === 'email' ? <EmailView onClose={onClose} /> : null}
      {which === 'music' ? <MusicView onClose={onClose} /> : null}
      {which === 'focus' ? <FocusView /> : null}
      {which === 'fx' ? <CurrencyView /> : null}
    </div>
  );
}
