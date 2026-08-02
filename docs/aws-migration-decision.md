# Atlas → AWS migration — decision record

## UPDATE 2026-08-02 — DECISION: EEA confinement withdrawn; non-EU models permitted

**Reverses the residency position taken on 2026-07-28**, which is restated in several places below and should be read as superseded wherever it appears.

**Why.** The EEA-only rule was costing us the frontier tier outright. Fable 5 has **no `eu.` inference profile in existence**, and Sonnet 5 / Opus 5 / Opus 4.8 have never returned a successful `InvokeModel` in `eu-central-1`. Staying EEA-confined therefore meant staying permanently a model tier below the best available — not as a temporary entitlement wait, but structurally. Capability won.

**What changed, precisely:**

| | Before | After |
|---|---|---|
| Guard | `assertEeaProfile` — threw on non-`eu.` unless `ATLAS_BEDROCK_ALLOW_NON_EEA=1` | `assertAllowedProfile` — permits non-`eu.`; `ATLAS_BEDROCK_EEA_ONLY=1` restores confinement |
| `TIER_DEFAULT` | all `eu.` | **all `eu.` — unchanged** |
| Rust env forwarding | `AWS_*` + `ATLAS_AI_PROVIDER` only | + five `BEDROCK_MODEL_*` overrides + `ATLAS_BEDROCK_EEA_ONLY`, from the Keychain |
| IAM | `inference-profile/eu.anthropic.claude-*` | + `global.anthropic.claude-*` (us-east-1 ARN) + `foundation-model/anthropic.*` |
| Privacy policy | background tier "processed inside the EEA", explicitly *not* a transfer | split withdrawn; AWS listed as a third-country transfer on an SCC basis |

**Three things deliberately NOT done, each for a reason worth keeping:**

1. **No default moved.** Permitting a non-EEA profile and routing to one are separate decisions; only the first was taken. An ordinary install still runs entirely on `eu.` profiles. Guarded by a test.
2. **Fable 5 still has no `TIER_DEFAULT` entry.** Not for residency reasons any more — for the rule that binds every tier: a default may only name a profile a live `InvokeModel` has answered on. Nothing has invoked Fable yet.
3. **The guard was inverted, not deleted.** With the `foundation-model/anthropic.*` wildcard in IAM, the policy is now a *name filter* rather than a geographic boundary, so `ATLAS_BEDROCK_EEA_ONLY=1` is the only remaining containment control. It is also the one-line revert, and the switch an enterprise/DPA-constrained deployment would turn on.

**Outstanding, in order:** ① account owner applies `docs/aws-iam-bedrock-invoke-policy.json`; ② account owner requests model access in **us-east-1** (separate from eu-central-1) and does the per-model Marketplace bootstrap invoke; ③ live-invoke verification, then promote a default in a commit citing it; ④ **deploy the privacy policy — this must be live before any non-EEA profile serves a real request.**

Full checklist: `docs/aws-bedrock-non-eea-enablement.md`.

---

## UPDATE 2026-07-28 — DECISION: Path A now (Bedrock, credits), designed for a one-flip move to B

Supersedes the "recommend B / hybrid" framing below. Reason: **we are credit-dependent now**, so inference runs on Bedrock (credit-eligible — `AmazonBedrockFoundationModels` confirmed on the FOUNDERS allowlist). The plan is built so migrating to **Claude Platform on AWS (Path B)** later is a **config flip, not a rewrite**.

**Two corrections to the original synthesis (found via the user's links):**
1. **Bedrock *does* have web search — via AgentCore** (MCP Gateway, `us-east-1` only, $7/1k). Credit-eligible (AgentCore is on the allowlist). But it is a heavy Gateway/MCP re-architecture **and it is exactly the piece that becomes throwaway under B** (B uses the native `web_search` tool). So we **deliberately do NOT build AgentCore.**
2. **Bedrock has native batch inference** (50% off) — the digest can batch there. (No Anthropic *Batches API*, that's first-party/P-AWS only.)

**The migration-friendly architecture:**
- Provider is a config value: `ATLAS_AI_PROVIDER = bedrock` (now) → `aws` (Path B) is a one-line flip. Bedrock, P-AWS and first-party all speak the **same Messages API** and Bedrock+P-AWS share the **same SigV4 auth + AWS creds** — B differs only in endpoint, model-id prefix (`eu.anthropic.` → bare), and one tool.
- **Capability routing:** everything except web-search chat → Bedrock (credits, and where the token volume is). The thin **web-search-chat slice → first-party Anthropic** for now (small real $), because it is the one thing Bedrock's Messages API can't serve. That special-case is the **only** provider branch and it **evaporates on the flip to B** (P-AWS serves native web search).
- **Honest cost while on credits:** web-search-chat runs real money (single-digit $/mo at current volume). That's the price of staying credit-max without building the throwaway AgentCore rig.

**Built + verified (2026-07-28):** `supabase/functions/_shared/awsSigV4.ts` — runtime-neutral (pure WebCrypto, no dep, works verbatim under Deno edge + Bun) SigV4 signer, shared by Bedrock/P-AWS/SES/S3. 5 tests pass incl. AWS's published `get-vanilla` vector reproduced exactly. This is the auth foundation for every AWS piece; because A and B share it, the B-migration auth is already done.

**Also built + verified (2026-07-28, commit `fa1d7f6`):** `_shared/bedrockAdapter.ts` + the `aiGateway.ts` seam.
- `mapModelToBedrock()` with the `BEDROCK_ID` short-circuit — the `startsWith("claude-")` trap flagged in §1 is handled, and per-tier ids are env-overridable (`BEDROCK_MODEL_{HAIKU,SONNET,OPUS,OPUS_5,FABLE_5}`) so a wrong id is a config fix, not a redeploy. **Caveat:** `src-tauri/src/lib.rs` forwards only `AWS_*` + `ATLAS_AI_PROVIDER` to the brain sidecar, and a Finder-launched `.app` inherits no shell env — so these overrides are a dev/CI lever, not something a shipped build can turn. For the Fable entry that is deliberate.

**Model mapping — Opus 5 / Fable 5 (2026-07-28).** Both are now *named* tiers, neither is a default:
- **Opus 5 — residency-clean, entitlement-blocked.** `eu.anthropic.claude-opus-5` exists and matches the `eu.anthropic.claude-*` IAM resource, so it costs **zero policy change**. But it has never returned a successful `InvokeModel`, and listing ≠ entitlement (the trap that already caught sonnet-5 / opus-4-8 / opus-4-7). So the `claude-opus-5` tier key resolves to the verified `eu.anthropic.claude-opus-4-6-v1` and the new id is reachable only via `BEDROCK_MODEL_OPUS_5`. **Promote it to the default table only in a commit whose message cites a live invocation** — a wrong default is user-visible on Bedrock, since a streaming `AccessDeniedException` arrives as an in-band frame and is injected into the transcript as text.
- **Fable 5 — residency-blocked, full stop.** There is **no `eu.` Fable profile**; the only one is `global.anthropic.claude-fable-5`, and a `global.` cross-region profile routes worldwide by definition. Bedrock has no `inference_geo` escape hatch (that is P-AWS-only, noted below) — **on Bedrock the EU guarantee IS the profile prefix.** Enabling it would require *both* widening `AtlasBedrockInvoke` to the global profile ARN **and** the underlying `arn:aws:bedrock:*::foundation-model/…` wildcard (which turns the policy from a containment mechanism into a name filter), *and* rewriting the §7 privacy delta below: the "EU win" bullet would have to be **deleted**, the §6 country cell would split ("EU for background summarisation; US/global for frontier reasoning"), and §8 would gain an AWS third-country-transfer entry on an SCC basis. Fable additionally mandates 30-day retention and is unavailable under zero-data-retention. It therefore has **no default entry at all** (mapping throws) and needs *two* deliberate env vars to reach.
- **Residency is now enforced in code, not only in IAM.** `mapModelToBedrock` refuses any resolved id that is not `eu.` unless `ATLAS_BEDROCK_ALLOW_NON_EEA=1`. Previously IAM was the single point of failure — one console edit would have silently unlocked worldwide routing, since `BEDROCK_ID` whitelists `global.` for passthrough. Never set that flag in a shipped build. **↳ REVERSED 2026-08-02 — see the update at the top of this file. The flag is now `ATLAS_BEDROCK_EEA_ONLY=1` and the default is permissive.**
- **Unknown tiers now throw at map time** instead of synthesising `eu.anthropic.${tier}`. That old fallback invented plausible-looking profile ids with no existence check — for Fable it invented a broken one.
- **`thinking` is stated, not implied.** `toBedrockRequest` drops `thinking`/`output_config`, which means *no thinking* on Opus 4.6 but *thinking on* for Opus 5 (and unconditionally for Fable 5). With `DEFAULT_MAX_TOKENS = 4096` capping thinking + text together, that would truncate background summaries and cost materially more — so the adapter sends `thinking: {type:"disabled"}` explicitly for Opus 5, and omits it for Fable 5 (which 400s on `disabled`).
- **Streaming needed more than expected:** Bedrock streams the AWS binary event-stream (`application/vnd.amazon.eventstream`), not `text/event-stream`. Each frame wraps a base64 Anthropic SSE event, so the adapter carries a frame decoder that buffers across reads and surfaces post-header exception frames *inside* the stream (the only way a throttling error reaches the user).
- `ATLAS_AI_PROVIDER=bedrock` switch; the Bedrock branch **fails closed** like the Anthropic one (no silent fall-through to another processor when AWS creds are missing).
- Capability router: `web_search`/`web_fetch` turns bridge to first-party; without a bridge key it degrades (drops server tools) rather than 400ing.
- Verified: 13 adapter/signer tests, 91/91 brain tests, `tsc -b` exit 0, `deno check` exit 0 (both runtimes, since `_shared/*` is imported verbatim by each).

**Correction to §6 below:** `generateEmbedding()` is **NOT dead code.** It has seven live callers, including `orchestrator.ts:776`'s recall fallback (`deps.embed ?? generateEmbedding`). Deleting it standalone breaks the typecheck — its removal is genuinely coupled to the Phase-8 edge-function deletion (task #13), not a free cleanup in this phase. Embeddings staying local is unchanged and still correct.

**Remaining before Bedrock can actually serve traffic:** (1) the one-time Anthropic use-case form in the Bedrock console — filled, awaiting the user's Submit; (2) a least-privilege IAM policy + access keys in the brain env; (3) the model-id + prompt-caching confirmation against a live invoke.

---

# Atlas → AWS migration — decision record

**Date:** 2026-07-28 · **Credits:** $1,100 AWS Activate (FOUNDERS $1,000, exp **2028-07-31**; Free Tier $100) · Account: Innovo Studio (389642461729).

Websites stay on Cloudflare. This record is the source of truth; the research + synthesis that produced it are in the session scratchpad.

## 0. The fact everything hinges on (verified in the AWS console, not inferred)

Billing → Credits → FOUNDERS → *Applicable products* (233 services). Present: **Amazon Bedrock**, **SES**, **Polly**, **Transcribe**, **S3**, **CloudFront**, **Lambda**. **Absent: AWS Marketplace.**

- **Bedrock Claude = credit-eligible.**
- **"Claude Platform on AWS" bills through AWS Marketplace → NOT credit-eligible.** And Bedrock has **no `web_search` server tool and no Batches API** (Anthropic platform matrix). Atlas's chat path structurally depends on `web_search_20260209`.

→ Not a tie to break, a **split**. The codebase already has the seam (`aiGateway.ts`).

Realistic lifetime credit spend at single-user volume: **under ~$150 of $1,100.** Credits are a reason to *prefer* AWS on a tie — never a reason to move something that already works.

## 1. Claude path — HYBRID, split on server-tool presence

| Traffic | Provider |
|---|---|
| Chat / user turns (tools on, `web_search`) | **First-party Anthropic API** (Bedrock can't serve it) |
| `summary` `classify` `memory` `digest` `insights` `extraction` `title` `mail_draft`, teaching, evals | **Amazon Bedrock** `eu.anthropic.*` (credits, EU residency, no server tools needed — and this is most of the token volume) |

Code: new `_shared/bedrockAdapter.ts` (~90% reuse of `claudeAdapter.ts`); add `"bedrock"` to `getAIConfig()`; ~15-line `routeProvider(body)` in `aiGateway.ts` keyed on `NATIVE_SEARCH_TOOLS` → **no call-site changes**. Use **`aws4fetch`** (runtime-neutral SigV4), NOT the AWS SDK — `_shared/*` is imported by Deno + Bun verbatim. **Trap:** `mapModelToClaude()` guards on `startsWith("claude-")`; Bedrock ids are `eu.anthropic.claude-…` and miss the guard → add a separate `mapModelToBedrock()`.

**Fallback if credits somehow don't cover Bedrock:** stay 100% first-party for inference; spend credits on SES/S3/CloudFront; accept most of $1,100 expires. Do NOT use P-AWS as a consolation (Marketplace = no credit + a client migration for nothing).

## 2. Platform features
- **Prompt-caching audit — DO IT FIRST, it's a prerequisite.** Bedrock caching is **manual breakpoints only** (no top-level auto). Highest-value check: recalled memories must land **after** the last cache breakpoint, or the prefix changes every turn and cache reads = 0.
- **Batches — no.** First-party only; the digest is the workload we're moving to Bedrock. 100%-off credits beat 50%-off batch while credits last. Batches is the post-credit plan, and a fit for first-party eval runs if/when they exist.
- **Fast mode — no.** First-party only, Opus-only, 2× price — the inverse of the credit goal. Chat is streamed; caching fixes perceived latency for free.
- **Advisor tool — defer.** Beta, not on Bedrock; natural fit is the *rarest* (hard) tier; revisit with real per-tier cost numbers.

## 3. Mail — **SES for sending; receiving stays on Cloudflare**
- SES beats Workers Paid ($60/yr recurring, pre-revenue) — ~$0 and credit-plausible.
- **DNS objection dissolves:** SES sending touches the apex MX **not at all**. Needs 3 DKIM CNAMEs (+ optional `mail.helloatlas.dk` MAIL-FROM records). CF Email Routing MX + DMARC untouched. DKIM alignment alone passes DMARC `p=reject`.
- SigV4-from-Worker is more code than the `send_email` binding — but the SigV4 helper is already written for Bedrock + S3.
- **Do SES production-access request on day 1** (starts in sandbox; ~24h first response).
- Receiving stays on CF (moving inbound would break Email Routing and pin everything to a region).

## 4. Voice — **stay direct on ElevenLabs. No move, not even partial.**
- Polly **Generative** (the only ElevenLabs-competitive tier) does **not** include **Danish**. Danish only at Standard/Neural = audible downgrade. Brief says no quality compromise → categorical no for TTS.
- "ElevenLabs through AWS" isn't a real callable option (enterprise SageMaker only) and wouldn't be credit-eligible anyway.
- STT→Transcribe: no credible 2026 WER benchmark vs ElevenLabs; the one anecdote is high latency on short non-English audio = Atlas's exact workload. Don't swap a working gateway on unverified quality.
- Keep `services/voice-gateway/` as a clean seam. Only defensible lever ever: Polly Generative for **English-only** digest read-aloud — never Danish, never conversational.

## 5. Auth — **keep Cloudflare D1. Do not move.**
Built, verified, free, and named in the published policy (§4.1/§6/§8). Moving to Cognito burns credits on a $0 line, forces a 3-place policy rewrite + re-dated verification, and risks locking installed builds out of sign-in. Keeping it put is a **feature** — the one major component with zero policy delta.

## 6. Also moves / must-not
- **S3 for mail attachment blobs — yes.** `atlas-mail/schema.sql` already has a nullable key column waiting. **Rename `r2_key` → `blob_key`** in the same migration.
- **S3 + CloudFront as the updater release home — yes.** Closes task #11, decouples the endpoint from the release-repo decision, and swaps GitHub (a processor Atlas doesn't otherwise use) for CloudFront (already in the table). ~$1/mo.
- **Must NOT move (published commitment):** local memories, SQLite app DB, sqlite-vec/FTS5 indexes, chat history, local mail bodies, the e5 embedding model, wake-word model, Keychain secrets. **Do NOT route embeddings through Bedrock Titan** — they're local by design. **Delete** the dead `aiGateway.ts generateEmbedding()` Gemini call in Phase 8 — do not migrate dead code.

## 7. Privacy-policy deltas (must land *before or with* each change)
- **Bedrock:** §6 new row `Amazon Web Services, Inc.` / background AI inference / **EU (Frankfurt/Ireland)**; **split §4.3** (chat→Anthropic US; background→Bedrock EU); fix §4.7 + §5 (digest no longer "entirely between your Mac and Anthropic"); §8 re-date + add AWS DPA/SCC/DPF row.
- **The EU win (state it, don't overclaim):** `eu.anthropic.*` keeps background requests inside the EEA → no third-country transfer for that slice. **Chat + web search stays US.** §8 becomes a *split*, never a blanket claim. Note: `inference_geo` is P-AWS-only; on Bedrock the EU guarantee is the profile prefix, not a request param.
- SES / S3 / updater: extend the AWS row; net processor count unchanged (updater swaps GitHub→CloudFront).
- **Auth: no change.**

## 8. Phased rollout
| Phase | Work | Effort | Headless? |
|---|---|---|---|
| **A. Foundation** | credits check (DONE — Bedrock eligible); Bedrock model access (EU); least-priv IAM; `aws4fetch` SigV4 helper + tests | S | console needs user |
| **B. Bedrock background tier** | `bedrockAdapter.ts`; `getAIConfig` `"bedrock"`; `routeProvider`; **caching audit**; `mapModelToBedrock` | M | mostly headless |
| **C. SES sending** (unblocks #24) | prod-access day 1; DKIM CNAMEs; swap binding→SES v2+SigV4 | S–M | DNS+access need user |
| **D. S3 attachments + S3/CloudFront updater** (closes #11) | bucket+distribution; `blob_key` migration; updater endpoint | M | infra needs user |
| **E. Privacy policy + atlas-site redeploy** | draft §4.3/§4.7/§5/§6/§8 deltas; user reviews+deploys | M | sign-off needs user |
| **F. Deferred** | Batches (post-credit), advisor tool, re-eval voice | — | — |

**Ordering:** E lands before/with B reaching users, or three published paragraphs go false.

## UPDATE 2026-07-28 — Phase E: privacy-policy delta WRITTEN (not deployed)

Landed in **`atlas-site/public/privacy.html`** — the only copy of the policy text in either repo (`dist/privacy.html` is a gitignored `vite build` copy and regenerates itself). Nothing in `helloatlas` needed changing. **Not deployed:** `bun run deploy` in `atlas-site` is still the user's call.

**Correction to §7 above: the section numbers were off by one.** The transfer/DPA/SCC content lives in the published policy's **§7 "International transfers"**, not §8. §8 is "Retention" — it needed its own smaller edit (the `Processor-side retention` bullet named only Anthropic and ElevenLabs). Both were touched.

**What changed, section by section:**
- **Header** — re-dated 26 → **28 July 2026**.
- **§2 "the short version"** — the digest sentence said it goes to Anthropic. Now names AWS, dates the change, and adds "it did *not* change for your chat messages". (Not in the original delta list; it goes false the moment Bedrock serves the digest, and §2 is the paragraph that promises to tell you this up front.)
- **§4.3** — retitled *"Chat and reasoning — one model, two providers, two continents"* and rewritten as a **two-bullet split**: Anthropic/US for chat, AWS Bedrock/EU for background. Followed by an explicit *"Read that as a split, not a relocation"* paragraph. The web-search paragraph now explains **why** chat can't follow: the `web_search` server tool exists only on the first-party API. The **teaching flow is named as an EU destination** (tools off → Bedrock, per §1's routing table) rather than being rounded into "chat → US".
- **§4.7** — four edits: the "same recipient as ordinary chat" sentence (the false one) now names Bedrock/EU; "no web search is run as part of it" gained *"which is exactly why this one can run in the EU when chat cannot"*; the stop-it paragraph now warns that chat and digest run on **separate credentials for separate providers**, so quitting Atlas is the only remedy that reliably stops both; "no AI key" → "no AI credentials".
- **§4.8** — "your Mac to Anthropic" → "your Mac to AWS".
- **§5** — the Art. 21 paragraph's *"entirely between your Mac and Anthropic"* fixed; closes with *"we will not offer the move to the EU as an answer to an Art. 21 objection."* The legitimate-interests bullet needed no change (it never named a provider).
- **§6** — Anthropic row no longer claims the digest; **new `Amazon Web Services, Inc. (Amazon Bedrock)` row** added directly beneath it.
- **§7** — opening paragraph reframed as a jurisdiction split (*"Atlas is split across two jurisdictions; it has not moved to the EU"*); "three processors" → four, with AWS explicitly listed *"because it is a processor of your content, not because it is a transfer"*; new AWS bullet; the "common mechanism across all three" line scoped to the three that leave the EEA.
- **§8** — `Processor-side retention` now lists AWS, with Bedrock's no-store/no-train position flagged as *AWS's* claim, unverified by us.

**Two places the draft was deliberately made weaker than §7's brief, and why:**
1. **The EU claim is the `eu.` inference-profile prefix, stated as such.** The §6 location cell says **EU (Frankfurt)** but then explains that the guarantee comes from addressing an **EU inference profile** — the `eu.` model-id prefix — that *"is not a per-request setting we tick"*, and that AWS may serve from another EU region for capacity. This is the policy-side of the `inference_geo`-is-P-AWS-only note in §7 above; the published text must never imply a per-request geo parameter or a single-datacentre guarantee.
2. **The dated verification sentence was NOT extended to AWS.** §7's brief said "re-date + add AWS DPA/SCC/DPF row", but the existing sentence is a signed statement that *we read* those agreements on 25 July. **Nobody has read the AWS GDPR DPA or checked its DPF entry.** So the AWS bullet says, in the document's own "we have not verified this" voice, that the line-by-line reading is outstanding, and the dated paragraph now explicitly says *"The AWS bullet is not covered by that reading."*

**Blocking follow-ups before this text is true / before it should be deployed:**
- **Read the AWS GDPR Data Processing Addendum + the DPF list entry for Amazon Web Services, Inc.**, then replace the "not yet read" language in the §7 AWS bullet and add the date to the closing paragraph. Until then the policy is honest but incomplete.
- **Confirm the router really sends the teaching flow to Bedrock** (inferred from §1's table + the tools-off rule, not read out of the routing code). §4.3 and the §6 AWS row both assert it.
- **Confirm where the AWS credentials live.** §4.5 makes a great deal of the fact that no key of ours ships with the app. If a normal install carries working IAM keys (the "access keys in the brain env" of §A), that is a new disclosure and §4.5 needs a companion sentence — and §4.7's "removing the AI credentials" remedy becomes untrue for the digest, which would be a materially worse disclosure. The current §4.7 wording is hedged ("removing one does not necessarily stop the other") but not a substitute for knowing.
- **Sequencing unchanged:** this text must be live before Bedrock serves a real user request. Writing it is not publishing it.

## Open questions
1. ~~Does the Credits page list Bedrock?~~ **RESOLVED — yes, verified in console.**
2. ~~Which Claude models are actually served in eu-central-1/eu-west-1?~~ **PARTLY RESOLVED (2026-07-28, live InvokeModel as `atlas-brain`).** Invocable: `haiku-4-5-20251001-v1:0`, `sonnet-4-6`, `sonnet-4-5-20250929-v1:0`, `opus-4-6-v1`. Denied ("not available for this account"): `sonnet-5`, `opus-4-8`, `opus-4-7`. **Still untested: `eu.anthropic.claude-opus-5`** — one live call closes this and, if it answers, promotes the hard tier with zero policy delta (task #28). Separately: **Fable 5 can never match** — it has no `eu.` profile at all, so matching the first-party frontier tier on Bedrock is not an entitlement question but a residency one. See the model-mapping note in §1.
3. SES / VAT credit-eligibility — immaterial to the decision (SES ~$0 either way).
4. Bedrock default quotas — fine for one user; increases are self-serve.

## See also

- **`docs/aws-admin-checklist.md`** — the runnable admin checklist (SES identity/DKIM/MAIL-FROM/production access, S3 attachment + release buckets, CloudFront OAC, IAM least-priv, worker secrets) with per-step pending/done status. Implements §3 and §6 of this document; worker code lives in the separate `atlas-mail` repo.
