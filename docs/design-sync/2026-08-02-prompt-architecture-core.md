# Claude Design prompt — Atlas Architecture + Atlas Core

Paste everything below the line into Claude Design. It is written to be
self-contained: Claude Design has no access to this repo.

Scope note: an "Atlas Control" screen appears as a dock link in older Atlas
prototypes but was never designed or built. It is **out of scope** — do not
design it, and do not include it in the dock.

---

**Redesign two screens for Atlas — a local-first AI assistant that runs as a
native macOS app — so they match the rest of the product.**

Both screens are currently off-design: they were built early, in a dark
Tailwind style, before the warm-light "Workshop" system existed. They look like
a different application.

## Design system — match it exactly

Warm-light "Workshop": soft off-white paper background with ambient colour
wash, generous whitespace, large editorial headlines, one accent colour.

- **Accent: Atlas Blue `#3461f2`.** (If an older Atlas handoff names `#ff6a00`
  orange as the only accent, that is out of date — the product deliberately
  swapped to blue.)
- Reference the existing **Atlas Design System** and **Atlas Dashboard
  (Current)** screens for tokens, type scale, card treatment and elevation.
- Icons are **Lucide only**, at 12 / 14 / 16 / 20 px.

## Structural rules — both screens, non-negotiable

Atlas removed its top bar; the greeting band **is** the header. Both screens
must follow the dashboard's three-part structure:

1. **Band header** — particle sphere on the left, large editorial headline with
   a coloured accent word, serif italic subline, right-aligned metric.
   Back-navigation is the **clickable headline** plus Esc. **No header bar, no
   back arrow, no sticky top strip.**
2. **Content** — card grid, `auto-fill minmax(340px, 1fr)`.
3. **Floating dock pill**, fixed bottom centre. Mandatory on both screens.

Full-page scroll, not a fixed modal overlay. Ambient wash + atmosphere canvas +
grain behind everything.

---

## Screen 1 — Atlas Architecture

**Purpose.** Explain to a curious user how Atlas actually works. The audience is
someone who bought a private AI assistant and wants to understand what it does
with their data — **not** an engineer reading a spec. Explain, don't specify.

**Content to cover:**

- **Where reasoning happens.** Chat goes to Anthropic's Claude; background work
  runs on Amazon Bedrock in the EU. This is the honest, and slightly
  uncomfortable, part: memories and files stay on the Mac, but the prompts
  derived from them do leave it. The design should carry that clearly rather
  than bury it.
- **What stays local.** The SQLite database, semantic search over memories, the
  wake-word detector and the voice-activity detector all run on-device.
- **The learning pipeline** — how conversation becomes memory becomes recall.
- **Memory architecture** — how memories are stored, embedded and retrieved.
- **The particle sphere** — what the visual actually represents.
- **A tech-stack summary.**

**The centrepiece is a system diagram.** Today this is a machine-generated
Mermaid flowchart hard-coded to a dark theme with purple nodes — it cannot
survive on a warm-light page and looks generated, because it is. **Design the
diagram as a first-class piece of visual design** in the Workshop palette: the
flow from voice input through the local core to the reasoning providers and
back. This single element carries the page.

The current page also ends with a "Built with Lovable" footer, which is a
leftover from scaffolding. Design whatever belongs there instead — or nothing.

---

## Screen 2 — Atlas Core

**Purpose.** The operational surface — what Atlas is doing, knows, and is
working on right now.

**Structure:** hero with the particle sphere and four stat tiles, then a tab
bar, then a panel grid.

**The four stat tiles** show Knowledge (item count), Research (active topics),
Error Rate (percentage) and Health (percentage).

**Tabs.** Seven exist today: Search, Overview, Live, Agent, Knowledge,
Research, Learning. An eighth — **Memory** — was specified in an earlier plan
and never built. **Include it.** It is the natural home for browsing what Atlas
remembers, and its absence is a real gap.

The Live tab carries a live-state indicator; the Agent tab carries a count
badge.

### The honesty requirement — read this carefully

This page currently shows **fabricated data**, and we are removing it. The
overview panels contain hard-coded fake content — invented search results
("Transformer scaling laws — 2026 review", "arXiv · indexed 4 min ago · 0.94
relevance"), a fake research queue, a fake error log, a static "3" badge on the
Agent tab, and stat-tile trend lines that always read "+12% from last period"
and "all systems nominal" regardless of reality.

All of it goes. Which means:

- **Every panel needs a designed empty state**, and those states must look
  deliberate rather than broken. A new user will see mostly empty panels on
  day one, and that should feel like a system at rest — not a failure.
- **Stat tiles need a no-trend state.** If there is no comparison period, the
  tile shows the number without a fabricated trend arrow.
- Design panels that read well with **one** item, not just with eight.

Treat "nothing here yet" as a first-class design problem for this screen. It is
the state most users will actually see.

---

## Deliverables

1. Both screens at desktop width, in the Workshop design system
2. The Atlas Architecture **system diagram** as designed artwork
3. A **reusable stat tile** (with and without trend) and a **reusable panel**
   component — these two screens currently each define their own, and we want
   one shared set
4. The tab bar, including live-indicator and badge treatments
5. **Every empty state**: each panel type, each stat tile, and the first-run
   "Atlas hasn't learned anything yet" case
