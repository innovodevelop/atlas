#!/usr/bin/env bun
/**
 * Does TAURI_SIGNING_PRIVATE_KEY actually match the public key compiled into
 * the app?
 *
 * WHY THIS EXISTS. docs/RELEASE.md states as an Invariant that
 * `plugins.updater.pubkey` must be the public half of the key CI signs with.
 * Nothing enforced it. Tauri signs with whatever private key you hand it and
 * never compares the two, so a mismatched pair:
 *
 *   - builds green,
 *   - produces updater artifacts that look correct,
 *   - uploads and publishes without complaint,
 *   - and is then REJECTED by every installed copy of Atlas, because the app
 *     verifies the signature against the pubkey baked into its own binary.
 *
 * The failure is invisible until users stop receiving updates, and the recovery
 * is a manual reinstall for every one of them. That is the most expensive class
 * of bug this repo can ship, and it was guarded by a sentence in a document.
 *
 * HOW. Both a minisign/rsign public key and a signature carry the same 8-byte
 * key id, so the two halves can be compared without verifying anything
 * cryptographically. Each file is base64 of a two-line block:
 *
 *     untrusted comment: …
 *     <base64 payload>
 *
 * and the payload is 2 bytes of algorithm followed by the 8-byte key id, which
 * minisign prints reversed as uppercase hex.
 *
 * Run it against a signature produced by the key under test:
 *
 *     bun scripts/ci/verify-signing-key.ts <file.sig> [tauri.conf.json]
 *
 * Exits 0 on a match, 1 on anything else. Never reads, prints or writes the
 * private key — it only ever looks at a signature the key produced.
 */
import { readFileSync } from "node:fs";

/** The 8-byte key id shared by a keypair, as minisign prints it. */
export function keyId(blockBase64: string): string {
  const block = Buffer.from(blockBase64.trim(), "base64").toString("utf8");
  const lines = block.split("\n").filter((l) => l.length > 0);
  if (lines.length < 2) {
    throw new Error(`expected a comment line and a payload line, got ${lines.length}`);
  }
  const payload = Buffer.from(lines[1], "base64");
  // 2 bytes algorithm ("Ed"/"ED"), then the key id. Reversed for display —
  // this is the ordering minisign itself uses, so the hex here can be pasted
  // straight into a `minisign -V` comparison.
  if (payload.length < 10) throw new Error(`payload too short (${payload.length} bytes)`);
  return Buffer.from(payload.subarray(2, 10)).reverse().toString("hex").toUpperCase();
}

const sigPath = process.argv[2];
const confPath = process.argv[3] ?? "src-tauri/tauri.conf.json";

if (!sigPath) {
  console.error("usage: bun scripts/ci/verify-signing-key.ts <file.sig> [tauri.conf.json]");
  process.exit(2);
}

let signatureKeyId: string;
let pubkeyKeyId: string;
try {
  signatureKeyId = keyId(readFileSync(sigPath, "utf8"));
  const conf = JSON.parse(readFileSync(confPath, "utf8"));
  const pubkey = conf?.plugins?.updater?.pubkey;
  if (typeof pubkey !== "string" || pubkey.length === 0) {
    throw new Error(`${confPath} has no plugins.updater.pubkey`);
  }
  pubkeyKeyId = keyId(pubkey);
} catch (e) {
  // A parse failure must FAIL, never pass. This guard exists precisely for the
  // case where something upstream changed shape, and "couldn't read it, carry
  // on" would make it useless on exactly the day it was needed.
  console.error(
    `::error::Could not compare the signing key against the shipped pubkey: ${
      e instanceof Error ? e.message : String(e)
    }. Refusing to build rather than shipping an unverified keypair.`,
  );
  process.exit(1);
}

console.log(`signature key id  : ${signatureKeyId}`);
console.log(`shipped pubkey id : ${pubkeyKeyId}`);

if (signatureKeyId !== pubkeyKeyId) {
  console.error(
    `::error::TAURI_SIGNING_PRIVATE_KEY (key id ${signatureKeyId}) is NOT the private half of ` +
      `plugins.updater.pubkey in ${confPath} (key id ${pubkeyKeyId}). Tauri does not check this, so ` +
      `this build would succeed and every installed copy of Atlas would then REJECT the update — ` +
      `recoverable only by a manual reinstall for every user. Make both halves come from one ` +
      `keypair: fix the CI secret, or update the pubkey (which strands existing installs). ` +
      `See docs/RELEASE.md.`,
  );
  process.exit(1);
}

console.log("Keypair OK — the release will be signed by the key the app trusts.");
