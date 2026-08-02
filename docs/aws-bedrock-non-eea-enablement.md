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

`AtlasBedrockInvoke` is a **customer-managed** policy
(`arn:aws:iam::389642461729:policy/AtlasBedrockInvoke`) attached to `atlas-brain`
— *not* an inline policy. `atlas-brain` also carries one genuinely inline policy,
`atlas-mail-ses-s3`, which is unrelated. So this is `create-policy-version`, and
**`put-user-policy` would be wrong**: it would create a second, inline policy of
the same name alongside the managed one, leaving two same-named policies
disagreeing about what Atlas may invoke (IAM unions the Allows, so it would
"work" while being untraceable).

`docs/aws-iam-bedrock-invoke-policy.json` is **v3 = the live v2 document plus one
added resource**, the `global.` inference-profile ARN. Verified against v2 as
read from the account on 2026-08-02.

```bash
aws iam create-policy-version \
  --policy-arn arn:aws:iam::389642461729:policy/AtlasBedrockInvoke \
  --policy-document file://docs/aws-iam-bedrock-invoke-policy.json \
  --set-as-default
```

Things to understand before applying it:

- **`global.` profiles are anchored in `us-east-1`.** The ARN region is
  `us-east-1` even though the request may be *sent* to another region. That is
  not a typo; a cross-region profile's ARN lives in its home region.
- **The `foundation-model` wildcard was already there.** v2 already grants
  `arn:aws:bedrock:*::foundation-model/anthropic.claude-*` across all regions,
  which is what a global profile needs to fan out to the underlying model. An
  earlier draft of this document claimed adding it was the step that surrendered
  containment — wrong. It had been surrendered since at least 2026-07-30; the
  geographic boundary was the `eu.` inference-profile pattern alone, exactly as
  the code comments said. This apply gives up nothing new at the IAM layer.
- **v2 also carries `aws-marketplace:Subscribe`** (`MarketplaceSubscribeForModelAccess`)
  and the four discovery reads. Both are preserved verbatim in v3. An earlier
  draft of the policy file omitted the Marketplace statement entirely, which
  would have revoked the grant the per-model bootstrap in step 2 depends on.
- Resources stay scoped to `anthropic.claude-*`, so Bedrock's other vendors —
  and Anthropic non-Claude models — remain closed.
- **Reverting is one command**, since the old version is retained:
  `aws iam set-default-policy-version --policy-arn <arn> --version-id v2`.
  Managed policies cap at **five versions**; the account was at two before this,
  so v3 fits. Past five, delete an old version first.

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
