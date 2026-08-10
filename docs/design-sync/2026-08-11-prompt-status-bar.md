# Claude Design prompt — Atlas system status bar

Written for a Claude Design session with the repo attached, already knowing the
Workshop design system. States intent and decisions, not background. Paste
everything below the line.

---

**Design a floating system status bar — the strip that tells you the state of
the Mac Atlas is running on, and lets you change it.**

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
- **Bluetooth:** toggling it on and off, and the device list.
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
  connection. Expect a device list that refreshes on an interval rather than
  instantly — so a device appearing or disappearing may lag by a second or two.
  Design a transition that survives that, rather than one that implies realtime.
- **Wi-Fi and Bluetooth both need a one-time macOS permission**, and Wi-Fi
  network names additionally require *location* permission on modern macOS —
  which surprises people. Design that consent moment; it should feel like
  Atlas's existing `/permissions` screen, which explains before it asks, rather
  than like a bare system dialog.
