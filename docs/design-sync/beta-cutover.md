# Beta cutover: the runbook

This is the day `beta_ui` turns on for everyone and the Workshop screens the
Beta replaced are deleted. Phase 8 prepares that day (package P8d); it does
not carry it out. DEFAULT_ON stays `false`, no screen is deleted and
`src/App.tsx` is unchanged until the user has chosen a dock and reviewed the
Beta in the Mac app.

Three files keep this document honest:

- `src/betaCutover.test.ts` is the guard. It reads `src/surfaces.ts` and
  `src/App.tsx` as text. Every surface must be a Beta page itself, have a Beta
  override (`BETA_CONSUMER`, `BETA_ADMIN` or the `"/"` ternary), or be on the
  commented allow-list `KEEP_WORKSHOP` in `src/lib/betaCutover.ts`. It passes
  today. It fails when a new surface lands without a Beta page. This was
  checked by registering a temporary `/journal` surface backed by a Workshop
  page: the guard failed with `/journal (./pages/atlas/AtlasJournal)`, and the
  edit was then reverted. It also fails when an allow-list entry goes stale
  because its screen got a Beta page.
- `scripts/beta-cutover-inventory.ts` walks the import graph from
  `src/main.tsx` with the TypeScript parser. Comments are not edges, and
  type-only imports still count, because deleting their target breaks `tsc`.
  It walks the graph twice: as it is today, and after the cutover with the
  flag on for good, the replaced pages deleted and any panel a Beta page still
  imports from one of them moved out first. The difference between the two is
  the deletion list.
- `src/lib/betaCutover.ts` holds the model both of them use. It is pure and
  is tested on small fixtures in `src/lib/betaCutover.test.ts`.

Re-run the script after every merge that touches a page. The copy below is
only as current as the commit it names.

## The steps, in order

1. **The dock is chosen.** P8c puts each exploration from
   `Atlas Dock Explorations` in the app as a style of `BetaDock`. The user picks
   one there. Make it the default and delete the styles that lost.
2. **Mac review.** Merge every `beta-wip/` branch, run `cargo check`, build
   the app (`bun run tauri build --no-sign`) and go through every screen with
   `?beta=1`, including at phone width. Fix what the review finds before going
   on. Then run `bun scripts/beta-cutover-inventory.ts` again on that tree and
   replace the inventory below. The feature packages add modules and imports.
3. **DEFAULT_ON.** Set `DEFAULT_ON = true` in `src/lib/betaFlag.ts` and ship
   one release like that. `?beta=0` and Settings → Interface still reach the
   Workshop as a way back. Note that `localStorage["atlas:beta_ui"] = "0"`
   wins over the default. Anyone who switched back once stays on the Workshop
   until step 4 removes the flag (see Risks).
4. **Remove the flag checks.** Work through every site under "Flag checks to
   remove" in the inventory. Keep the Beta side of each check and drop the
   Workshop side:
   - `src/App.tsx`: point each registry loader in `src/surfaces.ts` at its
     Beta page, delete `BETA_CONSUMER` / `BETA_ADMIN` and the `isBetaUi()`
     spread, and make `"/"` and `/permissions` use `BetaHome` /
     `BetaPermissions` statically. Both are `eager` surfaces. The admin Beta
     pages go into `ADMIN_LOADERS`, inside its edition ternary, and never
     into a static import.
   - `src/AppRoutes.tsx`: always render `<BetaShell>`.
   - Hero pages (`AtlasCoreScreen`, `AtlasTeach`, `AtlasArchitecture`), plus
     `BetaAnswer`, `BetaClock` and `BetaSchool`: keep the Beta branch.
   - `BetaSettings`: remove the "back to Workshop" control (`setBetaUi`).
   - Delete `src/lib/betaFlag.ts` once nothing imports it.
   - Move the `export const surface` blocks from the replaced Workshop pages
     to their Beta pages. `src/surfaces.test.ts` requires each loader's module
     to register its own path (see Risks for the pages that serve several
     paths).
5. **Delete the listed modules.** First resolve every blocker: move the
   panels and the `AtlasExpandedKey` type out of the pages that go. Then
   delete everything under "Only the old UI uses it". Keep every module under
   "Shared". Update the tests listed under "Tests that import a module the
   cutover deletes". In `src/betaCutover.test.ts`, drop the assertions that
   only make sense while overrides exist (both override maps found, `"/"`
   ternary, the inventory block). The coverage check itself stays, since
   every loader is now a Beta page.
6. **Drop the Workshop CSS.** `src/styles/workshop.css` is loaded by
   `main.tsx` for every screen, so the graph cannot drop it. The inventory
   counts its classes that modules that stay still name. Move what the Beta
   still needs (see Risks) into `src/styles/beta.css` or a scoped
   `src/styles/beta/*.css`, then remove the import and the file. Do the same
   for the per-surface sheets under "Shared → Styles".
7. **Gates.** Run every one, with nothing skipped:
   ```bash
   bunx tsc -p tsconfig.app.json --noEmit
   bun run typecheck:strict
   bunx eslint <every changed file>
   bun test tests/ ./src ./scripts supabase/functions/_shared
   bun test services/
   bun test src/editionSplit.test.ts      # two real Vite builds
   bun run build
   ```
   Then on the Mac: `cargo check`, build the app, and check the screens
   again.

## Risks found

- **Beta pages import from Workshop pages that go.** None of these imports a
  page whole, so none blocks the deletion, but each must move first:
  - `BetaHealth.tsx:24` imports `ForgetPanel`, `ImportPanel` and `SourcesView`
    from `AtlasHealth.tsx`. These bring `atlas-ui/primitives` and `useHealth`
    with them.
  - `BetaSmartHome.tsx:40` imports `LinkForm` and `OutageNotice` from
    `AtlasSmartHome.tsx`. These bring `atlas-ui/primitives`.
  - `AtlasExpandedKey` is a type, but four modules that stay import it from
    `AtlasDashboard.tsx`: `BetaHome.tsx:30`, `home/views/FullView.tsx:13`,
    `atlas-ui/AtlasExpanded.tsx:18` and `pages/atlas/useBandNarration.ts:10`.
    The bundle would not notice its removal, but `tsc` would. Move the type
    next to `AtlasExpanded`.
- **The Beta still renders Workshop components.** The Home widget screens
  (`home/views/MusicView`, `EmailView`, `StocksView`) render
  `atlas-ui/AtlasExpanded`. That module names about 95 `workshop.css`
  classes. `BetaDock` uses `atlas-ui/primitives`, and `BetaMail`, `BetaHealth`
  and `BetaMoney` import `styles/mail.css`, `surfaces/health.css` and
  `surfaces/banking.css`. Dropping `workshop.css` whole would unstyle those
  screens. Step 6 is a move, not a delete. The inventory's count (240 of 441
  classes still named) is an upper bound, because short class names such as
  `on` or `card` match ordinary words.
- **Multi-path Beta pages and `surfaces.test.ts`.** `BetaWidgetCatalog`
  serves `/widgets` and `/widget-sheet`, and `BetaDevTools` serves `/tests`,
  `/versions` and `/design-sync`. The registry test expects one
  `export const surface` per page and one page per path. Step 4 needs either
  a thin `Beta<Name>.tsx` per path that renders the shared page on its tab, or
  a deliberate change to that test.
- **`src/editionSplit.test.ts` imports `visibleSettingsTabs` from
  `AtlasSettings.tsx`, which goes.** `src/lib/betaSettings.ts` already mirrors
  it. Point the test there before deleting.
- **`/permissions` is wired twice.** `App.tsx` imports `AtlasPermissions`
  statically for `ROUTE_OVERRIDES` and lets `BETA_CONSUMER` override it while
  the flag is on. Step 4 must leave a static `BetaPermissions` in place,
  because a cold start may not depend on a chunk fetch.
- **Stored opt-out.** After step 3, a stored `atlas:beta_ui = "0"` still beats
  `DEFAULT_ON`. If the release is meant to move everyone, step 4 must follow
  promptly, or the key must be cleared once.
- **Kept Workshop screens.** `/atlas-core`, `/atlas-teach` and
  `/atlas-architecture` keep their page module under a Beta hero. P8a restyles
  their bodies, and whatever those bodies import stays. Two surfaces have no
  Beta design: `/homekit-lab`, a Lighthouse-only dev tool the handoff keeps
  as is, and `/atlas-sphere`, the DEV-only gallery of the Workshop sphere
  engine. `/answer-views` is the Workshop gallery that `/answer`
  (`BetaAnswer`) superseded. Whether it is deleted at the cutover or kept as
  an admin gallery is the user's call. `BetaAnswer` sends the flag-off UI
  there today.
- **The inventory is static.** It cannot see a module loaded through a
  computed `import()` (the app has none) or a class name built at runtime.
  Config files (`tailwind.config.ts`, `vite.config.ts`) are not on the graph,
  so check them before removing an npm package. Today no package is used only
  by the old UI.

## Inventory

The output of `bun scripts/beta-cutover-inventory.ts`, copied unedited. It was
run on the tree of the P8d commit. The commit it names is that commit's
parent: the run happened before committing, and the commit changes only the
cutover tooling, not the app's graph.

Generated by `bun scripts/beta-cutover-inventory.ts` at `82ab1b4`.

From `src/main.tsx`: **366** modules reachable today, **293** after the cutover, **73** to delete.

### Coverage: every surface and its Beta page

| Path | Verdict | Workshop page | Beta page, or why it stays |
|---|---|---|---|
| `/` | override (flag ternary) | `./pages/atlas/AtlasDashboard` | `./pages/atlas/BetaHome` |
| `/atlas-core` | keeps Workshop | `./pages/atlas/AtlasCoreScreen` | Beta hero: Core hero (ink orbit lab) over the Workshop body |
| `/mail` | override (BETA_CONSUMER) | `./pages/atlas/AtlasMail` | `./pages/atlas/BetaMail` |
| `/home` | override (BETA_CONSUMER) | `./pages/atlas/AtlasHome` | `./pages/atlas/BetaVoice` |
| `/answer` | Beta page | — | `./pages/atlas/BetaAnswer` |
| `/clock` | Beta page | — | `./pages/atlas/BetaClock` |
| `/school` | Beta page | — | `./pages/atlas/BetaSchool` |
| `/atlas-teach` | keeps Workshop | `./pages/AtlasTeach` | Beta hero: Teach hero (the sphere as microphone) over the Workshop body |
| `/smart-home` | override (BETA_CONSUMER) | `./pages/atlas/AtlasSmartHome` | `./pages/atlas/BetaSmartHome` |
| `/health` | override (BETA_CONSUMER) | `./pages/atlas/AtlasHealth` | `./pages/atlas/BetaHealth` |
| `/music` | Beta page | — | `./pages/atlas/BetaMusic` |
| `/onboarding` | override (BETA_CONSUMER) | `./pages/atlas/AtlasOnboarding` | `./pages/atlas/BetaOnboarding` |
| `/settings` | override (BETA_CONSUMER) | `./pages/atlas/AtlasSettingsRoute` | `./pages/atlas/BetaSettings` |
| `/auth` | override (BETA_CONSUMER) | `./pages/Auth` | `./pages/BetaAuth` |
| `/permissions` | override (BETA_CONSUMER) | `./pages/AtlasPermissions` | `./pages/BetaPermissions` |
| `/money` | override (BETA_ADMIN) | `./pages/atlas/AtlasBanking` | `./pages/atlas/BetaMoney` |
| `/browser` | override (BETA_ADMIN) | `./pages/atlas/AtlasBrowser` | `./pages/atlas/BetaBrowser` |
| `/widgets` | override (BETA_ADMIN) | `./pages/atlas/AtlasWidgetCatalog` | `./pages/atlas/BetaWidgetCatalog` |
| `/widget-sheet` | override (BETA_ADMIN) | `./pages/atlas/AtlasWidgetSheet` | `./pages/atlas/BetaWidgetCatalog` |
| `/answer-views` | keeps Workshop | `./pages/atlas/AtlasAnswerViews` | superseded by `/answer`: the Answer design shipped as /answer (BetaAnswer) |
| `/model-lab` | override (BETA_ADMIN) | `./pages/atlas/AtlasModelLab` | `./pages/atlas/BetaModelLab` |
| `/versions` | override (BETA_ADMIN) | `./pages/atlas/AtlasVersions` | `./pages/atlas/BetaDevTools` |
| `/agent-view` | override (BETA_ADMIN) | `./pages/atlas/AtlasAgentView` | `./pages/atlas/BetaAgentView` |
| `/design-sync` | override (BETA_ADMIN) | `./pages/atlas/AtlasDesignSync` | `./pages/atlas/BetaDevTools` |
| `/tests` | override (BETA_ADMIN) | `./pages/atlas/AtlasTests` | `./pages/atlas/BetaDevTools` |
| `/system-status` | override (BETA_ADMIN) | `./pages/atlas/AtlasSystemStatus` | `./pages/atlas/BetaSystemStatus` |
| `/atlas-architecture` | keeps Workshop | `./pages/AtlasArchitecture` | Beta hero: Architecture hero (isometric layer stack) over the Workshop body |
| `/homekit-lab` | keeps Workshop | `./pages/atlas/AtlasHomeKitLab` | no Beta design: a Lighthouse-only dev tool; the handoff keeps it as is |
| `/atlas-sphere` | keeps Workshop | `./pages/AtlasSphereGallery` | no Beta design: the DEV-only gallery of the Workshop sphere engine |

### Workshop pages the cutover deletes

| Workshop page | Path(s) | Replaced by |
|---|---|---|
| `src/pages/atlas/AtlasAgentView.tsx` | `/agent-view` | `src/pages/atlas/BetaAgentView.tsx` |
| `src/pages/atlas/AtlasBanking.tsx` | `/money` | `src/pages/atlas/BetaMoney.tsx` |
| `src/pages/atlas/AtlasBrowser.tsx` | `/browser` | `src/pages/atlas/BetaBrowser.tsx` |
| `src/pages/atlas/AtlasDashboard.tsx` | `/` | `src/pages/atlas/BetaHome.tsx` |
| `src/pages/atlas/AtlasDesignSync.tsx` | `/design-sync` | `src/pages/atlas/BetaDevTools.tsx` |
| `src/pages/atlas/AtlasHealth.tsx` | `/health` | `src/pages/atlas/BetaHealth.tsx` |
| `src/pages/atlas/AtlasHome.tsx` | `/home` | `src/pages/atlas/BetaVoice.tsx` |
| `src/pages/atlas/AtlasMail.tsx` | `/mail` | `src/pages/atlas/BetaMail.tsx` |
| `src/pages/atlas/AtlasModelLab.tsx` | `/model-lab` | `src/pages/atlas/BetaModelLab.tsx` |
| `src/pages/atlas/AtlasOnboarding.tsx` | `/onboarding` | `src/pages/atlas/BetaOnboarding.tsx` |
| `src/pages/atlas/AtlasSettingsRoute.tsx` | `/settings` | `src/pages/atlas/BetaSettings.tsx` |
| `src/pages/atlas/AtlasSmartHome.tsx` | `/smart-home` | `src/pages/atlas/BetaSmartHome.tsx` |
| `src/pages/atlas/AtlasSystemStatus.tsx` | `/system-status` | `src/pages/atlas/BetaSystemStatus.tsx` |
| `src/pages/atlas/AtlasTests.tsx` | `/tests` | `src/pages/atlas/BetaDevTools.tsx` |
| `src/pages/atlas/AtlasVersions.tsx` | `/versions` | `src/pages/atlas/BetaDevTools.tsx` |
| `src/pages/atlas/AtlasWidgetCatalog.tsx` | `/widgets` | `src/pages/atlas/BetaWidgetCatalog.tsx` |
| `src/pages/atlas/AtlasWidgetSheet.tsx` | `/widget-sheet` | `src/pages/atlas/BetaWidgetCatalog.tsx` |
| `src/pages/AtlasPermissions.tsx` | `/permissions` | `src/pages/BetaPermissions.tsx` |
| `src/pages/Auth.tsx` | `/auth` | `src/pages/BetaAuth.tsx` |

### Workshop pages that stay

| Page | Path | Why |
|---|---|---|
| `src/pages/atlas/AtlasCoreScreen.tsx` | `/atlas-core` | Beta hero: Core hero (ink orbit lab) over the Workshop body |
| `src/pages/AtlasTeach.tsx` | `/atlas-teach` | Beta hero: Teach hero (the sphere as microphone) over the Workshop body |
| `src/pages/atlas/AtlasAnswerViews.tsx` | `/answer-views` | superseded by `/answer`: the Answer design shipped as /answer (BetaAnswer) |
| `src/pages/AtlasArchitecture.tsx` | `/atlas-architecture` | Beta hero: Architecture hero (isometric layer stack) over the Workshop body |
| `src/pages/atlas/AtlasHomeKitLab.tsx` | `/homekit-lab` | no Beta design: a Lighthouse-only dev tool; the handoff keeps it as is |
| `src/pages/AtlasSphereGallery.tsx` | `/atlas-sphere` | no Beta design: the DEV-only gallery of the Workshop sphere engine |

### Blockers: code that stays and imports a page that goes

- `src/components/atlas-ui/AtlasExpanded.tsx:18` imports `AtlasExpandedKey` (type only) from `src/pages/atlas/AtlasDashboard.tsx`; they need no other module
- `src/components/atlas/home/views/FullView.tsx:13` imports `AtlasExpandedKey` (type only) from `src/pages/atlas/AtlasDashboard.tsx`; they need no other module
- `src/pages/atlas/BetaHome.tsx:30` imports `AtlasExpandedKey` (type only) from `src/pages/atlas/AtlasDashboard.tsx`; they need no other module
- `src/pages/atlas/BetaSmartHome.tsx:40` imports `LinkForm`, `OutageNotice` from `src/pages/atlas/AtlasSmartHome.tsx`; they bring `src/components/atlas-ui/primitives/index.ts`
- `src/pages/atlas/BetaHealth.tsx:24` imports `ForgetPanel`, `ImportPanel`, `SourcesView` from `src/pages/atlas/AtlasHealth.tsx`; they bring `src/components/atlas-ui/primitives/index.ts`, `src/hooks/useHealth.ts`
- `src/pages/atlas/useBandNarration.ts:10` imports `AtlasExpandedKey` (type only) from `src/pages/atlas/AtlasDashboard.tsx`; they need no other module

### Only the old UI uses it: delete (73)

"replaced page" is a Workshop page a Beta page took over; "old UI only" is imported only by modules that go; "flag branch" is imported only from the flag-off side of a check in a module that stays, so it goes with that check.

**Styles (11)**

- `src/styles/surfaces/agentView.css` — old UI only (from `src/pages/atlas/AtlasAgentView.tsx`)
- `src/styles/surfaces/browser.css` — old UI only (from `src/pages/atlas/AtlasBrowser.tsx`)
- `src/styles/surfaces/designSync.css` — old UI only (from `src/pages/atlas/AtlasDesignSync.tsx`)
- `src/styles/surfaces/modelLab.css` — old UI only (from `src/pages/atlas/AtlasModelLab.tsx`)
- `src/styles/surfaces/onboarding.css` — old UI only (from `src/pages/atlas/AtlasOnboarding.tsx`)
- `src/styles/surfaces/smartHome.css` — old UI only (from `src/pages/atlas/AtlasSmartHome.tsx`)
- `src/styles/surfaces/systemStatus.css` — old UI only (from `src/pages/atlas/AtlasSystemStatus.tsx`)
- `src/styles/surfaces/tests.css` — old UI only (from `src/pages/atlas/AtlasTests.tsx`)
- `src/styles/surfaces/versions.css` — old UI only (from `src/pages/atlas/AtlasVersions.tsx`)
- `src/styles/surfaces/widgetCatalog.css` — old UI only (from `src/pages/atlas/AtlasWidgetCatalog.tsx`)
- `src/styles/surfaces/widgetSheet.css` — old UI only (from `src/pages/atlas/AtlasWidgetSheet.tsx`)

**Pages (20)**

- `src/pages/AtlasPermissions.tsx` — replaced page (from `src/App.tsx`, `src/surfaces.ts`)
- `src/pages/Auth.tsx` — replaced page (from `src/surfaces.ts`)
- `src/pages/atlas/AtlasAgentView.tsx` — replaced page (from `src/surfaces.ts`)
- `src/pages/atlas/AtlasBanking.tsx` — replaced page (from `src/surfaces.ts`)
- `src/pages/atlas/AtlasBrowser.tsx` — replaced page (from `src/surfaces.ts`)
- `src/pages/atlas/AtlasDashboard.tsx` — replaced page (from `src/App.tsx`, `src/components/atlas-ui/AtlasExpanded.tsx`, `src/components/atlas/home/views/FullView.tsx` and 3 more)
- `src/pages/atlas/AtlasDesignSync.tsx` — replaced page (from `src/surfaces.ts`)
- `src/pages/atlas/AtlasHealth.tsx` — replaced page (from `src/pages/atlas/BetaHealth.tsx`, `src/surfaces.ts`)
- `src/pages/atlas/AtlasHome.tsx` — replaced page (from `src/surfaces.ts`)
- `src/pages/atlas/AtlasMail.tsx` — replaced page (from `src/surfaces.ts`)
- `src/pages/atlas/AtlasModelLab.tsx` — replaced page (from `src/surfaces.ts`)
- `src/pages/atlas/AtlasOnboarding.tsx` — replaced page (from `src/surfaces.ts`)
- `src/pages/atlas/AtlasSettings.tsx` — old UI only (from `src/pages/atlas/AtlasDashboard.tsx`, `src/pages/atlas/AtlasSettingsRoute.tsx`)
- `src/pages/atlas/AtlasSettingsRoute.tsx` — replaced page (from `src/surfaces.ts`)
- `src/pages/atlas/AtlasSmartHome.tsx` — replaced page (from `src/pages/atlas/BetaSmartHome.tsx`, `src/surfaces.ts`)
- `src/pages/atlas/AtlasSystemStatus.tsx` — replaced page (from `src/surfaces.ts`)
- `src/pages/atlas/AtlasTests.tsx` — replaced page (from `src/surfaces.ts`)
- `src/pages/atlas/AtlasVersions.tsx` — replaced page (from `src/surfaces.ts`)
- `src/pages/atlas/AtlasWidgetCatalog.tsx` — replaced page (from `src/surfaces.ts`)
- `src/pages/atlas/AtlasWidgetSheet.tsx` — replaced page (from `src/surfaces.ts`)

**Components (37)**

- `src/components/atlas-health/PersonalityPanel.tsx` — old UI only (from `src/pages/atlas/AtlasSettings.tsx`)
- `src/components/atlas-health/SoftwareUpdatePanel.tsx` — old UI only (from `src/pages/atlas/AtlasSettings.tsx`)
- `src/components/atlas-ui/AtlasCards.tsx` — old UI only (from `src/pages/atlas/AtlasDashboard.tsx`)
- `src/components/atlas-ui/AtlasDrawer.tsx` — old UI only (from `src/pages/atlas/AtlasDashboard.tsx`)
- `src/components/atlas-ui/AtlasExtraCards.tsx` — old UI only (from `src/pages/atlas/AtlasDashboard.tsx`)
- `src/components/atlas-ui/AtmosphereCanvas.tsx` — old UI only (from `src/pages/atlas/AtlasDashboard.tsx`, `src/pages/atlas/AtlasMail.tsx`)
- `src/components/atlas-ui/AuthSphere.tsx` — old UI only (from `src/pages/AtlasPermissions.tsx`, `src/pages/Auth.tsx`)
- `src/components/atlas-ui/ProactiveInsight.tsx` — old UI only (from `src/pages/atlas/AtlasDashboard.tsx`)
- `src/components/atlas-ui/browser/BrowserReader.tsx` — old UI only (from `src/pages/atlas/AtlasBrowser.tsx`)
- `src/components/atlas-ui/browser/BrowserTabRail.tsx` — old UI only (from `src/pages/atlas/AtlasBrowser.tsx`)
- `src/components/atlas-ui/browser/BrowserThumb.tsx` — old UI only (from `src/components/atlas-ui/browser/BrowserTabRail.tsx`)
- `src/components/atlas-ui/health/HealthWidget.tsx` — old UI only (from `src/pages/atlas/AtlasHealth.tsx`)
- `src/components/atlas-ui/mail/MailAuditTrail.tsx` — old UI only (from `src/components/atlas-ui/mail/MailReadingPane.tsx`)
- `src/components/atlas-ui/mail/MailDraftComposer.tsx` — old UI only (from `src/components/atlas-ui/mail/MailReadingPane.tsx`)
- `src/components/atlas-ui/mail/MailEmptyState.tsx` — old UI only (from `src/pages/atlas/AtlasMail.tsx`)
- `src/components/atlas-ui/mail/MailReadingPane.tsx` — old UI only (from `src/pages/atlas/AtlasMail.tsx`)
- `src/components/atlas-ui/mail/MailShell.tsx` — old UI only (from `src/pages/atlas/AtlasMail.tsx`)
- `src/components/atlas-ui/mail/MailSidebar.tsx` — old UI only (from `src/pages/atlas/AtlasMail.tsx`)
- `src/components/atlas-ui/mail/MailStatusChip.tsx` — old UI only (from `src/components/atlas-ui/mail/MailReadingPane.tsx`, `src/components/atlas-ui/mail/MailThreadRow.tsx`)
- `src/components/atlas-ui/mail/MailThreadList.tsx` — old UI only (from `src/pages/atlas/AtlasMail.tsx`)
- `src/components/atlas-ui/mail/MailThreadRow.tsx` — old UI only (from `src/components/atlas-ui/mail/MailThreadList.tsx`)
- `src/components/atlas-ui/modelLab/CompareView.tsx` — old UI only (from `src/pages/atlas/AtlasModelLab.tsx`)
- `src/components/atlas-ui/modelLab/ModelDetail.tsx` — old UI only (from `src/pages/atlas/AtlasModelLab.tsx`)
- `src/components/atlas-ui/modelLab/ModelWall.tsx` — old UI only (from `src/pages/atlas/AtlasModelLab.tsx`)
- `src/components/atlas-ui/modelLab/ProvidersView.tsx` — old UI only (from `src/pages/atlas/AtlasModelLab.tsx`)
- `src/components/atlas-ui/modelLab/RouteFlow.tsx` — old UI only (from `src/components/atlas-ui/modelLab/ModelDetail.tsx`, `src/components/atlas-ui/modelLab/ModelWall.tsx`)
- `src/components/atlas-ui/modelLab/parts.tsx` — old UI only (from `src/components/atlas-ui/modelLab/CompareView.tsx`, `src/components/atlas-ui/modelLab/ModelDetail.tsx`, `src/components/atlas-ui/modelLab/ModelWall.tsx` and 2 more)
- `src/components/atlas-ui/music/MusicPlayerCompact.tsx` — old UI only (from `src/components/atlas-ui/AtlasExtraCards.tsx`)
- `src/components/atlas-ui/onboarding/CapabilityTile.tsx` — old UI only (from `src/pages/atlas/AtlasOnboarding.tsx`)
- `src/components/atlas-ui/onboarding/OnboardingSphere.tsx` — old UI only (from `src/pages/atlas/AtlasOnboarding.tsx`)
- `src/components/atlas-ui/onboarding/WelcomeGrid.tsx` — old UI only (from `src/pages/atlas/AtlasOnboarding.tsx`)
- `src/components/atlas-ui/smartHome/DeviceCard.tsx` — old UI only (from `src/pages/atlas/AtlasSmartHome.tsx`)
- `src/components/atlas-ui/smartHome/HomeWidgetCard.tsx` — old UI only (from `src/pages/atlas/AtlasSmartHome.tsx`)
- `src/components/atlas-ui/widgetCatalog/WidgetPreview.tsx` — old UI only (from `src/pages/atlas/AtlasWidgetCatalog.tsx`)
- `src/components/atlas-ui/widgetCatalog/registry.ts` — old UI only (from `src/components/atlas-ui/widgetCatalog/WidgetPreview.tsx`, `src/pages/atlas/AtlasWidgetCatalog.tsx`)
- `src/components/atlas-ui/widgetCatalog/useCatalogWidgets.ts` — old UI only (from `src/components/atlas-ui/widgetCatalog/WidgetPreview.tsx`, `src/pages/atlas/AtlasWidgetCatalog.tsx`)
- `src/components/atlas-ui/widgetSheet/WidgetPreview.tsx` — old UI only (from `src/pages/atlas/AtlasWidgetSheet.tsx`)

**Hooks (2)**

- `src/hooks/useAtlasSpeech.ts` — old UI only (from `src/pages/AtlasPermissions.tsx`, `src/pages/atlas/AtlasOnboarding.tsx`)
- `src/hooks/useProactiveAI.ts` — old UI only (from `src/components/atlas-ui/ProactiveInsight.tsx`)

**Lib (3)**

- `src/lib/commitAfter.ts` — old UI only (from `src/pages/atlas/AtlasDashboard.tsx`)
- `src/lib/voicePreference.ts` — old UI only (from `src/hooks/useAtlasSpeech.ts`, `src/pages/AtlasPermissions.tsx`, `src/pages/Auth.tsx`)
- `src/lib/wxAtmosphere.ts` — old UI only (from `src/components/atlas-ui/AtlasCards.tsx`, `src/components/atlas-ui/AtmosphereCanvas.tsx`)

### Shared: the old UI uses it, and so does code that stays — keep (83)

Only the boundary is listed: modules a deleted module imports directly. Everything behind them stays for the same reason.

**Styles (4)**

- `src/styles/mail.css` — kept by 1 module; old importers `src/pages/atlas/AtlasMail.tsx`
- `src/styles/surfaces/banking.css` — kept by 1 module; old importers `src/pages/atlas/AtlasBanking.tsx`
- `src/styles/surfaces/health.css` — kept by 1 module; old importers `src/pages/atlas/AtlasHealth.tsx`
- `src/styles/surfaces/music.css` — kept by 2 modules; old importers `src/components/atlas-ui/music/MusicPlayerCompact.tsx`

**Pages (2)**

- `src/pages/atlas/atlasHelpers.ts` — kept by 22 modules; old importers `src/components/atlas-ui/AtlasCards.tsx`, `src/components/atlas-ui/widgetCatalog/useCatalogWidgets.ts`, `src/pages/atlas/AtlasBrowser.tsx` and 3 more
- `src/pages/atlas/useBandNarration.ts` — kept by 1 module; old importers `src/pages/atlas/AtlasDashboard.tsx`

**Components (28)**

- `src/components/atlas-health/MemoryPrivacyPanel.tsx` — kept by 1 module; old importers `src/pages/atlas/AtlasSettings.tsx`
- `src/components/atlas-health/VoiceSettingsPanel.tsx` — kept by 1 module; old importers `src/pages/atlas/AtlasSettings.tsx`
- `src/components/atlas-ui/AtlasBudgetTab.tsx` — kept by 1 module; old importers `src/pages/atlas/AtlasSettings.tsx`
- `src/components/atlas-ui/AtlasExpanded.tsx` — kept by 3 modules; old importers `src/pages/atlas/AtlasDashboard.tsx`
- `src/components/atlas-ui/atlasIcons.tsx` — kept by 1 module; old importers `src/components/atlas-ui/AtlasCards.tsx`
- `src/components/atlas-ui/AtlasSphereCanvas.tsx` — kept by 7 modules; old importers `src/components/atlas-ui/AuthSphere.tsx`, `src/components/atlas-ui/music/MusicPlayerCompact.tsx`, `src/pages/atlas/AtlasDashboard.tsx` and 1 more
- `src/components/atlas-ui/banking/BankingCatalog.tsx` — kept by 1 module; old importers `src/pages/atlas/AtlasBanking.tsx`
- `src/components/atlas-ui/banking/BankingConnections.tsx` — kept by 1 module; old importers `src/pages/atlas/AtlasBanking.tsx`
- `src/components/atlas-ui/banking/BankingNotice.tsx` — kept by 1 module; old importers `src/pages/atlas/AtlasBanking.tsx`
- `src/components/atlas-ui/banking/MoneyCard.tsx` — kept by 1 module; old importers `src/pages/atlas/AtlasBanking.tsx`
- `src/components/atlas-ui/browser/useReducedMotion.ts` — kept by 1 module; old importers `src/components/atlas-ui/browser/BrowserReader.tsx`
- `src/components/atlas-ui/mail/mailFormat.ts` — kept by 5 modules; old importers `src/components/atlas-ui/mail/MailAuditTrail.tsx`, `src/components/atlas-ui/mail/MailEmptyState.tsx`, `src/components/atlas-ui/mail/MailReadingPane.tsx` and 4 more
- `src/components/atlas-ui/mail/MailNotices.tsx` — kept by 1 module; old importers `src/pages/atlas/AtlasMail.tsx`
- `src/components/atlas-ui/mail/MailRulesEditor.tsx` — kept by 1 module; old importers `src/pages/atlas/AtlasMail.tsx`
- `src/components/atlas-ui/modelLab/useModelLabRuntime.ts` — kept by 1 module; old importers `src/components/atlas-ui/modelLab/ProvidersView.tsx`, `src/pages/atlas/AtlasModelLab.tsx`
- `src/components/atlas-ui/music/musicIcons.tsx` — kept by 2 modules; old importers `src/components/atlas-ui/music/MusicPlayerCompact.tsx`
- `src/components/atlas-ui/music/musicPalette.ts` — kept by 3 modules; old importers `src/components/atlas-ui/music/MusicPlayerCompact.tsx`
- `src/components/atlas-ui/music/musicWave.ts` — kept by 2 modules; old importers `src/components/atlas-ui/music/MusicPlayerCompact.tsx`
- `src/components/atlas-ui/music/useMusicStage.ts` — kept by 3 modules; old importers `src/components/atlas-ui/music/MusicPlayerCompact.tsx`
- `src/components/atlas-ui/music/useMusicSurface.tsx` — kept by 3 modules; old importers `src/components/atlas-ui/music/MusicPlayerCompact.tsx`
- `src/components/atlas-ui/primitives/index.ts` — kept by 21 modules; old importers `src/components/atlas-ui/AtlasCards.tsx`, `src/components/atlas-ui/AtlasExtraCards.tsx`, `src/components/atlas-ui/browser/BrowserReader.tsx` and 30 more
- `src/components/atlas-ui/smartHome/DeviceControls.tsx` — kept by 1 module; old importers `src/components/atlas-ui/smartHome/DeviceCard.tsx`, `src/components/atlas-ui/smartHome/HomeWidgetCard.tsx`, `src/pages/atlas/AtlasSmartHome.tsx`
- `src/components/atlas-ui/smartHome/deviceGlyph.tsx` — kept by 1 module; old importers `src/components/atlas-ui/smartHome/DeviceCard.tsx`
- `src/components/atlas-ui/useAccountDockItem.tsx` — kept by 1 module; old importers `src/pages/atlas/AtlasDashboard.tsx`, `src/pages/atlas/AtlasMail.tsx`
- `src/components/atlas-ui/widgetSheet/useSourceStatus.ts` — kept by 1 module; old importers `src/pages/atlas/AtlasWidgetSheet.tsx`
- `src/components/ui/badge.tsx` — kept by 1 module; old importers `src/components/atlas-health/PersonalityPanel.tsx`
- `src/components/ui/button.tsx` — kept by 4 modules; old importers `src/components/atlas-health/PersonalityPanel.tsx`, `src/components/atlas-health/SoftwareUpdatePanel.tsx`
- `src/components/ui/slider.tsx` — kept by 1 module; old importers `src/components/atlas-health/PersonalityPanel.tsx`

**Hooks (30)**

- `src/hooks/useAgentView.ts` — kept by 1 module; old importers `src/pages/atlas/AtlasAgentView.tsx`
- `src/hooks/useAppUpdater.ts` — kept by 1 module; old importers `src/components/atlas-health/SoftwareUpdatePanel.tsx`
- `src/hooks/useAtlasMail.ts` — kept by 1 module; old importers `src/pages/atlas/AtlasMail.tsx`
- `src/hooks/useAtlasProviderStatus.ts` — kept by 4 modules; old importers `src/components/atlas-ui/modelLab/ProvidersView.tsx`
- `src/hooks/useAtlasSettings.ts` — kept by 4 modules; old importers `src/pages/atlas/AtlasHome.tsx`
- `src/hooks/useAuth.ts` — kept by 29 modules; old importers `src/components/atlas-ui/widgetCatalog/useCatalogWidgets.ts`, `src/pages/Auth.tsx`, `src/pages/atlas/AtlasAgentView.tsx` and 6 more
- `src/hooks/useCalendarEvents.ts` — kept by 10 modules; old importers `src/components/atlas-ui/AtlasCards.tsx`, `src/components/atlas-ui/widgetCatalog/useCatalogWidgets.ts`
- `src/hooks/useDashboardLayout.ts` — kept by 1 module; old importers `src/pages/atlas/AtlasDashboard.tsx`
- `src/hooks/useDesignSync.ts` — kept by 1 module; old importers `src/pages/atlas/AtlasDesignSync.tsx`
- `src/hooks/useHealth.ts` — kept by 2 modules; old importers `src/pages/atlas/AtlasHealth.tsx`
- `src/hooks/useHomeSession.ts` — kept by 2 modules; old importers `src/pages/atlas/AtlasDashboard.tsx`
- `src/hooks/useLoginVoice.ts` — kept by 1 module; old importers `src/pages/Auth.tsx`
- `src/hooks/useMailIntelligence.ts` — kept by 6 modules; old importers `src/components/atlas-ui/AtlasCards.tsx`, `src/components/atlas-ui/widgetCatalog/useCatalogWidgets.ts`, `src/pages/atlas/AtlasSettings.tsx`
- `src/hooks/useMusicPlayer.ts` — kept by 8 modules; old importers `src/components/atlas-ui/widgetCatalog/useCatalogWidgets.ts`, `src/pages/atlas/AtlasSettings.tsx`
- `src/hooks/useNews.ts` — kept by 5 modules; old importers `src/components/atlas-ui/AtlasCards.tsx`, `src/components/atlas-ui/widgetCatalog/useCatalogWidgets.ts`
- `src/hooks/usePersonality.ts` — kept by 1 module; old importers `src/components/atlas-health/PersonalityPanel.tsx`
- `src/hooks/usePortfolio.ts` — kept by 5 modules; old importers `src/components/atlas-ui/AtlasCards.tsx`, `src/components/atlas-ui/widgetCatalog/useCatalogWidgets.ts`, `src/pages/atlas/AtlasSettings.tsx`
- `src/hooks/useSmartHome.ts` — kept by 3 modules; old importers `src/pages/atlas/AtlasSmartHome.tsx`
- `src/hooks/useStocks.ts` — kept by 3 modules; old importers `src/components/atlas-ui/AtlasCards.tsx`, `src/components/atlas-ui/widgetCatalog/useCatalogWidgets.ts`
- `src/hooks/useStreamingTTS.ts` — kept by 5 modules; old importers `src/hooks/useAtlasSpeech.ts`, `src/pages/Auth.tsx`
- `src/hooks/useSystemStatus.ts` — kept by 1 module; old importers `src/pages/atlas/AtlasSystemStatus.tsx`
- `src/hooks/useTasks.ts` — kept by 6 modules; old importers `src/components/atlas-ui/AtlasCards.tsx`, `src/components/atlas-ui/widgetCatalog/useCatalogWidgets.ts`
- `src/hooks/useTests.ts` — kept by 1 module; old importers `src/pages/atlas/AtlasTests.tsx`
- `src/hooks/useUnifiedChat.ts` — kept by 1 module; old importers `src/pages/atlas/AtlasDashboard.tsx`, `src/pages/atlas/AtlasHome.tsx`
- `src/hooks/useUsageHistory.ts` — kept by 1 module; old importers `src/components/atlas-ui/modelLab/ProvidersView.tsx`
- `src/hooks/useUserProfile.ts` — kept by 4 modules; old importers `src/pages/atlas/AtlasHome.tsx`
- `src/hooks/useVersions.ts` — kept by 1 module; old importers `src/pages/atlas/AtlasVersions.tsx`
- `src/hooks/useVoiceSession.ts` — kept by 2 modules; old importers `src/pages/atlas/AtlasHome.tsx`
- `src/hooks/useWeather.ts` — kept by 8 modules; old importers `src/components/atlas-ui/AtlasCards.tsx`, `src/components/atlas-ui/AtlasExtraCards.tsx`, `src/components/atlas-ui/AtmosphereCanvas.tsx` and 1 more
- `src/hooks/useWindowActivity.ts` — kept by 10 modules; old importers `src/components/atlas-ui/AtlasCards.tsx`, `src/components/atlas-ui/AtlasExtraCards.tsx`, `src/components/atlas-ui/AtmosphereCanvas.tsx` and 2 more

**Lib (15)**

- `src/lib/atlasPermissions.ts` — kept by 7 modules; old importers `src/pages/AtlasPermissions.tsx`, `src/pages/Auth.tsx`, `src/pages/atlas/AtlasOnboarding.tsx` and 1 more
- `src/lib/atlasSphere.ts` — kept by 6 modules; old importers `src/components/atlas-ui/AuthSphere.tsx`, `src/components/atlas-ui/onboarding/OnboardingSphere.tsx`, `src/pages/atlas/AtlasOnboarding.tsx`
- `src/lib/authClient.ts` — kept by 18 modules; old importers `src/pages/Auth.tsx`
- `src/lib/greetingGate.ts` — kept by 1 module; old importers `src/pages/atlas/AtlasHome.tsx`
- `src/lib/loginSpeech.ts` — kept by 1 module; old importers `src/pages/Auth.tsx`
- `src/lib/mocks/banking.ts` — kept by 5 modules; old importers `src/pages/atlas/AtlasBanking.tsx`
- `src/lib/mocks/browser.ts` — kept by 2 modules; old importers `src/components/atlas-ui/browser/BrowserReader.tsx`, `src/components/atlas-ui/browser/BrowserTabRail.tsx`, `src/components/atlas-ui/browser/BrowserThumb.tsx` and 1 more
- `src/lib/mocks/health.ts` — kept by 1 module; old importers `src/components/atlas-ui/health/HealthWidget.tsx`, `src/pages/atlas/AtlasHealth.tsx`
- `src/lib/mocks/modelLab.ts` — kept by 2 modules; old importers `src/components/atlas-ui/modelLab/CompareView.tsx`, `src/components/atlas-ui/modelLab/ModelDetail.tsx`, `src/components/atlas-ui/modelLab/ModelWall.tsx` and 3 more
- `src/lib/mocks/smartHome.ts` — kept by 4 modules; old importers `src/components/atlas-ui/smartHome/DeviceCard.tsx`, `src/components/atlas-ui/smartHome/HomeWidgetCard.tsx`, `src/pages/atlas/AtlasSmartHome.tsx`
- `src/lib/mocks/widgetSheet.ts` — kept by 2 modules; old importers `src/components/atlas-ui/widgetSheet/WidgetPreview.tsx`, `src/pages/atlas/AtlasWidgetSheet.tsx`
- `src/lib/presenceBridge.ts` — kept by 1 module; old importers `src/pages/atlas/AtlasDashboard.tsx`
- `src/lib/voiceTuning.ts` — kept by 4 modules; old importers `src/pages/atlas/AtlasHome.tsx`
- `src/lib/wakeWord.ts` — kept by 4 modules; old importers `src/pages/atlas/AtlasDashboard.tsx`
- `src/lib/worldClock.ts` — kept by 2 modules; old importers `src/components/atlas-ui/AtlasExtraCards.tsx`, `src/components/atlas-ui/widgetCatalog/useCatalogWidgets.ts`

**Other (4)**

- `src/integrations/local/localClient.ts` — kept by 44 modules; old importers `src/hooks/useProactiveAI.ts`
- `src/surfaces.ts` — kept by 15 modules; old importers `src/pages/atlas/AtlasSettings.tsx`
- `src/types/index.ts` — kept by 6 modules; old importers `src/components/atlas-ui/AtlasDrawer.tsx`
- `src/types/mail.ts` — kept by 9 modules; old importers `src/components/atlas-ui/mail/MailAuditTrail.tsx`, `src/components/atlas-ui/mail/MailDraftComposer.tsx`, `src/components/atlas-ui/mail/MailEmptyState.tsx` and 6 more

### Flag checks to remove

- `src/App.tsx:117` `isBetaUi` — `Component: isBetaUi() ? BetaHome : AtlasDashboard,`
- `src/App.tsx:129` `isBetaUi` — `...(isBetaUi() ? { ...BETA_CONSUMER, ...BETA_ADMIN } : {}),`
- `src/AppRoutes.tsx:81` `useBetaUi` — `const beta = useBetaUi();`
- `src/pages/atlas/AtlasCoreScreen.tsx:91` `isBetaUi` — `{isBetaUi() ? (`
- `src/pages/atlas/BetaAnswer.tsx:85` `isBetaUi` — `useEffect(() => { if (!isBetaUi()) plainNavigate(isRoutable('/answer-views') ? '/answer-views' : '/', { replace: true }); }, [plainNavigate]);`
- `src/pages/atlas/BetaClock.tsx:317` `isBetaUi` — `{isBetaUi() ? null : <ClockRinging />}`
- `src/pages/atlas/BetaSchool.tsx:83` `isBetaUi` — `const talk = isBetaUi();`
- `src/pages/atlas/BetaSettings.tsx:816` `setBetaUi` — `setBetaUi(false, { reload: true });`
- `src/pages/AtlasArchitecture.tsx:55` `isBetaUi` — `{isBetaUi() ? (`
- `src/pages/AtlasTeach.tsx:514` `isBetaUi` — `{isBetaUi() ? (`

Imports that only a flag-off branch uses (they go with the check):

- `src/App.tsx:20` → `src/pages/atlas/AtlasDashboard.tsx`
- `src/pages/atlas/BetaClock.tsx:28` → `src/components/atlas/clock/ClockRinging.tsx`

### npm packages only the old UI imports

Candidates for package.json once the modules are gone. Check tailwind.config.ts, vite.config.ts and postcss.config.js first: config files are not on this graph.

None.

### Tests that import a module the cutover deletes

- `src/editionSplit.test.ts` → `src/pages/atlas/AtlasSettings.tsx`

### Workshop stylesheets

main.tsx loads these for every screen, so the graph cannot drop them. A class counts as used when a module that stays contains its name as a word anywhere, so these numbers are an upper bound.

`src/styles/workshop.css`: 441 classes, 240 still named by modules that stay.

- `src/components/atlas-ui/AtlasExpanded.tsx` — 95: ac avB2 band bigprice bigtemp chgB ckB col dnB done …
- `src/pages/atlas/AtlasCoreScreen.tsx` — 34: ac badge corebody corebrand coregrid corehead corehero coreorb coreorbglow coretabs …
- `src/components/atlas-ui/AtlasAgentTab.tsx` — 24: ac card col coregrid danger field fs12 fx gap10 gap12 …
- `src/components/atlas-health/MemoryPrivacyPanel.tsx` — 22: ac badge col fs12 fw6 fx gap10 gap16 gap8 gpanel …
- `src/components/atlas-ui/primitives/Card.tsx` — 22: ac card cardAcc cardB cardBleed cardInk cardStatic cbB chB d1 …
- `src/components/atlas-ui/AtlasBudgetTab.tsx` — 20: ac badge brand col eq field flowbar flowfill fx gap16 …
- `src/pages/AtlasSphereGallery.tsx` — 20: accw auro backdrop bandB bandlisten chips dock eye field grain …
- `src/components/atlas-ui/primitives/Row.tsx` — 18: chip errrow flowrow kbrow mailrow on qrow row0 row0-compact row0-lead …
- `src/lib/mocks/widgetSheet.ts` — 18: band card cardStatic chip chips col done field grid gridB …
- `src/pages/atlas/AtlasAnswerViews.tsx` — 18: accw band bandB bandmetaB card done grain greetB grid gsubB …
- `src/components/atlas-ui/primitives/Panel.tsx` — 17: card col cpanel cph exp f1 gap16 gpanel gpanel2 panelDk …
- `src/components/atlas-ui/primitives/Button.tsx` — 15: abtn abtn-icon abtn-sm abtn-spin achoice aenter bandlisten bigin chip cta …
- `src/components/atlas-ui/primitives/Dock.tsx` — 15: acctwrap cta danger dock dockav dockb dockcta dockl field live …
- `src/components/atlas-ui/AtlasCoreTabs.tsx` — 14: ac coregrid done f1 field flowdot fs12 fx gap8 i14 …
- `src/lib/atlasSphere.ts` — 14: band cb ch exp field fx grid live on overlay …
- `src/components/atlas-ui/AccountMenu.tsx` — 13: acctdanger acctid acctitem acctmail acctmenu acctplan acctsep chip dock i12 …
- `src/components/atlas-ui/AtlasLearningControl.tsx` — 13: danger field fs12 fx gap12 i14 i16 i20 kbico on …
- `src/lib/mocks/smartHome.ts` — 13: card d1 d2 d3 d4 d5 grid live on page …
- `src/components/atlas-ui/primitives/Empty.tsx` — 12: aempty aempty-actions aempty-body aempty-dot aempty-dot-error aempty-dot-stale aempty-ico aempty-title card folding …
- `src/components/architecture/SphereDocumentation.tsx` — 11: authorbcv band coreorb field grid homeorb live on orbwrapB page …
- `src/components/atlas-ui/AtlasCoreAdminTabs.tsx` — 11: coregrid errsev flowbar flowdot flowfill i16 kbico live sev-e sev-i …
- `src/components/atlas-ui/primitives/StatTile.tsx` — 11: eslbl estat esval on statcard statico statlbl stattrend statval tnum …
- `src/lib/mocks/health.ts` — 11: band card d1 d2 d3 d4 grid live on page …
- `src/components/atlas-ui/banking/BankingConnections.tsx` — 10: card field grid i14 i16 i20 live on tnum trunc
- `src/components/atlas/home/WidgetFace.tsx` — 10: card chip chips done grid live on rings sampleB up
- and 210 more modules
