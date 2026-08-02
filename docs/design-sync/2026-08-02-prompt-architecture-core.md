# Claude Design prompt — Atlas Architecture + Atlas Core

Written for a Claude Design session that has the repo attached and already knows
the Workshop design system. It states intent and decisions, not background.
Paste everything below the line.

---

**Redesign two screens so they stop looking like a different application:
Atlas Architecture and Atlas Core.**

You have the codebase. Conform both to the dashboard structure in
`src/pages/atlas/AtlasDashboard.tsx` — band header instead of a top bar,
back-navigation via the clickable headline plus Esc, the mandatory dock,
`.page` rather than a fixed overlay.

Two corrections to what you may be working from:

- The accent is **Atlas Blue `#3461f2`**, not the `#ff6a00` the handoff README
  still names.
- **"Atlas Control" is out of scope.** It exists only as a dock link in old
  prototypes and was never designed or built. Don't design it, don't put it in
  the dock.

---

## Screen 1 — Atlas Architecture

`src/pages/AtlasArchitecture.tsx` plus ~1,230 lines under
`src/components/architecture/`. Currently a dark Tailwind marketing page with a
sticky header and a "Built with Lovable" footer.

**The centrepiece is the system diagram.** Today it's machine-generated Mermaid
hard-coded to a dark theme with purple nodes — it cannot survive on a
warm-light page and looks generated because it is. **Design it as artwork:**
voice in, through the local core, out to the reasoning providers, and back.

Audience is a curious owner of a private AI assistant, not an engineer.
Explain, don't specify. Content: where reasoning happens (chat → Anthropic;
background → Bedrock EU), what stays on device (SQLite, semantic recall, wake
word, VAD), the learning pipeline, memory architecture, the sphere, and a stack
summary.

Say the uncomfortable part plainly rather than burying it: **memories and files
stay on the Mac, but the prompts derived from them leave it.** That honesty is
the page's reason to exist.

---

## Screen 2 — Atlas Core

`src/pages/atlas/AtlasCoreScreen.tsx`. Already on `workshop.css`, so this is a
restructure: drop `.corehead`, switch `.overlay` → `.page`, add the dock.

**Eight tabs.** Seven exist; **Memory** was specified in an earlier plan and
never built — include it. Design each with a populated state and an empty state:

- **Search** — semantic search across everything, with provenance (which
  memory or document, and how relevant)
- **Overview** — system state at a glance
- **Live** — what Atlas is doing right now, as it happens
- **Agent** — autonomous work in flight: queued, running, done, failed;
  inspectable and cancellable
- **Knowledge** — the knowledge base, browsable and filterable
- **Research** — self-directed research topics; add, prioritise, stop
- **Memory** — everything remembered about the user, by category, with removal
  and correction *(new)*
- **Learning** — what it's learning, on what schedule, and a master switch

**The honesty requirement.** This page currently ships fabricated data:
invented search results ("Transformer scaling laws — 2026 review", "arXiv ·
indexed 4 min ago · 0.94 relevance"), a fake research queue and error log, a
static `3` on the Agent badge, and stat trends permanently reading "+12% from
last period" and "all systems nominal" whatever the real numbers are. All of it
is being removed and wired to real data.

So **empty states are the central design problem here**, not an afterthought —
a new user sees mostly empty panels on day one, and that should read as a system
at rest rather than a broken one. Stat tiles need a no-trend variant for when
there's no comparison period. Panels must read well with one item, not only
with eight.

Design both ends: at rest, and fully loaded.

---

## Deliverables

Both screens; all eight Core tabs populated **and** empty; the Architecture
system diagram as artwork; a shared stat tile (with and without trend) and a
shared panel component — the two screens each define their own today and this is
the moment to unify them; the tab bar with live-indicator and badge treatments;
every empty state including first-run.
