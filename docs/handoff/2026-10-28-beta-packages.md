# Beta redesign — the package briefs

The exact briefs the two workflows of 2026-10-28 gave their agents, copied here so a cloud session can continue a package. Read `2026-10-28-beta-cloud.md` first: in the cloud, skip every cargo step (the Rust is checked on the Mac) and ignore the worktree and Browser-pane notes.

## Left-out features — the common brief

You are building ONE package of left-out features for the Atlas Beta redesign in the helloatlas repo (Tauri v2 macOS app: React 18 + TypeScript webview, Rust core in src-tauri, Bun sidecars in services/). You are in your own git worktree. Thirteen other agents build other packages in sibling worktrees at the same time; the orchestrator merges every branch afterwards.

## First, before anything else
1. `git merge --ff-only ws-beta-redesign` in your worktree (worktrees can be cut from an older commit). `git log -1 --oneline` must then show f65fc14 or later. Report `pwd` as your worktree path.
2. Read docs/design-sync/2026-10-28-left-out-features.md (your rows are listed below by number), the status notes for your screens in docs/design-sync/2026-10-27-beta-plan.md, design/current/design_handoff_atlas_beta/README.md, the design file(s) named below (copy their values and copy, not their mock data), and the Beta page(s) you extend with their src/lib/beta*.ts and tests.

## The rule that matters most (handoff README)
Implement the features, not the look. Every visible control must do something real; nothing is invented. A "Key" row is built as a REAL integration that stays dormant until the user adds a key, a link or a consent, and the screen says plainly what it needs and what will leave the Mac. Where a row turns out impossible once you read the code, leave it out and report it as skipped with the reason. A labelled sample is acceptable only where the code already ships one.

## Constraints (hard)
- Secrets: never put a real key, token, password or private link in code, tests, logs, localStorage or the repo. Keys and private links the user enters in the app go to the macOS Keychain through the existing secrets path (src-tauri/src/secrets.rs and the commands that already store keys — read how brain_set_ai_key / atlas-core keys work). A password the user types to join something is passed straight through and never stored or logged.
- Local-first: data stays on this Mac (SQLite through src-tauri/src/db_schema.sql + db.rs and the local CRUD shim src/integrations/local/localClient.ts, or the existing local stores). The only network calls allowed are the ones your rows name. The UI says what leaves the Mac.
- Do NOT edit src/App.tsx, src/styles/beta.css or src/components/atlas/TopBar.tsx; the orchestrator wires routes. Styles go in src/styles/beta/<screen>.css (extend the screen's existing file), classes with the screen's existing prefix, --b-* tokens, no borders, phone width (375 px) never scrolls sideways, prefers-reduced-motion respected.
- Edition split: admin-only code must stay out of a consumer build. Gate it with `EDITION === 'admin'` from src/surfaces.ts the way BetaSettings.tsx gates AtlasBudgetTab, never with a static import of an admin page.
- Rust is allowed. Build checks MUST share the main checkout's target dir (the disk has ~19 GB free and that dir is 60 GB): from your worktree run `CARGO_TARGET_DIR="<repo root on the Mac>/src-tauri/target" cargo check --manifest-path src-tauri/Cargo.toml` (PATH must include ~/.cargo/bin). It may block on a lock while another agent builds; wait. NEVER run `cargo update`; never touch the vergen pins; prefer std::process::Command calling macOS tools (networksetup, ipconfig, sysctl, ioreg, pmset, caffeinate, system_profiler, df) over new crates. If a crate is truly unavoidable, add it to Cargo.toml surgically and report it. Pass user input to commands as separate arguments, never through a shell string (no sh -c), and validate it.
- New Tauri commands are registered in src-tauri/src/lib.rs's generate_handler list; new tables are appended to db_schema.sql as CREATE TABLE IF NOT EXISTS (and to the local CRUD allow-list if the webview reads them through localClient). Keep edits to shared files (lib.rs, db_schema.sql, src/lib/betaHome.ts WIDGETS, src/components/atlas/home/widgets.tsx) additive and inside your own functions so merges stay clean.
- JS dependencies: do not run bun add or bun install. If one is truly needed, report it and design around it.
- The brain sidecar (services/atlas-brain) may get routes or tools; test with `bun test services/atlas-brain`.
- Do NOT use the Browser pane tools at all (they are shared by ~17 agents); do not start dev servers on port 8080; never write .env.local. Verify with unit tests, the typecheck and careful reading; the orchestrator checks in the browser and the Mac app after merging.
- Shared contracts with other packages: localStorage key 'atlas:sphere_paused' ("1" = spheres paused) is written by Settings and read by the sphere engine; the Rust command 'app_restart' (calls AppHandle::restart) is added by the Settings package only — others may invoke it by name.
- Toolchain: Bun only (bun / bunx with ~/.bun/bin on PATH), never npm/npx/node.
- Code, UI copy, comments and commit messages in English, in the voice of the existing files (comments say why, in full sentences). Put pure logic in src/lib/*.ts with bun tests beside it.

## Gates (all must pass before you commit), from your worktree root
  bunx tsc -p tsconfig.app.json --noEmit
  bun run typecheck:strict
  bunx eslint <every file you created or changed>      (0 errors)
  bun test ./src                                       (and bun test services/atlas-brain if you touched it)
  the cargo check above, if you touched src-tauri
If src/surfaces.test.ts fails because you added a surface, update its count and path lists deliberately. Prefer full views inside existing pages over new routes.

## Finish
Commit on your CURRENT branch (do not push, do not switch branches): git add <your files> && git commit -m "<title>" -m "<body>" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>". Your final output IS the report: branch, commit, worktree (absolute path), one item per row you were given (built / dormant-until-key / partly / skipped, with a one-line note), files, whether Rust or the schema changed, new dependencies, routes (should be none), what the user must provide (keys, links, reconnects), and the gate results.

## F1 Money (`beta-wip/money`)

Design: Atlas Money Beta.dc.html. Extend src/pages/atlas/BetaMoney.tsx (+ src/lib/betaMoney.ts, src/styles/beta/money.css or the Money block's file); read src/pages/atlas/AtlasBanking.tsx for the banking specimen and the policy text, and the portfolio code (src-tauri/src/portfolio*.rs, usePortfolio) for patterns.
- Rows 31–32: a local bank store (new tables, e.g. bank_accounts, bank_transactions, bank_categories, bank_budgets, bank_goals). Import from a netbank CSV export: detect delimiter (; or ,), decimal comma, date formats (dd-mm-yyyy, dd.mm.yyyy, yyyy-mm-dd), and offer a column-mapping step when headers are unknown; dedupe re-imports. Optional live connection through GoCardless Bank Account Data (read-only PSD2 AIS): the user's secret_id/secret_key go to the Keychain; Rust commands get a token, list institutions for DK, create a requisition whose link opens in the browser (opener), then read accounts and transactions on demand and once a day; everything is stored locally. The screen says that with a bank connected, transactions pass through GoCardless; without one it offers CSV import. Remove the "specimen" stamp only where real data now shows.
- Row 33: budget ring with category arcs and the pace tick: the user sets monthly limits per category (local); spend per category from transactions; categories from local rules (merchant text patterns) the user can correct, with "Ask Atlas to sort these" on demand through askAtlas for uncategorised merchants (only merchant names and amounts are sent).
- Row 34: projected cash flow for 30 days from detected recurring income and payments, with event chips.
- Row 35: category filter across the ring, list and line.
- Row 36: subscriptions found from recurring monthly/annual payments; "Cancel" cannot cancel at the merchant — it adds a reminder task and, when known, opens the merchant's account page; "Mark cancelled" stops counting it; undo.
- Row 37: savings goals (target, date, saved amount, manual contributions; optionally tied to an account balance).
- Row 17: Home widgets Spend, Budget and Subscriptions (src/lib/betaHome.ts WIDGETS + adapters in src/components/atlas/home/widgets.tsx, the same face pattern as the others), honest empty states that open Money.
Note: Money is an admin surface (/money); keep it that way. Row 38 (held-payment approval) stays out.

## F2 School (`beta-wip/school`)

Designs: Atlas School Beta.dc.html and Atlas School Tools Beta.dc.html. Extend src/pages/atlas/BetaSchool.tsx, src/components/atlas/school/*, src/lib/betaSchool.ts / betaSchoolStore.ts (+ tests), src/styles/beta/school.css. The "Your school" view (SchoolConnect.tsx) becomes the real connect screen.
- Row 60 Lectio: the student pastes the calendar link from Lectio (Skema → Abonnér; webcal:// or https://). It is a private capability link: store it in the Keychain. Fetch it in Rust (no CORS) with a size cap and timeout, parse the ICS (VEVENT, SUMMARY, LOCATION, DESCRIPTION, DTSTART/DTEND with TZID, STATUS:CANCELLED and Lectio's cancellation markers) in tested TS, and show the real schedule in the ribbon, Today and the week (lessons, rooms, teachers, cancellations and changes). Refresh on open and hourly while open. Disconnect removes the link.
- Row 61 LearnIT (Moodle): the student enters the site URL (default https://learnit.itu.dk) and a web-service token they create in Moodle (Preferences → Security keys). Never ask for or handle their Moodle password; if the site issues no token, say so. Rust calls /webservice/rest/server.php (moodlewsrestformat=json): core_webservice_get_site_info, core_enrol_get_users_courses, mod_assign_get_assignments, core_course_get_contents (materials), core_message_get_conversations (read-only messages), gradereport_user_get_grade_items (grades). Cache locally; show Assignments, Materials, Messages and Grades views in the design's style.
- Row 63 Prepared by Atlas: for each new assignment, on the student's "Prepare" (and listed on Today as the design's card), the brain breaks the task into steps, sessions are spread before the due date in the study plan (spreadSessions), and cards are drafted from readable material text — nothing is kept until the student accepts. The work stays theirs; Atlas never writes the answer.
- Row 64: grades from Moodle; absence has no source (Lectio has no API) — say so.
- Row 65 Exams: exams from Lectio events whose title marks an exam (eksamen, prøve, terminsprøve, mundtlig) plus exams the student adds; countdowns; revision readiness per topic = share of that topic's cards (decks linked to the exam) at an interval of 7 days or more.
- Row 66 Tutor "What you understood today": from the student's own turns only, the brain summarises what they showed they understood, on demand or when they leave a problem; stored per day; shown in the tutor side panel as the design draws it.
- Row 67 Spreadsheet: "Suggest a column" — Atlas proposes a header and formulas for the next empty column as a pale draft (the design's range colour); Keep column writes it, Discard drops it; Atlas never writes cells without Keep.
- Row 68 Writing: headings split the document into sections; margin notes are numbered and anchored to a section; clicking a number focuses the note and the note's number marks the section.
itslearning (row 62) stays "not available": its API is partner-only.

## F3 Smart Home (`beta-wip/smarthome`)

Design: Atlas Smart Home Beta.dc.html (and the Lamp widget in Atlas Dashboard Beta.dc.html / Atlas Widgets Beta.dc.html). Extend src/pages/atlas/BetaSmartHome.tsx, src/lib/betaSmartHome.ts (+ test), src/styles/beta/smartHome.css, the smart-home hooks, and the Home Assistant bridge in src-tauri/src/home/ (ha.rs and friends).
- Row 40 modes: Home / Away / Night, each mapped by the user to a scene or script; switching runs it. When Home Assistant exposes person.* or device_tracker.* presence, suggest Home/Away from it. Stored locally.
- Row 41 energy: mirror HA sensors with device_class power (W) and energy (kWh); the card shows live W and today's kWh, per device where attributed.
- Row 42 automations: list HA automation.* entities with on/off (automation.turn_on/turn_off), following the bridge's existing approval policy.
- Row 43 tips and row 44 lock history: start keeping a local history of device state changes the mirror sees (new table, capped, e.g. 30 days) and of commands Atlas sent; tips are rule-based on it (a light on in a room with no motion for an hour late at night, a door unlocked after 23:00, heating high while Away); the lock note reads "Locked by Atlas at 08:31" when Atlas sent it, "Locked at 08:31" otherwise.
- Row 45 camera events: HA binary_sensor entities with device_class motion/occupancy/person tied to the camera's device or area → "Motion at 10:42".
- Row 46 thermostat: mirror the climate target temperature and hvac_action alongside the current temperature; the stepper sets the target; "Heating to 21.5°" from the real action.
- Row 47: carry the HA domain through the mirror so water_heater entities stay out of the inside temperature.
- Rows 3 and 16: Home widgets Lamp (with the design's swatches → setDeviceColour), Lights, Bulb, Floor lamp, Front door camera (src/lib/betaHome.ts WIDGETS + adapters in src/components/atlas/home/widgets.tsx), with real controls and honest no-bridge states.
Row 48 (scene colours / active scene) stays out.

## F4 Music (`beta-wip/music`)

Designs: Atlas Music Beta.dc.html, Atlas Widget Screens Beta.dc.html (Podcast), Atlas Dashboard Beta.dc.html (Now playing). Extend src/pages/atlas/BetaMusic.tsx, src/lib/betaMusic.ts (+ test), src/styles/beta/music.css, src/hooks/useMusicPlayer.ts, src-tauri/src/music.rs and music_engine.rs.
- Rows 49–50: add the Spotify scopes user-library-read, user-library-modify, user-read-playback-state, user-modify-playback-state (and user-read-playback-position for podcasts). Existing grants keep working; read which scopes the stored grant has and, when Like or Rooms need one it lacks, show one "Reconnect Spotify to turn on Like and Rooms" action (the existing connect flow). Like = PUT/DELETE /me/tracks with a contains check. Rooms = GET /me/player/devices, transfer playback (PUT /me/player), volume for the active device; this Mac's librespot device is one of them.
- Row 51 lyrics: LRCLIB (https://lrclib.net/api/get with track_name, artist_name, album_name, duration; no key) → syncedLyrics (LRC) parsed in tested TS; the current line follows readPosition; cached locally; the tab says lyrics come from LRCLIB and that the title and artist are sent.
- Row 52 ducking: while Atlas listens or speaks (the state bus), lower the engine volume to about 30 % and restore it after; a stored switch turns it off.
- Row 53 mood stations: Focus, Wind down, Cooking, Run — Atlas picks from the user's liked songs by asking the brain with track names and artists only (Spotify's audio-features and recommendations endpoints are closed to new apps; say so in a comment). "Matches your pace" stays out.
- Row 54: release year from the album's release_date, normalised into Track.
- Row 55: move the queue and auto-advance out of the page into a module store started from BetaShell (as Clock mounts its ringing dialog — one lazy import, one element), so playback continues on any screen.
- Row 11: a Podcast full view on Home — widget key 'podcast' in src/lib/betaHome.ts WIDGETS, src/components/atlas/home/views/PodcastView.tsx opened from BetaHome's full view like the other views: saved shows (GET /me/shows), episodes, play through the engine if librespot plays episodes (check music_engine.rs; if not, say so and transfer to a Connect device), resume position. Chapters stay out (no public source).
- Row 13: the Now playing widget gains like, output (rooms), shuffle, repeat, volume and up next from the shared queue store.

## F5 Clock (`beta-wip/clock`)

Design: Atlas Clock Beta.dc.html (and the Elsewhere / clock widgets in Atlas Widgets Beta.dc.html). Extend src/pages/atlas/BetaClock.tsx, src/lib/betaClock*.ts (+ tests), src/components/atlas/clock/*, src/styles/beta/clock.css, and ClockWidget in src/components/atlas/home/widgets.tsx.
- Row 57 keep awake: a Rust command that holds the Mac awake until the next alarm by spawning `caffeinate -i -t <seconds>` (or -w <atlas pid>), released when the alarm rings, is cancelled or Atlas quits; the "Keep this Mac awake until then" switch from the design, stored.
- Row 58 ring on Home Assistant speakers: the alarm editor's "Ring on" lists This Mac plus the media_player entities the smart-home mirror knows; at ring time Atlas speaks through Home Assistant's TTS (tts.speak / the bridge's existing service call path) on the chosen speakers, falling back to This Mac with a note when the bridge or TTS is unavailable.
- Row 59 voice: "Atlas, wake me at seven", "stop", "snooze". Find how the brain's tools reach the app (the control port in src-tauri/src/control, tool execution in the brain, Tauri events) and add set_alarm / stop_alarm / snooze_alarm tools that act on the webview's clock store (betaClockStore). The design's voice hints return only once this works.
- Row 2: the Elsewhere widget reads useClock(): the first four cities, the next alarm and a running timer or countdown, linking to /clock.
- Row 14: Clock dials and Countdown widgets (src/lib/betaHome.ts WIDGETS + adapters) from the same store.

## F6 Home (`beta-wip/home`)

Designs: Atlas Dashboard Beta.dc.html, Atlas Widget Screens Beta.dc.html, Atlas Widgets Beta.dc.html. Extend src/pages/atlas/BetaHome.tsx, src/components/atlas/home/* (widgets.tsx, WidgetFace.tsx, views/*), src/lib/betaHome.ts, betaViews.ts, betaWidgetCatalog.ts, src/hooks (useWeather, useNews, useTasks, useCalendarEvents), src-tauri/src/datafetch.rs.
- Row 1: Home's live widgets switch into attention, offline and loading faces on their own, using the detectors the widget catalog already has (src/lib/betaWidgetCatalog.ts — share them, do not copy). Edit Home is unaffected.
- Row 4 weather: datafetch.rs returns per-slice rain (rain.3h) and chance (pop), feels-like and wind; the air-pollution call returns components pm10, o3, no2 as well as pm2_5; a location setting (city search through OpenWeather geocoding with the existing key, stored locally) replaces the fixed default city everywhere useWeather is used. Row 5 (24 hourly columns, paid One Call) and row 6 (pollen) stay out.
- Row 7: the watchlist is editable (add, remove, reorder tickers; stored locally) from the Stocks view, with a ± threshold setting the attention rule uses.
- Row 8: Briefing topics the user chooses (stored); the news fetch filters or queries by them (check what the provider supports).
- Row 9: "Prepare" on a calendar event card asks the brain for notes from the event's own title, attendees and description, saved with the event locally and shown on the card.
- Row 10: "Research" on a task asks the brain for a short note, saved with the task; the delegation badge is remembered.
- Row 12 Focus: widget key 'focus' + src/components/atlas/home/views/FocusView.tsx — a 25/50-minute timer; while it runs Atlas holds its own notifications (a small shared gate other notifiers call; alarms and approvals still come through) and shows how many it held at the end; optionally runs a macOS Shortcut the user names (`shortcuts run "<name>"` as separate args) to turn on a system Focus.
- Row 15: Up next widget (next calendar events) and Currency widget (rates from https://api.frankfurter.app, ECB data, no key; base currency and amount stored locally).

## F7 Mail (`beta-wip/mail`)

Design: Atlas Mail Beta.dc.html. Extend src/pages/atlas/BetaMail.tsx, src/components/atlas/mail/*, src/hooks/useAtlasMail.ts, src/lib/betaMail.ts (+ test), and the mail engine (src-tauri/src/mail.rs, mail_imap.rs, gmail.rs, outlook.rs; find where sync and snoozes run).
- Row 21: snooze "until they reply": a snooze can carry an address (or "anyone"); on every sync, a new inbound message in that thread from that sender wakes it to Needs you; a fallback date still applies.
- Row 22: Archive at the provider (Gmail: remove the INBOX label; Outlook: move to Archive; IMAP: move to an Archive folder when one exists) plus the local status; an "Archive" lane in the design's lane list; undo. If a provider's stored grant lacks the scope this needs, the action says "Reconnect <account> to archive" rather than failing.
- Row 23: the design's Alerts switch (bills and deadlines): stored; when the mail intelligence flags a bill or a deadline (find the existing classification), Atlas posts a local notification once per thread.
- Row 24: toasts when a mailbox finishes connecting or disconnecting, detected from the account list changing.
Row 25 (sending a new message from Atlas) stays out: it waits on the user's Workers Paid plan decision.

## F8 Answer, Voice, Entry (`beta-wip/answer`)

Designs: Atlas Answer Views Beta.dc.html, Atlas Voice Beta.dc.html, Atlas Entry Beta.dc.html. Extend src/pages/atlas/BetaAnswer.tsx, src/lib/betaAnswer.ts (+ test), src/lib/answerStore.ts, src/pages/atlas/BetaVoice.tsx, src/pages/BetaAuth.tsx / src/pages/atlas/BetaOnboarding.tsx, and the brain where structured output is needed.
- Row 27 comparison: when classify says comparison, ask the brain for a strict JSON comparison (items, rows of attribute → values, a one-line verdict), validate it, and draw the design's table; fall back to the composed answer when the JSON is invalid.
- Row 28 person: look the name up in local mail threads and contacts (useAtlasMail's known addresses, local tables) and draw the design's card: who, last messages, next meeting from the calendar. Nothing leaves the Mac for this.
- Rows 26 and 20: departures and a Transit widget on Rejseplanen (dormant until the user adds an API key, stored in the Keychain; the screen says how to get one): departures from a chosen stop.
- Row 29: "Earlier conversations" on Voice and Answer from what the app already stores locally (find the chat or session history); open one to read it.
- Row 30: the Entry Voice pill: Atlas speaks its lines through the existing TTS (useStreamingTTS), off by default, remembered; never speaks on the password step.

## F9 Settings (`beta-wip/settings`)

Design: Atlas Settings Beta.dc.html (and the status panels in Atlas Dashboard Beta.dc.html). Extend src/pages/atlas/BetaSettings.tsx, src/lib/betaSettings.ts (+ test), src/styles/beta/settings.css, src/components/atlas/home/StatusPanels.tsx, src/hooks/useSystemVitals.ts, src-tauri/src/system_vitals.rs and lib.rs, the voice session hook, the brain's memory write path, src/hooks/useAppUpdater.
- Row 89 Wi-Fi: Rust commands over networksetup / ipconfig / route / system_profiler SPAirPortDataType: power on/off, nearby networks (scan), join (SSID and the password the user types, passed as separate arguments, never stored or logged), disconnect, forget (removepreferredwirelessnetwork), known networks, and details (signal, IP, router).
- Row 90 Bluetooth: power on/off and connect/disconnect paired devices. Use IOBluetooth through objc bindings already in Cargo.lock if present, or the blueutil tool when the user has it installed (detect it; never install it). If neither is possible, keep Bluetooth read-only and report why.
- Row 91 Devices: chip (sysctl machdep.cpu.brand_string), memory (hw.memsize), macOS (sw_vers), uptime (kern.boottime), CPU / memory / storage meters (vm_stat, df).
- Row 92 Battery: a 24-hour charge history recorded locally every 10 minutes (new table, capped), health from ioreg AppleSmartBattery (cycle count, maximum vs design capacity), apps using significant energy from ps sorted by CPU, and the "pause the sphere" switch, stored in localStorage 'atlas:sphere_paused' ("1"/"0") — the sphere engine reads that key (another package wires the engine side; you only write it). Row 93: Low Power Mode needs admin rights, so show its state from pmset -g read-only.
- Row 94 voice: "Listen for Hey Atlas" on/off, push to talk (hold a shortcut), mute when the Mac is locked (a Rust lock-state check), wired into the voice session.
- Row 95 memory: "Remember things I share" — when off, the brain skips memory writes (pass the setting through the existing settings path; test it).
- Row 96 updates: download automatically and install overnight (stored, used by useAppUpdater), and a Restart Atlas button: add the Rust command 'app_restart' that calls AppHandle::restart() (no plugin). Other packages invoke 'app_restart' by that name.
The status panels get the same Wi-Fi and Bluetooth switches. Row 97 (update channel) stays out.

## F10 System Status and Model Lab (`beta-wip/system`)

Designs: Atlas System Status Beta.dc.html, Atlas Model Lab Beta.dc.html. Extend src/pages/atlas/BetaSystemStatus.tsx, src/lib/betaSystemStatus.ts, src/pages/atlas/BetaModelLab.tsx, src/lib/betaModelLab.ts, src/hooks/useModelLabReadings.ts (+ tests), the brain's AI gateway and admin routes (services/atlas-brain), and src-tauri for storage sizes. Both pages are admin; keep their code admin-gated.
- Rows 72, 73, 77: the brain records every model call — lane/provider, model id, tokens in and out, a cost estimate from a small price table, latency ms, ok/error — into a local table (extend atlas_usage_history or add atlas_model_calls; check how the brain writes local data). Model Lab draws usage per model with token and cost bars and p95 latency per lane; System Status's Model calls tile counts today's calls.
- Row 74: a provider switch in Model Lab that writes atlas_ai_provider the way the brain reads it, says it takes effect on restart, and offers Restart by invoking the Rust command 'app_restart' (added by the Settings package; if it is missing at runtime, show the error).
- Row 75: System Status probes the AI provider (a cheap reachability check through the brain, no tokens spent), mail sync (mail_accounts last sync and errors), the Home Assistant bridge and calendar sync, each with latency where measured.
- Row 76: the latency history survives a reload (local, capped).
- Row 78: record the app version and the time it was first seen on startup; uptime "since the last update"; install and update events in Recently.
- Row 79: a Rust command measuring bytes on disk for atlas.db, the models directory, the mail cache and the audit trail (SQLite page counts), shown in MB as the design draws.
Row 80 (other devices) stays out.

## F11 Agent View (`beta-wip/agent`)

Design: Atlas Agent View Beta.dc.html. Extend src/pages/atlas/BetaAgentView.tsx, src/lib/betaAgentView.ts (+ test), src/hooks/useAgentRuns.ts and useAgentView.ts, the agent runner (find it: brain or Rust scheduler), the control port approvals (src-tauri/src/control) and the brain's agent-session routes. Admin page; keep it admin-gated.
- Row 85: pause and resume: a 'paused' run status; the runner checks it between steps and waits; Resume continues from the next step.
- Row 86: stop and undo: when a step runs a tool that has an inverse (calendar create → delete, task create → delete, note create → delete, smart-home set → previous state, and any others you find), record the inverse with the step; "Stop and undo" stops the run and runs the inverses newest first after one confirmation; steps without an inverse are listed as "can't be undone".
- Row 87: the runner writes runs.plan_json when a run starts (the planned steps, from the model's plan or the goal), so progress is measured done/total and the plan shows ahead of time.
- Row 88: a brain route to stop an agent session, shown as Stop on live sessions; approvals carry their run_id from the control port where the runner knows it, so they appear inside their run's plan.

## F12 Browser (`beta-wip/browser`)

Design: Atlas Browser Beta.dc.html. Extend src/pages/atlas/BetaBrowser.tsx, src/lib/betaBrowser.ts (+ test), src/styles/beta/browser.css; replace the sample session (src/lib/mocks/browser.ts) with a real one for this page (keep the sample only if the Workshop page still needs it). Admin page; keep it admin-gated.
- Row 69: Go fetches the page on this Mac through a Rust command: http/https only, private and local addresses refused (no 127.0.0.1, 10/8, 172.16/12, 192.168/16, .local, file:), 2 MB cap, timeout, at most 5 redirects, a plain user agent. Extract readable blocks (title, headings, paragraphs, lists, quotes, figure captions, links) in Rust or tested TS; no script ever runs and no remote image loads; render the reader view in the design's style. Links in the page open as new tabs through Go.
- Row 70: tabs, history and Kept shelves persist locally.
- Row 71: Find searches the real text (findMatches already exists). Ask answers from the page text only, through a brain route that never writes memory (check the chat path's memory writes and add a page-grounded route that skips them); "On this page" observations are asked on demand. The screen says pages are fetched by this Mac and that Ask sends the page text to the AI provider.
"Open in your browser" stays.

## F13 Dev tools (`beta-wip/devtools`)

Design: Atlas Dev Tools Beta.dc.html (and Atlas Widgets Beta.dc.html for the developer widgets). Extend src/pages/atlas/BetaDevTools.tsx, src/lib/betaDevTools.ts (+ test), src/hooks/useTests.ts, and the brain's test-runner routes (services/atlas-brain adminRoutes and CI_JOBS). Admin page; keep it admin-gated.
- Row 81: run the frontend and brain test jobs with coverage (bun test --coverage) and parse the summary into the Coverage tile.
- Row 82: parse bun test output for per-file and total pass/fail/skip counts and durations; rows show "N tests · X s" as the design draws.
- Row 18: Pull requests and Deploys widgets for Home, admin edition only (absent from a consumer build): open pull requests and the latest workflow runs through the gh CLI the brain already uses for plan sync, via a brain route.
Rows 83 and 84 stay out.

## Phase 8 — the common brief

You are building ONE package of phase 8 (polish and cutover) of the Atlas Beta redesign in the helloatlas repo (Tauri v2 macOS app: React 18 + TypeScript webview, Rust core, Bun sidecars). You are in your own git worktree. At the same time, thirteen other agents are adding left-out features to the Beta screens in sibling worktrees (Money, School, Smart Home, Music, Clock, Home widgets, Mail, Answer/Voice/Entry, Settings and the status panels, System Status/Model Lab, Agent View, Browser, Dev tools), and three more phase-8 agents work beside you. The orchestrator merges every branch afterwards, so stay inside the files your package owns.

## First
1. `git merge --ff-only ws-beta-redesign` (worktrees can be cut from an older commit); `git log -1 --oneline` must show f65fc14 or later. Report `pwd` as your worktree path.
2. Read design/current/design_handoff_atlas_beta/README.md (phase 8 and the design rules), docs/design-sync/2026-10-27-beta-plan.md §8 and §9, docs/design-sync/2026-10-28-left-out-features.md (the Phase 8 table), src/styles/beta.css lines 1–120 (tokens and shell primitives), src/lib/betaFlag.ts, src/AppRoutes.tsx, src/App.tsx, src/surfaces.ts.

## Constraints (hard)
- Everything ships behind the beta_ui flag: with the flag off, the Workshop UI must look and behave exactly as before.
- Do NOT edit src/App.tsx. Do NOT flip DEFAULT_ON and do NOT delete any screen: the cutover waits for the user's dock choice and their review in the Mac app.
- Bun only (bun / bunx with ~/.bun/bin on PATH), never npm/npx/node; do not run bun add or bun install. NEVER run cargo update; if you must check Rust, share the main target dir: CARGO_TARGET_DIR="<repo root on the Mac>/src-tauri/target" cargo check --manifest-path src-tauri/Cargo.toml.
- Do NOT use the Browser pane tools (shared by ~17 agents); no dev server on 8080; never write .env.local. Verify with unit tests, the typecheck and careful reading.
- Edition split: never import an admin page statically into anything a consumer build reaches.
- Contracts with the feature packages: localStorage 'atlas:sphere_paused' ("1" = paused) is written by Settings; the sphere engine reads it. The Rust command 'app_restart' is added by the Settings package.
- English for code, comments, UI copy and commits, in the voice of the existing files (comments say why). Pure logic in src/lib/*.ts with bun tests.

## Gates (all must pass before you commit), from your worktree root
  bunx tsc -p tsconfig.app.json --noEmit
  bun run typecheck:strict
  bunx eslint <every file you created or changed>   (0 errors)
  bun test ./src

## Finish
Commit on your CURRENT branch (no push, no branch switch) with "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" as the last paragraph. Your final output IS the report: branch, commit, worktree (absolute path), one item per task you were given (done / partly / skipped with a note), files, anything the user must decide, and the gate results.

## P8a Core, Teach, Architecture bodies (`beta-wip/bodies`)

Designs: Atlas Core Beta.dc.html, Atlas Teach Beta.dc.html, Atlas Architecture Beta.dc.html. Phase 3 put a Beta hero (src/components/atlas/BetaScreenHero.tsx) above the Workshop bodies of src/pages/atlas/AtlasCoreScreen.tsx, src/pages/AtlasTeach.tsx and src/pages/AtlasArchitecture.tsx; under the hero the bodies still look like the Workshop (Tailwind). Restyle each body to the design while the flag is on: the paper scale, no borders, --b-* tokens, the design's cards, rows, chips, segmented controls and type; keep every control and every data source exactly as it is (same hooks, same actions). Prefer Beta markup rendered under isBetaUi() for structure that differs, and scoped CSS in src/styles/beta/<screen>.css (html[data-ui="beta"] .<scope> …) for the rest; with the flag off nothing changes. AtlasCoreScreen hides admin tabs in the consumer edition (visibleTabs) — keep that split exactly. Phone width must not scroll sideways; reduced motion respected. You own these three pages and their Beta stylesheets only.

## P8b Shell accessibility and sphere performance (`beta-wip/shell`)

You own src/components/atlas/TopBar.tsx, src/components/atlas/TalkToAtlas.tsx, src/components/atlas/BetaShell.tsx (keep the existing lazy mounts; other packages add one line each there), src/components/atlas/VeilSphere.tsx and the Beta sphere engine it uses (quickSphere or the equivalent under src/components/atlas or src/lib). Do NOT edit src/components/atlas/BetaDock.tsx (another package owns it) or the contents of the status panels (src/components/atlas/home/StatusPanels.tsx is being extended elsewhere; at most adjust the panel container's focus handling if it lives in TopBar).
- Accessibility: a sensible focus order (top bar, page, dock), visible focus for keyboard users only (:focus-visible, per §9 of the plan), labels on every icon button, the Talk panel and the status panels trap focus while open and return it to their trigger on close, Esc closes the topmost layer only, live regions only where a screen reader should hear a change, and prefers-reduced-motion respected across the shell (view transitions, panel motion).
- Performance: particle budgets per sphere size (write them down in one table, tested), every sphere pauses its animation when off-screen (IntersectionObserver) and when the window is hidden or inactive (useWindowActivity), and all spheres stop when localStorage 'atlas:sphere_paused' is "1" (read it with a storage-event listener so the Settings switch applies at once; when paused, draw one still frame). Measure nothing you cannot measure here; explain the budgets in a comment.
Add tests for the pure parts (budget table, the pause decision).

## P8c Dock styles (`beta-wip/dock`)

Design: design/current/design_handoff_atlas_beta/Atlas Dock Explorations.dc.html (read it fully: it holds several dock explorations). The user has not chosen a final dock; this lets them choose in the real app instead of in the design file. You own src/components/atlas/BetaDock.tsx (and a new src/styles/beta/dock.css if useful) and the "Beta UI" section of src/pages/atlas/BetaSettings.tsx (another package is editing the other sections of that file — keep your change to that section only, additive).
- Implement each exploration that is a real dock layout as a style of BetaDock, with the same destinations, the account menu and the edition rules the current dock has (entries come from the surfaces registry; keep that). The current dock stays the default.
- A "Dock style" choice in Settings → Beta UI, stored in localStorage 'atlas:beta_dock', applied at once (no reload), with a small preview per style.
- Keyboard and screen-reader access for every style; phone width (375 px) must fit; reduced motion respected.
- List in your report which explorations you built and which you left out (and why), so the user can choose.

## P8d Cutover readiness (`beta-wip/cutover`)

The cutover will turn beta_ui on by default (src/lib/betaFlag.ts DEFAULT_ON) and remove the Workshop screens the Beta replaced. Prepare it so that day is mechanical, without doing it:
- A test (e.g. src/betaCutover.test.ts) that reads src/surfaces.ts and src/App.tsx and asserts every surface either is a Beta page itself or has a Beta override in App.tsx's BETA_CONSUMER / BETA_ADMIN maps (or the "/" ternary) — with an explicit, commented allow-list for surfaces that deliberately keep their Workshop page under a Beta hero (Core, Teach, Architecture) or have no Beta design (answer-views, homekit-lab, atlas-sphere: check the handoff's screen map). It must pass today and fail when a new surface lands without a Beta page.
- A script scripts/beta-cutover-inventory.ts (bun) that walks the import graph from src/main.tsx with the flag assumed on and lists the modules that become unreachable once the Workshop pages are removed (pages, their components, hooks and styles), separating "only the old UI uses it" from "shared".
- docs/design-sync/beta-cutover.md: the steps of the cutover in order (dock chosen → Mac review → DEFAULT_ON → remove the flag checks → delete the listed modules → drop the Workshop CSS → gates), the inventory's output, and the risks you found (anything the Beta still imports from a Workshop page, e.g. exported panels reused by Beta pages, which must move before deletion).
You own only these new files. Touch nothing else.

