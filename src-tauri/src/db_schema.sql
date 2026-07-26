-- Atlas local app database — SQLite mirror of the Supabase Postgres schema.
-- Phase 1 of the local-first migration (docs/architecture-local-first-migration.md).
--
-- Type mapping Postgres -> SQLite:
--   uuid                -> TEXT   (ids supplied by Rust via uuid::Uuid::new_v4, or the importer)
--   timestamptz / date  -> TEXT   (ISO-8601, e.g. 2026-07-22T09:00:00.000Z)
--   jsonb               -> TEXT   (raw JSON string)
--   boolean             -> INTEGER (0/1)
--   integer             -> INTEGER
--   float/double/real   -> REAL
--   numeric/decimal     -> REAL
--   enum (app_role,     -> TEXT with a CHECK constraint
--         model_tier)
--   vector(768)         -> BLOB   (placeholder; Phase 3 adds a sqlite-vec vec0 table + FTS5)
--
-- FKs: app-internal references are kept; every "-> auth.users" FK is dropped —
-- there is no cloud auth table locally (single local trust boundary, Phase 6).
-- user_id survives as a plain TEXT column (the local profile id).
--
-- pgvector ivfflat + GIN(FTS) indexes are intentionally omitted here; the hybrid
-- recall_memories() reimplementation lands in Phase 3 (sqlite-vec + FTS5).

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Identity / profile
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS profiles (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL UNIQUE,
  display_name        TEXT,
  avatar_url          TEXT,
  first_name          TEXT,
  nickname            TEXT,
  birthday            TEXT,
  timezone            TEXT DEFAULT 'UTC',
  communication_style TEXT DEFAULT 'casual',
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS user_roles (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('admin','moderator','user')),
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (user_id, role)
);

-- ---------------------------------------------------------------------------
-- Conversations / chat
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conversations (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  title      TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content         TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);

-- SFT capture (Phase 3): the full generation transcript, one row per message.
-- Unlike `messages` (frontend-shaped, user/assistant only), a row here can hold
-- the whole fine-tuning tuple — role incl. system/tool, tool_calls, model id,
-- and the composed system prompt at generation time (system_prompt on the
-- assistant row). conversation_id is a plain TEXT ref on purpose: capture must
-- never fail on a missing/foreign conversation row.
CREATE TABLE IF NOT EXISTS chat_turns (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  conversation_id TEXT,
  turn_id         TEXT NOT NULL,                 -- groups all rows of one generation
  seq             INTEGER NOT NULL DEFAULT 0,   -- order within the turn
  role            TEXT NOT NULL CHECK (role IN ('system','user','assistant','tool')),
  content         TEXT NOT NULL,
  tool_calls      TEXT,                          -- jsonb: assistant tool_calls array
  model           TEXT,                          -- logical model id used for the turn
  system_prompt   TEXT,                          -- composed prompt snapshot (assistant row)
  source          TEXT,                          -- text_chat / voice / teaching
  followed_up_at  TEXT,                          -- engagement success signal (see brain capture)
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_chat_turns_user ON chat_turns(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_chat_turns_conv ON chat_turns(conversation_id, created_at);

-- ---------------------------------------------------------------------------
-- Memory / knowledge
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_memory (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL,
  memory_type      TEXT NOT NULL,
  category         TEXT NOT NULL,
  key              TEXT NOT NULL,
  value            TEXT NOT NULL,                 -- jsonb
  importance       INTEGER DEFAULT 5 CHECK (importance BETWEEN 1 AND 10),
  last_mentioned   TEXT,
  mention_count    INTEGER DEFAULT 1,
  is_validated     INTEGER DEFAULT 0,
  is_fake          INTEGER DEFAULT 0,
  validation_score REAL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_memory_validated ON ai_memory(is_validated, is_fake);
-- One fact per (user, key): restating a fact must UPDATE, not duplicate. Kept
-- as a unique INDEX (not a table constraint) because that is the migratable
-- form — existing DBs get deduped first, then this same statement, in
-- db.rs::migrate_ai_memory / localDb.ts::ensureMemoryIntegrity. Also what the
-- upserts' ON CONFLICT(user_id, key) resolves against.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_memory_user_key ON ai_memory(user_id, key);

CREATE TABLE IF NOT EXISTS atlas_learning_sessions (
  id             TEXT PRIMARY KEY,
  user_id        TEXT,
  topic          TEXT NOT NULL,
  mode           TEXT NOT NULL DEFAULT 'explore',
  status         TEXT NOT NULL DEFAULT 'active',
  discoveries    TEXT DEFAULT '[]',
  conversation_id TEXT,
  root_topic     TEXT,
  trigger_type   TEXT NOT NULL DEFAULT 'text',
  topic_count    INTEGER NOT NULL DEFAULT 0,
  token_cost     REAL NOT NULL DEFAULT 0,
  budget_cents   REAL,
  expires_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now','+2 hours')),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ended_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_learning_sessions_conversation
  ON atlas_learning_sessions(conversation_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS atlas_research_topics (
  id                 TEXT PRIMARY KEY,
  parent_id          TEXT REFERENCES atlas_research_topics(id) ON DELETE CASCADE,
  user_id            TEXT,
  topic              TEXT NOT NULL,
  description        TEXT,
  status             TEXT NOT NULL DEFAULT 'queued',
  depth_level        INTEGER NOT NULL DEFAULT 0,
  findings           TEXT DEFAULT '[]',
  sources            TEXT DEFAULT '[]',
  priority           INTEGER NOT NULL DEFAULT 5,
  auto_generated     INTEGER NOT NULL DEFAULT 0,
  is_validated       INTEGER DEFAULT 0,
  is_fake            INTEGER DEFAULT 0,
  validation_score   REAL DEFAULT 0,
  root_topic_context TEXT,
  learning_session_id TEXT REFERENCES atlas_learning_sessions(id) ON DELETE SET NULL,
  conversation_id    TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_research_learning_session ON atlas_research_topics(learning_session_id);
CREATE INDEX IF NOT EXISTS idx_research_session_status ON atlas_research_topics(learning_session_id, status);

CREATE TABLE IF NOT EXISTS atlas_knowledge_entries (
  id                   TEXT PRIMARY KEY,
  user_id              TEXT,                        -- NULL = system knowledge
  category             TEXT NOT NULL DEFAULT 'general',
  topic                TEXT NOT NULL,
  content              TEXT NOT NULL,               -- jsonb
  source               TEXT NOT NULL DEFAULT 'conversation',
  confidence           REAL NOT NULL DEFAULT 0.5,
  relevance_score      REAL NOT NULL DEFAULT 0.5,
  last_accessed        TEXT,
  access_count         INTEGER NOT NULL DEFAULT 0,
  is_fake              INTEGER DEFAULT 0,
  is_validated         INTEGER DEFAULT 0,
  validation_score     REAL DEFAULT 0,
  validation_consensus TEXT DEFAULT '{}',
  validated_at         TEXT,
  research_topic_id    TEXT REFERENCES atlas_research_topics(id) ON DELETE SET NULL,
  validation_status    TEXT DEFAULT 'pending',
  relevance_to_root    REAL,
  root_topic_context   TEXT,
  learning_session_id  TEXT REFERENCES atlas_learning_sessions(id) ON DELETE SET NULL,
  conversation_id      TEXT,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_knowledge_validated ON atlas_knowledge_entries(is_validated, is_fake);
CREATE INDEX IF NOT EXISTS idx_knowledge_research_topic ON atlas_knowledge_entries(research_topic_id);

-- The vector table. embedding stays a BLOB placeholder until Phase 3 wires
-- sqlite-vec (vec0 virtual table) + an FTS5 mirror of chunk_text.
CREATE TABLE IF NOT EXISTS memory_vectors (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL,
  memory_item_id     TEXT REFERENCES ai_memory(id) ON DELETE CASCADE,
  knowledge_entry_id TEXT REFERENCES atlas_knowledge_entries(id) ON DELETE CASCADE,
  embedding          BLOB,                          -- vector(768) -> sqlite-vec in Phase 3
  chunk_text         TEXT NOT NULL,
  source_ref_json    TEXT DEFAULT '{}',
  created_at         TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_accessed      TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_memory_vectors_user ON memory_vectors(user_id);

CREATE TABLE IF NOT EXISTS memory_policies (
  id                   TEXT PRIMARY KEY,
  user_id              TEXT NOT NULL,
  policy_name          TEXT NOT NULL,
  category             TEXT NOT NULL,
  should_remember      INTEGER DEFAULT 1,
  retention_days       INTEGER,
  importance_threshold INTEGER DEFAULT 5,
  auto_prune           INTEGER DEFAULT 0,
  is_active            INTEGER DEFAULT 1,
  created_at           TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ---------------------------------------------------------------------------
-- Life / insights / user content
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_life_events (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  event_type     TEXT NOT NULL,
  event_date     TEXT NOT NULL,
  description    TEXT NOT NULL,
  people_involved TEXT,
  should_follow_up INTEGER DEFAULT 1,
  follow_up_after TEXT,
  is_recurring   INTEGER DEFAULT 0,
  sentiment      TEXT DEFAULT 'neutral',
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS ai_insights (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL,
  insight_type     TEXT NOT NULL,
  title            TEXT NOT NULL,
  content          TEXT NOT NULL,
  related_event_id TEXT REFERENCES user_life_events(id),
  priority         INTEGER DEFAULT 5,
  is_read          INTEGER DEFAULT 0,
  is_spoken        INTEGER DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS data_sources (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_name TEXT NOT NULL,
  config      TEXT,
  is_active   INTEGER DEFAULT 1,
  last_synced TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS user_notes (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  title      TEXT NOT NULL,
  content    TEXT,
  color      TEXT DEFAULT 'amber',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS user_tasks (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  title      TEXT NOT NULL,
  completed  INTEGER DEFAULT 0,
  priority   TEXT DEFAULT 'medium',
  due_date   TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS user_events (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  title       TEXT NOT NULL,
  description TEXT,
  start_time  TEXT NOT NULL,
  end_time    TEXT,
  location    TEXT,
  event_type  TEXT DEFAULT 'meeting',
  attendees   TEXT DEFAULT '[]',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS user_watchlist (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  symbol     TEXT NOT NULL,
  name       TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (user_id, symbol)
);

CREATE TABLE IF NOT EXISTS user_weather_settings (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL UNIQUE,
  city         TEXT DEFAULT 'San Francisco',
  country_code TEXT DEFAULT 'US',
  lat          REAL,
  lon          REAL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ---------------------------------------------------------------------------
-- Agents / runs / tools / approvals
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agents (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL,
  name              TEXT NOT NULL,
  description       TEXT,
  system_prompt     TEXT NOT NULL,
  model_config_json TEXT DEFAULT '{"planner":"openai/gpt-5","worker":"google/gemini-2.5-flash","reasoner":"openai/gpt-5"}',
  enabled_tools_json TEXT DEFAULT '[]',
  risky_tools_json  TEXT DEFAULT '["file_write","shell_exec","api_call"]',
  max_steps         INTEGER DEFAULT 20,
  daily_budget_limit REAL DEFAULT 5.00,
  is_active         INTEGER DEFAULT 1,
  created_at        TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_agents_user_active ON agents(user_id, is_active);

CREATE TABLE IF NOT EXISTS runs (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL,
  agent_id         TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','planning','running','verifying','completed','failed','cancelled')),
  goal_text        TEXT NOT NULL,
  plan_json        TEXT,
  result_json      TEXT,
  verification_json TEXT,
  tokens_planner   INTEGER DEFAULT 0,
  tokens_worker    INTEGER DEFAULT 0,
  tokens_reasoner  INTEGER DEFAULT 0,
  cost_estimate    REAL DEFAULT 0,
  error_message    TEXT,
  started_at       TEXT,
  finished_at      TEXT,
  created_at       TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_runs_user_created ON runs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);

CREATE TABLE IF NOT EXISTS run_steps (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  step_index  INTEGER NOT NULL,
  kind        TEXT NOT NULL
                CHECK (kind IN ('planning','thinking','tool_call','tool_result','response','verification','error')),
  model_tier  TEXT CHECK (model_tier IN ('planner','worker','reasoner')),
  model_used  TEXT,
  input_json  TEXT,
  output_json TEXT,
  tokens_used INTEGER DEFAULT 0,
  started_at  TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at TEXT,
  created_at  TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_run_steps_run ON run_steps(run_id, step_index);

CREATE TABLE IF NOT EXISTS tool_calls (
  id                TEXT PRIMARY KEY,
  run_id            TEXT REFERENCES runs(id) ON DELETE SET NULL,
  step_id           TEXT REFERENCES run_steps(id) ON DELETE SET NULL,
  user_id           TEXT NOT NULL,
  tool_name         TEXT NOT NULL,
  args_json         TEXT NOT NULL DEFAULT '{}',
  result_json       TEXT,
  status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','awaiting_approval','approved','rejected','running','completed','failed')),
  requires_approval INTEGER DEFAULT 0,
  sandboxed         INTEGER DEFAULT 0,
  cost_estimate     REAL DEFAULT 0,
  error_message     TEXT,
  created_at        TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_tool_calls_run ON tool_calls(run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_tool_calls_user_status ON tool_calls(user_id, status);

CREATE TABLE IF NOT EXISTS approvals (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  run_id         TEXT REFERENCES runs(id) ON DELETE CASCADE,
  tool_call_id   TEXT NOT NULL REFERENCES tool_calls(id) ON DELETE CASCADE,
  action_summary TEXT NOT NULL,
  risk_level     TEXT DEFAULT 'medium' CHECK (risk_level IN ('low','medium','high','critical')),
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  approved_by    TEXT,
  approved_at    TEXT,
  reason         TEXT,
  expires_at     TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now','+24 hours')),
  created_at     TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_approvals_user_status ON approvals(user_id, status);

CREATE TABLE IF NOT EXISTS schedules (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  agent_id       TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  description    TEXT,
  cron_expression TEXT NOT NULL,
  payload_json   TEXT DEFAULT '{}',
  enabled        INTEGER DEFAULT 1,
  last_run_at    TEXT,
  next_run_at    TEXT,
  last_run_status TEXT,
  last_run_id    TEXT REFERENCES runs(id) ON DELETE SET NULL,
  created_at     TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_schedules_user_enabled ON schedules(user_id, enabled);

CREATE TABLE IF NOT EXISTS events_inbox (
  id            TEXT PRIMARY KEY,
  user_id       TEXT,
  event_type    TEXT NOT NULL,
  source        TEXT DEFAULT 'manual',
  payload_json  TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','done','failed')),
  run_id        TEXT REFERENCES runs(id) ON DELETE SET NULL,
  error_message TEXT,
  processed_at  TEXT,
  created_at    TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_events_inbox_status ON events_inbox(status, created_at);

CREATE TABLE IF NOT EXISTS research_citations (
  id                TEXT PRIMARY KEY,
  user_id           TEXT,
  run_id            TEXT REFERENCES runs(id) ON DELETE SET NULL,
  research_topic_id TEXT REFERENCES atlas_research_topics(id) ON DELETE SET NULL,
  url               TEXT NOT NULL,
  title             TEXT,
  snippet           TEXT,
  domain            TEXT,
  credibility_score REAL DEFAULT 0.5,
  citation_type     TEXT DEFAULT 'web' CHECK (citation_type IN ('web','academic','news','documentation','social')),
  raw_json          TEXT,
  accessed_at       TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_at        TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_research_citations_run ON research_citations(run_id);

CREATE TABLE IF NOT EXISTS workspace_settings (
  id                     TEXT PRIMARY KEY,
  user_id                TEXT NOT NULL UNIQUE,
  daily_budget_limit     REAL DEFAULT 10.00,
  daily_run_limit        INTEGER DEFAULT 100,
  daily_tool_call_limit  INTEGER DEFAULT 500,
  require_approval_for_risky INTEGER DEFAULT 1,
  auto_approve_low_risk  INTEGER DEFAULT 1,
  settings_json          TEXT DEFAULT '{}',
  created_at             TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at             TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS model_configs (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  tier        TEXT NOT NULL CHECK (tier IN ('planner','worker','reasoner')),
  model_name  TEXT NOT NULL,
  max_tokens  INTEGER DEFAULT 4096,
  temperature REAL DEFAULT 0.7,
  is_default  INTEGER DEFAULT 0,
  created_at  TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (user_id, tier, is_default)
);

CREATE TABLE IF NOT EXISTS session_context (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  session_id   TEXT NOT NULL,
  context_type TEXT NOT NULL,
  content      TEXT NOT NULL,
  confidence   REAL DEFAULT 1.0,
  expires_at   TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now','+30 minutes')),
  created_at   TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_session_context_user_session ON session_context(user_id, session_id);
CREATE INDEX IF NOT EXISTS idx_session_context_expires ON session_context(expires_at);

-- ---------------------------------------------------------------------------
-- Atlas brain / learning / observability
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS atlas_error_logs (
  id            TEXT PRIMARY KEY,
  user_id       TEXT,
  error_type    TEXT NOT NULL,
  error_message TEXT NOT NULL,
  stack_trace   TEXT,
  context       TEXT,
  severity      TEXT NOT NULL DEFAULT 'error',
  resolved      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS atlas_health_metrics (
  id          TEXT PRIMARY KEY,
  metric_type TEXT NOT NULL,
  value       REAL NOT NULL,
  context     TEXT,
  recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS validation_logs (
  id                 TEXT PRIMARY KEY,
  entry_id           TEXT NOT NULL,
  entry_type         TEXT NOT NULL,
  validator_model    TEXT NOT NULL,
  verdict            TEXT NOT NULL,
  confidence         REAL NOT NULL DEFAULT 0.5,
  reasoning          TEXT,
  sources_checked    TEXT DEFAULT '[]',
  processing_time_ms INTEGER,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_validation_logs_entry ON validation_logs(entry_id, entry_type);
CREATE INDEX IF NOT EXISTS idx_validation_logs_verdict ON validation_logs(verdict);
CREATE INDEX IF NOT EXISTS idx_validation_logs_created ON validation_logs(created_at DESC);

CREATE TABLE IF NOT EXISTS memory_synthesis_logs (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT,
  operation_type     TEXT NOT NULL,
  input_count        INTEGER DEFAULT 0,
  output_count       INTEGER DEFAULT 0,
  conflicts_resolved INTEGER DEFAULT 0,
  insights_extracted INTEGER DEFAULT 0,
  duration_ms        INTEGER,
  details            TEXT DEFAULT '{}',
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_synthesis_logs_user ON memory_synthesis_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_synthesis_logs_operation ON memory_synthesis_logs(operation_type);
CREATE INDEX IF NOT EXISTS idx_synthesis_logs_created ON memory_synthesis_logs(created_at DESC);

CREATE TABLE IF NOT EXISTS atlas_research_queue (
  id                   TEXT PRIMARY KEY,
  topic                TEXT NOT NULL,
  description          TEXT,
  priority_score       REAL DEFAULT 0.5,
  source               TEXT NOT NULL DEFAULT 'manual',
  category             TEXT DEFAULT 'general',
  status               TEXT DEFAULT 'queued',
  attempts             INTEGER DEFAULT 0,
  max_attempts         INTEGER DEFAULT 3,
  last_attempt_at      TEXT,
  scheduled_for        TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  processing_started_at TEXT,
  completed_at         TEXT,
  error_message        TEXT,
  metadata             TEXT DEFAULT '{}',
  user_id              TEXT,
  created_at           TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at           TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_research_queue_status_priority
  ON atlas_research_queue(status, priority_score DESC, scheduled_for);
CREATE INDEX IF NOT EXISTS idx_research_queue_source ON atlas_research_queue(source);

CREATE TABLE IF NOT EXISTS atlas_brain_runs (
  id                  TEXT PRIMARY KEY,
  run_type            TEXT NOT NULL,
  status              TEXT DEFAULT 'running',
  started_at          TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at        TEXT,
  metrics             TEXT DEFAULT '{}',
  error_message       TEXT,
  news_collected      INTEGER DEFAULT 0,
  topics_generated    INTEGER DEFAULT 0,
  research_completed  INTEGER DEFAULT 0,
  entries_validated   INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS atlas_learning_logs (
  id               TEXT PRIMARY KEY,
  session_id       TEXT,
  user_id          TEXT,
  trigger_type     TEXT NOT NULL CHECK (trigger_type IN ('voice','text','manual','scheduled')),
  intent_detected  TEXT,
  topic_requested  TEXT,
  topics_learned   INTEGER NOT NULL DEFAULT 0,
  max_topics_allowed INTEGER NOT NULL DEFAULT 3,
  status           TEXT NOT NULL DEFAULT 'started'
                     CHECK (status IN ('started','learning','completed','stopped','error')),
  error_message    TEXT,
  provider_errors  TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at     TEXT
);

CREATE TABLE IF NOT EXISTS atlas_system_settings (
  id                          TEXT PRIMARY KEY,
  learning_enabled            INTEGER NOT NULL DEFAULT 0,
  learning_mode               TEXT NOT NULL DEFAULT 'on_demand'
                                CHECK (learning_mode IN ('on_demand','scheduled','disabled')),
  max_topics_per_session      INTEGER NOT NULL DEFAULT 3,
  max_research_depth          INTEGER NOT NULL DEFAULT 2,
  auto_validation             INTEGER NOT NULL DEFAULT 0,
  auto_knowledge_extraction   INTEGER NOT NULL DEFAULT 0,
  lovable_ai_enabled          INTEGER NOT NULL DEFAULT 1,
  auto_switch_enabled         INTEGER NOT NULL DEFAULT 1,
  budget_switch_threshold_pct INTEGER NOT NULL DEFAULT 70,
  preferred_cheap_provider    TEXT DEFAULT 'lovable_ai',
  disable_reason              TEXT,
  disabled_at                 TEXT,
  global_discovery_enabled    INTEGER NOT NULL DEFAULT 0,
  created_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Seed (idempotent, and re-run on every open since the whole schema batch is):
-- without any row, isLearningEnabled() reads "disabled" forever — there was no
-- INSERT anywhere, so fresh installs never learned. Guarded on the table being
-- empty so a user's later change to learning_enabled is never overwritten.
-- JS twin lives in services/atlas-brain/src/localDb.ts (keep in lockstep).
INSERT INTO atlas_system_settings (id, learning_enabled)
SELECT 'default', 1
WHERE NOT EXISTS (SELECT 1 FROM atlas_system_settings);

-- Personality as bounded state (MVP Phase 4): trait vector + learned lexicon,
-- composed into the system prompt by _shared/personality.ts. One row per user.
CREATE TABLE IF NOT EXISTS atlas_personality (
  user_id      TEXT PRIMARY KEY,
  traits_json  TEXT NOT NULL DEFAULT '{}',
  lexicon_json TEXT NOT NULL DEFAULT '{}',
  -- Trait names the user set by hand; drift may never move these.
  pinned_json  TEXT NOT NULL DEFAULT '[]',
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS atlas_provider_status (
  id                   TEXT PRIMARY KEY,
  provider             TEXT NOT NULL UNIQUE
                         CHECK (provider IN ('lovable_ai','perplexity','anthropic','jina','openai')),
  status               TEXT NOT NULL DEFAULT 'unknown'
                         CHECK (status IN ('healthy','degraded','error','rate_limited','credits_exhausted','unknown')),
  last_success         TEXT,
  last_error           TEXT,
  error_count          INTEGER NOT NULL DEFAULT 0,
  rate_limit_until     TEXT,
  total_calls          INTEGER NOT NULL DEFAULT 0,
  successful_calls     INTEGER NOT NULL DEFAULT 0,
  failed_calls         INTEGER NOT NULL DEFAULT 0,
  avg_response_time_ms INTEGER,
  priority_order       INTEGER NOT NULL DEFAULT 10,
  cost_tier            TEXT DEFAULT 'standard',
  is_enabled           INTEGER NOT NULL DEFAULT 1,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_provider_status_routing
  ON atlas_provider_status(is_enabled, cost_tier, priority_order);

CREATE TABLE IF NOT EXISTS atlas_usage_history (
  id               TEXT PRIMARY KEY,
  date             TEXT NOT NULL,
  provider         TEXT NOT NULL,
  total_calls      INTEGER NOT NULL DEFAULT 0,
  successful_calls INTEGER NOT NULL DEFAULT 0,
  failed_calls     INTEGER NOT NULL DEFAULT 0,
  estimated_cost   REAL NOT NULL DEFAULT 0,
  tokens_used      INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (date, provider)
);

CREATE TABLE IF NOT EXISTS atlas_budget_settings (
  id                    TEXT PRIMARY KEY,
  daily_budget_usd      REAL NOT NULL DEFAULT 5.00,
  weekly_budget_usd     REAL NOT NULL DEFAULT 25.00,
  alert_threshold_pct   INTEGER NOT NULL DEFAULT 80,
  critical_threshold_pct INTEGER NOT NULL DEFAULT 95,
  auto_disable_on_limit INTEGER NOT NULL DEFAULT 1,
  alerts_enabled        INTEGER NOT NULL DEFAULT 1,
  last_daily_alert_at   TEXT,
  last_weekly_alert_at  TEXT,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ---------------------------------------------------------------------------
-- Mail
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mail_accounts (
  id                      TEXT PRIMARY KEY,
  user_id                 TEXT NOT NULL,
  provider                TEXT NOT NULL CHECK (provider IN ('gmail','outlook','imap')),
  email_address           TEXT NOT NULL,
  -- Legacy column from the Supabase-era mail functions, which held a
  -- server-encrypted Gmail refresh token. The local flow keeps the token in the
  -- macOS Keychain instead (secrets.rs) and leaves this NULL. Kept so existing
  -- rows still load; migrate_mail adds the columns below beside it.
  encrypted_refresh_token TEXT,
  sync_cursor             TEXT,
  status                  TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','error','disconnected')),
  last_error              TEXT,
  last_synced_at          TEXT,
  -- Per-mailbox autonomy (the design's "Mailbox" record). 'approve_all' is the
  -- deliberate default: an agent that sends mail unsupervised is the highest-risk
  -- behaviour in the product, so 'autonomous' must be chosen, never inherited.
  autonomy_mode           TEXT NOT NULL DEFAULT 'approve_all'
                            CHECK (autonomy_mode IN ('approve_all','conditional','autonomous')),
  autonomy_condition      TEXT NOT NULL DEFAULT '{}',
  colour                  TEXT,
  created_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (user_id, provider, email_address)
);

CREATE TABLE IF NOT EXISTS mail_messages (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL,
  account_id          TEXT NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  -- Nullable on purpose: a message can be stored before its thread row exists
  -- (and every row written by the pre-Phase-7a builds has no thread at all).
  thread_id           TEXT REFERENCES mail_threads(id) ON DELETE SET NULL,
  provider_message_id TEXT NOT NULL,
  from_address        TEXT,
  subject             TEXT,
  snippet             TEXT,
  received_at         TEXT,
  category            TEXT NOT NULL DEFAULT 'other'
                        CHECK (category IN ('bills','important','documents','personal','newsletters','other')),
  importance          REAL NOT NULL DEFAULT 0,
  extracted           TEXT NOT NULL DEFAULT '{}',
  has_attachments     INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (account_id, provider_message_id)
);
CREATE INDEX IF NOT EXISTS idx_mail_messages_user_recent ON mail_messages(user_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_mail_messages_thread ON mail_messages(thread_id, received_at);

CREATE TABLE IF NOT EXISTS mail_alerts (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  message_id   TEXT REFERENCES mail_messages(id) ON DELETE CASCADE,
  alert_type   TEXT NOT NULL CHECK (alert_type IN ('bill','deadline','important','document')),
  title        TEXT NOT NULL,
  body         TEXT,
  payload      TEXT NOT NULL DEFAULT '{}',
  acknowledged INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_mail_alerts_user_unacked ON mail_alerts(user_id, acknowledged, created_at DESC);

CREATE TABLE IF NOT EXISTS mail_oauth_states (
  state         TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  provider      TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ---------------------------------------------------------------------------
-- Mail — threads, rules, drafts and the audit trail (Phase 7a).
--
-- Everything the Mail design works in is thread-shaped, and mail_messages above
-- is message-shaped with no grouping key at all — see the audit's P1-7
-- (docs/design-sync/2026-07-26-audit-sphere-mail-header.md §2.1). These tables
-- close that gap. They are the data layer only; nothing populates them until
-- the sync path lands.
-- ---------------------------------------------------------------------------

-- A thread is the unit every Mail view lists, filters and acts on.
-- `status` carries the six states the design's views map 1:1 onto, plus
-- 'triage' — a thread that has arrived and not yet been placed, which is what
-- the catch-all Triage view actually shows.
CREATE TABLE IF NOT EXISTS mail_threads (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL,
  account_id         TEXT NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  provider_thread_id TEXT NOT NULL,
  subject            TEXT,
  participants       TEXT NOT NULL DEFAULT '[]',   -- JSON array of addresses
  status             TEXT NOT NULL DEFAULT 'triage'
                       CHECK (status IN ('triage','approve','drafting','escalate','snooze','handled','handoff')),
  snoozed_until      TEXT,
  unread_count       INTEGER NOT NULL DEFAULT 0,
  last_message_at    TEXT,
  -- Stamped when status becomes 'handled'. This is what makes the design's
  -- "Atlas answered 14 threads since 6am" a real count instead of a mock.
  handled_at         TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (account_id, provider_thread_id)
);
CREATE INDEX IF NOT EXISTS idx_mail_threads_user_status ON mail_threads(user_id, status, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_mail_threads_snoozed ON mail_threads(user_id, snoozed_until) WHERE snoozed_until IS NOT NULL;

-- Autonomy rules are per-mailbox and USER-OWNED data, not constants: the
-- prototype hardcoded three of them (audit Q7). `predicate` and `action_config`
-- are JSON so a rule can grow new match/condition fields without a migration.
CREATE TABLE IF NOT EXISTS mail_rules (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  account_id    TEXT REFERENCES mail_accounts(id) ON DELETE CASCADE,
  label         TEXT NOT NULL,
  predicate     TEXT NOT NULL DEFAULT '{}',
  action        TEXT NOT NULL CHECK (action IN ('approve','draft','escalate','snooze','handoff','handle')),
  action_config TEXT NOT NULL DEFAULT '{}',
  enabled       INTEGER NOT NULL DEFAULT 1,
  position      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_mail_rules_user ON mail_rules(user_id, account_id, position);

-- A reply Atlas has written. 'proposed' waits for approval, 'scheduled' has a
-- send time, 'sent' is done. `model`/`prompt_version` are recorded per draft so
-- the audit trail can answer "which model wrote this" years later.
CREATE TABLE IF NOT EXISTS mail_drafts (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  thread_id      TEXT NOT NULL REFERENCES mail_threads(id) ON DELETE CASCADE,
  body           TEXT NOT NULL DEFAULT '',
  state          TEXT NOT NULL DEFAULT 'proposed'
                   CHECK (state IN ('proposed','scheduled','sent','discarded')),
  scheduled_for  TEXT,
  sent_at        TEXT,
  model          TEXT,
  prompt_version TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_mail_drafts_thread ON mail_drafts(thread_id, state);
CREATE INDEX IF NOT EXISTS idx_mail_drafts_due ON mail_drafts(user_id, scheduled_for) WHERE state = 'scheduled';

-- The audit trail. DECIDED 2026-07-26: it is LOCAL — it lives here, next to the
-- mail it describes, and nothing derived from message content is uploaded. The
-- reasoning is in the audit doc §2.3.1; the short version is that the reader of
-- this table is the account owner asking "why did Atlas send that", and a local
-- log answers that completely, whereas putting it on our servers would falsify
-- the privacy policy published at helloatlas.dk.
--
-- `seq` is INTEGER PRIMARY KEY AUTOINCREMENT rather than plain rowid because
-- AUTOINCREMENT is what guarantees ids are never reused after a delete — a
-- reused id in an audit trail is a silently rewritten history.
--
-- `thread_id` is deliberately NOT a foreign key. A CASCADE from mail_threads
-- would delete the record of what Atlas did to a thread at the moment the
-- thread is deleted, which is precisely when you want to keep it. It also could
-- not work: the append-only trigger below aborts the cascade, taking the
-- thread delete down with it.
CREATE TABLE IF NOT EXISTS mail_audit_events (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,
  id             TEXT NOT NULL UNIQUE,
  user_id        TEXT NOT NULL,
  thread_id      TEXT,
  ts             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  actor          TEXT NOT NULL CHECK (actor IN ('atlas','user','rule')),
  action         TEXT NOT NULL,
  detail         TEXT NOT NULL DEFAULT '',
  rule_id        TEXT,
  model          TEXT,
  prompt_version TEXT
);
CREATE INDEX IF NOT EXISTS idx_mail_audit_user_ts ON mail_audit_events(user_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_mail_audit_thread ON mail_audit_events(thread_id, seq);

-- Append-only, enforced. Not tamper-PROOF: this is the owner's own machine and
-- any SQLite client can drop these triggers. That is fine and is stated in the
-- audit doc rather than hidden. What they do buy is the failure mode that
-- actually matters — Atlas cannot quietly edit or drop its own record through a
-- bug or a careless query.
--
-- Erasure is the one legitimate delete, and it works by DROPPING the delete
-- trigger, deleting, and recreating it (see eraseUserData in the brain). A
-- WHEN-clause escape hatch was tried first and is not possible: SQLite refuses
-- to compile a trigger that references temp.* ("cannot reference objects in
-- database temp"). If the process dies mid-erase the trigger is restored on the
-- next launch by this file's CREATE TRIGGER IF NOT EXISTS.
CREATE TRIGGER IF NOT EXISTS trg_mail_audit_no_update BEFORE UPDATE ON mail_audit_events
  BEGIN SELECT RAISE(ABORT, 'mail_audit_events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_mail_audit_no_delete BEFORE DELETE ON mail_audit_events
  BEGIN SELECT RAISE(ABORT, 'mail_audit_events is append-only (erase via the account-erase path)'); END;

-- ---------------------------------------------------------------------------
-- updated_at triggers (mirror Postgres update_updated_at_column()).
-- Guard `WHEN NEW.updated_at = OLD.updated_at` bounds recursion to depth 1:
-- the trigger's own UPDATE changes updated_at, so it won't re-fire.
-- ---------------------------------------------------------------------------
CREATE TRIGGER IF NOT EXISTS trg_profiles_updated AFTER UPDATE ON profiles
  FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
  BEGIN UPDATE profiles SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id; END;
CREATE TRIGGER IF NOT EXISTS trg_conversations_updated AFTER UPDATE ON conversations
  FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
  BEGIN UPDATE conversations SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id; END;
CREATE TRIGGER IF NOT EXISTS trg_ai_memory_updated AFTER UPDATE ON ai_memory
  FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
  BEGIN UPDATE ai_memory SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id; END;
CREATE TRIGGER IF NOT EXISTS trg_user_notes_updated AFTER UPDATE ON user_notes
  FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
  BEGIN UPDATE user_notes SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id; END;
CREATE TRIGGER IF NOT EXISTS trg_user_tasks_updated AFTER UPDATE ON user_tasks
  FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
  BEGIN UPDATE user_tasks SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id; END;
CREATE TRIGGER IF NOT EXISTS trg_user_events_updated AFTER UPDATE ON user_events
  FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
  BEGIN UPDATE user_events SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id; END;
CREATE TRIGGER IF NOT EXISTS trg_user_weather_settings_updated AFTER UPDATE ON user_weather_settings
  FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
  BEGIN UPDATE user_weather_settings SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id; END;
CREATE TRIGGER IF NOT EXISTS trg_atlas_knowledge_entries_updated AFTER UPDATE ON atlas_knowledge_entries
  FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
  BEGIN UPDATE atlas_knowledge_entries SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id; END;
CREATE TRIGGER IF NOT EXISTS trg_atlas_research_topics_updated AFTER UPDATE ON atlas_research_topics
  FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
  BEGIN UPDATE atlas_research_topics SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id; END;
CREATE TRIGGER IF NOT EXISTS trg_model_configs_updated AFTER UPDATE ON model_configs
  FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
  BEGIN UPDATE model_configs SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id; END;
CREATE TRIGGER IF NOT EXISTS trg_agents_updated AFTER UPDATE ON agents
  FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
  BEGIN UPDATE agents SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id; END;
CREATE TRIGGER IF NOT EXISTS trg_workspace_settings_updated AFTER UPDATE ON workspace_settings
  FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
  BEGIN UPDATE workspace_settings SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id; END;
CREATE TRIGGER IF NOT EXISTS trg_events_inbox_updated AFTER UPDATE ON events_inbox
  FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
  BEGIN UPDATE events_inbox SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id; END;
CREATE TRIGGER IF NOT EXISTS trg_atlas_system_settings_updated AFTER UPDATE ON atlas_system_settings
  FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
  BEGIN UPDATE atlas_system_settings SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id; END;
CREATE TRIGGER IF NOT EXISTS trg_atlas_personality_updated AFTER UPDATE ON atlas_personality
  FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
  BEGIN UPDATE atlas_personality SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id = NEW.user_id; END;
CREATE TRIGGER IF NOT EXISTS trg_atlas_provider_status_updated AFTER UPDATE ON atlas_provider_status
  FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
  BEGIN UPDATE atlas_provider_status SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id; END;
CREATE TRIGGER IF NOT EXISTS trg_atlas_budget_settings_updated AFTER UPDATE ON atlas_budget_settings
  FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
  BEGIN UPDATE atlas_budget_settings SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id; END;
CREATE TRIGGER IF NOT EXISTS trg_atlas_research_queue_updated AFTER UPDATE ON atlas_research_queue
  FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
  BEGIN UPDATE atlas_research_queue SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id; END;
