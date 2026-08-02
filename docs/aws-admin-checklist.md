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
| 2 | DKIM CNAMEs in Cloudflare DNS | **BLOCKER — see docs/aws-ses-dns-records.md** |
| 3 | MAIL-FROM (`mail.helloatlas.dk`) + its DNS records | pending |
| 4 | Verify DKIM went green | pending |
| 5 | SES production-access request (day 1!) | **done** — filed, PENDING |
| 6 | Sandbox interim: verify test recipient | pending |
| 7 | S3 bucket: attachments (private) | pending |
| 8 | S3 bucket: releases (private) | pending |
| 9 | CloudFront OAC + distribution over releases | pending |
| 10 | Releases bucket policy (OAC read) | pending |
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

## 9. CloudFront OAC + distribution

Note the `Id` printed by the first command; note `Id` + `DomainName` from the
second:

```
aws cloudfront create-origin-access-control --origin-access-control-config Name=atlas-releases-oac,OriginAccessControlOriginType=s3,SigningBehavior=always,SigningProtocol=sigv4
```
```
cat > /tmp/atlas-releases-dist.json <<'EOF'
{
  "CallerReference": "atlas-releases-2026-07-31",
  "Comment": "Atlas updater release home",
  "Enabled": true,
  "DefaultRootObject": "",
  "Origins": { "Quantity": 1, "Items": [ {
    "Id": "s3-releases",
    "DomainName": "atlas-releases-389642461729.s3.eu-central-1.amazonaws.com",
    "OriginAccessControlId": "REPLACE_WITH_OAC_ID",
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
aws cloudfront create-distribution --distribution-config file:///tmp/atlas-releases-dist.json
```

## 10. Releases bucket policy

Letting that distribution read (replace DIST_ID):

```
cat > /tmp/atlas-releases-policy.json <<'EOF'
{ "Version": "2012-10-17", "Statement": [ {
  "Sid": "AllowCloudFrontOAC",
  "Effect": "Allow",
  "Principal": { "Service": "cloudfront.amazonaws.com" },
  "Action": "s3:GetObject",
  "Resource": "arn:aws:s3:::atlas-releases-389642461729/*",
  "Condition": { "StringEquals": { "AWS:SourceArn": "arn:aws:cloudfront::389642461729:distribution/REPLACE_WITH_DIST_ID" } }
} ] }
EOF
aws s3api put-bucket-policy --bucket atlas-releases-389642461729 --policy file:///tmp/atlas-releases-policy.json
```

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
