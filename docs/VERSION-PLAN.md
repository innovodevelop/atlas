# Atlas Version Plan

> Machine-parseable. The brain sidecar reads this file and syncs it to SQLite.
> Format: `## vX.Y.Z — Codename` / `Status: planned|in-progress|released` /
> `Target: YYYY-MM-DD` / Features as `- [ ]`/`- [x]` task items with optional
> `{id: feat-NNN, agent: ..., design: ...}` metadata suffix.

---

## v0.2.0 — Foundation
Status: released
Target: 2026-08-04

### Features
- [x] Local-first migration complete {id: feat-001}
- [x] Bedrock live end-to-end {id: feat-002}
- [x] Prompt caching (stable/volatile system split) {id: feat-003}
- [x] Canvas sphere port (three.js retired) {id: feat-004}
- [x] Workshop reskin (suite v2) {id: feat-005}
- [x] Signing + updater substrate {id: feat-006}
- [x] First-run permissions screen {id: feat-007}
- [x] Atlas site with Terms/Privacy + account deletion {id: feat-008}

---

## v0.3.0 — Admin Suite
Status: in-progress
Target: 2026-09-01

### Features
- [ ] Version tracking surface (/versions) {id: feat-010, agent: claude-code}
- [ ] Live agent view (/agent-view) {id: feat-011, agent: claude-code}
- [ ] Design sync surface (/design-sync) {id: feat-012, agent: claude-code}
- [ ] Test management surface (/tests) {id: feat-013, agent: claude-code}
- [ ] Internal changelog {id: feat-014, agent: claude-code}
- [ ] Claude Code JSONL ingestion (file watcher) {id: feat-015, agent: claude-code}
- [ ] CI pipeline monitoring {id: feat-016, agent: claude-code}
- [ ] VERSION-PLAN.md parser + DB sync {id: feat-017, agent: claude-code}

---

## v0.4.0 — Mail & Voice
Status: planned
Target: 2026-10-01

### Features
- [ ] Mail Stage 6e: Gmail/Outlook/IMAP connectors {id: feat-020}
- [ ] Mail sending (SES production access) {id: feat-021}
- [ ] Mail 6b-6d runtime verification {id: feat-022}
- [ ] Wake-word model licensing resolution (Google speech_embedding) {id: feat-023, design: linked}
- [ ] Hey Atlas custom wake phrase {id: feat-024}
- [ ] Voice latency optimization {id: feat-025}

---

## v0.5.0 — Intelligence
Status: planned
Target: 2026-11-01

### Features
- [ ] Fable 5 / Opus 5 / Sonnet 5 Bedrock enablement {id: feat-030}
- [ ] Batch API integration (post-credit phase) {id: feat-031}
- [ ] Autonomous agent dispatch from admin {id: feat-032}
- [ ] Test auto-suggestion (AI-driven) {id: feat-033}
- [ ] Memory: manual add + correction mechanism {id: feat-034}
- [ ] Portfolio hero (Mastercard Open Finance) {id: feat-035}

---

## v0.6.0 — Platform
Status: planned
Target: 2026-12-01

### Features
- [ ] S3/CloudFront updater release home {id: feat-040}
- [ ] CI signing + automated releases {id: feat-041}
- [ ] Privacy policy deploy automation {id: feat-042}
- [ ] Atlas Teach redesign (design system compliance) {id: feat-043, design: linked}
- [ ] Home floating memory cards {id: feat-044, design: linked}
- [ ] E5 model extraction from sidecar binary {id: feat-045}

---

## v1.0.0 — Commercial Release
Status: planned
Target: 2027-Q1

### Features
- [ ] All commercial blockers resolved {id: feat-050}
- [ ] Full test coverage across all surfaces {id: feat-051}
- [ ] Performance audit + budget enforcement {id: feat-052}
- [ ] Public release documentation {id: feat-053}
- [ ] App Store submission (if applicable) {id: feat-054}
