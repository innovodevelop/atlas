# ADR 016 — The Tauri IPC surface has no policy model, and the control port does

**Status:** accepted (analysis) · **Date:** 2026-08-12 · **Verdict:** **GAP CONFIRMED — mostly benign, four items are not**
**Gates:** R13 of `docs/audit/2026-08-11-refactor-plan.md` (Wave 2), completeness-critic gap #2.
**Scope:** analysis only. Nothing in this ADR was changed in code; every recommendation names the exact file to change in a later wave.

## Verdict

| Question | Answer |
|---|---|
| Do two routes to desktop capability exist? | **Yes.** The control port (38 ops in a default build, 39 with `homekit`) and the Tauri IPC surface (60 commands, 62 with `homekit`). |
| Does the IPC surface have tiers, audit, or rate limits? | **No. None of the three.** Not one of the 60 passes through `policy::decide`. |
| Is that wrong? | **Mostly no.** For **47 of the 60** the honest answer holds without qualification: a person clicked a control in our own UI, and the model reads attacker-authored text while the person does not. That is a real distinction, not a slogan. |
| Where does that answer fail? | **On 13 commands**, gathered into nine gaps below, of which **four are worth acting on** (G1, G2, G5, G6) and one is a design question larger than this ADR (G3). The sharpest: the control port's own audit tables are writable and deletable from the webview, while `mail_audit_events` is protected by triggers. |
| Is the boundary the audit assumed (`MailReadingPane` does not render `body_html`) real? | **Verified true.** So is the wider claim: nothing in `src/` renders remote HTML. |
| Is the IPC surface pinned by any test? | **No.** `generate_handler!` is read by nothing. A new `#[tauri::command]` reaches the webview with zero review and breaks no test. |

R13's brief said "26 webview-reachable commands". The real number is **60** (62 under `--features homekit`). The brief undercounted by 34, which is itself evidence for the last row of that table: nobody had enumerated this list before.

## The two routes, stated once

**Control port** — `src-tauri/src/control/`. A tiny_http server on 127.0.0.1, reached by the brain sidecar and nothing else. Every invoke passes the auth ladder (`auth.rs`: method+path, no-Origin, exact-Host, constant-time bearer, 256 KB cap), a per-tier token bucket (`policy.rs:177-184` — 60/20/10/10 per minute), the tier×profile gate (`policy.rs:115`), and — above Read — a `tool_calls` row written **before** dispatch (`audit.rs:375-408`). `EXPECTED_TIERS` (`registry.rs:1618`) pins all 38 ops to a hand-reviewed tier; `ALLOWED_COMMANDS` (`registry.rs:756`) is an allowlist of every `crate::…` path a runner may even name; `DENIED` (`registry.rs:972`) is the belt to that braces.

**IPC surface** — `src-tauri/src/lib.rs:491`, one `generate_handler!` block. Reachable from any script running in the WKWebView. No tier, no audit, no rate limit, no allowlist, and no test that reads the list.

The asymmetry is deliberate in origin — the control port exists *because* the brain is a separate process that cannot reach IPC at all (`control/mod.rs:4-10`) — but it was never written down as a diff, so nobody could see which commands sit on one side, both, or neither.

## The full diff

Legend for **Registry status**: **op** = reachable on the control port at the stated tier · **allowed** = named in `ALLOWED_COMMANDS` as a helper but not an op of its own · **denied** = in `DENIED`, with the reason quoted from the absence notes (`registry.rs:77-186`) · **absent (reasoned)** = excluded in prose but not in `DENIED` · **unlisted** = no decision exists anywhere in `src-tauri/src/control/`.

### lib.rs — sidecars and keys (4)

| IPC command | Control port | Registry status | Why webview reach is acceptable |
|---|---|---|---|
| `voice_gateway_info` | — | **denied** — *"Returns the same shared gateway token."* | **NOT the human-click argument.** See gap **G4**: this hands the webview a live bearer token by design; `voiceClient.ts` cannot authenticate to the gateway without it. |
| `atlas_brain_info` | — | **denied** — *"RETURNS THE SIDECAR TOKEN. Handing it out here would let anything that reached one op reach the brain's own API."* | **NOT the human-click argument.** `brainClient.ts:17` calls it on every page load. See **G4**. |
| `brain_set_ai_key` | — | **denied** — *"Writes the macOS Keychain… an empty value silently CLEARS the stored key, so a model that calls it with a plausible-looking empty argument disables Atlas' own reasoning and leaves no trace."* | **Yes.** Model Lab settings: a person pasting a key into a field, and clearing it is what the empty field is *for*. The silent-clear property is identical; the difference is entirely who chose it. |
| `brain_ai_status` | — | **unlisted** | Returns presence booleans and the provider slug, never a key value (`lib.rs:351-367`). Defensible — but see **G5**: no decision was ever written. |

### portfolio (8)

| IPC command | Control port | Registry status | Why webview reach is acceptable |
|---|---|---|---|
| `portfolio_status` | `portfolio.status` · Read | op | Read either way. |
| `portfolio_summary` | `portfolio.summary` · Read | op | Read either way. |
| `portfolio_holdings` | `portfolio.holdings` · Read | op | Read either way. |
| `portfolio_history` | `portfolio.history` · Read | op | Read either way. |
| `portfolio_allocation` | `portfolio.allocation` · Read | op | Read either way. |
| `portfolio_connect_url` | — | **denied** — *"it raises a brokerage-linking consent screen"* | **Yes, and this is the cleanest case in the table.** The objection is that a model *choosing the moment* to raise a real consent screen is a phishing primitive. A user clicking "Connect broker" chose the moment. |
| `portfolio_disconnect` | — | **denied** — *"WIPES the local DuckDB store — the entire holdings and activity history, gone."* | **Yes**, with the caveat in **G2**: destructive, and no audit row records that it happened. |
| `portfolio_sync` | — | **unlisted-unreviewed** — registry.rs:170-177 calls it a write "nobody has reviewed" (it "rewrites the whole local DuckDB store from the brokerage") | **Yes** — a Sync button. Note the exclusion here is *pending review*, not rejection. |

### music (15)

| IPC command | Control port | Registry status | Why webview reach is acceptable |
|---|---|---|---|
| `music_status` `music_search` `music_library_tracks` `music_playlists` `music_playlist_tracks` `music_now_playing` | `music.*` · Read | op | Read either way. |
| `music_play` | `music.play` · **Actuate** | op | **Yes.** Actuate exists because sound in the room is observable from outside the app and needs a human present. Pressing Play *is* the human, present. |
| `music_pause` | `music.pause` · **Actuate** | op | Same. |
| `music_volume` | `music.volume` · **Actuate** | op | Same. |
| `music_load` | — (helper inside `ops_music::play`) | **allowed** | Same trust as `music_play`. |
| `music_connect` | — | **denied** — *"A model that can raise a real consent screen at a moment of its own choosing is a phishing primitive, whatever the URL says."* | **Yes** — same reasoning as `portfolio_connect_url`. |
| `music_disconnect` | — | **denied** — *"Destroys the Keychain refresh token. Unrecoverable without the user re-doing the whole OAuth flow."* | **Yes** — a Disconnect button, and the user is the one who would have to redo it. |
| `music_next` `music_prev` | — | absent (reasoned) — registry.rs:460-467 documents them as **broken, not unsafe**: `music_engine.rs` holds a one-track queue, so both take the do-nothing branch on every call | **Yes**, and the honest note is that they do nothing on this route either. |
| `music_seek` | — | **unlisted** | See **G5** — `music_seek` is named nowhere in `src-tauri/src/control/`. |

### db (7)

| IPC command | Control port | Registry status | Why webview reach is acceptable |
|---|---|---|---|
| `db_select` | `tasks.list`, `notes.list`, `events.list`, `watchlist.list`, `mail.list_threads`, `mail.read_thread`, `health.*` · Read | **allowed**, behind three gates `db_select` itself does not have (`ops_db.rs:10-20`: table in `TABLES`, every column in that table's allowlist, `user_id` from the Ctx) | **Partly.** The webview reaches the raw command: any of the ~44 tables, any column. That is the same primitive `ops_db.rs` calls *"a multi-account read primitive over every table in the app"* when handed to a model. It is a local single-user SQLite file, so today the exposure is bounded by there being one user — see **G3**. |
| `db_insert` | `tasks.create`, `notes.create`, `events.create`, `watchlist.add` · Write (audited) | **allowed**, pinned to one table per runner by `ops_write.rs` | Same shape: the webview reaches it unpinned and **unaudited**. See **G1**/**G2**. |
| `db_update` | `tasks.update`, `notes.update` · Write (audited) | **allowed**, pinned per runner | Same. **G1** is specifically about this command reaching `tool_calls` and `approvals`. |
| `db_delete` | — | **denied** — *"Nothing in this product deletes user rows… A DELETE is none of those, and no write tier will change that."* | **Partly.** Four call sites use it, all user-initiated (`useAtlasMail.ts:1113` mail rule, `useAgents.ts:150`, `useCrudOperations.ts:149`, `useSchedules.ts:126`). But the command takes an arbitrary table, so **G1** applies. |
| `db_info` | — | **denied** — *"That is reconnaissance: it answers 'what is worth asking for' for an attacker and nothing at all for the user."* | **Yes** — and it is currently called by nothing in `src/`. |
| `memory_recall` | — | **unlisted** (named only in a timeout comment, `control/mod.rs:181`) | Read-only hybrid retrieval; `localClient.ts:396` uses it for the memory surface. See **G5**. |
| `memory_upsert_vector` | — | **denied** — *"A vector that did not come from the embedding model… silently poisons recall ranking for every future query."* | **Yes** — no `src/` caller at all today; the ingest path that produces embeddings lives in the brain. |

### datafetch (3)

| IPC command | Control port | Registry status | Why webview reach is acceptable |
|---|---|---|---|
| `fetch_weather` `fetch_stocks` `fetch_news` | `data.weather` `data.stocks` `data.news` · Read | op | Read either way. Reached from the webview only through `LOCAL_FN`, a fixed three-entry map (`localClient.ts:453-457`) — not a dispatch-by-string surface. |

### mail (6)

| IPC command | Control port | Registry status | Why webview reach is acceptable |
|---|---|---|---|
| `mail_mark_read` | `mail.mark_read` · **Approval** | op — never auto-runs on either profile | **Almost.** `useAtlasMail.ts:733-736` states it outright: *"markRead is the one action fired by an effect rather than a click."* The human act is opening the thread, not pressing a button. Same intent, weaker surface. See **G7**. |
| `mail_set_status` | `mail.archive` · **Approval** | op | **Yes** — Archive/Escalate/Snooze buttons in `MailReadingPane`. |
| `mail_send_reply` | — | **denied** — *"an archive is undone by the user in one click, an email that left the building is not… an op that is safe only because a bill is unpaid is not safe."* | **Yes** — and it hard-refuses on both routes today (`mail.rs:1108`, Workers Paid not purchased). |
| `mail_ingest_errors` | — | **denied** — *"internal failure detail that belongs in a log, not in a prompt, where it becomes both noise and a description of the server's internals."* | **Yes** — an operator diagnostics panel a person opens. Note it takes the CF token as an argument (`mail.rs:1114`). |
| `mail_sync` | — | **unlisted-unreviewed** — registry.rs:170-177 flags that *"mail_sync's rule pass can change an unbounded number of remote thread statuses behind one call"* | **Yes**, with the shape named: rules match on attacker-authored `from`/`subject` and mutate remote state with no per-thread click. The rules are user-authored, only server-side-Triage threads are offered (`mail.rs:731-736`), and every application writes to `mail_audit_events`, which **is** append-only. This is the best-defended mutating path in the app. |
| `mail_thread_fetch` | `mail.read_thread` reads the local mirror instead | **unlisted-unreviewed** | **Yes** — opening a thread. The control port deliberately never fetches: `ops_db.rs:127-131` excludes the `extracted` column *"where the full message bodies live… those are attacker-authored text."* |

### control (1)

| IPC command | Control port | Registry status | Why webview reach is acceptable |
|---|---|---|---|
| `approval_resolve` | n/a — it is the answer path, not an op | by design | **Yes, and this is the design's load-bearing case.** `control/mod.rs:32-35`: the webview supplies a yes/no and an id; the payload it executes never leaves Rust memory. The webview can answer the question and cannot choose it. |

### home (13)

| IPC command | Control port | Registry status | Why webview reach is acceptable |
|---|---|---|---|
| `home_snapshot` | `home.list` · Read | op | Read either way. |
| `home_device_set` | `home.device_set` · **Actuate** | op | **Yes** — a slider. Refuses locks and garage doors on both routes (`home/mod.rs:921`). |
| `home_scene_run` | `home.scene_run` · **Actuate** | op | **Yes** — a scene button. |
| `home_lock_set` | `home.lock_set` · **Approval** | op | **Yes, and it is the strongest case for the click distinction in the whole table.** The op always queues a card *because a model asked*; a person pressing Lock in `useSmartHome` has already performed the consent the card would collect. `useSmartHome.test.ts:292` pins that the UI never routes a lock through `home_device_set`. |
| `home_homekit_discover` | `home.discover` · Read *(cfg `homekit`, Lighthouse only)* | op | Read either way; the 2.5s budget is a constant, not an argument. |
| `home_homekit_pair` | — | **denied** — *"Needs the 8-digit setup code printed on the device — a credential a person reads off a physical label while standing in front of it — and leaves a permanent key behind."* | **Yes, and definitionally so:** the excluded capability requires a human at the accessory. `AtlasHomeKitLab.tsx:376` says this on screen. |
| `home_link_home_assistant` `home_unlink` | — | absent (reasoned) — *"Linking a bridge means taking a long-lived Home Assistant token and writing it to the Keychain… a tool that can re-point the bridge at another address can point the whole house at it"* (`ops_home.rs:5-11`) | **Yes** — the user types the token on a setup screen. |
| `home_sync` | — | absent (reasoned) — *"a bridge-wide network pull the user does not see coming. The webview and the link flow trigger it"* | **Yes**, and the note already says the webview is the intended trigger. |
| `home_set_autonomy` | — | absent (reasoned) — *"There is nothing to set"* | **Yes** — it returns `Err` by construction (`home/mod.rs:1019-1024`) and exists to explain the tier table to the UI. |
| `home_device_colour` | — | **unlisted** | Mutates a device with **no control-port equivalent at all**, so the registry's "device_set is the only way to a device value" is true of the port and not of the app. It also does not call `device_set_allowed`, the lock/garage refusal `home_device_set` does. See **G5**/**G6**. |
| `home_live_start` `home_live_stop` | — | **unlisted** | `home_live_start` opens a LAN push channel and spawns a polling thread (`home/mod.rs:1029-1052`); the doc comment says it is off by default precisely because *"an open socket is LAN traffic and a live thread."* No written decision about the model's reach. See **G5**. |

### health (5)

| IPC command | Control port | Registry status | Why webview reach is acceptable |
|---|---|---|---|
| `health_snapshot` | `health.summary` · Read | op | Read either way. |
| `health_series` | `health.metric_history` · Read | op | Read either way. |
| `health_workouts` | `health.workouts` · Read | op | Read either way. |
| `health_import` | — | **denied** — *"a file-probing primitive wearing a health tool's clothes: a model could map a disk by error message alone. It is also a capability nobody needs, because importing is a person choosing a file in a picker."* | **Yes, and the exclusion note names the webview path as the reason.** `AtlasHealth.tsx:464` is the picker plus a fallback text field. |
| `health_forget` | — | **denied** — *"'Can Atlas delete my health data on its own?' has to answer no… There is no undo and no second copy."* | **Yes** — "Atlas cannot" is the claim, and a user erasing their own data does not contradict it. But it is destructive and leaves no audit row: **G2**. |

**Totals — 60 commands in a default build, 62 with `homekit`.** Counted by command, not by op (`db_select` alone backs nine Read ops):

| Class | Count (default build) | Commands |
|---|---|---|
| Maps to a **Read** op | 19 | 5 portfolio, 6 music, 3 datafetch, `home_snapshot`, 3 health, `db_select` |
| Maps to a **Write** op | 2 | `db_insert`, `db_update` |
| Maps to an **Actuate** op | 5 | `music_play/pause/volume`, `home_device_set`, `home_scene_run` |
| Maps to an **Approval** op | 3 | `mail_mark_read`, `mail_set_status`, `home_lock_set` |
| Allowed helper, no op of its own | 1 | `music_load` |
| **`DENIED`** | 14 (15 with `homekit`) | the fourteen quoted above, plus `home_homekit_pair` |
| Absent with a written reason | 6 | `music_next/prev`, `home_link_home_assistant`, `home_unlink`, `home_sync`, `home_set_autonomy` |
| Unlisted, flagged as *unreviewed* | 3 | `portfolio_sync`, `mail_sync`, `mail_thread_fetch` |
| **No written decision anywhere** | 6 | `brain_ai_status`, `music_seek`, `home_device_colour`, `home_live_start`, `home_live_stop`, `memory_recall` (named only in an unrelated timeout comment) |
| By design, not an op | 1 | `approval_resolve` |

The "a human clicked a button" justification carries **47 of the 60** with no qualification. The other 13 are the two token-returning `*_info` commands (**G4**), the six with no written decision (**G5**), the four unpinned `db_*` primitives (**G1**–**G3**), and `mail_mark_read` (**G7**).

## Prioritised gaps

### G1 — CRITICAL: the control port's audit trail is webview-writable and webview-deletable

`db_update` (`db.rs:694`) and `db_delete` (`db.rs:710`) take a `table: String` validated only against the live schema — there is no table allowlist on the IPC route. `tool_calls` (`db_schema.sql:377`) and `approvals` (`db_schema.sql:397`) are ordinary tables in that same database. So the row `audit.rs` writes *before* dispatch — the thing that makes "Atlas archived a thread overnight" answerable — can be rewritten or removed afterwards from the webview.

The schema already contains the precedent and the precedent does **not** cover these tables:

```sql
CREATE TRIGGER IF NOT EXISTS trg_mail_audit_no_update BEFORE UPDATE ON mail_audit_events
  BEGIN SELECT RAISE(ABORT, 'mail_audit_events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_mail_audit_no_delete BEFORE DELETE ON mail_audit_events
  BEGIN SELECT RAISE(ABORT, 'mail_audit_events is append-only (erase via the account-erase path)'); END;
```

`db_schema.sql:891-894`. Nothing equivalent exists for `tool_calls` or `approvals`. `PRAGMA foreign_keys = ON` (`db.rs:209`) and `approvals.run_id REFERENCES runs(id) ON DELETE CASCADE`, so deleting one `runs` row also takes its approvals with it.

**Change:** add to `src-tauri/src/db_schema.sql`, beside the mail pair —

```sql
CREATE TRIGGER IF NOT EXISTS trg_tool_calls_no_delete BEFORE DELETE ON tool_calls
  BEGIN SELECT RAISE(ABORT, 'tool_calls is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_approvals_no_delete BEFORE DELETE ON approvals
  BEGIN SELECT RAISE(ABORT, 'approvals is append-only'); END;
```

**Delete-only, not update.** Rust legitimately UPDATEs both tables (`audit.rs:456` status transitions, `audit.rs:590` / `audit.rs:616` approval settlement), so a `BEFORE UPDATE` trigger would break `approval_resolve`. Claim exactly what this buys and no more: it stops Atlas erasing its own record through a bug or a careless `localClient.from('tool_calls').delete()`. It does not stop anyone with the file open in `sqlite3` — the existing comment at `db_schema.sql:880-890` already says so about the mail pair, and the same sentence must be written for these.

### G2 — HIGH: every mutating IPC command except mail writes no audit row

`policy.rs:118-121` calls the Write-tier audit row *"what makes 'Atlas added a task overnight' answerable instead of mysterious."* On the IPC route, none of these produce one: `db_insert`, `db_update`, `db_delete`, `home_device_set`, `home_device_colour`, `home_lock_set`, `home_scene_run`, `home_link_home_assistant`, `home_unlink`, `health_import`, `health_forget`, `brain_set_ai_key`, `music_play/pause/volume/load/seek`, `portfolio_sync`, `portfolio_disconnect`. Mail is the sole exception, and it is thorough (`mail.rs:108-133` → the protected `mail_audit_events`).

This is defensible as a decision — the user performing an action does not need to be told they performed it — but it is not currently *stated* as one, and one comment overstates what happens. `home/mod.rs:929-933` justifies emitting `changed()` with *"the audit trail and the activity strip both changed"*. The audit trail changed only when the call arrived over the control port; on the IPC path nothing was written. That is the exact failure mode the house rule about comments exists to prevent.

**Change (pick one, do not do both):**
- *Minimum, honest:* edit the comment at `src-tauri/src/home/mod.rs:929-933` to say the audit row belongs to the control-port path, and add one paragraph to the `control/mod.rs` header recording that the IPC route is deliberately unaudited and why.
- *Fuller:* a `crate::control::audit::record_user_action(app, user_id, command, args)` helper called by the mutating commands with `actor='user'`, so `tool_calls` becomes the single trail for both routes. This is a larger change than it looks: it puts a DB write on the hot path of every slider drag, so it needs a throttle or it will out-noise the reads that `policy.rs:60-70` deliberately refuses to log.

### G3 — HIGH: `user_id` is an argument on *both* routes, and one comment reads stronger than it is

Every IPC command that scopes to a user takes `user_id: String` from the caller: `mail_sync`, `mail_thread_fetch`, `mail_mark_read`, `mail_set_status`, `mail_send_reply`, all nine `home_*` user commands, all five `health_*`, `memory_recall`, `memory_upsert_vector`. There is no authenticated context in Tauri IPC at all; the webview passes `user?.id` from `useAuth` (`useAtlasMail.ts:359`) and Rust trusts the string.

The control port has **the same shape**: `control/mod.rs:628` builds the Ctx with `user_id: parsed.user_id.clone().unwrap_or_default()` — straight off the wire, from a body the brain composed. `ops_db.rs:14` states gate 3 as *"`user_id` comes from the authenticated Ctx and nowhere else."* That is true relative to the op's own arguments (a caller cannot smuggle a `user_id` filter into a table read) and it is what the sentence is for — but "authenticated Ctx" reads like the value was verified, and it was not; the bearer token authenticates *the brain*, not *the user*.

Today the exposure is theoretical: one signed-in user, one `atlas.db`. It stops being theoretical the moment two accounts share a machine.

**Change:** do not patch this per-command. Two coherent options for a later wave, both bigger than R13:
1. Resolve the local user in Rust once (there is exactly one session) and *ignore* the argument — a `DbState`-adjacent `current_user_id()`; or
2. Verify the brain's CF-issued JWT in `control/auth.rs` and derive `Ctx.user_id` from its claim.
Whichever is chosen, `ops_db.rs:14` needs its sentence narrowed to what it actually guarantees in the meantime.

### G4 — HIGH: two IPC commands hand the webview a sidecar bearer token, which is precisely what `DENIED` forbids

`atlas_brain_info` and `voice_gateway_info` return `{port, token, running, owner, integrity_error}` (`lib.rs:67-100`). `brainClient.ts:17` caches that token for the session. This is **necessary** — the webview cannot reach a token-gated local server without a token — and the "human clicked a button" argument does not apply, so it should be recorded as a deliberate asymmetry rather than left looking like an oversight.

What it means concretely, said plainly: script execution in the webview yields a full brain API session, and `POST /chat` runs the tool loop that drives the control port (`services/atlas-brain/src/index.ts:426-441`). So webview script execution reaches desktop capability **indirectly**, even though it never holds `ATLAS_CONTROL_TOKEN` — that credential is injected into the brain's process env at spawn (`lib.rs:237-241`) and is a different value from the sidecar token. The mitigations that make this acceptable are real and should be named where they can be found: the tokens are per-launch, 127.0.0.1-only, and the CSP is `default-src 'self'` with no remote script origin (`tauri.conf.json:26`).

**Change:** a paragraph in the `src-tauri/src/control/mod.rs` header describing the webview→brain→control-port chain and naming the CSP as the thing that holds it shut, plus a line in `registry.rs`'s absence note for the two `*_info` commands acknowledging that the webview gets what the port refuses, and why. No code change; the current behaviour is correct.

### G5 — MEDIUM: six commands have no written decision anywhere

`brain_ai_status`, `music_seek`, `home_device_colour`, `home_live_start` and `home_live_stop` are named nowhere in `src-tauri/src/control/`, and `memory_recall` appears only inside an unrelated comment about op timeouts (`control/mod.rs:181`) — not in `OPS`, not in `ALLOWED_COMMANDS`, not in `DENIED`, not in an absence note. The registry's whole discipline is that absence is a decision somebody wrote down; for these five it is a decision nobody made. Two deserve real thought rather than a rubber stamp:

- `home_device_colour` mutates a device and has **no** control-port equivalent, so a model can set a light's brightness (Actuate, audited, rate-limited) but colour is simply not on the menu. That is a coherent position; it just isn't recorded. It also skips `device_set_allowed`, so unlike `home_device_set` it does not refuse a lock or garage target — moot in practice (a lock has no colour and the bridge rejects), which is an argument for a one-line comment, not for leaving it silent.
- `home_live_start` spawns a thread and opens a LAN push channel — a resource commitment, and exactly the kind of thing `ops_home.rs` excludes `home.sync` for.

**Change:** add these six to the absence-notes block above `OPS` in `src-tauri/src/control/registry.rs` (the block at :77-186), with a reason each. That block is already the canonical place; it just has holes.

### G6 — MEDIUM: nothing pins the IPC surface, the way `EXPECTED_TIERS` pins the ops

`generate_handler!` occurs exactly once in the tree (`lib.rs:491`) and no test reads it. `registry.rs`'s guards read `RUNNER_SOURCES` and `OPS`; `lib.rs` is in neither. So a `#[tauri::command]` added to `db.rs` or `home.rs` and registered in the handler block is webview-reachable immediately, reviewed by nobody, and fails no test. That is the same class of hole the allowlist inversion (task #34) closed on the control-port route — closed there, still open here.

**Change:** the cheapest high-value item in this ADR. Add a test module to `src-tauri/src/lib.rs` (or a new `src-tauri/src/ipc_surface.rs` declared from it) that `include_str!("lib.rs")`s, extracts the identifiers between `generate_handler![` and its closing `]`, and asserts set-equality against an `EXPECTED_IPC_COMMANDS: &[&str]` constant — modelled line-for-line on `every_op_carries_the_tier_a_human_wrote_down` (`registry.rs:1667`), including the `#[cfg(feature = "homekit")]` handling that `declared_runners()` already demonstrates (`registry.rs:1099-1121`). Adding a command then costs one reviewed line, which is the entire point.

### G7 — LOW, named for honesty: `mail_mark_read` is fired by an effect, not a click

It is `Tier::Approval` on the control port — *never* auto-runs, on either profile, because the model calling it has just read attacker-authored text. On the IPC route it fires from a React effect when a thread is opened (`useAtlasMail.ts:733-736`, which says so itself). The human act is real (opening the thread), the intent is the same, and the code is already careful to make the no-op path inert. This is not a defect. It is the one place where the sentence "a human clicked a button" is literally untrue, and it belongs in the record rather than in a footnote.

### G8 — LOW: no rate limit on the IPC route

`policy.rs`'s buckets are process-wide but consulted only in the control dispatcher (`control/mod.rs:638`). A render loop calling `home_device_set` has nothing between it and the bridge. The webview is our own code and the failure mode is a bug, not an attack — recorded, not recommended for change.

### G9 — LOW: three stale counts, in files whose job is to be countable

- `registry.rs:11-15` — the header says *"Actuate (3) music transport"* and *"Approval (2) mail mutations."* The table now holds **5** Actuate (music.play/pause/volume, home.device_set, home.scene_run) and **3** Approval (home.lock_set, mail.archive, mail.mark_read). `EXPECTED_TIERS` is correct; the summary above it is not.
- `registry.rs:730` — *"`DENIED` below proves 'not these twelve'"*; `DENIED` has **15** entries. (The absence-notes header at :79 correctly says fifteen.)
- `docs/audit/2026-08-11-refactor-plan.md:124` — *"all 26 webview-reachable commands"*; there are **60**.

**Change:** three one-line edits, in `src-tauri/src/control/registry.rs` and `docs/audit/2026-08-11-refactor-plan.md`.

## The injected-content check

The task asked whether `MailReadingPane.tsx`'s claim is true rather than aspirational. It is true, and so is the wider version.

**Verified at `src/components/atlas-ui/mail/MailReadingPane.tsx:93-95`:**

```jsx
{/* body_html is deliberately not rendered: remote mail is untrusted
    input, and the pane has no sanitiser. Plain text only. */}
<div className="mail-msg-body">{m.extracted?.body_text || m.snippet || '(no text body stored)'}</div>
```

`body_html` exists on the type (`src/types/mail.ts:67,158`), is written by `mail.rs:894` and carried by `useAtlasMail.ts:231` — and is read by no renderer. The body renders as a React text child, which escapes. Attachments are metadata only, with nothing clickable (`MailReadingPane.tsx:107-110`). `src/styles/mail.css:187` repeats the rule.

**A repo-wide sweep for the same class of hole found three other things, none of them a live path:**

| Site | What it is | Verdict |
|---|---|---|
| `src/components/ui/chart.tsx:70` | `dangerouslySetInnerHTML` on a `<style>` tag, built from a local `ChartConfig` | Stock shadcn. **Imported by nothing** in `src/` — dead file. No remote input can reach it. |
| `src/components/architecture/*.tsx` (4 files, 6 sites) | `ref.innerHTML = svg` from `mermaid.render(...)` | Every diagram source is a module-level template literal in the same file (`ArchitectureOverview.tsx:11`, `MemoryArchitectureSection.tsx:9,44`, `LearningPipelineSection.tsx:12`, `AIProvidersSection.tsx:12,29`). No remote input. **But** all four initialise with `securityLevel: 'loose'`, which permits HTML labels and click bindings in mermaid source — the setting that would matter the day a diagram string stops being a literal. |
| `src/components/atlas-ui/answerViews/AnswerBlocks.tsx:11` | A comment, not a call: model output on the `web_search` path *"contains text the model read off a third-party page — `dangerouslySetInnerHTML` on that would be a script injection with extra steps."* Inline markdown is rendered as React nodes through a four-alternative regex (`AnswerBlocks.tsx:19`) | The riskiest text in the app, handled correctly. |

**Suggested standing guard (optional, cheap):** change `securityLevel: 'loose'` → `'strict'` in the four `src/components/architecture/*.tsx` files. Nothing renders today that needs loose; verify the diagrams still draw, since `htmlLabels: true` interacts with it.

One CSP note, since it is adjacent: `img-src 'self' data: blob: https:` (`tauri.conf.json:26`) permits any remote image. Nothing renders remote-authored image URLs today — mail bodies are plain text and attachments are not links — so this is not currently reachable. It is the constraint to remember if a mail HTML view is ever built.

## What I could not determine

Stated so nobody reads confidence into it that this analysis does not have. **This was a static read of the tree at `1b3dd40`; nothing was executed, built, or run.**

1. **Whether the multi-user exposure in G3 is reachable at all.** It depends on whether a single `atlas.db` ever holds rows for two `user_id`s. Determining that needs a real app run with two accounts (task #38's territory), not a source read.
2. **Whether any op or command actually behaves as declared at runtime.** Task #38 ("Runtime-verify the control port end to end") is still open, and V3 in the plan calls the 560 unit tests' missing complement an integration test that binds a real port. Every tier claim in the table above is read off `EXPECTED_TIERS` and `policy::decide`, not observed.
3. **Whether `db_update`/`db_delete` on `tool_calls` actually succeeds.** G1 is derived from the schema (no triggers) plus the command signature (arbitrary table). I did not execute it against a live database, and there could be a runtime constraint I did not find.
4. **Whether `music_seek` works.** `music_next`/`music_prev` are documented as no-ops against the one-track queue; whether `seek` shares that fate is a `music_engine.rs` question I did not chase.
5. **Whether the two `homekit`-gated commands change anything else about the surface.** I read the `cfg` attributes; I did not build both configurations to compare.
6. **The webview's real script-execution risk.** G4's chain is only interesting if something can execute unintended script in the webview. The CSP forbids remote script origins, but I did not audit every dependency for an eval-shaped path, and CSP enforcement inside WKWebView under Tauri was not tested.
7. **Whether `mail_ingest_errors`' passthrough is safe to render.** `MailIngestErrors.tsx:23` describes it as a verbatim passthrough of worker output; I confirmed it is not rendered as HTML, but I did not review what the worker can be made to put in those strings.

## Consequences

The IPC surface is not, today, the hole it looks like from a distance: 51 of 60 commands are genuinely a person operating their own app, and the exclusions that matter most on the control port (`music_connect`, `portfolio_connect_url`, `home_homekit_pair`, `health_import`) are excluded *precisely because* the webview is the right place for them. The registry's absence notes are unusually good and several of them already name the webview as the intended path.

What is missing is not tiers on IPC. It is four narrower things: an append-only guarantee for the tables that record what the model did (**G1**), an honest statement of where the trail stops (**G2**), a decision written down for the five commands nobody has decided about (**G5**), and a test that makes the surface countable so the next command costs one reviewed line (**G6**). G6 and G1 are small and should go into Wave 2's tail. G3 is a real design question and should not be attempted piecemeal.
