/**
 * Atlas Smart Home — the `/smart-home` route.
 * Design: `Atlas Smart Home.dc.html` (design_handoff_atlas_suite_v2).
 *
 * ── THE ONE THING TO KNOW ───────────────────────────────────────────────────
 * There is no smart-home anything in Atlas. No HomeKit bridge, no Matter
 * commissioner, no Thread router, no local hub client, no device API of any
 * kind — the repo has never had one. This surface is therefore MOCK-BACKED, on
 * purpose and out loud: every value comes from `@/lib/mocks/smartHome`, and the
 * page carries a permanent, designed "Sample data" treatment saying so. A user
 * cannot mistake this for their own house.
 *
 * That treatment is load-bearing. Remove it and this becomes exactly what T4
 * spent a week deleting from Atlas Core — a surface full of numbers with
 * nothing behind them. The same banner also carries the control that flips the
 * page to its DAY-ONE state, so every empty state on the surface is reachable
 * in one click rather than only existing in theory.
 *
 * ── THREE VIEWS ─────────────────────────────────────────────────────────────
 * House   the design's 12-column widget grid, plus scenes and the devices you
 *         most recently touched.
 * Rooms   room by room, every device with its real affordance.
 * Setup   pairing, the room roster, bridges, and what Atlas may do alone.
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
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  CornerUpLeft, Home, Info, Link2, Plus, Radio, Search, ShieldCheck, Sparkles,
} from 'lucide-react';
import { Button, Empty, Panel } from '@/components/atlas-ui/primitives';
import {
  EMPTY_SNAPSHOT, IS_MOCK, useSmartHome,
  type SmartDevice, type SmartHomeSnapshot, type SmartRoom,
} from '@/lib/mocks/smartHome';
import { HomeWidgetCard } from '@/components/atlas-ui/smartHome/HomeWidgetCard';
import { DeviceCard, RecentDeviceStrip } from '@/components/atlas-ui/smartHome/DeviceCard';
import { Switch } from '@/components/atlas-ui/smartHome/DeviceControls';
import '@/styles/surfaces/smartHome.css';

/** The wiring pass reads this; it does not have to read the file. */
export const surface = {
  path: '/smart-home',
  label: 'Smart home',
  icon: 'Home',
  // `menu`, not `dock`: a surface with no bridge behind it has not earned a
  // primary slot. It becomes a dock candidate the day a real adapter lands.
  entry: 'menu',
  mock: true,
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
const isTyping = (target: EventTarget | null): boolean => {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
};

const AtlasSmartHome = () => {
  const navigate = useNavigate();
  const [view, setView] = useState<View>('house');
  const [preview, setPreview] = useState<'sample' | 'empty'>('sample');
  const [protocol, setProtocol] = useState<string>('all');

  // The swap point. A real adapter is `@/hooks/useSmartHome` with this exact
  // signature; nothing below this line knows which one it is talking to.
  const live = useSmartHome();

  /**
   * Autonomy survives the empty preview on purpose: "may Atlas unlock doors"
   * is a preference about Atlas, not data about a house, so it exists before
   * any device does — and its switches stay live in both previews.
   */
  const snapshot: SmartHomeSnapshot = useMemo(
    () => (preview === 'empty'
      ? { ...EMPTY_SNAPSHOT, autonomy: live.snapshot.autonomy }
      : live.snapshot),
    [preview, live.snapshot],
  );

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
    const map = new Map<string, SmartDevice>();
    for (const room of snapshot.rooms) for (const d of room.devices) map.set(d.id, d);
    return map;
  }, [snapshot.rooms]);

  const recent = useMemo(
    () => snapshot.recentIds.map((id) => devicesById.get(id)).filter((d): d is SmartDevice => !!d),
    [snapshot.recentIds, devicesById],
  );

  const deviceCount = devicesById.size;

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
      const linked = snapshot.bridges.filter((b) => b.state === 'connected').length;
      return {
        lead: 'Set up the ', accent: 'house.',
        subline: snapshot.bridgeConnected
          ? 'Pairing, bridges, and the standing question of what Atlas is allowed to do while you are not looking.'
          : 'Nothing is linked. Atlas cannot discover, pair or command a device until a bridge exists.',
        metaBig: String(linked),
        metaSmall: linked === 1 ? 'bridge linked' : 'bridges linked',
      };
    }
    return h;
  }, [view, snapshot, deviceCount]);

  const backHint = view === 'house' ? 'the dashboard' : 'the house';

  /* Discovery filters are derived from what was found, not hardcoded, so the
     counts cannot drift away from the list under them. */
  const protocols = useMemo(() => {
    const counts = new Map<string, number>();
    for (const d of snapshot.discovery.found) counts.set(d.protocol, (counts.get(d.protocol) ?? 0) + 1);
    return [
      { id: 'all', label: 'All', n: snapshot.discovery.found.length },
      ...[...counts.entries()].map(([label, n]) => ({ id: label, label, n })),
    ];
  }, [snapshot.discovery.found]);

  const found = snapshot.discovery.found.filter((d) => protocol === 'all' || d.protocol === protocol);

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

        {/* The sample-data treatment. Not a console warning, not a comment —
            a designed, permanent, on-screen statement, plus the control that
            shows what a real adapter returns on day one. */}
        {IS_MOCK && (
          <div className="sh-notice" role="note">
            <span className="sh-notice-ico" aria-hidden>
              {preview === 'empty' ? <Sparkles className="i16" /> : <Info className="i16" />}
            </span>
            <div className="sh-notice-body">
              <p className="sh-notice-title">
                {preview === 'empty' ? 'Empty state — day one' : 'Sample data — this is not your house'}
              </p>
              <p className="sh-notice-text">
                {preview === 'empty'
                  ? 'This is what the surface returns before anything is paired: no rooms, no devices, no scenes, no bridges. Every panel below is showing its real empty state.'
                  : 'Atlas has no smart-home bridge — no Apple Home, no Matter fabric, no hub, no device API anywhere in the app. Every room, device and reading here is a fixed sample so the surface can be designed and reviewed. The controls move the sample; they touch nothing you own.'}
              </p>
            </div>
            <div className="sh-notice-act">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setPreview((p) => (p === 'empty' ? 'sample' : 'empty'))}
              >
                {preview === 'empty' ? 'Show the sample house' : 'Preview the empty state'}
              </Button>
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
                      variant={snapshot.activeSceneId === s.id ? 'ink' : 'ghost'}
                      aria-pressed={snapshot.activeSceneId === s.id}
                      onClick={() => live.runScene(s.id)}
                    >
                      {s.label}
                    </Button>
                  ))}
                </div>
              ) : (
                <Empty body="No scenes. A connected home brings its own — Atlas does not invent them." />
              )}
            </div>

            {/* The design reveals these controls on hover. Hover-only
                disclosure has no keyboard or touch equivalent, so they are
                always visible and the strip is taller instead. */}
            <Panel title="Recently operated" icon={<Radio className="i16" />}>
              {recent.length ? (
                <div className="sh-recent">
                  {recent.map((d) => (
                    <RecentDeviceStrip
                      key={d.id}
                      device={d}
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
            <Empty
              size="section"
              icon={<Home className="i20" />}
              title="No house to show"
              body="Atlas is not connected to a home. Link a bridge and the rooms, devices, scenes and readings it exposes appear here — nothing is shown until they do."
              status="stale"
              action={{ label: 'Go to setup', onClick: () => setView('setup'), variant: 'primary' }}
            />
          </div>
        )
      )}

      {view === 'rooms' && (
        <main className="sh-rooms">
          {snapshot.rooms.length === 0 && (
            <Empty
              size="section"
              icon={<Home className="i20" />}
              title="No rooms"
              body="Rooms come from the home you link — Atlas does not make them up, and it will not guess which lamp is in which room."
              status="stale"
              action={{ label: 'Go to setup', onClick: () => setView('setup'), variant: 'primary' }}
            />
          )}
          {snapshot.rooms.map((room) => {
            const active = room.devices.filter((d) => d.value > 0).length;
            return (
              <section key={room.id}>
                <header className="sh-room-head">
                  <h2 className="sh-room-name">{room.name}</h2>
                  <span className="sh-room-meta tnum">
                    {room.devices.length} devices · {active} active
                  </span>
                  <span className="sh-room-status" data-tone={room.tone}>
                    <span className="sh-dot" style={{ background: TONE_DOT[room.tone] }} aria-hidden />
                    {room.status}
                  </span>
                </header>
                {room.devices.length ? (
                  <div className="sh-devgrid">
                    {room.devices.map((d) => (
                      <DeviceCard
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
            <Panel title="Add a device" icon={<Plus className="i16" />} action={
              <span className="sh-scan">
                <span className="sh-scan-dot" aria-hidden />
                Not scanning
              </span>
            }>
              {/* The design pulses a green "Scanning" dot here. That would be a
                  claim about a radio, not about the sample, so the pill says
                  what is true and the field and buttons are disabled with the
                  reason attached rather than silently doing nothing. */}
              <p className="sh-panel-note">
                Atlas has no discovery stack: it cannot see Matter, Thread, Zigbee or
                anything else on your network, and it cannot pair a device.
                {snapshot.discovery.scope ? ` The sample below stands in for ${snapshot.discovery.scope}.` : ''}
              </p>

              <div className="sh-field">
                <Search className="i16" style={{ color: 'var(--ink3)' }} aria-hidden />
                <input
                  placeholder="Name, brand or pairing code"
                  aria-label="Search for a device to pair"
                  disabled
                />
                <Button size="sm" variant="primary" disabled title="Pairing needs a device bridge">
                  Pair
                </Button>
              </div>

              {snapshot.discovery.found.length > 0 && (
                <div className="sh-filters" style={{ marginTop: 12 }}>
                  {protocols.map((p) => (
                    <Button
                      key={p.id}
                      size="sm"
                      variant={protocol === p.id ? 'ink' : 'ghost'}
                      aria-pressed={protocol === p.id}
                      onClick={() => setProtocol(p.id)}
                      trailing={<span style={{ opacity: .55 }} className="tnum">{p.n}</span>}
                    >
                      {p.label}
                    </Button>
                  ))}
                </div>
              )}

              {found.length ? (
                <div style={{ marginTop: 6 }}>
                  {found.map((d) => (
                    <div className="sh-disc-row" key={d.id}>
                      <span className="sh-disc-tile" aria-hidden>{d.name.charAt(0)}</span>
                      <div style={{ minWidth: 0 }}>
                        <p className="sh-disc-name">{d.name}</p>
                        <p className="sh-disc-meta">{d.protocol} · {d.note}</p>
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled
                        title="Pairing needs a device bridge"
                      >
                        {d.suggested === 'add' ? 'Add' : 'Ignore'}
                      </Button>
                    </div>
                  ))}
                </div>
              ) : (
                <Empty
                  size="block"
                  icon={<Search className="i20" />}
                  title="Nothing found"
                  body={snapshot.discovery.found.length
                    ? 'No sample device uses that protocol.'
                    : 'Atlas is not scanning, and it has no way to scan. Discovery arrives with the first bridge.'}
                  status="stale"
                />
              )}
            </Panel>

            <Panel title="Connected" icon={<Link2 className="i16" />} action={
              <span className="sh-room-meta tnum">
                {deviceCount} accessories · {snapshot.rooms.length} rooms
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
                <Empty body="Nothing is connected. Rooms appear once a bridge reports them." />
              )}
            </Panel>
          </div>

          <div className="sh-col">
            <Panel className="sh-ink">
              <p className="sh-ink-lbl">Sync</p>
              <h2 className="sh-ink-h">{snapshot.hub?.name ?? 'No home hub'}</h2>
              <p className="sh-ink-p">
                {snapshot.hub
                  ? 'Two-way. Rooms, scenes and device names stay identical in both apps; Atlas adds its own automations on top without writing them back.'
                  : 'Atlas has nothing to sync with. When a hub is linked, rooms, scenes and device names stay identical in both apps.'}
              </p>

              {snapshot.hub ? (
                <div className="sh-ink-tile">
                  <span className="sh-live-dot" aria-hidden />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p className="sh-ink-tile-t tnum">Connected · {snapshot.hub.accessories} accessories</p>
                    <p className="sh-ink-tile-s">{snapshot.hub.lastSyncLabel}</p>
                  </div>
                  <Button size="sm" variant="ghost" disabled title="There is no bridge to sync with">
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
                        <p className="sh-bridge-meta">{b.detail}</p>
                      </div>
                      <span className="sh-bridge-state" data-linked={b.state === 'connected'}>
                        {b.state === 'connected' ? 'Connected' : 'Not linked'}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ marginTop: 8 }}>
                  <Empty body="No bridges. Apple Home, a Matter fabric and a Thread border router would each be listed here." />
                </div>
              )}
            </Panel>

            <Panel title="What Atlas may do alone" icon={<ShieldCheck className="i16" />}>
              <p className="sh-panel-note">
                These are preferences about Atlas, so they exist before a house does — but
                nothing acts on them until a bridge can carry a command, and they are not
                saved anywhere yet.
              </p>
              {snapshot.autonomy.map((rule) => (
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
              ))}
            </Panel>
          </div>
        </main>
      )}
    </div>
  );
};

export default AtlasSmartHome;
