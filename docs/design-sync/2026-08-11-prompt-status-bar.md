# Claude Design prompt — Atlas system status bar

Written for a Claude Design session with the repo attached, already knowing the
Workshop design system. States intent and decisions, not background. Paste
everything below the line.

---

**Design a floating system status bar — the strip that tells you the state of
the Mac Atlas is running on, and lets you change what can be changed.**

One thing settled by testing before you start: **Wi-Fi can be switched from
inside Atlas; Bluetooth cannot be toggled at all.** Every public macOS framework
exposes Bluetooth power as a read-only property — there is no setter anywhere.
So Bluetooth is a readout plus a route into System Settings, and that asymmetry
is a design problem you have to solve rather than a detail to note: two
neighbouring controls in one strip, one of which acts and one of which hands
off.

Atlas today knows nothing about its own machine. No battery, no Wi-Fi, no
Bluetooth, no idea what is connected. This adds all of it.

## Design the complete feature set

**Everything below is being built to match your design.** Design it fully — do
not hedge, do not mark anything as a future state.

**1. The resting bar.** Floating, glass. It shows:
- **Battery / power** — charge, charging or on battery, time remaining.
- **Wi-Fi** — connected network name and signal strength, or not connected.
- **Bluetooth** — on or off.
- **Connected devices** — beautiful icons for what is actually connected right
  now: AirPods, headphones, a mouse, a keyboard, a game controller, a phone.
  This is the part that should feel delightful rather than utilitarian.

**2. Placement is your call.** Top-left, top-centre, or floating at the bottom.
The window has no title bar (`titleBarStyle: Overlay`, hidden title), so the top
strip is genuinely free. Consider that a **dock already floats at the bottom
centre and is solid dark**, not glass — the two have to coexist on one screen
without competing, so the contrast between them should be deliberate.

**3. Apple glassmorphism**, and Atlas already has the vocabulary — existing
panels use `backdrop-filter: blur(24px)`, cards use `blur(12px) saturate(1.06)`.
Match that family rather than inventing a new blur.

**4. The expanded states — this is where the design earns its keep.**
- **Wi-Fi:** the network list, signal strengths, the one you are on, joining a
  new one, and the password prompt for a network Atlas has not seen before.
  This is the one genuine control on the bar.
- **Bluetooth:** the device list, and the hand-off to System Settings for the
  on/off switch. **Do not draw a toggle** — it cannot be built, and a switch
  that opens another app instead of switching is worse than an honest link.
  Design what a "this happens elsewhere" affordance looks like in this system;
  Atlas does not have one yet, and it will be needed again.
- **Battery:** whatever detail is worth a second glance — time remaining, what
  is draining it.

**5. Degraded states, designed honestly.** Atlas's house rule is honest UI over
fake data, and this bar has more failure modes than anything else in the app:
permission not granted, Bluetooth off, Wi-Fi off, no network, on AC power,
battery unknown, a device connected but unidentifiable. Each needs a real
resting appearance — **not a spinner, not a dash, and never a plausible-looking
placeholder value.**

## House rules — these are not negotiable

| Rule | Detail |
|---|---|
| **Borderless** | Separation is fill and space only. No 1px rings, no dividers. Drawings (signal arcs, battery fill) are exempt. |
| **Orange is forbidden** | `#ff6a00` is the voice indicator and nothing else. Use Atlas Blue `#3461f2` or the status tokens (`--grn`, `--red`, `--amber`) for battery states. |
| **Tabular numerals** | On the battery percentage and anything else that ticks. |
| **Reduced motion** | A charging animation needs a defined static state. |
| **Focus** | Every control keyboard-reachable with a visible focus ring — this bar is small and dense, which is exactly where that gets skipped. |
| **Legibility over glass** | Glass over a bright dashboard is where contrast dies. The bar must stay readable over the lightest and the darkest surface in the app, including the blue login scene and the music player's full-screen artwork. |

## What to be careful about

- **This is the only always-present chrome besides the dock.** It is on screen
  during every other surface you have designed. It must never compete with the
  content, and it must never move.
- **Density.** Four status groups plus a device list, in a strip. Decide what
  collapses and what is always visible — and what happens with eight connected
  devices rather than two.
- **It is a control surface, not a readout.** Tapping Wi-Fi should feel like it
  will do something, and switching networks should feel safe.

## What the app can actually do

Two honest limits worth designing around:

- **Connected-device names come from a system query**, not from a live
  connection. Measured at 60–110 ms, so the list refreshes on an interval rather
  than instantly — a device appearing or disappearing may lag a second or two.
  Design a transition that survives that, rather than one implying realtime.
- **The device list may be partial.** The system query distinguishes connected
  from merely paired, but it was never observed with something actually
  connected during testing. Design for the case where Atlas knows a device is
  paired but is not certain it is in use.
- **Wi-Fi network names require *location* permission** on modern macOS, which
  surprises people — Atlas can see the signal strength and the security type
  without it, but not the name. Design both that consent moment (it should feel
  like Atlas's existing `/permissions` screen, which explains before it asks)
  **and the degraded state where the user declines**: a connected network with
  no name is a real thing this bar will show.
- **Bluetooth needs its own one-time permission**, and the first framework call
  without it crashes the app rather than returning nothing — so that prompt is
  not optional and cannot be deferred.
