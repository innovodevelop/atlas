/**
 * The Beta dock — the guideline dock (§09) and the six directions of the
 * handoff's Dock Explorations, as styles of one dock, chosen in Settings →
 * Beta UI (`src/lib/betaDock.ts` holds the choice and the reasons). The
 * guideline dock stays the default until the user picks the final one.
 *
 * Whatever the style, the dock keeps the same contract:
 *   - the same destinations, in the guideline order: Home · Core · Teach ·
 *     Mail · Architecture · Voice, then the account chip with its menu (the
 *     app's only sign-out and its only route to deleting the account);
 *   - the same edition rule: the destinations go through the Workshop dock's
 *     own filter (`dockableItems`, which asks the surface registry), so an
 *     Architecture button never appears in a consumer build in any style;
 *   - the current screen is `aria-current="page"`, every item has a name and
 *     a tooltip, arrow keys walk the dock (both axes, wrapping) and every
 *     item stays a Tab stop;
 *   - the shell renders exactly one, so it stays put across route
 *     transitions (`view-transition-name: beta-dock`).
 *
 * The status lines some styles show come from `useDockNotes` (screens report
 * there) plus Voice, which the dock reads from the state bus itself.
 */
import {
  useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { useLocation } from 'react-router-dom';
import { Dock, type DockItem } from '@/components/atlas-ui/primitives';
import { dockableItems } from '@/components/atlas-ui/primitives/dockEdition';
import { useAccountDockItem } from '@/components/atlas-ui/useAccountDockItem';
import { AtlasIcon } from './AtlasIcon';
import { VeilSphere } from './VeilSphere';
import { screenLabel } from './TopBar';
import { useBetaNavigate } from '@/lib/viewTransitions';
import { STATE_LABEL, useAtlasState, type AtlasBusState } from '@/lib/atlasStateBus';
import { useTalkAnchor } from '@/lib/talkBus';
import type { RGB } from '@/lib/quickSphere';
import {
  DOCK_DESTINATIONS, DOCK_SPHERE, DOCK_STYLE_KEY, badgeCount, badgeText, crumbLine, currentDockId, hubSides, itemName,
  mergeNotes, reloadDockStyle, statusMini, stepIndex, useDockNotes, useDockStyle, voiceNote,
  type DockDestination, type DockDestinationId, type DockNotes,
} from '@/lib/betaDock';
import '@/styles/beta/dock.css';

/** The hub sphere sits on the panel paper; a transparent canvas lifts its dust toward it. */
const PANEL_RGB: RGB = [241, 238, 234];

interface StyleProps {
  dests: readonly DockDestination[];
  current: DockDestinationId | undefined;
  go: (d: DockDestination) => void;
  account: DockItem;
  notes: DockNotes;
}

/* ── Shared pieces ───────────────────────────────────────────────────────── */

const ITEM = '[data-dk-item]';

/**
 * Arrow keys walk the dock's items (`selector`); keys inside the account menu
 * are the menu's own. Handled keys stop here, so a screen's own arrow
 * shortcuts (Mail's list) do not also move.
 */
function walk(selector: string) {
  return (e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const target = e.target as HTMLElement;
    if (!target.matches?.(selector)) return;
    const list = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(selector));
    const next = stepIndex(e.key, list.indexOf(target), list.length);
    if (next === null) return;
    e.preventDefault();
    e.stopPropagation();
    list[next]?.focus();
  };
}

const walkItems = walk(ITEM);
const walkGuide = walk('.dockb, .dockav');

/** The full label, swapped for the short one where a phone has no room ("Layers"). */
function Label({ d, className = 'b-dk-l' }: { d: DockDestination; className?: string }) {
  if (d.short === d.label) return <span className={className}>{d.label}</span>;
  return (
    <span className={className}>
      <span className="b-dk-l-full">{d.label}</span>
      <span className="b-dk-l-short">{d.short}</span>
    </span>
  );
}

/**
 * The account chip and its menu, the way the Workshop `<Dock>` draws it
 * (`.acctwrap` anchors `.acctmenu`); `row` is the rail's full-width row.
 */
function DockAvatar({ account, row = false }: { account: DockItem; row?: boolean }) {
  return (
    <div className="acctwrap b-dk-acct">
      <button
        type="button"
        data-dk-item
        className={row ? 'b-dk-btn b-dk-acctrow' : 'b-dk-av'}
        onClick={account.onClick}
        title={account.label}
        aria-label={account.label}
        aria-haspopup="menu"
        aria-expanded={!!account.popover}
      >
        {row ? (
          <>
            <span className="b-dk-av" aria-hidden="true">{account.icon}</span>
            <span className="b-dk-rtext"><span className="b-dk-rl">{account.label}</span></span>
          </>
        ) : account.icon}
      </button>
      {account.popover}
    </div>
  );
}

/* ── 3a · Lens ───────────────────────────────────────────────────────────── */

function LensDock({ dests, current, go, account }: StyleProps) {
  return (
    <nav className="b-dk b-dk-bar b-dk--lens" aria-label="Dock" onKeyDown={walkItems}>
      {dests.map((d) => {
        const on = d.id === current;
        return (
          <button
            key={d.id}
            type="button"
            data-dk-item
            className={`b-dk-btn${on ? ' on' : ''}`}
            title={d.label}
            aria-label={d.label}
            aria-current={on ? 'page' : undefined}
            onClick={() => go(d)}
          >
            <AtlasIcon name={d.icon} size={19} weight={1.5} />
            {on ? <Label d={d} /> : null}
          </button>
        );
      })}
      <DockAvatar account={account} />
    </nav>
  );
}

/* ── 3b · Sphere hub ─────────────────────────────────────────────────────── */

function HubDock({ dests, current, go, account }: StyleProps) {
  const { left, hub, right } = hubSides(dests);
  const item = (d: DockDestination) => {
    const on = d.id === current;
    return (
      <button
        key={d.id}
        type="button"
        data-dk-item
        className={`b-dk-btn${on ? ' on' : ''}`}
        title={d.label}
        aria-label={d.label}
        aria-current={on ? 'page' : undefined}
        onClick={() => go(d)}
      >
        <AtlasIcon name={d.icon} size={19} weight={1.5} />
        {on ? <span className="b-dk-tag" aria-hidden="true">{d.label}</span> : null}
      </button>
    );
  };
  const hubOn = hub?.id === current;
  return (
    <nav className="b-dk b-dk-bar b-dk--hub" aria-label="Dock" onKeyDown={walkItems}>
      {left.map(item)}
      {hub ? (
        <button
          type="button"
          data-dk-item
          className={`b-dk-hub${hubOn ? ' on' : ''}`}
          title={`${hub.label}: talk to Atlas`}
          aria-label={hub.label}
          aria-current={hubOn ? 'page' : undefined}
          onClick={() => go(hub)}
        >
          {/* The live sphere: no `state`, so it follows the state bus like every other one. */}
          <VeilSphere count={DOCK_SPHERE.count} scale={DOCK_SPHERE.scale} bg="transparent" tone={PANEL_RGB} />
          {hubOn ? <span className="b-dk-tag" aria-hidden="true">{hub.label}</span> : null}
        </button>
      ) : null}
      {right.map(item)}
      <DockAvatar account={account} />
    </nav>
  );
}

/* ── 3c · Breadcrumb rail ────────────────────────────────────────────────── */

function RailDock({ dests, current, go, account, notes, orb }: StyleProps & { orb: boolean }) {
  return (
    <nav className={`b-dk b-dk--rail${orb ? '' : ' b-dk--no-orb'}`} aria-label="Dock" onKeyDown={walkItems}>
      <div className="b-dk-rlist">
        {dests.map((d) => {
          const on = d.id === current;
          const note = on ? notes[d.id] : undefined;
          const crumb = on ? crumbLine(d, note) : null;
          return (
            <button
              key={d.id}
              type="button"
              data-dk-item
              className={`b-dk-btn${on ? ' on' : ''}`}
              title={d.label}
              aria-label={note?.crumb ? `${d.label}, ${note.crumb}` : itemName(d, note)}
              aria-current={on ? 'page' : undefined}
              onClick={() => go(d)}
            >
              <AtlasIcon name={d.icon} size={17} weight={1.5} />
              <span className="b-dk-rtext">
                <Label d={d} className="b-dk-rl" />
                {crumb ? <span className="b-dk-crumb">{crumb}</span> : null}
              </span>
            </button>
          );
        })}
      </div>
      <DockAvatar account={account} row />
    </nav>
  );
}

/* ── 3d · Capsule ────────────────────────────────────────────────────────── */

function CapsuleDock({ dests, current, go, account, notes, pathname, state }: StyleProps & { pathname: string; state: AtlasBusState }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLElement | null>(null);
  const capRef = useRef<HTMLButtonElement | null>(null);
  const fanRef = useRef<HTMLDivElement | null>(null);
  const fanId = useId();

  const screen = screenLabel(pathname);
  const status = (current ? notes[current]?.line : undefined) ?? `Atlas · ${STATE_LABEL[state]}`;

  /** Close; give focus back to the capsule if it was inside the fan, so the keyboard is never dropped on <body>. */
  const close = useCallback(() => {
    if (fanRef.current?.contains(document.activeElement)) capRef.current?.focus();
    setOpen(false);
  }, []);

  // A route change from anywhere else (a link on the page, a shortcut) folds it too.
  useEffect(() => { close(); }, [pathname, close]);

  // ⌘J (Ctrl+J off the Mac) toggles from anywhere, and Esc closes. Captured
  // and stopped, so Mail's J and Esc and Agent View's J do not also run.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        e.stopPropagation();
        if (open) close(); else setOpen(true);
      } else if (e.key === 'Escape' && open) {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, close]);

  // Opening puts focus on the current screen's tile, so arrows work at once.
  useEffect(() => {
    if (!open) return;
    const fan = fanRef.current;
    (fan?.querySelector<HTMLElement>('[data-dk-item].on') ?? fan?.querySelector<HTMLElement>(ITEM))?.focus();
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  return (
    <nav ref={rootRef} className={`b-dk b-dk--capsule${open ? ' open' : ''}`} aria-label="Dock">
      {open ? (
        <div ref={fanRef} id={fanId} className="b-dk-fan" role="group" aria-label="Every screen" onKeyDown={walkItems}>
          {dests.map((d, i) => {
            const on = d.id === current;
            return (
              <button
                key={d.id}
                type="button"
                data-dk-item
                className={`b-dk-btn${on ? ' on' : ''}`}
                style={{ animationDelay: `${i * 30}ms` }}
                title={d.label}
                aria-label={d.label}
                aria-current={on ? 'page' : undefined}
                // Close first: picking the screen you are on changes no route, and the fan must still fold.
                onClick={() => { close(); go(d); }}
              >
                <AtlasIcon name={d.icon} size={19} weight={1.5} />
                <span className="b-dk-fan-l">{d.label}</span>
              </button>
            );
          })}
        </div>
      ) : null}
      <div className="b-dk-caprow">
        <button
          ref={capRef}
          type="button"
          className="b-dk-cap"
          aria-expanded={open}
          aria-controls={open ? fanId : undefined}
          aria-keyshortcuts="Meta+J"
          aria-label={`${screen}, ${status}. Every screen`}
          title="Every screen (⌘J)"
          onClick={() => (open ? close() : setOpen(true))}
        >
          <span className="b-dk-cap-sph" aria-hidden="true">
            <VeilSphere ink bg="#1e1e24" count={DOCK_SPHERE.count} scale={DOCK_SPHERE.scale} />
          </span>
          <span className="b-dk-cap-t">
            <b>{screen}</b>
            <small>{status}</small>
          </span>
          <kbd className="b-dk-kbd" aria-hidden="true">⌘J</kbd>
        </button>
        <DockAvatar account={account} />
      </div>
    </nav>
  );
}

/* ── 3e · Colour lane ────────────────────────────────────────────────────── */

function LaneDock({ dests, current, go, account }: StyleProps) {
  const laneRef = useRef<HTMLDivElement | null>(null);
  const [blob, setBlob] = useState<{ x: number; w: number } | null>(null);
  // The blob slides between items, but it must not slide in from the left
  // edge on first paint: transitions start one frame after the first measure.
  const [ready, setReady] = useState(false);
  const cur = dests.find((d) => d.id === current);

  // Measured, not the board's fixed 100 px steps: the edition filter drops
  // Architecture in a consumer build, and the items narrow at phone width.
  useLayoutEffect(() => {
    const lane = laneRef.current;
    if (!lane) return;
    const on = () => lane.querySelector<HTMLElement>('.b-dk-btn.on');
    const measure = () => {
      const el = on();
      setBlob((prev) => {
        if (!el) return null;
        const next = { x: el.offsetLeft, w: el.offsetWidth };
        return prev && prev.x === next.x && prev.w === next.w ? prev : next;
      });
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(lane);
    const el = on();
    if (el) ro.observe(el);
    return () => ro.disconnect();
  }, [current, dests]);

  useEffect(() => {
    if (!blob || ready) return;
    const id = window.requestAnimationFrame(() => setReady(true));
    return () => window.cancelAnimationFrame(id);
  }, [blob, ready]);

  return (
    <>
      {cur ? <span className="b-dk-stripe" style={{ background: cur.accent }} aria-hidden="true" /> : null}
      <nav className="b-dk b-dk-bar b-dk--lane" aria-label="Dock" onKeyDown={walkItems}>
        <div className="b-dk-lane" ref={laneRef}>
          {cur && blob ? (
            <span
              className={`b-dk-blob${ready ? ' ready' : ''}`}
              style={{ width: blob.w, transform: `translateX(${blob.x}px)`, background: cur.fill }}
              aria-hidden="true"
            />
          ) : null}
          {dests.map((d) => {
            const on = d.id === current;
            return (
              <button
                key={d.id}
                type="button"
                data-dk-item
                className={`b-dk-btn${on ? ' on' : ''}`}
                title={d.label}
                aria-label={d.label}
                aria-current={on ? 'page' : undefined}
                onClick={() => go(d)}
              >
                <AtlasIcon name={d.icon} size={17} weight={1.5} />
                {on ? <span className="b-dk-l">{d.short}</span> : null}
              </button>
            );
          })}
        </div>
        <DockAvatar account={account} />
      </nav>
    </>
  );
}

/* ── 3f · Status dock ────────────────────────────────────────────────────── */

function StatusDock({ dests, current, go, account, notes, pathname }: StyleProps & { pathname: string }) {
  const line = current ? notes[current]?.line : undefined;
  return (
    <nav className="b-dk b-dk--status" aria-label="Dock" onKeyDown={walkItems}>
      {/* The current item already says this in its name; the card is for the eye. */}
      <div key={pathname} className="b-dk-card" aria-hidden="true">
        <strong>{screenLabel(pathname)}</strong>{line ? ` · ${line}` : null}
      </div>
      <div className="b-dk-tiles">
        {dests.map((d) => {
          const on = d.id === current;
          const note = notes[d.id];
          const n = badgeCount(note);
          return (
            <button
              key={d.id}
              type="button"
              data-dk-item
              className={`b-dk-btn${on ? ' on' : ''}`}
              title={d.label}
              aria-label={itemName(d, note)}
              aria-current={on ? 'page' : undefined}
              onClick={() => go(d)}
            >
              <span className="b-dk-ico">
                <AtlasIcon name={d.icon} size={19} weight={1.5} />
                {n !== null ? <span className="b-dk-badge" aria-hidden="true">{badgeText(n)}</span> : null}
              </span>
              <span className="b-dk-mini">{statusMini(d, note)}</span>
            </button>
          );
        })}
        <DockAvatar account={account} />
      </div>
    </nav>
  );
}

/* ── The dock ────────────────────────────────────────────────────────────── */

export function BetaDock() {
  const style = useDockStyle();
  const { pathname } = useLocation();
  const navigate = useBetaNavigate();
  // The account menu's "Privacy & delete account" asks for the memory tab;
  // the Beta Settings reads `?tab=` the way the Workshop route does.
  const openSettings = useCallback((tab?: 'memory') => navigate(tab ? `/settings?tab=${tab}` : '/settings'), [navigate]);
  const account = useAccountDockItem(openSettings);
  const state = useAtlasState();
  const published = useDockNotes();
  // With a header sphere registered the bottom-left orb is gone, and the rail can run to the bottom.
  const orb = !useTalkAnchor();
  const current = currentDockId(pathname);

  // Settings in another window of the app changed the choice.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => { if (e.key === DOCK_STYLE_KEY || e.key === null) reloadDockStyle(); };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // The style on <html>: the rail's page gutter and the orb's place at phone
  // width key off it (dock.css). Set before paint, so switching to the rail
  // never shows a frame of page under it; gone with the dock, so the
  // Workshop never sees it.
  useLayoutEffect(() => {
    document.documentElement.dataset.betaDock = style;
    return () => { delete document.documentElement.dataset.betaDock; };
  }, [style]);

  const navItems = useMemo<DockItem[]>(() => DOCK_DESTINATIONS.map((d) => ({
    id: d.id,
    label: d.label,
    icon: <AtlasIcon name={d.icon} size={18} />,
    to: d.to,
    onClick: () => navigate(d.to),
  })), [navigate]);

  // The Workshop dock's edition rule, once, for every style.
  const dests = useMemo(() => {
    const kept = new Set(dockableItems(navItems).map((i) => i.id));
    return DOCK_DESTINATIONS.filter((d) => kept.has(d.id));
  }, [navItems]);

  const notes = useMemo(() => mergeNotes(published, { voice: voiceNote(state) }), [published, state]);
  const go = useCallback((d: DockDestination) => navigate(d.to), [navigate]);
  const props: StyleProps = { dests, current, go, account, notes };

  switch (style) {
    case 'lens': return <LensDock {...props} />;
    case 'hub': return <HubDock {...props} />;
    case 'rail': return <RailDock {...props} orb={orb} />;
    case 'capsule': return <CapsuleDock {...props} pathname={pathname} state={state} />;
    case 'lane': return <LaneDock {...props} />;
    case 'status': return <StatusDock {...props} pathname={pathname} />;
    case 'guide':
    default:
      return (
        <nav className="b-dk-guide" aria-label="Dock" onKeyDown={walkGuide}>
          <Dock items={[...navItems, account]} current={current} variant="beta" />
        </nav>
      );
  }
}
