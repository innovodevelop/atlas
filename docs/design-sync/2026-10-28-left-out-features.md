# Beta redesign — the features left out, and what happens to each

Compiled 2026-10-28 from the departures recorded in `2026-10-27-beta-plan.md`
and the screen agents' reports. Phases 1–7 shipped every screen of the
handoff; this is what those screens still leave out of the design, sorted
by what it takes to build.

- **Build** — buildable now on what Atlas has, or on storage on this Mac.
- **Key** — built as a real integration that stays dormant until the user
  adds a key, a link or a consent; the screen says what it needs. Never a
  fake.
- **Decide** — waits on a decision only the user can make.
- **No** — no source exists for it on a Mac; stays out.

The package letter (F1–F13) is the workflow agent that builds it.

## Home, widgets and widget screens

| # | Feature | Kind | Pkg |
|---|---|---|---|
| 1 | Home widgets switch into their attention and offline states on their own | Build | F6 |
| 2 | "Elsewhere" widget shows your Clock cities, next alarm and running timer | Build | F5 |
| 3 | Lamp widget with colour swatches | Build | F3 |
| 4 | Weather: rain per forecast slice, feels-like, wind, PM10/O3/NO2, a location setting | Build | F6 |
| 5 | Weather: 24 hourly columns | Decide (paid OpenWeather One Call) | — |
| 6 | Weather: pollen | No | — |
| 7 | Watchlist: edit tickers, alert threshold | Build | F6 |
| 8 | Briefing: choose topics | Build | F6 |
| 9 | Calendar: Atlas prepares a meeting's notes, saved with it | Build | F6 |
| 10 | Tasks: Atlas researches a task, note saved; delegation remembered | Build | F6 |
| 11 | Podcast screen (Spotify shows and episodes) | Build | F4 |
| 12 | Focus screen: a timer that holds Atlas's notifications | Build | F6 |
| 13 | Now playing widget: like, output, shuffle, repeat, volume, up next | Build | F4 |
| 14 | New widget types with a source: Clock dials, Countdown | Build | F5 |
| 15 | New widget types: Up next, Currency | Build | F6 |
| 16 | New widget types: Lights, Bulb, Floor lamp, Front door camera | Build | F3 |
| 17 | New widget types: Spend, Budget, Subscriptions | Build | F1 |
| 18 | New widget types: Pull requests, Deploys (admin) | Build | F13 |
| 19 | New widget types: Flight, Commute, Packing, Nutrition, Invoices, Incidents | No | — |
| 20 | Transit widget | Key (Rejseplanen) | F8 |

## Mail

| # | Feature | Kind | Pkg |
|---|---|---|---|
| 21 | Snooze "until they reply" | Build | F7 |
| 22 | Archive lane and Archive action | Build | F7 |
| 23 | Alerts switch: bills and deadlines | Build | F7 |
| 24 | Toasts when a mailbox connects or disconnects | Build | F7 |
| 25 | Send a new message from Atlas | Decide (Workers Paid plan) | — |

## Answer, Voice, Entry

| # | Feature | Kind | Pkg |
|---|---|---|---|
| 26 | Departures answer shape | Key (Rejseplanen) | F8 |
| 27 | Comparison answer shape | Build | F8 |
| 28 | Person answer shape, from local mail and contacts | Build | F8 |
| 29 | "Earlier conversations" card | Build | F8 |
| 30 | Entry: the Voice pill, Atlas speaks its lines (off by default) | Build | F8 |

## Money

| # | Feature | Kind | Pkg |
|---|---|---|---|
| 31 | Bank transactions from a CSV export, kept on this Mac | Build | F1 |
| 32 | Bank connection (GoCardless Bank Account Data, read-only) | Key | F1 |
| 33 | Budget ring with category arcs and the pace tick | Build | F1 |
| 34 | 30-day projected cash flow with event chips | Build | F1 |
| 35 | Category filter | Build | F1 |
| 36 | Subscriptions found from recurring payments, with a cancel reminder | Build | F1 |
| 37 | Savings goals | Build | F1 |
| 38 | Held-payment approval | No (banks give read-only access) | — |

## Health

| # | Feature | Kind | Pkg |
|---|---|---|---|
| 39 | Live heart rate and ECG | No (nothing streams a watch to a Mac) | — |

## Smart Home

| # | Feature | Kind | Pkg |
|---|---|---|---|
| 40 | Home / Away / Night modes, each running a scene you choose | Build | F3 |
| 41 | Energy card from Home Assistant power and energy sensors | Build | F3 |
| 42 | Automations with on/off (Home Assistant automations) | Build | F3 |
| 43 | Atlas tips from device history Atlas starts keeping | Build | F3 |
| 44 | Lock history | Build | F3 |
| 45 | Camera motion and person events | Build | F3 |
| 46 | Thermostat target and "heating to" | Build | F3 |
| 47 | Water heaters kept out of the inside temperature | Build | F3 |
| 48 | Scene colours and the active scene | No | — |

## Music

| # | Feature | Kind | Pkg |
|---|---|---|---|
| 49 | Like | Key (Spotify reconnect, new permission) | F4 |
| 50 | Rooms: other Spotify Connect speakers, output switch, volume | Key (same reconnect) | F4 |
| 51 | Lyrics (LRCLIB, synced) | Build | F4 |
| 52 | Ducking while Atlas listens or talks | Build | F4 |
| 53 | Mood stations, picked by Atlas from your library | Build | F4 |
| 54 | Release year | Build | F4 |
| 55 | The queue keeps playing after you leave Music | Build | F4 |
| 56 | "Matches your pace" | No | — |

## Clock

| # | Feature | Kind | Pkg |
|---|---|---|---|
| 57 | Keep the Mac awake until an alarm | Build | F5 |
| 58 | Ring on Home Assistant speakers | Build | F5 |
| 59 | Voice: "wake me at seven", "stop", "snooze" | Build | F5 |

## School

| # | Feature | Kind | Pkg |
|---|---|---|---|
| 60 | Lectio schedule from its calendar feed link | Key (your feed link) | F2 |
| 61 | LearnIT (Moodle): assignments, materials, messages, grades | Key (your Moodle token) | F2 |
| 62 | itslearning | No (partner-only API) | — |
| 63 | "Prepared by Atlas": new assignments into the plan, cards from materials | Build | F2 |
| 64 | Grades and absence | Key (Moodle grades); Lectio grades No | F2 |
| 65 | Exams with countdowns and revision readiness | Build | F2 |
| 66 | Tutor: "what you understood today" | Build | F2 |
| 67 | Spreadsheet: Atlas proposes a column you keep or discard | Build | F2 |
| 68 | Writing: sections with numbered margin notes | Build | F2 |

## Browser

| # | Feature | Kind | Pkg |
|---|---|---|---|
| 69 | Real pages: Go fetches the page on this Mac and shows it in reader form | Build | F12 |
| 70 | Tabs and Kept shelves saved | Build | F12 |
| 71 | Find and Ask on the real page; Ask never writes to memory | Build | F12 |

## Model Lab, System Status, Dev tools

| # | Feature | Kind | Pkg |
|---|---|---|---|
| 72 | Usage per model, tokens and cost | Build | F10 |
| 73 | p95 latency per lane | Build | F10 |
| 74 | Provider switch, applied on restart | Build | F10 |
| 75 | More services probed: AI provider, mail sync, Home Assistant, calendar | Build | F10 |
| 76 | Latency history that survives a reload | Build | F10 |
| 77 | Model calls counted | Build | F10 |
| 78 | Uptime since the last update; install and update events | Build | F10 |
| 79 | Storage on this Mac in MB | Build | F10 |
| 80 | Other devices (iPhone, Watch, other Macs) | No | — |
| 81 | Test coverage figure | Build | F13 |
| 82 | Per-test counts and durations | Build | F13 |
| 83 | Release channels: promote and roll back | Decide (changes public releases) | — |
| 84 | Tester and install counts | No | — |

## Agent View

| # | Feature | Kind | Pkg |
|---|---|---|---|
| 85 | Pause and resume a run | Build | F11 |
| 86 | Stop and undo, for steps that have an undo | Build | F11 |
| 87 | Measured progress from a plan written when a run starts | Build | F11 |
| 88 | Stop a brain session; approvals tied to their run | Build | F11 |

## Settings and the status panels

| # | Feature | Kind | Pkg |
|---|---|---|---|
| 89 | Wi-Fi on/off, nearby networks, join, disconnect, forget, details | Build | F9 |
| 90 | Bluetooth on/off, connect and disconnect paired devices | Build | F9 |
| 91 | Devices: chip, memory, macOS, uptime, CPU/memory/storage meters | Build | F9 |
| 92 | Battery: 24-hour history, health, energy use, pause-the-sphere | Build | F9 |
| 93 | Low Power Mode switch | No (needs admin rights; shown read-only) | F9 |
| 94 | Voice: "Hey Atlas" on/off, push to talk, mute when locked | Build | F9 |
| 95 | Memory: "Remember things I share" | Build | F9 |
| 96 | Updates: download automatically, install overnight, Restart Atlas | Build | F9 |
| 97 | Update channel | Decide (with 83) | — |

## Phase 8 (second workflow)

| # | Work | Pkg |
|---|---|---|
| P1 | Core, Teach and Architecture bodies in the Beta style | P8a |
| P2 | Accessibility on the shell: focus order, labels, keys, reduced motion | P8b |
| P3 | Performance: sphere particle budgets, spheres pause off-screen and when hidden | P8b |
| P4 | The dock explorations as a switch in Settings, so the dock is chosen in the real app | P8c |
| P5 | Cutover readiness: a guard that every Workshop route has its Beta page, and the removal list | P8d |
| P6 | Phone-width pass on every screen | after both workflows merge |
| P7 | Flag on by default, old screens removed | after the dock choice and the Mac review |
