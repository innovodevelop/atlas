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

- **A `global.` profile is authorised against the CALLING region, not its home
  region.** v3 anchored the global ARN to `us-east-1` on the reasoning that a
  cross-region profile's ARN lives in its home region. Measured on 2026-08-02,
  that is wrong for authorisation: invoking `global.anthropic.claude-opus-5` from
  `eu-central-1` produced

  ```
  not authorized to perform: bedrock:InvokeModel on resource:
  arn:aws:bedrock:eu-central-1:389642461729:inference-profile/global.anthropic.claude-opus-5
  ```

  — the caller's region. Hence v4 uses a region wildcard,
  `arn:aws:bedrock:*:389642461729:inference-profile/global.anthropic.claude-*`.
  The same call against `us-east-1` passed the IAM check and failed on
  entitlement instead, which is how the two gates were told apart.
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

## 1b. STATUS 2026-08-02 — IAM is DONE and functionally verified

v4 was applied through the IAM console (create-policy-version, set as default)
and confirmed by measurement, not by reading the policy back:

| Probe (as `atlas-brain`) | Before v4 | After v4 |
|---|---|---|
| `global.anthropic.claude-*` from eu-central-1 | `User ... is not authorized to perform: bedrock:InvokeModel` | `anthropic.claude-* is not available for this account` |
| `eu.anthropic.claude-sonnet-4-6` (control) | real completion | real completion |

The error moving from *permission* to *entitlement* is the proof. The control
model still answering proves credentials and the signing path are untouched.

## 2. Model entitlement — **BLOCKED, and not self-service** (2026-08-02)

**Outcome: the frontier tier is unreachable on this Bedrock account by any route
we control.** Recording the full error, because every truncated version of it
sent us down a wrong path:

```
AccessDeniedException: anthropic.claude-fable-5 is not available for this
account. You can explore other available models on Amazon Bedrock. For
additional access options, contact AWS Sales at
https://aws.amazon.com/contact-us/sales-support/
```

"Contact AWS Sales" — not a use-case form, not a Marketplace subscribe, not an
IAM fix. It is a **commercial gate on the account**.

Established by measurement:

| Probe | Result |
|---|---|
| `anthropic.claude-fable-5` bare, us-east-1 **and** eu-central-1 | not available for this account |
| `global.anthropic.claude-fable-5`, both regions | not available for this account |
| `eu.` and `global.` opus-5 / sonnet-5 / opus-4-8 | not available for this account |
| Same model in the **console playground, as account admin** | access denied |
| `eu.anthropic.claude-sonnet-4-6` control | real completion |

Bare foundation-model ids are covered by IAM v4, so this is not profile routing.
The console admin failing too means it is not a `atlas-brain` privilege gap. And
`list-foundation-models` cheerfully returns `anthropic.claude-fable-5` with
`modelLifecycle: ACTIVE` — **`ACTIVE` means the model exists and is not
deprecated, not that this account may invoke it.** That is the same
listing-≠-entitlement trap that already caught sonnet-5, opus-4-8 and opus-4-7,
now confirmed a fourth time. Stop using the model list as evidence of access.

### What this does to the premise of the whole change

The residency withdrawal was justified by: *the frontier models are reachable
only via `global.` profiles, so EEA confinement costs us a model tier.* Half of
that is true — Fable has no `eu.` profile. But the operative fact is that this
account cannot invoke the frontier tier on **any** profile, EU or global. So
lifting the EEA restriction currently buys **nothing**.

The code change stays (it is guarded, default-EU, and is the flip we would need
later). **The published privacy policy should NOT be weakened for a capability we
do not have** — see the hold note in `docs/ROADMAP.md`.

### Routes that actually exist

1. **Contact AWS Sales** — the path the error names. Unknown timeline; likely
   wants a commitment conversation for a pre-revenue account on Activate credits.
2. **Accept Bedrock's ceiling.** `opus-4-6` / `sonnet-4-6` are the newest that
   answer, which is exactly what `TIER_DEFAULT` already targets. Nothing is
   broken today.
3. **First-party Anthropic for the frontier tier**, via the bridge the capability
   router already has. Real money rather than credits, but single-user volume.
   Also the fix for the missing `anthropic_api_key`.
4. **Claude Platform on AWS.** Marketplace-billed so *not* credit-eligible, but
   same SigV4 auth, one config flip, and it serves both the frontier models and
   native web search. The credit argument for Bedrock weakens considerably once
   Bedrock cannot serve the models we want.

## 3. (historical) How enablement works now that Model access is retired

> ⚠️ **The Bedrock "Model access" page has been RETIRED** (observed in-console
> 2026-08-02). Earlier revisions of this document, and the roadmap task "request
> Bedrock access", describe a form that no longer exists. Do not go looking for it.

AWS's replacement text, verbatim from the retired page:

> Serverless foundation models are now automatically enabled across all AWS
> commercial regions when first invoked in your account […] Note that for
> Anthropic models, first-time users may need to submit use case details before
> they can access the model. For models served from AWS Marketplace, a user with
> AWS Marketplace permissions must invoke the model once to enable it
> account-wide for all users.

So enablement is now **an invoke, not a request**, and the path is:

1. Bedrock → **Model catalog** → *Claude Fable 5* → **Open in playground**.
2. Send one message. If a use-case-details form appears, complete it — that is
   the Anthropic gate the text above refers to.
3. Repeat for Opus 5 / Sonnet 5 / Opus 4.8 if those tiers are wanted.

Doing this from the **console** matters: it runs as the signed-in admin, which
holds the Marketplace permissions the account-wide enablement needs.
`atlas-brain` holds `aws-marketplace:Subscribe` and `ViewSubscriptions` and still
gets `not available for this account`, so its Marketplace grant is **not**
sufficient on its own — the observed failure is the Anthropic use-case gate, not
a Marketplace-permission error (that one reads *"not authorized to perform the
required AWS Marketplace actions"*, which we never saw).

**Known automation blocker:** the Bedrock playground page wedges browser
automation — script injection times out repeatedly and neither a screenshot nor
an accessibility read completes. This step has to be done by hand.

### A `us.` profile exists, and IAM does not cover it

Opening Fable 5 from the catalog defaults the playground to
`arn:aws:bedrock:us-east-1:389642461729:inference-profile/us.anthropic.claude-fable-5`
— so a **US regional** profile exists alongside the global one. v4 grants `eu.`
(eu-central-1) and `global.` (any region) but **not `us.`**. That is fine for the
app, which invokes from eu-central-1 where a `us.` regional profile is not usable
anyway. If a `us.` profile is ever wanted, it needs its own resource line; the
code already permits the prefix, so IAM would be the only blocker.

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
