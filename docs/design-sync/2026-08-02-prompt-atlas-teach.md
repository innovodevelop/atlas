# Claude Design prompt — Atlas Teach

Paste everything below the line into Claude Design. It is written to be
self-contained: Claude Design has no access to this repo.

---

**Design a screen called "Atlas Teach" for Atlas — a local-first AI assistant
that runs as a native macOS app.**

## Why this screen exists

Atlas remembers things about its user. Today that happens invisibly and by
accident: memories are only written when the model spontaneously decides,
mid-conversation, that something is worth storing. The consequences:

- The user cannot see what is being learned as it happens.
- The user cannot deliberately state a fact and have it stored — there is no
  way to say "remember this" and be sure it landed.
- The user has no idea what is even *worth* teaching, so most people teach
  nothing and the assistant stays generic.

This screen makes teaching **deliberate, legible and reversible**. It is the
difference between an assistant that quietly forms opinions about you and one
you can actually train.

## Design system — match it exactly

Atlas uses a warm-light "Workshop" design system: a soft off-white paper
background with ambient colour wash, generous whitespace, large editorial
headlines, and one accent colour.

- **Accent: Atlas Blue `#3461f2`.** (If you are working from an older Atlas
  handoff that names `#ff6a00` orange as the only accent, that is out of date —
  the product deliberately swapped to blue. Blue wins.)
- Reference the existing **Atlas Design System** and **Atlas Dashboard
  (Current)** screens for tokens, type scale, card treatment and elevation.
- Icons are **Lucide only**, at 12 / 14 / 16 / 20 px. Never larger, never a
  different set.

## Layout — conform to the dashboard. There is no top bar.

Atlas removed its top bar. The greeting band **is** the header. Every screen
follows the same three-part structure, and this one must too:

1. **Band header** — the particle sphere on the left, a large editorial
   headline with a coloured accent word, a serif italic subline beneath it, and
   a right-aligned metric. Back-navigation is the **headline itself** (it is
   clickable) plus Esc — never a back arrow in a header bar.
2. **Content** — a card grid, `auto-fill minmax(340px, 1fr)`.
3. **Floating dock pill**, fixed at the bottom centre. It is mandatory on every
   screen and holds the primary navigation.

Behind all of it: an ambient colour wash, a subtle animated atmosphere canvas,
and a fine grain overlay. Full-page scroll — not a fixed modal overlay.

## What to design

### 1. The explaining card — this is the centrepiece

A designed card that teaches the user **how to teach**. Treat it as real
instruction, not a tooltip or an empty-state hint. This is the thing someone
reads once and remembers. It must answer three questions:

- **What is worth teaching?** Durable facts about the person — not passing
  moods. See the category list below.
- **How do I say it so it lands?** Specific, complete statements. Show a good
  example against a weak one, e.g. *"I work at Innovo as a founder, mostly on
  product"* versus *"work is busy"*. The first is storable; the second is not.
- **What happens to it?** Atlas confirms what it stored, stores it on this Mac,
  and anything stored can be removed later.

Design it so it can be collapsed once the user has read it, and re-opened.

### 2. Live capture feed

As the user talks, memories being written appear in real time, each with its
category. This should feel like **watching Atlas understand** — not like
tailing a log. Consider how a newly-captured item announces itself and then
settles into the list. Needs an empty state for "nothing learned yet".

### 3. Deliberate add — a capability that does not exist yet

A way to state a fact directly and have it stored verbatim, without hoping the
model volunteers it. This is the single biggest gap in the product, so design
it as **first-class**, not as a fallback for when voice fails. The user should
be able to pick a category, or let Atlas choose.

### 4. What Atlas knows

A reviewable panel of everything stored, grouped by category, each item
individually removable. Needs an honest empty state and a way to handle "there
are 400 of these" gracefully.

**The real categories** (use exactly these — they are what the system stores):

`identity` · `personality` · `values` · `beliefs` · `feelings` · `fears` ·
`dreams` · `joys` · `relationships` · `social` · `work` · `health` · `habits` ·
`preferences` · `memories` · `events` · `achievements`

They are not equal in weight. `identity`, `work`, `relationships` and
`preferences` carry most of the value; `fears`, `dreams` and `beliefs` are
sensitive and should feel like the user chose to share them. Let the design
reflect that difference rather than presenting seventeen identical chips.

## Voice-first, but never voice-only

Speaking is the primary mode. Design the states around the particle sphere:

- **Idle / ready** — Atlas is listening but nothing is happening
- **Hearing** — live transcript appearing as the user speaks
- **Thinking** — the turn is being processed
- **Responding** — Atlas is speaking back
- **Captured** — the moment a memory is written (this should be satisfying)

Typing must remain fully available and equal in status. Some people will never
talk to their computer, and some will be in an office.

## Be honest about what exists — this matters

Two things do **not** exist, and the design must not imply they do:

- **There is no "that's wrong, correct it" mechanism.** A user cannot amend a
  memory or tell Atlas it misunderstood. They can only remove it and state the
  fact again.
- **There is no document, file or email ingestion.** You cannot teach Atlas by
  giving it a PDF.

If you believe either is essential to the experience, design it as an
explicitly-labelled **future state** in a separate frame, so it can be scoped
as real work rather than shipped as a lie.

One thing that **does** exist and lives elsewhere: Atlas has five personality
dials — warmth, playfulness, formality, verbosity, directness — which drift
from conversation and can be overridden by the user. These already have a home
in Settings. The Teach screen may *reference* or summarise them, but must not
duplicate the controls.

## Deliverables

1. The full screen at desktop width, in the Workshop design system
2. The explaining card as a **reusable component**, with collapsed and expanded
   states
3. The live-capture animation — how a memory arrives and settles
4. The deliberate-add flow, including category selection
5. Every empty state (no memories, nothing captured yet, no microphone)
6. The five voice states around the sphere
