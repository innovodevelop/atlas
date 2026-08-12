# Adding a surface

A "surface" is one screen in Atlas — a route, a page module, a registry
entry. `src/surfaces.ts` is the one table everything else (the router, the
dock, the account menu) is generated from, and two pinned test files —
`src/surfaces.test.ts` and `src/editionSplit.test.ts` — fail loudly if a
page and the registry ever disagree. Adding a surface by hand means editing
four files in lockstep; this scaffolder does that mechanical part.

## The one command

```bash
bun scripts/new-surface.ts <Name> --label "..." --icon <LucideName> \
  [--entry dock|menu|none] [--edition consumer|admin] [--feature <entitlement>]
```

Example:

```bash
bun scripts/new-surface.ts Journal --label "Journal" --icon BookOpen
```

`<Name>` is PascalCase and becomes the component name (`Atlas<Name>`) and,
kebab-cased, the route (`/journal`). `--icon` must be a real `lucide-react`
export (PascalCase, e.g. `BookOpen` — not `book-open`); the script checks
this against the actual package before writing anything. `--entry` defaults
to `menu`, `--edition` to `consumer`.

## What it touches

- **Creates** `src/pages/atlas/Atlas<Name>.tsx` — the house chrome: the
  `surface` export literal the registry test parses, a band header whose
  headline is the back control, Esc-to-return via `isTyping`
  (`atlasHelpers.ts`), and an `<Empty>` state so the page is never a dead
  end while it has no real data behind it.
- **Creates** `src/styles/surfaces/<name>.css` — a banner-commented
  placeholder stylesheet scoped to the page's own two classes.
- **Edits in place** `src/surfaces.ts` — inserts the `SURFACES` entry at the
  end of the right edition's section, and the loader line at the end of
  `CONSUMER_LOADERS`/`ADMIN_LOADERS`, in the exact one-line shape
  `src/surfaces.test.ts` regex-parses.
- **Edits in place** `src/components/atlas-ui/surfaceIcons.ts` — adds the
  icon to both the `lucide-react` import list and the `SURFACE_ICONS` map,
  alphabetised, so `editionSplit.test.ts`'s "no missing, no spare" icon
  check passes.
- **Edits in place** `src/surfaces.test.ts` — bumps the two hardcoded counts
  in "the count is the count" by 1.

It is **idempotent**: every insertion checks whether the path/icon is
already present and no-ops if so. It **refuses cleanly**, before writing
anything, if the page file already exists, or if `--icon` doesn't resolve.

**Routing, the dock and the account menu need no further edit.** Per
`src/App.tsx`'s own comment, all three are generated from the registry
entry's `entry: 'dock' | 'menu' | 'none'` — a page with `entry: 'menu'`
appears in the account menu the moment the registry says so.

## What this does NOT do for you

The pinned tests are the enforcement, not the friction — this script removes
the friction, and only the friction:

1. **The real design and the data hook.** The generated page is an honest
   placeholder: a band header, an `<Empty>` state that says exactly that
   ("has no data hook wired in yet"), and nothing else. Swap it for the real
   layout and wire a `use<Thing>()` hook the way every other surface does —
   see `src/pages/atlas/AtlasHealth.tsx` or `AtlasSmartHome.tsx` for two
   different shapes of "real hook behind the chrome."
2. **`src/surfaces.test.ts`'s "the classification is the agreed one"
   test.** That test pins the exact consumer/admin path lists by hand, on
   purpose — which edition a surface belongs to is an editorial call (see
   the file's own comment on `/money` and `/browser`: admin *because* they
   have no backend), not something a generator should decide silently. The
   scaffolder deliberately leaves this list alone. After running it for a
   surface that is staying (not a scratch/throwaway run), add the new path
   to the matching array in that test by hand, then run:

   ```bash
   bun test src/surfaces.test.ts src/editionSplit.test.ts
   ```

   Until you do, that one test fails — correctly, the same way it would if
   you'd hand-added the registry entry and forgotten this list.
3. **`bun run new:op`** (the control-port checklist scaffolder) does not
   exist yet — this script only covers R9's screen half of the plan.

## The mechanics, if you're touching the script itself

`scripts/new-surface.ts` keeps every insertion as a pure `string → string`
function (`insertSurfaceEntry`, `insertLoaderLine`, `insertIconEntry`,
`bumpSurfaceCounts`) — no disk access inside them — precisely so
`scripts/newSurface.test.ts` can exercise the real insertion logic against
in-memory fixtures without ever writing into the repo. `main()` is the only
part that touches `fs`, and it's a thin sequence of read → pure-transform →
write, gated by `ensureNewSurface()` (also pure) running first.
