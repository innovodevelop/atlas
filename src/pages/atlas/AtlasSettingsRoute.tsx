import { useNavigate, useSearchParams } from 'react-router-dom';
import { AtlasSettings, type SettingsTab } from './AtlasSettings';

/**
 * Registration data. Mirrored in `src/surfaces.ts`, which is what the router,
 * the dock and the account menu are built from; `surfaces.test.ts` fails if the
 * two ever disagree.
 *
 * `entry: 'none'` is deliberate. Settings already has two doors — the dock
 * button and the account menu, both opening the overlay — and this route exists
 * so a deep link has somewhere to land. A generated third link would be a
 * second entry to one room.
 */
export const surface = {
  path: '/settings',
  label: 'Settings',
  icon: 'Settings',
  entry: 'none' as const,
  mock: false,
  edition: 'consumer' as const,
};

/**
 * Settings as a real route.
 *
 * Before this, Settings existed ONLY as an overlay inside the dashboard
 * (`AtlasDashboard.tsx`, gated by `settingsOpen`). Nothing could link to it, the
 * back button did not know it had been opened, and a crash on any other screen
 * left the user with no way to reach voice, budget or privacy at all.
 *
 * BOTH ENTRIES STAY. The dock button and the account menu still open the
 * overlay — that is the right feel from the dashboard, where Settings is a
 * modal over your own desk, and it keeps the deep-link-to-a-tab behaviour the
 * AccountMenu relies on. This route is the addressable copy of the same
 * component: `/settings`, or `/settings?tab=memory` for a panel.
 *
 * Closing navigates BACK rather than to `/`, so arriving here from Mail returns
 * you to Mail. `navigate(-1)` with no history (a cold launch straight onto
 * /settings) is a no-op in React Router, so the fallback is explicit.
 */
const TABS = new Set<SettingsTab>([
  'voice', 'mail', 'portfolio', 'music', 'budget',
  'personality', 'memory', 'permissions', 'updates',
]);

const AtlasSettingsRoute = () => {
  const navigate = useNavigate();
  const [params] = useSearchParams();

  const requested = params.get('tab') as SettingsTab | null;
  const initialTab = requested && TABS.has(requested) ? requested : undefined;

  const close = () => {
    if (window.history.length > 1) navigate(-1);
    else navigate('/');
  };

  // `mode="route"` tells the panels that closing here is a history traversal,
  // not a setState — so anything that navigates AWAY from Settings must not
  // also call `onClose` (the queued go(-1) would undo the push).
  return <AtlasSettings initialTab={initialTab} onClose={close} mode="route" />;
};

export default AtlasSettingsRoute;
