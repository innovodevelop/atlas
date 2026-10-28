/**
 * The widget screens — what a Home widget opens into while the beta_ui flag
 * is on (Beta redesign phase 2/4, `Atlas Widget Screens Beta.dc.html`).
 *
 * BetaHome keeps the band above, the Back bar and Esc; this is the view
 * under them, one component per key. Weather, Calendar, Tasks and Briefing
 * are the design's screens on the app's real hooks (styles in
 * src/styles/beta/views.css, reading in src/lib/betaViews.ts); Watchlist and
 * Music wrap the Workshop bodies until their own screens land; Mail goes to
 * `/mail`. The design's Podcast and Focus screens have no widget key and no
 * source behind them, so they are not built here.
 */
import type { AtlasExpandedKey } from '@/pages/atlas/AtlasDashboard';
import { WeatherView } from './WeatherView';
import { CalendarView } from './CalendarView';
import { TasksView } from './TasksView';
import { BriefingView } from './BriefingView';
import { StocksView } from './StocksView';
import { EmailView } from './EmailView';
import { MusicView } from './MusicView';
import '@/styles/beta/views.css';

export type FullViewKey = Exclude<AtlasExpandedKey, null>;

export interface FullViewProps {
  which: FullViewKey;
  /** Back to the grid — the Back bar, Esc, and the views that hand off elsewhere. */
  onClose: () => void;
}

const LABEL: Record<FullViewKey, string> = {
  weather: 'Weather', calendar: 'Calendar', tasks: 'Tasks', stocks: 'Watchlist', email: 'Mail', news: 'Briefing', music: 'Music',
};

export function FullView({ which, onClose }: FullViewProps) {
  return (
    <div className={`b-wv b-wv--${which}`} data-screen-label={`Beta — ${LABEL[which]}`}>
      {which === 'weather' ? <WeatherView /> : null}
      {which === 'calendar' ? <CalendarView /> : null}
      {which === 'tasks' ? <TasksView /> : null}
      {which === 'news' ? <BriefingView /> : null}
      {which === 'stocks' ? <StocksView onClose={onClose} /> : null}
      {which === 'email' ? <EmailView onClose={onClose} /> : null}
      {which === 'music' ? <MusicView onClose={onClose} /> : null}
    </div>
  );
}
