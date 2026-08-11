# ADR 012 — Alarms that fire while Atlas is quit (launchd LaunchAgent spike)

**Status:** accepted · **Date:** 2026-08-11 · **Verdict:** **NO-GO**

## Verdict

**NO-GO.** Do not ship a LaunchAgent-backed alarm. Atlas alarms fire **only
while Atlas is running**, and the Clock surface must say so plainly.

Three independent findings each kill it on their own, and all three were
reproduced by hand on this Mac (macOS 26.3, build 25D125, arm64) today:

1. **`StartCalendarInterval` does not fire at the requested wall-clock time on
   this machine.** Five agents were bootstrapped with explicit `Hour`/`Minute`.
   Zero fired. `UserEventAgent` registered every one of them for the requested
   minute at **hour − 10**. Apple's own `com.apple.appleseed.seedusaged` — a
   plain `{Hour: 12}` agent in `/System/Library/LaunchAgents` — is affected
   identically and actually spawns at ~02:0x. An alarm clock that fires ten
   hours off is not an alarm clock.
2. **Nothing Atlas can run is allowed to wake the Mac.** `IOPMSchedulePowerEvent`
   returns `kIOReturnNotPrivileged` to a non-root process. Waking requires root,
   which requires a privileged helper, which requires a Developer ID signature.
3. **An unsigned helper started by launchd hangs forever behind a Gatekeeper
   prompt.** A quarantined, ad-hoc-signed binary spawned by launchd never got
   past `_dyld_start`; `syspolicyd` logged `Prompt shown (6, 0), waiting for
   response`. At 07:00 with the lid shut, that prompt is the alarm.

Fixing (3) costs 99 USD/yr and a notarization pipeline. Fixing (2) additionally
costs a root helper and an admin-password prompt. **Neither fixes (1)**, and (1)
is the one Atlas has no lever on at all.

## Context

`docs/design-sync/2026-08-11-prompt-clock.md` specifies an Atlas Clock with an
Alarm mode, and states as a shaping decision: *"alarms fire even when Atlas is
quit."* Nothing in the product does this today. The only background timer is
`src-tauri/src/scheduler.rs` — a `std::thread` on a 30-minute `recv_timeout`
tick doing one HTTP POST to the brain sidecar — and it dies with the app. tokio
is deliberately built without the `time` feature (`scheduler.rs:11-14`), so
there is not even an in-process timer wheel to extend.

This ADR is the go/no-go on the standard macOS mechanism for out-of-process
scheduling: a per-user LaunchAgent in `~/Library/LaunchAgents`.

**Spike hygiene.** Every test label was namespaced
`dk.helloatlas.spike.1786446541.*`, every plist lived in a scratch directory
(never `~/Library/LaunchAgents`), and every job was bootstrapped by explicit
path and booted out afterwards. Teardown is verified at the end of this
document.

## Evidence

### 1. A LaunchAgent does load and does fire — `StartInterval` works perfectly

`bootstrap`/`bootout` are the current verbs; `launchctl help` on 26.3 says so
outright:

```
load      Recommended alternatives: bootstrap | enable. …
unload    Recommended alternatives: bootout | disable. …
```

The two invocations that work, with no `sudo` and no file in
`~/Library/LaunchAgents`:

```console
$ launchctl bootstrap gui/$UID /path/to/spike.plist    # exit 0
$ launchctl bootout   gui/$UID/dk.helloatlas.spike.1786446541.interval
```

A `StartInterval = 10` agent pointing at a shell script fired **104 times in 17
minutes, on the second, every time**:

```
2026-08-11T11:09:38Z label=interval pid=47754 ppid=1 user=magnuspilegaard
2026-08-11T11:09:48Z label=interval pid=47840 ppid=1 user=magnuspilegaard
2026-08-11T11:09:58Z label=interval pid=47862 ppid=1 user=magnuspilegaard
…
```

`launchctl print` confirms a clean per-run lifecycle — `runs = 1`,
`last exit code = 0`, `ran for 303ms`, spawned by `launchd[1]` via `xpcproxy`,
`spawn type = daemon (3)`, `PATH => /usr/bin:/bin:/usr/sbin:/sbin`.

**So the mechanism itself is available to this account.** That is the only part
of the spike that succeeded.

### 2. `StartCalendarInterval` fires at the wrong hour — the finding that ends it

Five agents, all valid per `plutil -lint`, all bootstrapped `exit 0`, all with
`RunAtLoad = false` so the only way to run is the schedule:

| label | requested | fired? |
|---|---|---|
| `.calendar` | 13:11 | no |
| `.calendar2` | 13:17 | no |
| `.calendar3` | `{Hour: 13}` | no |
| `.calendar4` | 13:26 | no |
| `.calendar5` | 13:32 | no |

```console
$ grep 'label=calendar' fired.log
NO — 0 fires across 5 calendar jobs
$ launchctl print gui/501/dk.helloatlas.spike.1786446541.calendar4 | grep 'runs ='
	runs = 0
```

`launchctl print` shows the trigger *was* registered correctly — the descriptor
launchd holds is exactly what was asked for:

```
	event triggers = {
		dk.helloatlas.spike.1786446541.calendar.268435470 => {
			stream = com.apple.launchd.calendarinterval
			monitor = com.apple.UserEventAgent-Aqua
			descriptor = { "Minute" => 11  "Hour" => 13 }
		}
	}
```

The corruption happens one layer down, in `UserEventAgent`, and the unified log
prints the date it actually committed to:

```console
$ log show --predicate 'subsystem == "com.apple.xpc.activity"' | grep 'Registered StartCalendarInterval'
… Registered … .calendar.268435470:  onsdag den 12. august 2026 kl. 03.11.00 CEST
… Registered … .calendar2.268435471: onsdag den 12. august 2026 kl. 03.17.00 CEST
… Registered … .calendar3.268435472: onsdag den 12. august 2026 kl. 03.00.00 CEST
… Registered … .calendar4.268435473: onsdag den 12. august 2026 kl. 03.26.00 CEST
… Registered … .calendar5.268435474: onsdag den 12. august 2026 kl. 03.32.00 CEST
```

Requested 13:11 → committed 03:11. The **minute is preserved exactly; the hour
is shifted by −10**. Three more agents pin the rule down (system TZ is
`Europe/Copenhagen`, `+0200`, clock correct against `date -u`):

| requested | registered |
|---|---|
| 20:45 | 10:45 next day |
| 05:05 | 19:05 same day |
| 00:30 | 14:30 same day |
| 13:11 | 03:11 next day |

`(H − 10) mod 24`, six for six.

**This is not something Atlas triggered, and not an artefact of bootstrapping
from a scratch path.** Apple's own agent shows it too.
`com.apple.appleseed.seedusaged` is a stock `/System/Library/LaunchAgents` job
whose descriptor is `{Hour: 12}` and whose `runs` counter is 18 — so it does
run. It just does not run at noon:

```console
$ log show --last 72h --predicate 'process == "launchd"' | grep 'Successfully spawned seedusaged'
2026-08-10 02:03:54.753  … Successfully spawned seedusaged[10649] because xpc event
2026-08-11 02:13:29.650  … Successfully spawned seedusaged[39504] because xpc event
```

Noon becomes ~02:0x, and the offset is **not stable** — 9h56m on Aug 10, 9h47m
on Aug 11. A drifting error, not a designed maintenance window.

The likely mechanism is state in `UserEventAgent` (pid 440, alive **18 days**,
since Jul 24) rather than a policy: the subsystem is `com.apple.xpc.activity`,
whose whole job is to defer work, and the error moves day to day. But the cause
does not change the decision. Atlas cannot detect this, cannot correct for it,
and cannot restart a system agent on the user's Mac. **`StartCalendarInterval`
is not a usable alarm primitive here.**

`StartInterval` is exact, so a "wake every 60s and check a due-list" helper
would sidestep the hour bug — but `man launchd.plist` is explicit that it does
not survive sleep, which is the entire requirement:

> **StartInterval** … If the system is asleep during the time of the next
> scheduled interval firing, that interval will be missed due to shortcomings
> in kqueue(3).
>
> **StartCalendarInterval** … Unlike cron which skips job invocations when the
> computer is asleep, launchd will start the job the next time the computer
> wakes up. If multiple intervals transpire before the computer is woken, those
> events will be coalesced into one event upon wake from sleep.

So even in a world where the hour were correct: launchd fires a missed alarm
**on wake**, which for a 07:00 alarm on a lid-shut MacBook means it rings when
the user opens the lid at 09:00. launchd never wakes the machine.

### 3. Waking the Mac requires root — verified, not assumed

`pmset -g sched` shows the machine already carries two wake events, both from
Apple daemons:

```console
$ pmset -g sched
Scheduled power events:
 [0]  wake at 08/11/2026 18:39:31 by 'com.apple.alarm.user-invisible-com.apple.calaccessd.travelEngine.periodicRefreshTimer'
 [1]  wake at 08/12/2026 01:33:17 by 'com.apple.alarm.user-invisible-com.apple.acmd.alarm'
```

So the capability exists on this hardware (`powernap 1`, `standby 1`,
`hibernatemode 3`). It is just not reachable from Atlas.

`pmset` refuses without root — but that is `pmset`'s own euid guard, not proof
about the API, so it was tested both ways. **Nothing was armed:** the CLI probe
*cancels* an event that does not exist, and the IOKit probe checks the event
count before and after.

```console
$ pmset schedule cancel wake "01/01/2030 12:00:00"
pmset: This operation must be run as root
exit=1
```

The decisive test — `IOPMSchedulePowerEvent` called directly from a plain
uid 501 process (`scratch/pmprobe.c`, ad-hoc signed exactly like an Atlas
build):

```console
$ ./pmprobe 240
euid=501 uid=501
--- scheduled events before: 2 ---
IOPMSchedulePowerEvent(wake, +240s) -> 0xe00002c1 (kIOReturnNotPrivileged)
--- scheduled events after schedule: 2 ---
```

`kIOReturnNotPrivileged`. Event count 2 → 2; `pmset -g sched` afterwards is
byte-identical to before. **A non-root process cannot schedule a wake, full
stop**, and `man pmset` agrees: *"pmset must be run as root in order to modify
any settings."*

To wake the Mac, Atlas would need a root LaunchDaemon, which means
`SMAppService`/`SMJobBless`, which means a Developer ID signature **and** an
admin-password prompt at install. Note also that `calaccessd` — the user agent
that owns wake event [0] — is a per-user LaunchAgent with **no
power-management entitlement of any kind** (`codesign -d --entitlements`
returns nothing matching `power`/`wake`/`alarm`), so Apple's alarm path runs
through private machinery that is not a public API we can copy.

### 4. Signing — an unsigned helper does not fail, it *hangs*

Atlas today, as installed:

```console
$ codesign -dvvv /Applications/Atlas.app
CodeDirectory v=20400 … flags=0x20002(adhoc,linker-signed)
Signature=adhoc
Info.plist=not bound
TeamIdentifier=not set
Sealed Resources=none

$ spctl -a -vvv -t exec /Applications/Atlas.app
/Applications/Atlas.app: code has no resources but signature indicates they must be present
```

Ad-hoc, no Team ID, and Gatekeeper already rejects the bundle
(`tauri.conf.json:62` `"signingIdentity": null`, hardened runtime on; see
`docs/RELEASE.md` §1 — no Apple Developer Program).

Two agents were bootstrapped against helpers carrying a
`com.apple.quarantine` xattr, to simulate an app the user downloaded:

- **Quarantined shell script** → **ran fine**, 73 times. Gatekeeper assesses the
  interpreter (`/bin/bash`, Apple-signed), not the script text.
- **Quarantined ad-hoc Mach-O** → **spawned and hung forever.**

```console
$ launchctl print gui/501/dk.helloatlas.spike.1786446541.qhelper | grep -E 'state|runs|last exit'
	state = running
	runs = 1
	last exit code = (never exited)

$ sample 49657 1
Call graph:
    808 Thread_17201381: Main Thread
      808 _dyld_start  (in dyld) + 0
```

A program whose entire body is one `fprintf` never left `_dyld_start`. The
unified log says exactly why:

```console
$ log show --predicate 'subsystem == "com.apple.syspolicy.exec"'
13:14:53.081 E  syspolicyd: Error Domain=GatekeeperPolicyScanError Code=-67018
                "Code did not match any currently allowed policy"
13:14:53.347 Df syspolicyd: GK evaluateScanResult: 0, PST: … (id: helper), (bundle_id: NOT_A_BUNDLE)
13:14:53.347 Df syspolicyd: Prompt shown (6, 0), waiting for response: PST: … (id: helper)
```

**`Prompt shown … waiting for response`.** launchd started the helper on
schedule and macOS put a Gatekeeper dialog on screen and blocked the process
until a human answered it. `syspolicyd` was still calling out to Apple's
notarization service a minute later (`Error checking with notarization daemon:
3`, then QUIC/TLS traffic). This is the worst possible failure mode for an
alarm: not a silent no-op that could be detected and reported, but an
indefinite block behind a modal the sleeping user cannot answer.

Answers to the four signing sub-questions:

- **Today (unsigned):** a *script* helper runs; a *binary* helper hangs behind a
  Gatekeeper prompt as soon as the app arrives with a quarantine bit — i.e. for
  every real user, since only locally-built copies escape quarantine. The
  developer's own machine is the one place this bug does not reproduce.
- **After Developer ID + notarization:** the Gatekeeper block goes away
  (`GatekeeperPolicyScanError -67018` is precisely "not signed by an accepted
  authority"). Nothing else in this ADR changes — not the hour shift, not
  `kIOReturnNotPrivileged`.
- **Must the helper live in the bundle?** For a *script*, no. For anything
  signed, effectively yes: the plist should point at a binary inside
  `Atlas.app/Contents/…` so it inherits the bundle's Developer ID and gets
  re-signed with each release, and so that deleting the app deletes the helper.
  A standalone binary copied to `~/Library/Application Support` needs its own
  signature and re-notarization, and orphans itself on uninstall.
- **What the user sees:** an agent installed as a plist in
  `~/Library/LaunchAgents` is registered with Background Task Management. The
  EA app's agent on this Mac shows the shape of it —
  `Type: legacy agent (0x10008)`, `Flags: [ legacy ]`,
  `Team Identifier: TSTV75T6Q5`, `Disposition: [enabled, allowed, notified]`,
  pointing at both the plist and the executable inside `/Applications`. So the
  user gets a *"Atlas added items that can run in the background"* notification,
  plus a permanent toggle in **System Settings → General → Login Items &
  Extensions** that they can flip off at any time — silently disabling every
  alarm. Unsigned, the row has no Team Identifier and no developer name to show.
  Not a TCC prompt; a Gatekeeper + BTM prompt. (The spike's agents were
  bootstrapped by explicit path and therefore never registered with BTM —
  confirmed absent from `sfltool dumpbtm`.)

## Decision

1. **Alarms fire only while Atlas is running.** Implement them in-process. The
   existing `ProactiveScheduler` pattern in `src-tauri/src/scheduler.rs`
   (`std::thread` + `mpsc::recv_timeout` as an interruptible sleep) already fits
   — a second thread with a short tick over a due-list needs no new tokio
   features and stops cleanly on exit, same as `stop()` does today.
2. **The Clock UI must say so, in the alarm list, not in a settings footnote.**
   The design brief's consent moment (`docs/design-sync/2026-08-11-prompt-clock.md`)
   becomes a statement of fact instead: *"Alarms ring while Atlas is open."*
   Nothing about it should imply the Mac will wake.
3. **Ship a "quit with alarms armed" guard.** Quitting Atlas with an enabled
   alarm is now a silent data-loss-shaped event and needs a confirmation.
4. **Do not install a LaunchAgent for any purpose while the app is unsigned.**
   The hang in §4 applies to *any* bundled binary helper, not just alarms.
5. **Revisit only if all three change:** Developer ID + notarization ships, a
   root helper with an admin prompt is acceptable, and
   `StartCalendarInterval` is confirmed accurate on a current macOS. Retest with
   the probes preserved below before believing any of it.

## What could NOT be determined

- **Whether the −10h `StartCalendarInterval` shift is a macOS 26.3 defect or a
  drift in this Mac's 18-day-old `UserEventAgent` (pid 440).** Distinguishing
  them means restarting a system agent or rebooting the user's machine, which
  was out of scope for a read-mostly spike. The drifting offset (9h56m → 9h47m
  across two days of `seedusaged`) points at accumulated state rather than
  policy. **This is the single biggest open risk**: if it is machine-local, the
  primitive might be sound elsewhere — but Atlas ships to machines it does not
  control and cannot detect the condition, so the decision stands either way.
- **Behaviour of a notarized helper.** No Developer ID certificate exists on
  this machine, so "the Gatekeeper block disappears once notarized" is inferred
  from the `-67018` verdict, not observed.
- **Whether a root LaunchDaemon's `StartCalendarInterval` is also shifted.**
  Testing needs root and a system-domain bootstrap; not attempted.
- **Real sleep/wake behaviour.** Nothing here was tested across an actual sleep
  cycle — the machine was awake throughout, deliberately. The sleep claims in
  §2 come from `man launchd.plist`, quoted verbatim above.
- **Whether the Gatekeeper dialog left anything on screen.** The blocked process
  was booted out and killed within ~40s and `launchctl print` now fails for the
  label, but `osascript` could not enumerate windows (Accessibility TCC not
  granted, and not granted for this spike). **Worth a glance at the screen.**

## Teardown — verified

Eleven agents were bootstrapped over the session. All eleven are gone:

```console
$ launchctl list | grep -i helloatlas
OK: no helloatlas labels in launchctl list

$ for j in interval calendar calendar2 calendar3 calendar4 calendar5 \
           qfire qhelper tzA tzB tzC; do
    launchctl print gui/501/dk.helloatlas.spike.1786446541.$j
  done
gone: …interval      gone: …calendar    gone: …calendar2   gone: …calendar3
gone: …calendar4     gone: …calendar5   gone: …qfire       gone: …qhelper
gone: …tzA           gone: …tzB         gone: …tzC
```

(`bootout` of `.qhelper` returned `rc=3 No such process` — it had already been
torn down when its Gatekeeper hang was found.)

- `~/Library/LaunchAgents/` — **never written to**; still the same four
  pre-existing third-party plists.
- `pmset -g sched` — byte-identical to the start of the session; the only two
  entries are Apple's, and no probe ever armed anything.
- `sfltool dumpbtm` — no `helloatlas` record.
- All plists, probes and logs live in the session scratch directory, outside the
  repo and outside the user's home.

## Where this is recorded

- `src-tauri/src/scheduler.rs:11-14` — the existing comment explaining why there
  is no tokio timer; the in-process alarm thread should follow the same pattern.
- `docs/design-sync/2026-08-11-prompt-clock.md` — the design brief that asked
  for "alarms fire even when Atlas is quit"; that line is superseded by this
  ADR.
- `docs/RELEASE.md` §1 — the two signing systems, and why Apple signing is not
  available yet. This ADR is another cost of that gap.
