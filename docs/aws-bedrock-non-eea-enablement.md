# Reaching Claude models outside the EU on Bedrock

**Decision date: 2026-08-02.** Until this date, Atlas confined every Bedrock
request to `eu.anthropic.*` inference profiles, and both the code and the
published privacy policy said so. That confinement was lifted deliberately in
order to reach the frontier tier — Fable 5 has **no** `eu.` profile at all, and
Sonnet 5 / Opus 5 / Opus 4.8 have never returned a successful `InvokeModel` in
`eu-central-1`.

This is the checklist for making that real. Steps 1 and 2 need the account owner;
everything else has landed.

---

## What changed in code (done)

| Piece | Before | After |
|---|---|---|
| Guard in `_shared/bedrockAdapter.ts` | `assertEeaProfile` — threw on any non-`eu.` id unless `ATLAS_BEDROCK_ALLOW_NON_EEA=1` | `assertAllowedProfile` — permits non-`eu.` ids; `ATLAS_BEDROCK_EEA_ONLY=1` restores confinement |
| `src-tauri/src/lib.rs` | forwarded only `AWS_*` + `ATLAS_AI_PROVIDER` | also forwards the five `BEDROCK_MODEL_*` overrides and `ATLAS_BEDROCK_EEA_ONLY`, all from the Keychain |
| `TIER_DEFAULT` | all `eu.` | **unchanged — still all `eu.`** |

**The defaults deliberately did not move.** Permitting a non-EEA profile and
routing to one are separate decisions. An ordinary install still runs entirely on
EU profiles; reaching outside takes a per-tier override. That is what keeps the
residency posture from drifting by accident, and it is asserted by a test
(`bedrockAdapter.test.ts`, "every default still resolves to an eu. profile").

The old flag name `ATLAS_BEDROCK_ALLOW_NON_EEA` is **dead and inert**. A leftover
copy of it in an environment does nothing in either direction — also asserted by
a test, because a stale `=1` silently becoming load-bearing again would be worse
than the original problem.

---

## 1. Widen the IAM policy — **account owner**

`docs/aws-iam-bedrock-invoke-policy.json` replaces the inline `AtlasBedrockInvoke`
policy on IAM user `atlas-brain`.

```bash
aws iam put-user-policy \
  --user-name atlas-brain \
  --policy-name AtlasBedrockInvoke \
  --policy-document file://docs/aws-iam-bedrock-invoke-policy.json
```

Three things to understand before applying it:

- **`global.` profiles are anchored in `us-east-1`.** The ARN region is
  `us-east-1` even though the request is *sent* to `eu-central-1`. That is not a
  typo; a cross-region profile's ARN lives in its home region while the request
  enters AWS wherever you address it.
- **The `foundation-model` wildcard is the part that gives up containment.** A
  global profile fans out to the underlying model in whichever region has
  capacity, so `arn:aws:bedrock:*::foundation-model/anthropic.*` is required for
  it to work at all. Once that statement exists, the policy is a *name filter*,
  not a geographic boundary — `ATLAS_BEDROCK_EEA_ONLY=1` in the code is then the
  only remaining control, which is why the guard was inverted rather than deleted.
- It is scoped to `anthropic.*`, so it does not open Bedrock's other vendors.

## 2. Request model access — **account owner, AWS console**

IAM permits the call; it does not grant entitlement. Bedrock → **Model access**,
in **`us-east-1`** for the global profiles, and request:

- `anthropic.claude-fable-5`
- `anthropic.claude-opus-5`, `anthropic.claude-opus-4-8`, `anthropic.claude-sonnet-5`

Subscriptions are **per-model** and go through AWS Marketplace on first invoke. A
least-privilege caller cannot complete that step — it fails with *"not authorized
to perform the required AWS Marketplace actions"* until an identity holding
`aws-marketplace:Subscribe` invokes **that specific model** once. So expect one
bootstrap invoke per model from an admin identity, not just an approved form.

Also note: **`us-east-1` model access is separate from `eu-central-1`.** Access
granted in one region does not carry to the other.

## 3. Verify, then promote a default — **runnable once 1 and 2 land**

Do not promote anything into `TIER_DEFAULT` on the strength of a console screen.
`list-inference-profiles` returns profiles the account cannot invoke; that trap
has already caught sonnet-5, opus-4-8, opus-4-7 and opus-5 once each. A default
pointing at a denied profile is user-visible, because on a streaming call
`AccessDeniedException` arrives as an in-band frame and is injected into the
transcript as text.

```bash
for m in global.anthropic.claude-fable-5 global.anthropic.claude-opus-5 \
         global.anthropic.claude-sonnet-5; do
  printf '%s -> ' "$m"
  aws bedrock-runtime invoke-model --region eu-central-1 --model-id "$m" \
    --body '{"anthropic_version":"bedrock-2023-05-31","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}' \
    --cli-binary-format raw-in-base64-out /dev/stdout 2>&1 | head -c 200
  echo
done
```

Only a profile that **answers** may become a `TIER_DEFAULT` entry, and the commit
message must cite the invocation.

## 4. Legal — **done, but not deployed**

`atlas-site/public/privacy.html` was rewritten on 2026-08-02: §2, §4.3, §4.7, §5,
§6, §7 and §8 no longer claim EEA-confinement for the background tier, AWS is
listed as a third-country transfer on an SCC basis, and §8 discloses Fable 5's
mandatory 30-day retention.

**Sequencing is load-bearing: that text must be live before a non-EEA profile
serves a real request.** Applying step 1 without deploying the policy would put
three published paragraphs into a false state. Because `TIER_DEFAULT` did not
move, applying step 1 alone changes nothing at runtime — but setting any
`BEDROCK_MODEL_*` override to a `global.` id does.
