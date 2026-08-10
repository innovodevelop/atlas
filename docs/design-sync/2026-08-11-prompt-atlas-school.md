# Claude Design prompt — Atlas School

Written for a Claude Design session with the repo attached, already knowing the
Workshop design system. States intent and decisions, not background. Paste
everything below the line.

---

**Design "Atlas School" — a suite of surfaces that makes Atlas the app a student
lives in.**

This is the largest addition Atlas has taken on. None of it exists. It is
entitlement-gated, so it is invisible to users who are not students, and it goes
inert until a school account is connected.

The user is in Denmark; the school systems are **Lectio** (gymnasium),
**LearnIT** (ITU, Moodle) and **itslearning**. Design in English, but assume
Danish content and Danish assignment vocabulary throughout — subject names,
`aflevering`, `SRP`, `Formelsamling`.

## Design the complete feature set

**Everything below is being built to match your design.** Design it fully — do
not hedge, do not mark anything as a future state, do not design around a
current limitation.

**1. School home.** Today at a glance: the day's schedule, what is due, and what
Atlas has already prepared. This is the screen a student opens first every
morning and it should answer "what do I have to do today" in one look.

**2. Schedule.** Week and day views. Lessons, rooms, teachers, changes and
cancellations — Danish schools change the timetable constantly and a cancelled
lesson is the single most-checked piece of information in the whole product.

**3. Assignments — list, then detail. The detail view is the centrepiece of the
whole suite.**

When an assignment arrives, Atlas reads it and lays out a **working view
tailored to what kind of assignment it is.** Not a document viewer — a
workspace. For a maths assignment that means: each individual exercise as its
own unit, with the **Formelsamling** (the official formula book) one click away
from the specific task, alongside the worked examples the teacher actually used
in class.

  **The boundary that defines this product: Atlas prepares the work. It does not
  do the work.** It lays out the tasks, brings the right materials to hand, and
  gets out of the way. The design has to make that feel like a feature and not a
  limitation — a student should look at this screen and feel *ready*, not
  *cheated*. Design what "prepared" looks like.

  Design at least four variants of the working view, because the shape genuinely
  differs: **maths/physics** (numbered tasks + formula reference), **written
  assignment** (essay scaffold + source panel), **lab report** (fixed Danish
  section structure: formål · teori · apparatur · fremgangsmåde · resultater ·
  databehandling · fejlkilder · konklusion), and **a long project** (SRP/SOP —
  multi-week planner, source log, milestones).

**4. Messages.** Teacher threads. Model on the existing Mail surface — it is the
most developed domain in the app and this should feel like a sibling, not a
stranger.

**5. Materials.** What the teacher shared, searchable — slides, notes, PDFs,
links, per course.

**6. Spreadsheet — AI-driven.** A real spreadsheet inside the Atlas design
system. **This is the hardest thing in the brief:** the house rule is that
separation is fill and space only, with no borders — and a spreadsheet is a
grid. You need a deliberate answer to "a cell grid with no cell borders" rather
than an improvised one. If the honest answer is that this one surface earns an
exception, say so explicitly and define its limits.

**7. Writing — AI-driven.** A document editor in the same system. Where does
Atlas's help appear without taking over the page?

**8. Connect flow.** Linking a school account. Three providers, three different
mechanisms, one coherent experience — including pairing a small browser
extension the student installs (see below).

## House rules — these are not negotiable

| Rule | Detail |
|---|---|
| **Borderless** | Fill and space only. Page `#f9f7f4` → panel `#f1eeea` → card `#fffdfa`. No 1px rings, no dividers. Drawings are exempt. See item 6 — this rule and the spreadsheet are in genuine tension and I want your judgement, not a fudge. |
| **Tabs** | The surface convention: a small button group with `role="tablist"`. Not the Atlas Core pill rail. |
| **Orange is forbidden** | `#ff6a00` is the voice indicator only. Atlas Blue `#3461f2` is the accent. |
| **Primitives** | `Panel`, `Row`, `Button`, `Empty`, `Card`. Sizes `s / m / l / xl`; skins `glass / ink / accent`. |
| **Navigation** | No back links. The headline is the control, plus Esc. |
| **Empty states** | Never a dead end. "No assignments" needs a next step. |
| **Never fabricate** | No sample grades, no invented deadlines, no placeholder teacher names in a state a real user can reach. |

## Constraints that are real, and should shape the design

- **The assignment working view is assembled by the model** from a *fixed
  vocabulary of blocks* — task, formula reference, material link, scratchpad,
  rubric, data table, timer, source list. The model chooses which blocks and
  what size; it can never invent a component, a colour or a layout. **So the
  vocabulary you design is the whole vocabulary.** Design each block as a real
  component with defined sizes, and assume they will be recombined in orders you
  did not draw.
- **Lectio has no API.** The schedule comes from a calendar feed; assignments,
  materials and messages arrive via a small browser extension the student
  installs, which pushes pages from their own logged-in session. **Atlas never
  sees a school password.** That is a selling point and the connect flow should
  say so plainly.
- **Some assignments will not parse.** A scanned PDF has no extractable text.
  Design the honest fallback — the student pastes or types the text, and Atlas
  prepares from that. This will happen often enough to be a designed state, not
  an error dialog.
- **Preparation happens when the student opens Atlas**, not silently overnight.
  The "Atlas prepared this for you" moment is a real moment and worth designing.

## What to be careful about

- **This must feel like Atlas, not like a school portal bolted on.** Lectio is
  ugly and students hate it. The whole point is that this is the pleasant place
  to do the same work.
- **Stress and deadlines are the emotional register here.** Restraint around
  anything red or urgent; a wall of overdue badges is a reason to close the app.
- **Density is real.** A gymnasium student has 10+ subjects and several
  assignments a week. Design for a busy week, not an empty one.
- **The student is the author.** Every surface should make it obvious the work
  is theirs.
