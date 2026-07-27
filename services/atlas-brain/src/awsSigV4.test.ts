import { test, expect } from "bun:test";
import { signRequest, amzDateParts } from "../../../supabase/functions/_shared/awsSigV4";

// The signer is the shared auth primitive for Bedrock (credits path), Claude
// Platform on AWS (the later Path-B migration), SES and S3. A subtle bug here
// fails every AWS call with an opaque 403, so it is pinned against AWS's OWN
// published SigV4 test vector rather than a self-consistency check.

const AWS_CREDS = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
};

test("get-vanilla: reproduces the canonical aws4_testsuite signature exactly", async () => {
  // From AWS's published SigV4 test suite (aws-sig-v4-test-suite/get-vanilla):
  // GET https://example.amazonaws.com/, signing only host;x-amz-date.
  const headers = await signRequest({
    method: "GET",
    url: "https://example.amazonaws.com/",
    region: "us-east-1",
    service: "service",
    credentials: AWS_CREDS,
    now: { amzDate: "20150830T123600Z", dateStamp: "20150830" },
    // signContentHeader defaults to false → matches the vector's signed set.
  });

  expect(headers.Authorization).toBe(
    "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, " +
      "SignedHeaders=host;x-amz-date, " +
      "Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
  );
});

test("empty-body payload hash is the canonical SHA-256 of the empty string", async () => {
  // When signContentHeader is on (S3/SES), the header carries the payload hash.
  // The empty string hashes to a fixed, well-known constant — a cheap check that
  // the hashing primitive itself is correct.
  const headers = await signRequest({
    method: "POST",
    url: "https://email.eu-central-1.amazonaws.com/v2/email/outbound-emails",
    region: "eu-central-1",
    service: "ses",
    credentials: AWS_CREDS,
    now: { amzDate: "20260728T120000Z", dateStamp: "20260728" },
    signContentHeader: true,
    body: "",
  });
  expect(headers["x-amz-content-sha256"]).toBe(
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
});

test("a body changes the signature (bodies are actually signed)", async () => {
  const base = {
    method: "POST" as const,
    url: "https://bedrock-runtime.eu-central-1.amazonaws.com/model/eu.anthropic.claude-sonnet-5/invoke",
    region: "eu-central-1",
    service: "bedrock",
    credentials: AWS_CREDS,
    now: { amzDate: "20260728T120000Z", dateStamp: "20260728" },
    headers: { "content-type": "application/json" },
  };
  const a = await signRequest({ ...base, body: JSON.stringify({ prompt: "hi" }) });
  const b = await signRequest({ ...base, body: JSON.stringify({ prompt: "bye" }) });
  expect(a.Authorization).not.toBe(b.Authorization);
});

test("session token is signed when present (assumed-role / STS creds)", async () => {
  const headers = await signRequest({
    method: "POST",
    url: "https://bedrock-runtime.eu-central-1.amazonaws.com/model/x/invoke",
    region: "eu-central-1",
    service: "bedrock",
    credentials: { ...AWS_CREDS, sessionToken: "FQoGZXIvYXdzEXAMPLE" },
    now: { amzDate: "20260728T120000Z", dateStamp: "20260728" },
    body: "{}",
  });
  expect(headers["x-amz-security-token"]).toBe("FQoGZXIvYXdzEXAMPLE");
  // It must also appear in the SignedHeaders list, or the request 403s.
  expect(headers.Authorization).toContain("x-amz-security-token");
});

test("amzDateParts formats the SigV4 date and datestamp", () => {
  const parts = amzDateParts(new Date("2026-07-28T12:34:56.789Z"));
  expect(parts.amzDate).toBe("20260728T123456Z");
  expect(parts.dateStamp).toBe("20260728");
});
