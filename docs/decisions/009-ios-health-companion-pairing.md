# ADR 009 — The iOS health companion: the design, and why it is not built yet

**Status:** accepted (design recorded, implementation deferred) · **Date:** 2026-08-08
**Supersedes nothing. Depends on:** ADR 008 (HealthKit/HomeKit platform wall).

## Context

ADR 008 established, by compiling and running native code, that
`HKHealthStore.isHealthDataAvailable()` returns `false` on macOS 26.3. It is a
device-capability answer, not a permission one: there is no HealthKit store on
this Mac to serve from, entitlement or no entitlement. Health data on Apple's
platform lives on the iPhone.

That leaves two ways for it to reach Atlas:

1. **The Apple Health export.** The person taps *Export All Health Data* in the
   Health app and hands Atlas the resulting zip. **This is built** — see
   `src-tauri/src/health/import.rs`. It works today, needs no entitlement, no
   companion, no network, and no account.
2. **An iOS companion app** that reads HealthKit on the phone and sends derived
   values to the Mac over the local network. **This is not built**, and this ADR
   is why, plus the design so it does not have to be re-derived.

## Decision

**Defer the companion. Ship the export importer. Record the pairing design
here.** `src-tauri/src/health/companion.rs` carries the seam — the
`HealthSource` trait, which `import::AppleExport` already implements — and a
`Companion` stub whose `pull()` returns `Unavailable` rather than an empty
result, because "your body produced no data" is a claim about a person's life
and "Atlas cannot read your health data" is a claim about our software.

### Why deferred, specifically

Not "it is a lot of work". Three reasons, in order of weight:

1. **It cannot be verified even once.** There is no iOS app on the other end.
   Every test would be Atlas talking to a fixture we also wrote, which proves
   the fixture and the implementation agree and nothing about whether either
   matches a real device.
2. **The failure mode of untested pairing crypto is not "it does not work".**
   A broken TCP client fails loudly on the first connection. A key exchange with
   a subtly wrong transcript hash, a reused nonce, or a missing identity binding
   works perfectly and is not secure — and the data it is protecting is a
   person's sleep, weight, heart rate and location-shaped workout history.
   Shipping crypto that has never completed a real handshake is worse than
   shipping none, because the surface would then tell the user their data is
   protected.
3. **It buys convenience, not capability.** The companion's advantage over the
   export is that it is automatic. The export already delivers the same derived
   values, and the derived values are all Atlas keeps.

## The design, for whoever builds it

### Shape

The phone is the **client** and the Mac is the **server**. Backwards from the
obvious reading — the phone has the data — and deliberate: the Mac is the
long-running process with a stable address on the LAN, and the phone is the one
that wakes up, has something to say, and sleeps. It also means the Mac never
has to reach an iPhone that is asleep, in someone's pocket, or on a different
network.

### 1. Discovery — Bonjour, and only to find an address

The Mac advertises `_atlas-health._tcp` on the local network, TXT records
carrying a protocol version and the Mac's **long-term public key fingerprint**.
The phone browses for it.

**Discovery is not authentication.** Anything on the LAN can advertise that
service name with any TXT record. Bonjour's only job here is to turn "the Mac
called Magnus' MacBook" into an IP and a port; every trust decision happens in
step 2. A design that treated the browse result as identification would pair
with whatever answered first.

### 2. Pairing — a QR code shown on the Mac, scanned by the phone

The Mac generates an **X25519** key pair, displays a QR code containing:

```
atlas-health-pair:v1?pk=<base64url X25519 public key>
                     &psk=<base64url 32 random bytes>
                     &host=<name>&port=<port>
```

The phone scans it. This is the whole trust anchor, and it is chosen for one
property: **the channel that carries it is the user's eyes**, which no attacker
on the LAN is on. It is out-of-band by construction rather than by a TOFU
prompt nobody reads.

- `pk` is the Mac's static public key. The phone pins it.
- `psk` is a one-time pre-shared key, valid for the pairing window only
  (5 minutes, single use), which binds the session to *this* QR code and defeats
  an attacker who has the public key from the TXT record but was not in the
  room.
- The QR **never** contains health data, an account token, or a long-term
  secret usable after pairing completes.

On completion each side stores the other's static public key. The Mac's key
lives in the Keychain under service `atlas-health-companion`; the phone's
pinned copy lives in its own Keychain. **Re-pairing is a new QR code** — there
is no "trust this device again" path, because that path is how a stolen phone
stays paired.

### 3. Transport — Noise `IKpsk2`, not TLS

`Noise_IKpsk2_25519_ChaChaPoly_SHA256`.

- **`IK`**: the initiator (phone) already knows the responder's static key from
  the QR. That is exactly the pattern's premise, and it means the phone can send
  its first message without a round trip and without ever talking to something
  it has not authenticated.
- **`psk2`**: mixes the QR's pre-shared key into the handshake, so possession
  of the Mac's public key alone is not enough.
- **Not TLS**, because TLS's trust model is certificate authorities and this
  has no CA, no domain name, and no revocation story. Self-signed TLS with
  pinning would end up reimplementing exactly this, in a protocol with far more
  surface. The chosen alternative to hand-rolling is a **reviewed Noise
  implementation** (`snow`), not hand-written primitives — see "what must not be
  hand-written" below.

The Mac binds to **127.0.0.1 and the LAN interface only**, never `0.0.0.0` with
a forwarded port, and refuses a connection from outside the local subnet.

### 4. What crosses the wire — derived values, never samples

The phone aggregates. It sends the same rows `import.rs` produces:

```
{ "day": "2026-08-08", "metric": "steps", "value": 8213, "unit": "count",
  "stat": "sum", "sampleCount": 40, "source": "Magnus' iPhone" }
```

This is not an optimisation. Atlas' published commitment is that health data
never leaves the device, and the narrower version — "the minute-by-minute record
of where a body was and what it was doing never leaves the phone" — is enforced
by the wire format itself rather than by a promise about what the Mac does after
receiving it. `HealthSource::pull` returns `Derived` for the same reason: a
companion that wanted to stream samples would not fit the trait.

### 5. What must not be hand-written

X25519, ChaCha20-Poly1305, SHA-256, and the Noise state machine. `ws.rs` in the
smart-home module is a hand-written RFC 6455 client and that was the right call
— WebSocket framing is checkable against published vectors, and a bug in it is
loud. Cryptography is neither. Use `snow` (Noise) over `x25519-dalek` +
`chacha20poly1305`, and note that adding them is a **Cargo.toml edit**, which is
governed by the vergen pin in ADR 006 and must be done surgically.

### 6. When to build it

When there is an iOS app that can complete a handshake — not before. The first
milestone is not "implement Noise", it is "an iOS app that reads HealthKit and
prints a derived day to its own console". Everything above is worthless until
something exists to talk to.

## Consequences

- The health surface has exactly one working source, and the Sources screen
  lists the companion as `state: "unavailable"` with the reason attached
  (`companion::source_entry()`), rather than hiding it. A person who wonders why
  Atlas cannot see their Watch data gets an answer instead of an empty list.
- Health data is **as fresh as the last export**, which is a real limitation and
  is why every stored value and every projection carries the day it is from.
- No new dependency, no new network listener, and no crypto has been added to
  this repo for health.
- `src-tauri/src/health/companion.rs` is a stub with tests asserting it stays
  one. If someone implements pairing, those tests fail — which is the intended
  signal to come back and rewrite this ADR rather than leave it describing code
  that no longer matches.

## Where this is recorded

- `src-tauri/src/health/companion.rs` — the `HealthSource` trait and the stub.
- `src-tauri/src/health/import.rs` — `AppleExport`, the one implementation that
  works, which is what makes the trait a contract rather than an aspiration.
- `docs/decisions/008-healthkit-homekit-platform-wall.md` — why there is no
  macOS-side alternative.
- `src-tauri/tests/platform_health_home_wall.rs` — the tripwire on 008.
