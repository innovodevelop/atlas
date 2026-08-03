/**
 * The dock's account chip, ready to append to any `<Dock>` item list.
 *
 * `AccountMenu` holds the app's ONLY sign-out control, its only plan display
 * and its only route to privacy/delete-account — and it was mounted from
 * `AtlasDashboard` alone, so every other docked surface silently dropped all
 * three. Sharing the item rather than re-declaring it is also what keeps the
 * docks from drifting the way their hand-written JSX did before `<Dock>`
 * existed (see `Dock.tsx`).
 *
 * Its own file rather than a second export from `AccountMenu.tsx`: a module
 * that exports both a component and a hook loses React Fast Refresh for the
 * whole file, which would make every tweak to the menu a full reload.
 */
import { useMemo, useState } from 'react';
import { AccountMenu } from './AccountMenu';
import { useUserProfile } from '@/hooks/useUserProfile';
import type { DockItem } from '@/components/atlas-ui/primitives';

/**
 * The avatar must be the LAST item in the list — `<Dock>` asserts that in DEV.
 *
 * `onOpenSettings` stays the caller's because the right answer differs per
 * screen: the dashboard opens Settings as an overlay over your own desk, and a
 * screen with no such overlay routes to `/settings`, the addressable copy that
 * `AtlasSettingsRoute` exists to be. Pass a stable callback.
 */
export function useAccountDockItem(onOpenSettings: (tab?: 'memory') => void): DockItem {
  const { profile } = useUserProfile();
  const [open, setOpen] = useState(false);

  const name = profile?.nickname || profile?.first_name || profile?.display_name || 'there';
  const initials = (name[0] || 'A').toUpperCase();

  return useMemo<DockItem>(() => ({
    id: 'account',
    label: 'Account',
    icon: initials,
    kind: 'avatar',
    onClick: () => setOpen((v) => !v),
    popover: open
      ? <AccountMenu onClose={() => setOpen(false)} onOpenSettings={onOpenSettings} />
      : undefined,
  }), [initials, open, onOpenSettings]);
}
