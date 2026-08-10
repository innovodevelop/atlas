/**
 * Atlas HomeKit Lab — `/homekit-lab`. ADMIN EDITION, and in practice Lighthouse.
 *
 * ── WHAT THIS IS ────────────────────────────────────────────────────────────
 *
 * A development tool for the HAP CONTROLLER: Atlas pairing with HomeKit
 * accessories directly over the LAN, speaking the HomeKit Accessory Protocol
 * itself. It is not the HomeKit framework — `HMHomeManager` is Mac Catalyst
 * only and Atlas is an AppKit app, which ADR 008 records and a Rust tripwire
 * pins. Nothing here calls a HomeKit API; it is mDNS, HTTP, SRP and Ed25519,
 * all in `src-tauri/src/home/hap/`.
 *
 * It says "development tool" on its face because it is one, and because the
 * single most useful thing it can tell a developer is why it is showing them
 * nothing.
 *
 * ── THE FOUR THINGS THIS SCREEN IS FOR ──────────────────────────────────────
 *
 * 1. NOTHING HERE HAS EVER SPOKEN TO A REAL ACCESSORY. The development target
 *    is Apple's HomeKit Accessory Simulator, and it is NOT installed on this
 *    machine — it ships in "Additional Tools for Xcode", a separate download
 *    that needs an Apple ID. A bare "no accessories found" would read as a
 *    broken feature, so the empty state spells the whole path out. That text is
 *    the reason this screen exists at all.
 *
 * 2. "Discovery found nothing" and "discovery has never run" are different
 *    facts and get different screens (`ScanState`, useHomeKitLab.ts). They draw
 *    the same zero rows and mean opposite things.
 *
 * 3. AN ACCESSORY HOLDS ONE PAIRING OWNER. An accessory already in Apple Home
 *    is NOT offered a code field — there is no code that would work, and the
 *    real instruction is to remove it from that home first, which resets its
 *    pairing. Offering a button that cannot work is the failure mode this whole
 *    surface is designed against.
 *
 * 4. A FAILED PAIRING SHOWS WHAT FAILED, in Rust's own words, next to the call
 *    that produced them (with the setup code redacted). "Pairing failed" would
 *    make the tool useless for the one job it has, because the protocol under
 *    it cannot be tested against a live accessory here.
 *
 * ── WHY THE MIRROR PANEL IS PHRASED THE WAY IT IS ───────────────────────────
 *
 * "What Atlas sees" reads back `home_snapshot` — the same mirror the consumer
 * Smart Home screen binds to. Two honest caveats are printed there rather than
 * silently smoothed over: HAP characteristics are already collapsed into
 * Atlas' own kind/control/value before they reach any UI, so this is Atlas'
 * view and not a raw characteristic table; and the snapshot does not tag rows
 * by bridge, so when a Home Assistant bridge is also linked the list contains
 * its devices too, and the panel says so instead of implying otherwise.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Network, Radar, ShieldAlert, Wrench } from 'lucide-react';
import { Button, Empty, Panel, Row } from '@/components/atlas-ui/primitives';
import {
  STATUS_LABEL, formatSetupCode, isValidSetupCode, statusTone, useHomeKitLab,
  type Accessory,
} from '@/hooks/useHomeKitLab';
import '@/styles/surfaces/homekitLab.css';

export const surface = {
  path: '/homekit-lab',
  label: 'HomeKit lab',
  icon: 'Network',
  entry: 'menu' as const,
  mock: false,
  edition: 'admin' as const,
};

/**
 * The download path, written out once. Apple does not offer a deep link to a
 * single tool inside the Additional Tools disk image, so the instruction is the
 * navigation: the page cannot open it for the user and does not pretend to.
 */
const SIMULATOR_STEPS = [
  'Sign in at developer.apple.com/download/all and search for "Additional Tools for Xcode".',
  'Download the version matching this Xcode (26.x), open the .dmg, and look in Hardware/.',
  'Drag HomeKit Accessory Simulator.app to /Applications.',
  'Open it, add an accessory (the + at the bottom left), and leave it running.',
  'Come back here and scan again. A simulated accessory advertises _hap._tcp exactly as a physical one does.',
];

function Chip({ a }: { a: Accessory }) {
  return (
    <span className={`hkl-chip hkl-chip-${statusTone(a.status)}`}>{STATUS_LABEL[a.status]}</span>
  );
}

/**
 * One accessory. The code field's PRESENCE is the honest part: it is rendered
 * from `pairable`, which Rust decided alongside the status, so a `blocked`
 * accessory has no input and no button to press rather than a disabled one to
 * wonder about.
 */
function AccessoryCard({
  a, busy, onPair,
}: {
  a: Accessory;
  busy: boolean;
  onPair: (a: Accessory, code: string) => void;
}) {
  const [code, setCode] = useState('');
  const complete = isValidSetupCode(code);

  return (
    <Panel tone="recessed" nested className="hkl-acc">
      <div className="hkl-acc-head">
        <div className="hkl-acc-name">
          <p className="hkl-acc-title">{a.name}</p>
          <p className="hkl-acc-addr">
            {a.id} · {a.host}:{a.port}
            {a.model ? ` · ${a.model}` : ''}
            {a.category !== null ? ` · category ${a.category}` : ''}
          </p>
        </div>
        <Chip a={a} />
      </div>

      {/* Rust's paragraph, verbatim — one sentence per state, written once. */}
      <p className="hkl-acc-detail">{a.detail}</p>

      {a.problem && (
        <p className="hkl-acc-problem">
          <ShieldAlert className="i16" aria-hidden /> The accessory is raising its own problem flag
          (status flag bit 1). That is the accessory reporting a fault about itself, not Atlas
          reporting one about the accessory.
        </p>
      )}

      {a.pairable ? (
        <form
          className="hkl-pair"
          onSubmit={(e) => { e.preventDefault(); onPair(a, code); }}
        >
          <label className="hkl-pair-label" htmlFor={`code-${a.id}`}>Setup code</label>
          <input
            id={`code-${a.id}`}
            className="hkl-pair-input"
            inputMode="numeric"
            autoComplete="off"
            spellCheck={false}
            placeholder="123-45-678"
            value={code}
            onChange={(e) => setCode(formatSetupCode(e.target.value))}
            aria-describedby={`codehelp-${a.id}`}
          />
          <Button type="submit" variant="primary" disabled={!complete || busy} loading={busy}>
            {busy ? 'Pairing…' : 'Pair'}
          </Button>
          <p className="hkl-pair-help" id={`codehelp-${a.id}`}>
            Eight digits from the accessory's label. The dashes are part of the SRP password —
            <code>123-45-678</code> and <code>12345678</code> are different passwords. The code is
            sent once and never stored.
          </p>
        </form>
      ) : (
        <p className="hkl-pair-blocked">
          No setup code is offered here, because none would be accepted.
        </p>
      )}
    </Panel>
  );
}

export default function AtlasHomeKitLab() {
  const navigate = useNavigate();
  const lab = useHomeKitLab();
  const {
    blocked, scanState, found, windowMs, scanFailure, scan, pairing, outcome, snapshot,
    snapshotFailure, refreshSnapshot,
  } = lab;

  const devices = snapshot.rooms.flatMap((r) => r.devices);
  const otherBridge = snapshot.bridges.some(
    (b) => b.kind !== null && b.kind !== 'homekit_companion' && b.state === 'connected',
  );
  const seconds = windowMs > 0 ? `${(windowMs / 1000).toFixed(1)}s` : null;

  return (
    <div className="page hkl-surface" data-screen-label="Atlas — HomeKit lab">
      <header className="hkl-header">
        <button className="hkl-back" onClick={() => navigate(-1)} aria-label="Back">
          <Network className="i20" />
          <h1 className="hkl-title">HomeKit Lab</h1>
        </button>
        <p className="hkl-eyebrow">admin · development tool</p>
      </header>

      <Panel tone="wash" className="hkl-standing">
        <p className="hkl-standing-lead">
          <Wrench className="i16" aria-hidden /> This is a development tool, not a feature.
        </p>
        <p className="hkl-standing-body">
          Atlas pairs with HomeKit accessories by speaking the HomeKit Accessory Protocol over
          the LAN itself — mDNS, SRP, Ed25519 — because the HomeKit <em>framework</em> is Mac
          Catalyst only and this app is AppKit (ADR 008). None of it has ever run against a live
          accessory: everything below is the first time this code meets a real network.
        </p>
      </Panel>

      {blocked ? (
        <Panel title="Not available here" icon={<Radar className="i20" />} tone="panel">
          <Empty size="block" status="error" title={
            blocked.kind === 'not-desktop' ? 'Desktop app only' : 'Sign in required'
          } body={blocked.message} />
        </Panel>
      ) : (
        <>
          <Panel
            title="Accessories on this network"
            icon={<Radar className="i20" />}
            tone="panel"
            action={
              <Button
                variant="primary"
                onClick={() => void scan()}
                loading={scanState === 'scanning'}
                disabled={scanState === 'scanning'}
              >
                {scanState === 'scanning' ? 'Listening…' : 'Scan for accessories'}
              </Button>
            }
          >
            {scanState === 'idle' && (
              <Empty
                size="block"
                status="resting"
                icon={<Radar className="i20" />}
                title="Nothing has been asked yet"
                body="Atlas has not browsed _hap._tcp in this session. Scanning sends one multicast DNS query and listens for a couple of seconds; nothing is stored and nothing is contacted directly."
              />
            )}

            {scanState === 'scanning' && (
              <Empty size="block" status="stale" title="Listening for _hap._tcp…" body={
                seconds
                  ? `One multicast query is out; replies are collected for ${seconds}.`
                  : 'One multicast query is out; replies are collected for a couple of seconds.'
              } />
            )}

            {scanState === 'failed' && scanFailure && (
              <div className="hkl-failure">
                <p className="hkl-failure-head">Discovery failed.</p>
                <pre className="hkl-verbatim">{scanFailure.message}</pre>
                {scanFailure.hint && <p className="hkl-failure-hint">{scanFailure.hint}</p>}
              </div>
            )}

            {/* The state this screen exists for. "No accessories found" alone
                reads as a broken feature; on this machine it almost always
                means the Simulator was never installed. */}
            {scanState === 'empty' && (
              <div className="hkl-empty">
                <p className="hkl-empty-head">
                  Nothing answered{seconds ? ` in ${seconds}` : ''}. That is expected on this
                  machine.
                </p>
                <p className="hkl-empty-body">
                  The development target is Apple's HomeKit Accessory Simulator, and it is not
                  installed here. It does not come with Xcode — it ships separately in
                  <strong> Additional Tools for Xcode</strong>, which needs an Apple ID download
                  you have to do yourself:
                </p>
                <ol className="hkl-steps">
                  {SIMULATOR_STEPS.map((s) => <li key={s}>{s}</li>)}
                </ol>
                <p className="hkl-empty-body">
                  If the Simulator <em>is</em> running and still nothing appears, the other
                  candidate is the query itself: Atlas asks for a unicast reply from an ephemeral
                  port rather than binding 5353 (mDNSResponder holds it, and `std::net` exposes no
                  SO_REUSEPORT). A responder that ignores the QU bit would never be seen. That
                  trade-off is written down in `hap/discovery.rs`.
                </p>
              </div>
            )}

            {scanState === 'found' && (
              <div className="hkl-list">
                <p className="hkl-count">
                  {found.length} {found.length === 1 ? 'accessory' : 'accessories'} answered
                  {seconds ? ` within ${seconds}` : ''}.
                </p>
                {found.map((a) => (
                  <AccessoryCard key={a.id} a={a} busy={pairing === a.id} onPair={lab.pair} />
                ))}
              </div>
            )}
          </Panel>

          {outcome && (
            <Panel
              title={outcome.ok ? 'Pairing succeeded' : 'Pairing failed'}
              tone={outcome.ok ? 'panel' : 'ink'}
              action={<Button variant="text" onClick={lab.clearOutcome}>Dismiss</Button>}
            >
              {/* The call is printed whether it worked or not: for a protocol
                  nobody here can test against an accessory, "what was actually
                  sent" is half the diagnosis. The setup code is redacted. */}
              <pre className="hkl-verbatim hkl-call">{outcome.call}</pre>
              {outcome.ok ? (
                <p className="hkl-ok">
                  The accessory is paired and its long-term public key is in the Keychain. The
                  inline sync stored {outcome.synced?.devices ?? 0} devices,{' '}
                  {outcome.synced?.scenes ?? 0} scenes and {outcome.synced?.rooms ?? 0} rooms —
                  HAP has no rooms or scenes at the accessory, so zero of each is the correct
                  answer, not a missing one.
                </p>
              ) : (
                <>
                  <p className="hkl-failure-head">What the pairing actually said:</p>
                  <pre className="hkl-verbatim">{outcome.failure?.message}</pre>
                  {outcome.failure?.hint && (
                    <p className="hkl-failure-hint">{outcome.failure.hint}</p>
                  )}
                  <p className="hkl-failure-note">
                    That sentence is the Rust error verbatim — pair-setup names its own failure
                    (a rejected code, a back-off, no room for another controller, an M4 proof
                    mismatch), and Atlas does not paraphrase it. Nothing was written: the
                    Keychain is only touched after M6 verifies.
                  </p>
                </>
              )}
            </Panel>
          )}

          <Panel
            title="What Atlas sees"
            tone="panel"
            action={
              <Button variant="ghost" onClick={() => void refreshSnapshot()}>Reload</Button>
            }
          >
            <p className="hkl-note">
              Read back from <code>home_snapshot</code> — the same mirror the Smart Home screen
              binds to. HAP characteristics are already collapsed into Atlas' kind / control /
              value by the adapter, so this is what Atlas <em>understood</em>, not the raw
              characteristic table the accessory published.
            </p>
            {otherBridge && (
              <p className="hkl-note hkl-note-warn">
                A non-HomeKit bridge is also linked, and the snapshot does not tag rows by bridge.
                Some of the devices below are its, not the accessory's.
              </p>
            )}
            {snapshotFailure ? (
              <div className="hkl-failure">
                <p className="hkl-failure-head">The mirror could not be read.</p>
                <pre className="hkl-verbatim">{snapshotFailure.message}</pre>
              </div>
            ) : devices.length === 0 ? (
              <Empty
                size="block"
                status="resting"
                title="The mirror is empty"
                body="Nothing has been paired and synced yet, so Atlas holds no devices. Pair an accessory above and this fills in — a paired accessory syncs inline."
              />
            ) : (
              devices.map((d) => (
                <Row
                  key={d.id}
                  density="compact"
                  title={d.name}
                  meta={`${d.kind} · ${d.control} · value ${d.value}${
                    d.roomName ? ` · ${d.roomName}` : ' · no room (HAP has none)'
                  }`}
                  trail={<span className="hkl-trail">{d.available ? d.state : 'unavailable'}</span>}
                />
              ))
            )}
          </Panel>
        </>
      )}

      <footer className="hkl-foot">
        Pairing is not on the model's control port. `home_homekit_pair` is on the registry's
        DENIED list because a setup code is read off a physical label — a credential, not a
        capability. Only the read-only browse is reachable to the model, through
        <code> home.discover</code>.
      </footer>
    </div>
  );
}
