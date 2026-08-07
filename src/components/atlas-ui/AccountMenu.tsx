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
 */
import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  LogOut, Settings as SettingsIcon, ShieldX, BadgeCheck,
  GraduationCap, Network, Orbit, Mic,
  GitBranch, Monitor, Palette, TestTube2,
} from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';

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

      {/* /atlas-teach and /atlas-architecture were routed but linked from
          nowhere — you could only reach them by typing the URL. The dock is
          full (eight items) and neither is a daily surface, so they land here
          rather than crowding it. */}
      <button className="acctitem" role="menuitem" onClick={() => go('/atlas-teach')}>
        <GraduationCap className="i16" /><span>Teach Atlas</span>
      </button>

      <button className="acctitem" role="menuitem" onClick={() => go('/atlas-architecture')}>
        <Network className="i16" /><span>How Atlas works</span>
      </button>

      {/* The T3 surfaces. Menu, not dock — four of them (Smart home, Health,
          Money, Widget sheet) run on clearly-labelled sample data because no
          adapter exists yet, and a surface with nothing behind it should not
          take a primary slot. They move to the dock the day real data lands.
          Routed AND linked together: `/atlas-teach` and `/atlas-architecture`
          above were routed-but-unreachable for weeks, which is the exact
          regression this menu exists to prevent. */}
      <button className="acctitem" role="menuitem" onClick={() => go('/onboarding')}>Onboarding</button>
      <button className="acctitem" role="menuitem" onClick={() => go('/widgets')}>Widget catalog</button>
      <button className="acctitem" role="menuitem" onClick={() => go('/widget-sheet')}>Widget sheet</button>
      <button className="acctitem" role="menuitem" onClick={() => go('/answer-views')}>Answer views</button>
      <button className="acctitem" role="menuitem" onClick={() => go('/model-lab')}>Model lab</button>

      <div className="acctsep" />
      <button className="acctitem" role="menuitem" onClick={() => go('/versions')}>
        <GitBranch className="i16" /><span>Versions</span>
      </button>
      <button className="acctitem" role="menuitem" onClick={() => go('/agent-view')}>
        <Monitor className="i16" /><span>Agent view</span>
      </button>
      <button className="acctitem" role="menuitem" onClick={() => go('/design-sync')}>
        <Palette className="i16" /><span>Design sync</span>
      </button>
      <button className="acctitem" role="menuitem" onClick={() => go('/tests')}>
        <TestTube2 className="i16" /><span>Tests</span>
      </button>
      <button className="acctitem" role="menuitem" onClick={() => go('/smart-home')}>Smart home</button>
      <button className="acctitem" role="menuitem" onClick={() => go('/health')}>Health</button>
      <button className="acctitem" role="menuitem" onClick={() => go('/money')}>Money</button>
      <button className="acctitem" role="menuitem" onClick={() => go('/browser')}>Browser</button>

      {/* `/home` — the voice-first landing — was routed in App.tsx and linked
          from nowhere: a whole product surface (its own chat session, voice
          session and sphere) that no user could reach without typing the URL.
          Exactly the regression the two items above record being fixed; this
          one was missed. It lands here rather than in the dock for the same
          reason they did — the dock is full and this is not a daily surface. */}
      <button className="acctitem" role="menuitem" onClick={() => go('/home')}>
        <Mic className="i16" /><span>Voice home</span>
      </button>

      {/* The sphere gallery is a design/QA tool, not a product screen, so it is
          exposed in development builds only. In a shipped build it stays
          URL-only by choice — see App.tsx. */}
      {import.meta.env.DEV && (
        <button className="acctitem" role="menuitem" onClick={() => go('/atlas-sphere')}>
          <Orbit className="i16" /><span>Sphere gallery (dev)</span>
        </button>
      )}

      <div className="acctsep" />

      <button className="acctitem acctdanger" role="menuitem" onClick={() => { onClose(); void signOut(); }}>
        <LogOut className="i16" /><span>Sign out</span>
      </button>
    </div>
  );
}
