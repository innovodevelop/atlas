# Claude Design prompt — Atlas Clock

Written for a Claude Design session with the repo attached, already knowing the
Workshop design system. States intent and decisions, not background. Paste
everything below the line.

---

**Design "Atlas Clock" — one full-screen surface covering timer, countdown,
alarms and world clocks.**

Nothing of this exists. The only clock in Atlas today is a small dashboard card
showing three hardcoded cities (`AtlasWorldClockCard`, `src/components/atlas-ui/AtlasExtraCards.tsx:115`),
and there is no timer, no alarm and no stopwatch anywhere in the product. The
widget catalog names `Clock`, `Countdown` and `Up next` — all three are
`built: false` placeholders. There is **no `.dc.html` reference for a clock in
the v2 handoff bundle.** You are designing this from nothing.

## Design the complete feature set

**Everything below is being built to match your design.** Design it fully — do
not hedge, do not mark anything as a future state, do not design around a
current limitation. Where a constraint is real I have named it explicitly below;
everything else is open.

**Four modes, switched by tabs: Timer · Countdown · Alarm · Clocks.**

**1. Timer** — counts *up*, with **laps**. Design running, paused and reset
states, and a lap list that reads well at 2 laps and at 40. Laps need a visible
delta against the previous lap, not just an absolute time.

**2. Countdown** — counts *down*, set either as a duration or a target date and
time. Also has laps (split marks against a shrinking remainder). **Overrun —
past zero — is a real state, not an error.** A countdown that hits zero and
keeps going is normal use; design what that looks like.

**3. Alarm** — a **list of alarms, with several enabled at once**. Per alarm:
label, time, repeat days, and an **output** control — this Mac's speakers, or a
named speaker in the user's home (Atlas already talks to Home Assistant and
HomeKit accessories, so "wake me through the kitchen speaker" is real). Design
the ringing state and snooze.

  A decision that shapes this: **alarms fire even when Atlas is quit.** That
  needs the user's permission once, so design the consent moment — it should
  feel like the existing `/permissions` screen, not like a system dialog.

**4. Clocks** — the city overview that replaces today's three-city card. Add,
reorder, remove. Day-offset badges (Today / Tomorrow / Yesterday) already exist
in logic and should be shown.

Also design **the dashboard clock card in its new form**, since the surface now
gives it somewhere to open to.

## House rules — these are not negotiable

| Rule | Detail |
|---|---|
| **Borderless** | Separation is fill and space only. Page `#f9f7f4` → panel `#f1eeea` → card `#fffdfa`. A card on a panel goes *lighter*; a recessed area goes *darker*. No 1px rings, no dividers — row padding carries lists. Drawings (progress rings, arcs, hands) are exempt. |
| **Tabs** | Use the surface convention: a small button group with `role="tablist"`, as on Health (`.hl-views`) and Smart Home (`.sh-views`). **Do not** use the Atlas Core pill rail (`.coretabs`) — it belongs to that screen and is not shared. |
| **Orange is forbidden** | `#ff6a00` is reserved for the voice indicator and nothing else. The Widget Sheet's `Focus` widget draws a timer ring in orange — **do not copy it.** Use Atlas Blue `#3461f2` or the status tokens. |
| **Tabular numerals** | Every changing digit. A clock whose digits reflow as the seconds tick is the canonical version of this bug. |
| **Reduced motion** | Anything continuously animated (a sweeping second hand) must have a defined static state. Do not rely on motion to communicate that a timer is running. |
| **Primitives** | `Panel`, `Row`, `Button`, `Empty`, `Card`. Card sizes `s / m / l / xl`; skins `glass / ink / accent`. |
| **Navigation** | No back link. The headline itself is the control, plus Esc, with the standard hint strip. |
| **Empty states** | Never a dead end. Atlas's rule is that "nothing to show" always carries a next step. |

## What to be careful about

- **Four modes is a lot for one surface.** The tab strip has to make the current
  mode obvious at a glance from across a desk. Consider whether a running timer
  or a ringing alarm should be visible from the *other* tabs.
- **The alarm list is the only genuinely dense thing here.** Several alarms,
  each with time, label, repeat days, output device and an on/off state — that
  is five properties per row without a single border to lean on. This is the
  hardest part of the screen and worth the most attention.
- **Two timers can run at once** (a timer and a countdown). Decide whether that
  is allowed and show it if so.
- **Nothing on this screen should fabricate data.** If no alarms exist, that is
  an empty state, not a sample list.

## What the app can actually do

So the design does not promise anything hollow:

- System clock, any timezone: **yes**, already working.
- Ringing through home speakers: **yes** — the home bridge is live, though it
  currently only sets volume, so playback is being added for this.
- Firing when Atlas is quit: **being built**, with the user's consent.
- Waking the Mac from sleep to ring: **being built**.
