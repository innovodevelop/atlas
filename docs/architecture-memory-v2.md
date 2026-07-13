# Atlas memory & learning architecture — v2 review

*July 2026. Reviews the post-containment architecture and specifies the v2
refactors implemented alongside this doc.*

## What works (keep, do not touch)

- **Learning containment**: DB trigger (`enforce_session_limits`) + `learningGuards.ts` + gated feeders + budgeted daily digest. Layered, verified live, non-negotiable.
- **Real embeddings**: 768-dim `gemini-embedding-001` via `aiGateway.generateEmbedding`, consistent column/RPC dims.
- **Conversation scoping**: sessions tie research to what the user actually talked about.

## What was weak (and what v2 changes)

### 1. Retrieval ignored the question → unified semantic recall

`chat-with-memory` assembled context from **static top-N queries** (`ai_memory`
by importance, `atlas_knowledge_entries` by relevance_score). The embedding
infrastructure existed (`memory_vectors` spans both stores via
`memory_item_id`/`knowledge_entry_id`) but the chat path never used it — asking
about your sister surfaced the same 25 rows as asking about Kubernetes.

**v2:** one `recall_memories(query_embedding, query_text, user_id, count)` RPC:
- **Hybrid**: pgvector cosine similarity + Postgres full-text (`ts_rank`) so
  exact names/terms match even when embeddings drift.
- **Scored**: `relevance × recency-decay × importance` — recency half-life
  ~45 days, importance from the source row.
- `chat-with-memory` embeds the latest user message (parallel with the other
  context queries) and injects the top hits as "Relevant memories for this
  message". Static profile/style/summaries remain (they are per-user, not
  per-query). Recalled vectors get `last_accessed` bumped (fire-and-forget).

### 2. Fact-checking validated fluency, not truth → grounded validation

`validation-engine` asked an LLM "does this sound accurate?" with **no source
text** — that detects vibes, not facts. It also still called the dead Lovable
gateway and a hardcoded Claude model directly, bypassing `aiGateway`.

**v2:** claims are checked **against their stored source**. `atlas-research`
already persists `source_url` per finding; the validator now fetches the
source (Firecrawl, capped excerpt) and asks: *does this text support the
claim?* → verdict `supported / partial / unsupported / source_unavailable` +
confidence, persisted. Entries without a source fall back to plausibility
checking but are explicitly marked `grounding: none` (low trust). All AI calls
go through `aiGateway`.

### 3. Memory only ever grew → light consolidation in the digest

Nothing ever demoted stale memories; recall quality degrades as noise
accumulates. **v2:** `atlas-daily-digest` additionally (a) re-verifies a small
budget-capped batch of the oldest validated knowledge entries against their
sources, and (b) decays importance (floor 1, never deletes) of memories whose
vectors haven't been recalled in 60 days. Combined with the existing semantic
dedup on write, this keeps the store self-cleaning without destructive merges.

## Deliberately not done

- **Physical table unification**: a single `memories` table would be cleaner,
  but `memory_vectors` already provides a unified *retrieval* surface; moving
  rows buys little and risks the containment triggers. Revisit only if a new
  memory type doesn't fit the vector-link pattern.
- **Cross-encoder reranking**: hybrid + scoring is enough at personal scale;
  reranking adds a model hop per message.

## Invariants for future changes

1. Every memory/knowledge write must produce a 768-dim `memory_vectors` row via
   `aiGateway.generateEmbedding` (no other embedding source).
2. `recall_memories` is the only retrieval path for chat context — extend its
   scoring rather than adding parallel ad-hoc queries.
3. A validation verdict without stored source text must carry
   `grounding: none`; UI/prompts must not present it as verified.
4. Consolidation may demote or merge — never hard-delete user memories.
