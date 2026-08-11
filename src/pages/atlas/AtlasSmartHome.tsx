/**
 * Atlas Smart Home — the `/smart-home` route.
 * Design: `Atlas Smart Home.dc.html` (design_handoff_atlas_suite_v2).
 *
 * ── THE ONE THING TO KNOW ───────────────────────────────────────────────────
 * This surface used to be mock-backed and said so in a permanent banner. It is
 * now REAL: every room, device, scene and reading comes from `@/hooks/useSmartHome`,
 * which talks to the Rust `home` module, which talks to Home Assistant over the
 * LAN. The banner is gone because the thing it warned about is gone.
 *
 * What replaced it is three states this page is built around, because each of
 * them is a way a home surface lies if it is not designed for:
 *
 *   NO BRIDGE     the common case, and a first-class screen — an offer to
 *                 connect Home Assistant, never an empty room list. "You own no
 *                 devices" and "Atlas cannot see your devices" are different
 *                 sentences and must not render as the same blank grid.
 *   STALE         a device the bridge could not reach keeps its last known
 *                 value (that is more useful than a blank), and therefore MUST
 *                 look like history: dimmed, labelled "Not responding", with
 *                 the last words it said shown as the past tense they are.
 *   FAILED        an actuation that did not happen says so, in the bridge's own
 *                 words, attached to the device it failed on. A control that
 *                 slides back with no explanation is indistinguishable from a
 *                 light that turned itself off.
 *
 * The three components under `src/components/atlas-ui/smartHome/` are unchanged
 * and did not need to change: the hook returns the mock's own types, so the
 * cards never learn which side of the swap they are on. The staleness and
 * failure treatments live HERE, wrapped around those cards, for the same reason.
 *
 * ── THREE VIEWS ─────────────────────────────────────────────────────────────
 * House   scenes, the devices most recently operated, and the widget grid.
 * Rooms   room by room, every device with its real affordance.
 * Setup   linking Home Assistant, the room roster, bridges, and what Atlas may
 *         do alone.
 *
 * The design file has a fourth view, "Widget set" — that is the Widget Catalog,
 * its own surface in this handoff (`Atlas Widget Catalog.dc.html`), and not
 * this page's job.
 *
 * ── CHROME ──────────────────────────────────────────────────────────────────
 * `.page` root, band header, and back-navigation through the headline plus Esc
 * — never a header link (AtlasDashboard's `.greetB.returnable` + `.retbar`
 * pattern). Esc and the headline both go up exactly one level: a sub-view
 * returns to House, House returns to the dashboard.
 *
 * No dock is rendered here — the wiring pass owns that. No sphere is mounted
 * either; the renderer is mid-migration in a parallel track and this surface
 * has no state to narrate through it.
 */
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle, CornerUpLeft, Home, Link2, Plus, Radio, RefreshCw, ShieldCheck, WifiOff,
} from 'lucide-react';
import { Button, Empty, Panel } from '@/components/atlas-ui/primitives';
import { useSmartHome, type LiveBridge, type LiveDevice, type LiveSnapshot } from '@/hooks/useSmartHome';
import type { SmartRoom } from '@/lib/mocks/smartHome';
import { HomeWidgetCard } from '@/components/atlas-ui/smartHome/HomeWidgetCard';
import { DeviceCard, RecentDeviceStrip } from '@/components/atlas-ui/smartHome/DeviceCard';
import { Switch } from '@/components/atlas-ui/smartHome/DeviceControls';
import { isTyping } from './atlasHelpers';
import '@/styles/surfaces/smartHome.css';

/**
 * Registration data. Mirrored in `src/surfaces.ts`, which is what the router,
 * the dock and the account menu are built from; `surfaces.test.ts` fails if the
 * two ever disagree.
 */
export const surface = {
  path: '/smart-home',
  label: 'Smart home',
  icon: 'Home',
  // Still `menu`, not `dock`. The adapter landing removes the reason this
  // surface could not be trusted; it does not make it one of the handful of
  // places a person lives, and the dock is already eight items.
  entry: 'menu',
  // Flipped from `true`: the header above is right that this is now real —
  // every room, device, scene and reading comes from `useSmartHome` → the Rust
  // `home` module → Home Assistant over the LAN. The `@/lib/mocks/smartHome`
  // import that remains in this file is a TYPE import; no sample data is drawn.
  mock: false,
  // Consumer BECAUSE of that. "No bridge linked" is a first-class designed
  // screen here, so the unconfigured case is honest rather than embarrassing.
  edition: 'consumer' as const,
};

type View = 'house' | 'rooms' | 'setup';

const VIEWS: Array<{ id: View; label: string }> = [
  { id: 'house', label: 'House' },
  { id: 'rooms', label: 'Rooms' },
  { id: 'setup', label: 'Setup' },
];

const TONE_DOT: Record<SmartRoom['tone'], string> = {
  ok: 'var(--grn)', warn: 'var(--amber)', error: 'var(--red)',
};

/** True when a keystroke belongs to whatever the user is typing into. */
/* ── The honesty treatments ─────────────────────────────────────────────────
   Both of these wrap the shared device components rather than changing them.
   A stale card is dimmed and desaturated and carries the last words the device
   said, in the past tense; a failed actuation carries the bridge's own reason.
   Neither is a tooltip: a claim about a lock has to be readable without hover. */

const NOTE_STYLE: Record<'bad' | 'warn' | 'stale', CSSProperties> = {
  bad: { color: 'var(--red-text, #b23c17)' },
  warn: { color: 'var(--amber-text, #8a6100)' },
  stale: { color: 'var(--ink2)' },
};

const DeviceTruth = ({ device }: { device: LiveDevice }) => {
  if (device.note) {
    return (
      <p className="sh-panel-note" style={{ margin: 0, ...NOTE_STYLE[device.note.tone] }} role="status">
        <AlertTriangle className="i16" style={{ verticalAlign: '-3px', marginRight: 6 }} aria-hidden />
        {device.note.text}
      </p>
    );
  }
  if (!device.available) {
    return (
      <p className="sh-panel-note" style={{ margin: 0, ...NOTE_STYLE.stale }} role="status">
        <WifiOff className="i16" style={{ verticalAlign: '-3px', marginRight: 6 }} aria-hidden />
        Not responding. The reading above is the last one Atlas received
        {device.lastKnownState ? ` — “${device.lastKnownState}”` : ''}
        {device.lastChanged ? `, ${device.lastChanged}` : ''}. It is not a claim about now.
      </p>
    );
  }
  return null;
};

interface SlotProps {
  device: LiveDevice;
  onValue: (value: number) => void;
  onColour: (colour: string) => void;
  compact?: boolean;
}

const DeviceSlot = ({ device, onValue, onColour, compact }: SlotProps) => {
  const stale = !device.available;
  return (
    <div
      className="sh-devslot"
      data-stale={stale || undefined}
      style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}
    >
      <div style={stale ? { opacity: 0.6, filter: 'saturate(.3)' } : undefined}>
        {compact
          ? <RecentDeviceStrip device={device} onValue={onValue} onColour={onColour} />
          : <DeviceCard device={device} onValue={onValue} onColour={onColour} />}
      </div>
      <DeviceTruth device={device} />
    </div>
  );
};

/**
 * The pill next to a bridge in Setup. `state` is the mock's two-valued field, so
 * a bridge that is linked and unreachable came out "Not linked" — the same words
 * as a bridge that was never connected at all. `health` is the real column.
 */
const bridgePill = (b: LiveBridge): string => {
  if (b.state === 'connected') return 'Connected';
  switch (b.health) {
    case 'unreachable': return 'Not answering';
    case 'unauthorised': return 'Token rejected';
    case 'unavailable': return 'Unavailable';
    default: return 'Not linked';
  }
};

/**
 * Linked, and silent.
 *
 * This is the state that used to render as day one. Every card below it is
 * dimmed and carries its own "not responding" line, but the reason they are ALL
 * stale is a fact about the bridge, not about each device, so it is said once,
 * here, above them — with the two things the user can actually do about it.
 */
const OutageNotice = ({
  state, lastReached, onRetry, onSetup, retrying,
}: {
  state: string;
  lastReached: string | null;
  onRetry: () => void;
  onSetup: () => void;
  retrying: boolean;
}) => (
  <div className="sh-panel-note" style={{ display: 'flex', gap: 10, alignItems: 'flex-start', color: 'var(--amber-text, #8a6100)' }} role="status">
    <WifiOff className="i16" style={{ marginTop: 2, flexShrink: 0 }} aria-hidden />
    <div style={{ flex: 1, minWidth: 0 }}>
      <p style={{ margin: 0, fontWeight: 600 }}>
        {state === 'unauthorised'
          ? 'Home Assistant rejected Atlas\u2019 token.'
          : 'Home Assistant is not answering.'}
      </p>
      <p style={{ margin: '2px 0 0' }}>
        {lastReached ? `Atlas last reached it ${lastReached}. ` : 'Atlas has not completed a sync with it. '}
        Everything below is the last thing your house reported \u2014 it is not a claim about now,
        and Atlas cannot command anything until the bridge answers again.
      </p>
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <Button size="sm" variant="primary" loading={retrying} onClick={onRetry}>Try again</Button>
        <Button size="sm" variant="ghost" onClick={onSetup}>
          {state === 'unauthorised' ? 'Replace the token' : 'Bridge settings'}
        </Button>
      </div>
    </div>
  </div>
);

/* ── Linking ────────────────────────────────────────────────────────────────
   The only bridge this build can link. The token is typed here and handed
   straight to Rust, which probes the hub with it and writes it to the macOS
   Keychain only if the probe succeeded — a token that does not work is never
   stored, so a failed link leaves nothing behind. */

const LinkForm = ({
  onLink, linking,
}: { onLink: (baseUrl: string, token: string) => Promise<void>; linking: boolean }) => {
  const [baseUrl, setBaseUrl] = useState('');
  const [token, setToken] = useState('');

  const submit = () => {
    void onLink(baseUrl.trim(), token).then(
      () => { setToken(''); },
      () => { /* The hook owns the banner; the token stays so it can be corrected. */ },
    );
  };

  return (
    <>
      <p className="sh-panel-note">
        Atlas talks to one bridge: Home Assistant, on your own network. It cannot scan for
        devices — there is no mDNS, Matter or Thread stack in this app — so Home Assistant
        does the discovering and Atlas mirrors what it already knows.
      </p>
      <div className="sh-field" style={{ marginTop: 10 }}>
        <Link2 className="i16" style={{ color: 'var(--ink3)' }} aria-hidden />
        <input
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="http://homeassistant.local:8123"
          aria-label="Home Assistant address"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
        />
      </div>
      <div className="sh-field" style={{ marginTop: 8 }}>
        <ShieldCheck className="i16" style={{ color: 'var(--ink3)' }} aria-hidden />
        <input
          value={token}
          onChange={(e) => setToken(e.target.value)}
          type="password"
          placeholder="Long-lived access token"
          aria-label="Home Assistant long-lived access token"
          spellCheck={false}
        />
        <Button
          size="sm"
          variant="primary"
          loading={linking}
          disabled={!baseUrl.trim() || !token.trim()}
          onClick={submit}
        >
          Link
        </Button>
      </div>
      <p className="sh-panel-note" style={{ marginTop: 10 }}>
        Create the token at the bottom of your Home Assistant profile page. Atlas stores it in
        the macOS Keychain, and only after your hub has accepted it.
      </p>
      {/* A long-lived token does not expire and controls every device in the
          house, locks included. Over http:// it crosses the LAN in clear text on
          every call — worth saying out loud, once, at the moment the user
          chooses the address, rather than never. */}
      {baseUrl.trim().toLowerCase().startsWith('http://') && (
        <p className="sh-panel-note" style={{ marginTop: 8, color: 'var(--amber-text, #8a6100)' }}>
          <AlertTriangle className="i16" style={{ verticalAlign: '-3px', marginRight: 6 }} aria-hidden />
          That address is unencrypted, so this token travels your network in clear text. It never
          expires and it can open every device Home Assistant controls, including locks. Fine on a
          network you trust; not on one you share.
        </p>
      )}
    </>
  );
};

const AtlasSmartHome = () => {
  const navigate = useNavigate();
  const [view, setView] = useState<View>('house');

  // The swap point. This is the real adapter — same signature as the mock's
  // `useSmartHome`, so nothing below this line knows which one it is talking to.
  const live = useSmartHome();
  const snapshot: LiveSnapshot = live.snapshot;

  const goUp = useCallback(() => {
    if (view !== 'house') setView('house');
    else navigate('/');
  }, [view, navigate]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTyping(e.target)) { (e.target as HTMLElement).blur(); return; }
      goUp();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goUp]);

  const devicesById = useMemo(() => {
    const map = new Map<string, LiveDevice>();
    for (const room of snapshot.rooms) for (const d of room.devices) map.set(d.id, d);
    return map;
  }, [snapshot.rooms]);

  const recent = useMemo(
    () => snapshot.recentIds.map((id) => devicesById.get(id)).filter((d): d is LiveDevice => !!d),
    [snapshot.recentIds, devicesById],
  );

  const deviceCount = devicesById.size;
  /**
   * A bridge EXISTS. Not the same question as "is it answering" — and this page
   * used to ask only the second, so a hub that had rebooted rendered the day-one
   * "connect a home" screen, offering to link something already linked, with the
   * user's entire mirrored house sitting underneath it.
   */
  const hasBridge = snapshot.bridgeState !== 'none';
  const answering = snapshot.bridgeConnected;
  /** Linked, silent. Everything on screen is history and must be labelled so. */
  const outage = hasBridge && !answering;
  // By kind, NOT by state: an unreachable bridge is still the bridge to unlink.
  const haBridge = snapshot.bridges.find((b) => b.kind === 'home_assistant');

  /**
   * The band narrates the view, the way the dashboard's band narrates the
   * focused widget. Only the House view uses the snapshot's own headline —
   * the other two describe themselves.
   */
  const headline = useMemo(() => {
    const h = snapshot.headline;
    if (view === 'rooms') {
      return {
        lead: 'Room by ', accent: 'room.',
        subline: deviceCount
          ? `${snapshot.rooms.length} ${snapshot.rooms.length === 1 ? 'room' : 'rooms'}, ${deviceCount} devices, every control in reach.`
          : 'No rooms yet. A connected home brings its own rooms, names and scenes with it.',
        metaBig: String(snapshot.rooms.length),
        metaSmall: snapshot.rooms.length === 1 ? 'room' : 'rooms',
      };
    }
    if (view === 'setup') {
      const count = snapshot.bridges.filter((b) => b.state === 'connected').length;
      return {
        lead: 'Set up the ', accent: 'house.',
        subline: hasBridge
          ? 'Your bridge, the rooms it reports, and the standing question of what Atlas is allowed to do while you are not looking.'
          : 'Nothing is linked. Atlas cannot see, pair or command a device until Home Assistant is connected.',
        metaBig: String(count),
        metaSmall: count === 1 ? 'bridge linked' : 'bridges linked',
      };
    }
    return h;
  }, [view, snapshot, deviceCount, hasBridge]);

  const backHint = view === 'house' ? 'the dashboard' : 'the house';

  const goToSetup = useCallback(() => setView('setup'), []);

  /** The one offer that turns the day-one screen into a working house. */
  const connectAction = { label: 'Connect Home Assistant', onClick: goToSetup, variant: 'primary' as const };

  return (
    <div className="page sh-page" data-screen-label="Atlas — Smart home">
      <div className="sh-wash" aria-hidden>
        <div className="sh-wash-a" />
        <div className="sh-wash-b" />
        <div className="sh-wash-c" />
      </div>
      <div className="grain" aria-hidden />

      {/* Band header. The headline is the back control — there is no header
          link, by the same rule the dashboard follows. */}
      <section className="bandB">
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2
            className="greetB returnable"
            onClick={goUp}
            title={`Return to ${backHint}`}
          >
            {headline.lead}<span className="accw">{headline.accent}</span>
          </h2>
          <p className="gsubB">{headline.subline}</p>
        </div>
        <div className="bandmetaB">
          <p className="bmvB tnum">{headline.metaBig}</p>
          <p className="bmlB">{headline.metaSmall}</p>
        </div>
      </section>

      <div className="sh-chrome">
        <button className="retbar" onClick={goUp} aria-label={`Return to ${backHint}`}>
          <CornerUpLeft className="i16" />Tap the title or press Esc to return to {backHint}
        </button>

        <div className="sh-views" role="tablist" aria-label="Smart home views">
          {VIEWS.map((v) => (
            <Button
              key={v.id}
              size="sm"
              variant={view === v.id ? 'ink' : 'ghost'}
              role="tab"
              aria-selected={view === v.id}
              onClick={() => setView(v.id)}
            >
              {v.label}
            </Button>
          ))}
        </div>

        {/* Why the surface is inert, when it is. Never a blank house. */}
        {!live.usable && live.unusableReason && (
          <div className="sh-notice" role="note">
            <span className="sh-notice-ico" aria-hidden><Home className="i16" /></span>
            <div className="sh-notice-body">
              <p className="sh-notice-title">Nothing is being read</p>
              <p className="sh-notice-text">{live.unusableReason}</p>
            </div>
          </div>
        )}

        {/* A failed command is loud and stays until it is dismissed. */}
        {live.error && (
          <div className="sh-notice" role="alert" style={{ background: 'rgba(194,60,23,.10)' }}>
            <span className="sh-notice-ico" aria-hidden style={{ background: 'rgba(194,60,23,.14)' }}>
              <AlertTriangle className="i16" />
            </span>
            <div className="sh-notice-body">
              <p className="sh-notice-title">That did not happen</p>
              <p className="sh-notice-text">{live.error}</p>
            </div>
            <div className="sh-notice-act">
              <Button size="sm" variant="ghost" onClick={live.dismissError}>Dismiss</Button>
            </div>
          </div>
        )}

        {/* Degraded, not failed — a different sentence and a different weight. */}
        {live.warning && (
          <div className="sh-notice" role="note">
            <span className="sh-notice-ico" aria-hidden><Radio className="i16" /></span>
            <div className="sh-notice-body">
              <p className="sh-notice-title">Working, with something switched off</p>
              <p className="sh-notice-text">{live.warning}</p>
            </div>
            <div className="sh-notice-act">
              <Button size="sm" variant="ghost" onClick={live.dismissWarning}>Dismiss</Button>
            </div>
          </div>
        )}

        {view === 'house' && (
          <>
            <div className="sh-hero">
              <p className="sh-hero-lbl">Scenes</p>
              {snapshot.scenes.length ? (
                <div className="sh-hero-scenes">
                  {snapshot.scenes.map((s) => (
                    <Button
                      key={s.id}
                      size="sm"
                      variant="ghost"
                      onClick={() => live.runScene(s.id)}
                    >
                      {s.label}
                    </Button>
                  ))}
                </div>
              ) : (
                <Empty body={hasBridge
                  ? 'Your bridge reports no scenes. Atlas does not invent them.'
                  : 'No scenes. A connected home brings its own — Atlas does not invent them.'} />
              )}
              {/* No scene is ever shown as "on": Home Assistant applies a scene
                  and forgets it, so a lit pill would be Atlas guessing that
                  nothing has changed since. What Atlas DID is a fact, so that
                  is what it says. */}
              {live.lastSceneRun && (
                <p className="sh-panel-note" style={{ margin: 0 }}>
                  Atlas applied “{live.lastSceneRun.label}”. Which scene the house is in now is
                  something no bridge reports, so nothing here is highlighted.
                </p>
              )}
            </div>

            {/* The design reveals these controls on hover. Hover-only
                disclosure has no keyboard or touch equivalent, so they are
                always visible and the strip is taller instead. */}
            <Panel title="Recently operated" icon={<Radio className="i16" />}>
              {recent.length ? (
                <div className="sh-recent">
                  {recent.map((d) => (
                    <DeviceSlot
                      key={d.id}
                      device={d}
                      compact
                      onValue={(v) => live.setDeviceValue(d.id, v)}
                      onColour={(c) => live.setDeviceColour(d.id, c)}
                    />
                  ))}
                </div>
              ) : (
                <Empty body="Nothing has been operated yet — this fills in as you and Atlas touch things." />
              )}
            </Panel>
          </>
        )}
      </div>

      {view === 'house' && (
        snapshot.widgets.length ? (
          <main className="sh-grid">
            {snapshot.widgets.map((w) => (
              <HomeWidgetCard key={w.id} widget={w} onToggle={(on) => live.setWidgetOn(w.id, on)} />
            ))}
          </main>
        ) : (
          <div className="sh-rooms">
            {live.loading && !hasBridge ? (
              <Empty size="section" icon={<Home className="i20" />} body="Reading Atlas’ home store…" />
            ) : outage ? (
              // NOT the day-one screen. There is a bridge; it is quiet.
              <Empty
                size="section"
                icon={<Home className="i20" />}
                title={snapshot.bridgeState === 'unauthorised'
                  ? 'Home Assistant rejected Atlas\u2019 token'
                  : 'Home Assistant is not answering'}
                body={`Atlas still holds ${deviceCount} device${deviceCount === 1 ? '' : 's'} from your house${snapshot.lastReachedLabel ? `, last reached ${snapshot.lastReachedLabel}` : ''}. They are shown in Rooms as history, not as status \u2014 nothing here is a claim about your house right now.`}
                status="stale"
                action={{ label: 'Try again', onClick: () => { void live.sync(); }, variant: 'primary' }}
              />
            ) : hasBridge ? (
              // A linked house with no widgets is not an empty house. Widgets are
              // editorial summaries ("4.1 kWh today") and nothing the bridge
              // reports is a history Atlas could summarise without inventing it,
              // so the grid stays empty and says why rather than filling up.
              <Empty
                size="section"
                icon={<Home className="i20" />}
                title="No home widgets"
                body="Atlas has your rooms and devices, but it keeps no history of them yet — and a widget is a summary of a history. Rather than compute one from nothing, it shows none. Rooms has every device."
                status="resting"
                action={{ label: 'Go to rooms', onClick: () => setView('rooms'), variant: 'primary' }}
              />
            ) : (
              <Empty
                size="section"
                icon={<Home className="i20" />}
                title="No home is connected"
                body="Atlas has no bridge to your house — it cannot see a single device. Connect Home Assistant and the rooms, devices and scenes it already knows about appear here. Nothing is shown until they do."
                status="stale"
                action={connectAction}
              />
            )}
          </div>
        )
      )}

      {view === 'rooms' && (
        <main className="sh-rooms">
          {outage && (
            <OutageNotice
              state={snapshot.bridgeState}
              lastReached={snapshot.lastReachedLabel}
              onRetry={() => { void live.sync(); }}
              onSetup={goToSetup}
              retrying={live.syncing}
            />
          )}
          {snapshot.rooms.length === 0 && (
            <Empty
              size="section"
              icon={<Home className="i20" />}
              title={hasBridge ? 'No rooms' : 'No home is connected'}
              body={hasBridge
                ? 'Your bridge reports no rooms yet. Rooms come from the home you link — Atlas does not make them up, and it will not guess which lamp is in which room.'
                : 'Rooms come from the home you link. Connect Home Assistant and its areas, devices and names arrive as they are.'}
              status="stale"
              action={hasBridge ? undefined : connectAction}
            />
          )}
          {snapshot.rooms.map((room) => {
            const active = room.devices.filter((d) => d.available && d.value > 0).length;
            const offline = room.devices.filter((d) => !d.available).length;
            return (
              <section key={room.id}>
                <header className="sh-room-head">
                  <h2 className="sh-room-name">{room.name}</h2>
                  <span className="sh-room-meta tnum">
                    {room.devices.length} devices · {active} active
                    {offline ? ` · ${offline} not responding` : ''}
                  </span>
                  <span className="sh-room-status" data-tone={room.tone}>
                    <span className="sh-dot" style={{ background: TONE_DOT[room.tone] }} aria-hidden />
                    {room.status}
                  </span>
                </header>
                {room.devices.length ? (
                  <div className="sh-devgrid">
                    {room.devices.map((d) => (
                      <DeviceSlot
                        key={d.id}
                        device={d}
                        onValue={(v) => live.setDeviceValue(d.id, v)}
                        onColour={(c) => live.setDeviceColour(d.id, c)}
                      />
                    ))}
                  </div>
                ) : (
                  <Empty body={`${room.name} has no devices in it yet.`} />
                )}
              </section>
            );
          })}
        </main>
      )}

      {view === 'setup' && (
        <main className="sh-setup">
          <div className="sh-col">
            <Panel title={hasBridge ? 'Bridge' : 'Connect your home'} icon={<Plus className="i16" />}>
              {hasBridge ? (
                <>
                  <p className="sh-panel-note">
                    Home Assistant is linked. Devices, rooms and scenes are mirrored from it; Atlas
                    adds nothing of its own to the list.
                  </p>
                  <div className="sh-ink-tile" style={{ marginTop: 10 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <p className="sh-ink-tile-t">{haBridge?.name ?? snapshot.hub?.name ?? 'Home Assistant'}</p>
                      <p className="sh-ink-tile-s">{haBridge?.detail ?? snapshot.hub?.lastSyncLabel ?? ''}</p>
                    </div>
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => { void live.unlink(haBridge?.kind ?? 'home_assistant'); }}
                    >
                      Unlink
                    </Button>
                  </div>
                  <p className="sh-panel-note" style={{ marginTop: 10 }}>
                    Unlinking removes the mirrored rooms and devices from Atlas and deletes the
                    token from the Keychain. It changes nothing in Home Assistant.
                  </p>
                </>
              ) : (
                <LinkForm onLink={live.linkHomeAssistant} linking={live.linking} />
              )}
            </Panel>

            <Panel title="Connected" icon={<Link2 className="i16" />} action={
              <span className="sh-room-meta tnum">
                {deviceCount} accessories · {snapshot.rooms.length} rooms
                {snapshot.counts.unavailable ? ` · ${snapshot.counts.unavailable} not responding` : ''}
              </span>
            }>
              {snapshot.rooms.length ? (
                <div className="sh-roomtiles">
                  {snapshot.rooms.map((room) => (
                    <div className="sh-roomtile" key={room.id}>
                      <div className="sh-roomtile-head">
                        <p className="sh-roomtile-name">{room.name}</p>
                        <span className="sh-roomtile-count tnum">{room.devices.length}</span>
                      </div>
                      <p className="sh-roomtile-list">
                        {room.devices.map((d) => d.name).join(', ')}
                      </p>
                      <div className="sh-roomtile-foot">
                        <span className="sh-dot" style={{ background: TONE_DOT[room.tone] }} aria-hidden />
                        <span className="sh-roomtile-status">{room.status}</span>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <Empty body={hasBridge
                  ? 'The bridge is linked but has reported no rooms yet. Sync to ask it again.'
                  : 'Nothing is connected. Rooms appear once a bridge reports them.'} />
              )}
            </Panel>
          </div>

          <div className="sh-col">
            <Panel className="sh-ink">
              <p className="sh-ink-lbl">Sync</p>
              <h2 className="sh-ink-h">{snapshot.hub?.name ?? 'No home hub'}</h2>
              <p className="sh-ink-p">
                {snapshot.hub
                  ? 'One way, on purpose. Rooms, scenes and device names are read from Home Assistant; Atlas writes commands, never a renamed room back.'
                  : 'Atlas has nothing to sync with. When a hub is linked, its rooms, scenes and device names appear here as it reports them.'}
              </p>

              {snapshot.hub ? (
                <div className="sh-ink-tile">
                  <span className="sh-live-dot" aria-hidden />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p className="sh-ink-tile-t tnum">Connected · {snapshot.hub.accessories} accessories</p>
                    <p className="sh-ink-tile-s">{snapshot.hub.lastSyncLabel}</p>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={live.syncing}
                    icon={<RefreshCw className="i16" />}
                    onClick={() => { void live.sync(); }}
                  >
                    Sync now
                  </Button>
                </div>
              ) : (
                <div className="sh-ink-tile">
                  <Empty body="Nothing linked yet." />
                </div>
              )}

              {snapshot.bridges.length ? (
                <div style={{ marginTop: 8 }}>
                  {snapshot.bridges.map((b) => (
                    <div className="sh-bridge-row" key={b.id}>
                      <div style={{ minWidth: 0 }}>
                        <p className="sh-bridge-name">{b.name}</p>
                        {/* `detail` is where "unreachable" and "unauthorised"
                            arrive as different sentences — they need different
                            fixes and must not both read as a grey pill. */}
                        <p className="sh-bridge-meta">{b.detail}</p>
                      </div>
                      <span className="sh-bridge-state" data-linked={b.state === 'connected'}>
                        {bridgePill(b)}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ marginTop: 8 }}>
                  <Empty body="No bridges. Home Assistant is the one Atlas can link today." />
                </div>
              )}
            </Panel>

            <Panel title="What Atlas may do alone" icon={<ShieldCheck className="i16" />}>
              <p className="sh-panel-note">
                These are not stored preferences. They are what Rust actually enforces through the
                control port’s approval tiers — locks ask you every time, and nothing on this screen
                can turn that off. Touch a switch and Atlas will say so rather than move it.
              </p>
              {snapshot.autonomy.length ? snapshot.autonomy.map((rule) => (
                <div className="sh-perm-row" key={rule.id}>
                  <div style={{ minWidth: 0 }}>
                    <p className="sh-perm-name">{rule.name}</p>
                    <p className="sh-perm-note">{rule.note}</p>
                  </div>
                  <Switch
                    checked={rule.allowed}
                    label={rule.name}
                    onChange={(next) => live.setAutonomy(rule.id, next)}
                  />
                </div>
              )) : (
                <Empty body="Atlas has not reported its home rules — nothing has been read from the app yet." />
              )}
            </Panel>
          </div>
        </main>
      )}
    </div>
  );
};

export default AtlasSmartHome;
