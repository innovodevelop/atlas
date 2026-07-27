# Atlas → AWS migration — decision record

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
- `mapModelToBedrock()` with the `BEDROCK_ID` short-circuit — the `startsWith("claude-")` trap flagged in §1 is handled, and per-tier ids are env-overridable (`BEDROCK_MODEL_{HAIKU,SONNET,OPUS}`) so a wrong id is a config fix, not a redeploy.
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

## Open questions
1. ~~Does the Credits page list Bedrock?~~ **RESOLVED — yes, verified in console.**
2. Which Claude models are actually served in eu-central-1/eu-west-1? If the current tier (Sonnet 5 / Opus 4.8 / Haiku 4.5) isn't fully in EU, **resolve toward matching the first-party tier** — a weaker background model = worse memories/digest, a user-visible regression, not worth a policy paragraph.
3. SES / VAT credit-eligibility — immaterial to the decision (SES ~$0 either way).
4. Bedrock default quotas — fine for one user; increases are self-serve.
