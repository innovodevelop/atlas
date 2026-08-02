# AWS admin checklist — SES sending + S3 (attachments & updater releases)

Run as an AWS admin, **account 389642461729, region eu-central-1**. Every step
starts **pending**; flip to **done** as you complete it. Commands are verbatim —
run them as written (replace only the explicit `REPLACE_WITH_*` placeholders).

Grounding: `docs/aws-migration-decision.md` §3 (SES), §6 (S3 + rename +
updater), §8 phases C/D. Worker-side code (signer, `ses.ts`, `s3.ts`, migration
`0002_blob_key.sql`) lives in the separate `atlas-mail` repo.

| # | Step | Status |
|---|------|--------|
| 1 | SES domain identity (`helloatlas.dk`) | **done** (2026-08-02) |
| 2 | DKIM CNAMEs in Cloudflare DNS | **done** (2026-08-02) |
| 3 | MAIL-FROM (`mail.helloatlas.dk`) + its DNS records | pending |
| 4 | Verify DKIM went green | **done** — SUCCESS, live send verified |
| 5 | SES production-access request (day 1!) | **done** — filed, PENDING |
| 6 | Sandbox interim: verify test recipient | **n/a** — domain identity covers @helloatlas.dk |
| 7 | S3 bucket: attachments (private) | **done** (2026-08-02) |
| 8 | S3 bucket: releases (private) | **done** (2026-08-02) |
| 9 | CloudFront OAC + distribution over releases | **needs admin** — see §9 one-paste |
| 10 | Releases bucket policy (OAC read) | **needs admin** — folded into §9 |
| 11 | IAM least-priv policy for `atlas-brain` (merge first!) | **done** — policy `atlas-mail-ses-s3` |
| 12 | Hand creds to worker via `wrangler secret put` | **done** — key AKIAVVOEAEIQVCKJKGPO |

---

## 1. SES domain identity

```
aws sesv2 create-email-identity --email-identity helloatlas.dk --region eu-central-1
```

## 2. DKIM CNAMEs

Fetch the 3 DKIM CNAME tokens (create these in Cloudflare DNS as
`<token>._domainkey.helloatlas.dk` CNAME → `<token>.dkim.amazonses.com`,
DNS-only/grey-cloud):

```
aws sesv2 get-email-identity --email-identity helloatlas.dk --region eu-central-1 --query 'DkimAttributes.Tokens' --output table
```

## 3. MAIL-FROM

Then add DNS: MX `mail.helloatlas.dk` → `10 feedback-smtp.eu-central-1.amazonses.com`,
TXT `mail.helloatlas.dk` → `"v=spf1 include:amazonses.com ~all"`; apex MX for CF
Email Routing untouched, per decision doc §3:

```
aws sesv2 put-email-identity-mail-from-attributes --email-identity helloatlas.dk --mail-from-domain mail.helloatlas.dk --behavior-on-mx-failure USE_DEFAULT_VALUE --region eu-central-1
```

## 4. Verify DKIM went green

Wait for DNS propagation first:

```
aws sesv2 get-email-identity --email-identity helloatlas.dk --region eu-central-1 --query '{Verified:VerifiedForSendingStatus,Dkim:DkimAttributes.Status}'
```

## 5. Production-access request

Day 1 — ~24h first response; sandbox blocks unverified recipients until granted.
CLI form, else console → SES → Account dashboard → "Request production access":

```
aws sesv2 put-account-details --production-access-enabled --mail-type TRANSACTIONAL --website-url https://helloatlas.dk --use-case-description "Transactional replies from contact@helloatlas.dk, the support mailbox of the Atlas desktop app. Low volume (tens/month), human-approved replies to inbound support mail only, no marketing, no lists." --additional-contact-email-addresses magnuspilegaard@gmail.com --contact-language EN --region eu-central-1
```

## 6. Sandbox interim — verify a test recipient

So end-to-end send can be tested before production access lands (click the mail
SES sends):

```
aws sesv2 create-email-identity --email-identity magnuspilegaard@gmail.com --region eu-central-1
```

## 7. S3 bucket — attachments (private)

```
aws s3api create-bucket --bucket atlas-mail-attachments-389642461729 --region eu-central-1 --create-bucket-configuration LocationConstraint=eu-central-1
```
```
aws s3api put-public-access-block --bucket atlas-mail-attachments-389642461729 --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
```

## 8. S3 bucket — releases (private)

```
aws s3api create-bucket --bucket atlas-releases-389642461729 --region eu-central-1 --create-bucket-configuration LocationConstraint=eu-central-1
```
```
aws s3api put-public-access-block --bucket atlas-releases-389642461729 --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
```

## 9 + 10. CloudFront OAC, distribution, and bucket policy

**Needs an admin principal.** `atlas-brain` deliberately has no CloudFront
permissions — `CreateDistribution` can spin up cost-bearing global
infrastructure, which is not a standing capability worth granting an application
key for one-time setup. Confirmed denied on 2026-08-02:

```
AccessDenied: not authorized to perform: cloudfront:CreateOriginAccessControl
```

Run this **in CloudShell** (it carries your console credentials). It replaces the
earlier REPLACE_WITH_* version: it captures the OAC id and distribution id
itself, so there is nothing to copy by hand between commands — which is where
the old version invited a mistake.

```bash
set -euo pipefail
BUCKET=atlas-releases-389642461729
ACCT=389642461729

OAC_ID=$(aws cloudfront create-origin-access-control \
  --origin-access-control-config Name=atlas-releases-oac,OriginAccessControlOriginType=s3,SigningBehavior=always,SigningProtocol=sigv4 \
  --query OriginAccessControl.Id --output text)
echo "OAC: $OAC_ID"

cat > /tmp/dist.json <<EOF
{
  "CallerReference": "atlas-releases-$(date +%s)",
  "Comment": "Atlas updater release home",
  "Enabled": true,
  "Origins": { "Quantity": 1, "Items": [ {
    "Id": "s3-releases",
    "DomainName": "${BUCKET}.s3.eu-central-1.amazonaws.com",
    "OriginAccessControlId": "${OAC_ID}",
    "S3OriginConfig": { "OriginAccessIdentity": "" }
  } ] },
  "DefaultCacheBehavior": {
    "TargetOriginId": "s3-releases",
    "ViewerProtocolPolicy": "https-only",
    "AllowedMethods": { "Quantity": 2, "Items": ["GET","HEAD"] },
    "CachePolicyId": "658327ea-f89d-4fab-a63d-7e88639e58f6",
    "Compress": true
  },
  "PriceClass": "PriceClass_100"
}
EOF

DIST_ID=$(aws cloudfront create-distribution --distribution-config file:///tmp/dist.json \
  --query Distribution.Id --output text)
DIST_DOMAIN=$(aws cloudfront get-distribution --id "$DIST_ID" \
  --query Distribution.DomainName --output text)
echo "Distribution: $DIST_ID"
echo "Domain:       $DIST_DOMAIN"

cat > /tmp/bucket-policy.json <<EOF
{ "Version": "2012-10-17", "Statement": [ {
  "Sid": "AllowCloudFrontOAC",
  "Effect": "Allow",
  "Principal": { "Service": "cloudfront.amazonaws.com" },
  "Action": "s3:GetObject",
  "Resource": "arn:aws:s3:::${BUCKET}/*",
  "Condition": { "StringEquals": { "AWS:SourceArn": "arn:aws:cloudfront::${ACCT}:distribution/${DIST_ID}" } }
} ] }
EOF
aws s3api put-bucket-policy --bucket "$BUCKET" --policy file:///tmp/bucket-policy.json
echo "Bucket policy applied."
```

`PriceClass_100` keeps edge locations to North America + Europe, which is the
cheap option and correct for a Danish product.

The distribution takes ~15 minutes to reach `Deployed`. Send the `Domain` value
back and the updater can be pointed at it — **but that is task #11 and still an
open decision.** The updater currently points at GitHub releases
(`src-tauri/tauri.conf.json`), and creating this bucket does not commit you to
switching. Nothing has moved it.

## 11. IAM — least-priv statements for `atlas-brain`

Append least-priv statements to the atlas-brain user's inline policy (SES send
restricted to the identity + From address; S3 rw on exactly the two buckets).
This **REPLACES** the inline policy of that name, so **merge these statements
into the existing document first** if the policy name already carries the
Bedrock statements — check with `aws iam list-user-policies --user-name atlas-brain`:

```
cat > /tmp/atlas-aws-mail-s3.json <<'EOF'
{ "Version": "2012-10-17", "Statement": [
  {
    "Sid": "AtlasSesSend",
    "Effect": "Allow",
    "Action": ["ses:SendEmail", "ses:SendRawEmail"],
    "Resource": "arn:aws:ses:eu-central-1:389642461729:identity/helloatlas.dk",
    "Condition": { "StringLike": { "ses:FromAddress": "contact@helloatlas.dk" } }
  },
  {
    "Sid": "AtlasS3Blobs",
    "Effect": "Allow",
    "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
    "Resource": [
      "arn:aws:s3:::atlas-mail-attachments-389642461729/*",
      "arn:aws:s3:::atlas-releases-389642461729/*"
    ]
  },
  {
    "Sid": "AtlasS3List",
    "Effect": "Allow",
    "Action": ["s3:ListBucket"],
    "Resource": [
      "arn:aws:s3:::atlas-mail-attachments-389642461729",
      "arn:aws:s3:::atlas-releases-389642461729"
    ]
  }
] }
EOF
aws iam put-user-policy --user-name atlas-brain --policy-name atlas-mail-s3 --policy-document file:///tmp/atlas-aws-mail-s3.json
```

## 12. Hand the worker its creds

Either the existing atlas-brain access key, or cleaner:
`aws iam create-access-key --user-name atlas-brain` for a second, revocable key
pair — then in the `atlas-mail` repo:

```
wrangler secret put AWS_ACCESS_KEY_ID
wrangler secret put AWS_SECRET_ACCESS_KEY
```

Never in vars, never committed. **Do not deploy the worker until a
sandbox-verified end-to-end send has been observed.**

---

*Updater release-home key layout, `latest.json` semantics, and the
`tauri.conf.json` endpoint swap are specified in the S3/updater section of the
mail+AWS spec; the endpoint stays on the raw `d<ID>.cloudfront.net` domain until
the helloatlas.dk zone carries `updates.helloatlas.dk`.*
