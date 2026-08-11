# Claude Design prompt — Lighthouse Test Lab

Written for a Claude Design session with the repo attached, already knowing the
Workshop design system. States intent and decisions, not background. Paste
everything below the line.

---

**Design the "Test Lab" — the Lighthouse surface where founders watch agents
test Atlas live, in a sandbox, and turn what breaks into work.**

Lighthouse is the admin edition of Atlas: same design system, same window, an
operator's view. The Test Lab is its flagship surface. A founder picks a feature,
launches one or more test agents, and **watches them use a sandboxed copy of
Atlas in real time** — a live video stage of the agent clicking around, a
narrated timeline of what it is doing and why, and a findings rail that fills up
as problems surface. Recordings are kept and replayable. From any finding, the
founder can launch a coding agent to fix it.

Nothing of this exists. You are designing it from nothing, and it is being built
to match your design — design it fully, no hedging, no future states.

## The screens

**1. The Lab home.** Recent runs as cards — feature under test, verdict at a
glance (clean / findings / failed), duration, a thumbnail from the recording.
One obvious action: **New run**. An empty lab (first launch) needs its own
moment; this is a power surface and the empty state should teach it.

**2. The launcher.** A focused flow, not a settings page:
- What to test — a feature/surface picker (the app's own surface registry), plus
  a free-text brief ("test the new forgot-password flow, including the wrong-email path").
- How many agents — **1 to 4**, each with its own isolated sandbox. Show what
  parallel means here: four stages, four recordings, one findings list.
- The sandbox source — **a clean fixture** (seeded demo data) or **a clone of
  current state** (a snapshot copy; the real database is never touched — say so
  on the screen, it is the whole trust story of the feature).
- Budget — a run has a hard cap (steps, minutes, model spend). Show it before
  launch, not after.

**3. The live stage — the centrepiece.** For a running agent:
- **The stream**: crisp live view of the sandboxed Atlas window (2K-class
  capture at a throttled live frame rate — think smooth slideshow, ~10–15 fps,
  not 60fps video; the full-quality recording is saved regardless). Design the
  stage so a slightly-choppy live feed still feels premium — the frame is the
  product here.
- **The narration timeline**: every agent action as it happens — "opened Mail",
  "clicked Approve on thread 3", "expected the badge to clear; it did not" —
  with timestamps, synced to the stream. Clicking a timeline entry seeks the
  recording.
- **The findings rail**: problems as structured cards the moment they are
  detected — severity, what happened, the frame it happened on, console/log
  evidence. This fills *during* the run; the founder should never wait for the
  end to know it found something.
- **Multi-agent layout**: with 2–4 agents running, the stage has to show all of
  them without becoming surveillance-wall chaos. One focused + thumbnails, or a
  grid — your call, but switching focus must be instant and the findings rail is
  shared (tagged by agent).
- Controls: pause an agent, stop a run, "take over" is explicitly NOT a feature
  (the sandbox is the agent's; the founder watches).

**4. The run report.** After a run: the replayable recording with the timeline
as chapters, the findings list finalized and de-duplicated, environment details
(sandbox source, model, budget spent), and per-finding the one action that
matters: **"Launch fix agent"** — which packages the finding (evidence, frames,
repro steps) into a coding-agent brief. Design the state of a finding across its
life: detected → briefed → fix in progress → fixed → re-verified (a later run
confirms it). That lifecycle is the loop that makes the Lab a tool rather than
a show.

**5. The sandbox badge.** Anything showing sandboxed Atlas — live or recorded —
must be unmistakably marked as the sandbox, so a recording can never be confused
with a real user's data. Design the marking; it should be elegant, not a
watermark slapped on.

## House rules — not negotiable

| Rule | Detail |
|---|---|
| **Borderless** | Fill and space only; the paper scale; no 1px rings. Drawings exempt. |
| **Orange forbidden** | `#ff6a00` is the voice indicator only. Atlas Blue `#3461f2` + status tokens (`--grn/--red/--amber`) for verdicts and severity. |
| **Tabs** | The button-group `role="tablist"` convention, not the Atlas Core pill rail. |
| **Primitives** | `Panel`, `Row`, `Button`, `Empty`, `Card`, `StatTile`. Sizes `s/m/l/xl`, skins `glass/ink/accent`. |
| **Navigation** | No back links; headline + Esc. |
| **Tabular numerals** | Timers, budgets, frame counters, durations. |
| **Honest states** | A stream that dropped, an agent that stalled, a capture permission not granted — each is a designed state, never a spinner that lies. |
| **Never fabricate** | No sample findings in reachable states; the empty lab is empty. |

## Constraints that are real and should shape the design

- **The live feed is a frame stream, not a video call.** Expect ~10–15 fps live;
  the saved recording is higher quality than the live view. Latency of ~1s is
  normal. Design for that honestly rather than implying zero-lag video.
- **Screen capture needs a one-time macOS permission** (Screen Recording, in
  System Settings — the OS makes the user grant it there). The first-run consent
  moment is part of this design; it should explain before it asks, like the
  existing `/permissions` flow, and the "not granted" state must be first-class.
- **A run can cost real money** (model spend). The budget is visible during the
  run — spent vs cap, unobtrusive but never hidden.
- **Findings are machine-detected and will sometimes be wrong.** A founder can
  dismiss a finding as noise, and dismissal is remembered on re-runs.
- **The fix agent runs outside this window** (a coding session in the repo).
  "Launch fix agent" hands off; design the handoff state, not a fake embedded
  IDE.

## What to be careful about

- This surface will be screen-shared in investor demos. The live stage is the
  single most impressive thing Atlas can show — design it to be watched by
  someone who has never seen Atlas.
- Density: a 15-minute run can produce hundreds of timeline entries and a dozen
  findings. Scanning must beat scrolling.
- The recording player is a real player: scrub, chapter jump, frame-step near a
  finding. Do not design a toy scrubber.
