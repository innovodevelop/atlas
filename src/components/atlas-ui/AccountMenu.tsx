/**
 * Account menu — the popover behind the dock's avatar chip.
 *
 * Atlas has never had one. Before this, the avatar navigated to /atlas-core (a
 * health dashboard) and there was no route to sign out, see which plan you are
 * on, or delete your account. That last one matters: the published privacy
 * policy tells users they can delete their account from inside the app, so the
 * absence was a promise the product did not keep. See
 * docs/design-sync/2026-07-26-audit-sphere-mail-header.md §5.
 *
 * Deliberately thin: it routes to things that already exist rather than
 * duplicating them. Account deletion lives in Settings → Memory & Privacy,
 * which owns the typed confirmation and the opt-in local erase.
 *
 * ── THE ROWS ARE GENERATED ──────────────────────────────────────────────────
 *
 * Every navigation row comes from `menuSurfaces` in src/surfaces.ts. The
 * hand-written list this replaces is the reason the registry exists: it had
 * drifted from the pages it linked (`Design Sync` vs `Design sync`,
 * `Model Lab` vs `Model lab`), and `/home` sat routed-but-unlinked for weeks
 * because adding a route and adding a link were two separate edits. They are
 * one edit now — a `surface` export plus a registry entry — and
 * `surfaces.test.ts` fails if the two disagree.
 *
 * It is also the second half of the edition split. `menuSurfaces` contains no
 * admin entry in a consumer build, so this menu cannot offer a door to a screen
 * that is not in the bundle; there is no `edition === 'admin' &&` conditional
 * here to forget, because there is nothing to hide.
 */
import { useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { LogOut, Settings as SettingsIcon, ShieldX, BadgeCheck } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { menuSurfaces } from '@/surfaces';
import { surfaceIcon } from './surfaceIcons';

interface Props {
  onClose: () => void;
  /** Opens the settings overlay; `tab` lets the menu deep-link to a panel. */
  onOpenSettings: (tab?: 'memory') => void;
}

export function AccountMenu({ onClose, onOpenSettings }: Props) {
  const { user, entitlement, signOut } = useAuth();
  const ref = useRef<HTMLDivElement | null>(null);
  const navigate = useNavigate();

  const go = (path: string) => { onClose(); navigate(path); };

  // Dismiss on outside click or Escape — a menu you cannot close without
  // picking something is a trap, and one of the items signs you out.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const email = user?.email ?? 'Not signed in';
  const plan = entitlement?.plan ?? 'free';
  const status = entitlement?.status;

  // Two groups, one separator between them. In a consumer build the admin group
  // is empty and the separator is not drawn — a menu that ends in a rule with
  // nothing under it is how a hidden section announces itself.
  const [personal, operator] = useMemo(() => [
    menuSurfaces.filter((s) => s.edition === 'consumer'),
    menuSurfaces.filter((s) => s.edition === 'admin'),
  ], []);

  const row = (path: string, label: string, icon: string) => {
    const Icon = surfaceIcon(icon);
    return (
      <button key={path} className="acctitem" role="menuitem" onClick={() => go(path)}>
        <Icon className="i16" /><span>{label}</span>
      </button>
    );
  };

  return (
    <div className="acctmenu" ref={ref} role="menu" aria-label="Account">
      <div className="acctid">
        <p className="acctmail" title={email}>{email}</p>
        <p className="acctplan">
          <BadgeCheck className="i12" />
          <span>{plan}{status && status !== 'active' ? ` · ${status}` : ''}</span>
        </p>
      </div>

      <button className="acctitem" role="menuitem" onClick={() => { onClose(); onOpenSettings(); }}>
        <SettingsIcon className="i16" /><span>Settings</span>
      </button>

      {/* Routes to the panel that owns the real flow rather than re-implementing
          a destructive action in a popover. */}
      <button className="acctitem" role="menuitem" onClick={() => { onClose(); onOpenSettings('memory'); }}>
        <ShieldX className="i16" /><span>Privacy &amp; delete account</span>
      </button>

      <div className="acctsep" />

      {personal.map((s) => row(s.path, s.label, s.icon))}

      {operator.length > 0 && <div className="acctsep" />}
      {operator.map((s) => row(s.path, s.label, s.icon))}

      <div className="acctsep" />

      <button className="acctitem acctdanger" role="menuitem" onClick={() => { onClose(); void signOut(); }}>
        <LogOut className="i16" /><span>Sign out</span>
      </button>
    </div>
  );
}
