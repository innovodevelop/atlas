/**
 * The dock's edition filter.
 *
 * Its own module rather than a second export from `Dock.tsx` for the same
 * reason `useAccountDockItem` is: a file that exports both a component and a
 * plain function loses React Fast Refresh for the whole file. It is also what
 * lets the filter be unit-tested without a DOM.
 */
import { isRoutable, surfaceByPath } from '@/surfaces';
import type { DockItem } from './Dock';

/**
 * Drops dock items linking to a path this edition does not ship.
 *
 * An UNKNOWN path (`to` naming nothing in the registry) is kept, not dropped:
 * that is a typo or an ad-hoc route, and silently deleting a button is a worse
 * answer to a typo than letting it 404 loudly. Only a path the registry knows
 * about AND this build does not route is removed — that case is deliberate,
 * not a mistake, and it must leave no trace in the UI.
 */
export const dockableItems = (items: DockItem[]): DockItem[] =>
  items.filter((i) => !i.to || !surfaceByPath(i.to) || isRoutable(i.to));
