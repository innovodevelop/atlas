# Claude Design prompt — Atlas Teach

Written for a Claude Design session that has the repo attached and already
knows the Workshop design system. It states intent and decisions, not
background. Paste everything below the line.

---

**Design "Atlas Teach" — the screen where a user deliberately trains Atlas.**

You have the codebase. `src/pages/AtlasTeach.tsx` is the existing attempt:
858 lines, routed at `/atlas-teach`, linked from nowhere, and built in Tailwind
before the Workshop system existed. Treat it as a source of intent, not a
starting point. Conform to the dashboard's structure — band header instead of a
top bar, mandatory dock, `.page` rather than a fixed overlay.

One correction to the handoff you may be working from: the accent is **Atlas
Blue `#3461f2`**, not the `#ff6a00` the README still names. The implementation
swapped deliberately.

## The problem

Memories are only written when the model spontaneously decides, mid-conversation,
that something is worth storing (`memory_store` in
`supabase/functions/_shared/orchestrator.ts`). So:

- the user can't see what's being learned
- the user can't state a fact and be sure it landed
- the user has no idea what's worth teaching, so most people teach nothing

This screen makes teaching deliberate, legible and reversible.

## Design the complete feature set

Several of these do not exist yet. **They are being built to match your design** —
so design them fully. Do not hedge, do not mark anything as a future state, do
not design around a current limitation.

**1. The explaining card — the centrepiece.** Real instruction, not a tooltip.
Answers: what is worth teaching, how to phrase it so it lands, and what happens
to it afterwards. Show a storable statement against a weak one ("I work at
Innovo as a founder, mostly on product" vs "work is busy"). Collapsible once
read.

**2. Live capture feed.** Memories appearing as the user talks, with category.
Should feel like watching Atlas understand, not like tailing a log.

**3. Deliberate add.** State a fact, have it stored verbatim, with a category
the user can set or let Atlas choose. *(New — the single biggest gap.)*

**4. What Atlas knows.** Everything stored, grouped by category, individually
removable, and usable when there are 400 of them. The real categories are the
enum in `orchestrator.ts` — `identity`, `work`, `relationships`, `preferences`
carry most of the weight; `fears`, `dreams`, `beliefs` are sensitive and should
feel volunteered rather than harvested. Don't render seventeen identical chips.

**5. Correction.** "That's not right", "it's Innovo, not Innovo Studio", "I
stopped doing that last year" — by voice and by pointer. Include how the
corrected version is supplied, how Atlas confirms, and what happens to the
superseded value (replaced silently, or kept as visible history). *(New.
Without it, an assistant accumulates confident errors about its user.)*

**6. Teaching from material.** Hand Atlas a CV, a brief, notes, a PDF. Design
the add, the **review step showing what Atlas proposes to remember before it
commits**, per-item accept/reject/edit, and progress for a long document. The
review step is the point — bulk import without confirmation is how an assistant
ends up believing forty things nobody said. *(New.)*

**7. Personality.** The five dials in `personality.ts` — warmth, playfulness,
formality, verbosity, directness. They drift from conversation and the user's
explicit setting wins. Show current value *and* whether it was learned or set.
Teaching Atlas what you're like and how to talk to you belong together. These
also appear in Settings; this screen is the primary home and they share state.

## Voice

Speaking is primary: design idle, hearing (live transcript), thinking,
responding, and captured — the last one should be satisfying. Typing stays
fully available and equal in status.

## Deliverables

Full screen; the explaining card as a reusable component (collapsed/expanded);
the live-capture animation; deliberate-add; the correction flow; document
ingestion with its review step; the personality dials; every empty state; the
five voice states.
