/**
 * The Beta dock — the guideline dock (§09) until the final one is chosen from
 * the handoff's Dock Explorations. Order: Home · Core · Teach · Mail ·
 * Architecture · Voice · avatar. Icon-only when idle; only the current screen
 * shows its label. The shell renders exactly one, so it stays put across
 * route transitions.
 *
 * Built on the Workshop `Dock` primitive with `variant="beta"`: the item
 * model, the edition filter (an Architecture button never appears in a
 * consumer build) and the DEV assertions are shared; only the skin differs.
 */
import { useCallback, useMemo } from 'react';
import { useLocation } from 'react-router-dom';
import { Dock, type DockItem } from '@/components/atlas-ui/primitives';
import { useAccountDockItem } from '@/components/atlas-ui/useAccountDockItem';
import { AtlasIcon } from './AtlasIcon';
import type { IconName } from './icons';
import { useBetaNavigate } from '@/lib/viewTransitions';

const ORDER: { id: string; label: string; icon: IconName; to: string }[] = [
  { id: 'home', label: 'Home', icon: 'home', to: '/' },
  { id: 'core', label: 'Core', icon: 'core', to: '/atlas-core' },
  { id: 'teach', label: 'Teach', icon: 'teach', to: '/atlas-teach' },
  { id: 'mail', label: 'Mail', icon: 'mail', to: '/mail' },
  { id: 'architecture', label: 'Architecture', icon: 'architecture', to: '/atlas-architecture' },
  { id: 'voice', label: 'Voice', icon: 'voice', to: '/home' },
];

export function currentDockId(pathname: string): string | undefined {
  if (pathname === '/dashboard') return 'home';
  return ORDER.find((o) => o.to === pathname)?.id;
}

export function BetaDock() {
  const { pathname } = useLocation();
  const navigate = useBetaNavigate();
  // The account menu's "Privacy & delete account" asks for the memory tab;
  // the Beta Settings reads `?tab=` the way the Workshop route does.
  const openSettings = useCallback((tab?: 'memory') => navigate(tab ? `/settings?tab=${tab}` : '/settings'), [navigate]);
  const account = useAccountDockItem(openSettings);

  const items = useMemo<DockItem[]>(() => [
    ...ORDER.map((o) => ({
      id: o.id,
      label: o.label,
      icon: <AtlasIcon name={o.icon} size={18} />,
      to: o.to,
      onClick: () => navigate(o.to),
    })),
    account,
  ], [account, navigate]);

  return <Dock items={items} current={currentDockId(pathname)} variant="beta" />;
}
