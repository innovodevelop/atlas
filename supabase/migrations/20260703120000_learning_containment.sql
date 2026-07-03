-- Learning-loop containment: conversation-scoped research with DB-enforced limits.
--
-- Before this migration research could grow without bound: atlas-research
-- recursively spawned sub-topics, topic-discovery invented global topics, and
-- nothing enforced depth/count limits at the data layer. This migration makes
-- atlas_learning_sessions the enforcement entity: every research topic must
-- belong to an active, unexpired session, and a BEFORE INSERT trigger rejects
-- anything over the configured limits — no edge function can bypass it.

-- 1. Session bookkeeping columns
ALTER TABLE public.atlas_learning_sessions
  ADD COLUMN IF NOT EXISTS conversation_id uuid,
  ADD COLUMN IF NOT EXISTS root_topic text,
  ADD COLUMN IF NOT EXISTS trigger_type text NOT NULL DEFAULT 'text',
  ADD COLUMN IF NOT EXISTS topic_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS token_cost numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS budget_cents numeric,
  ADD COLUMN IF NOT EXISTS expires_at timestamptz NOT NULL DEFAULT (now() + interval '2 hours');

CREATE INDEX IF NOT EXISTS idx_learning_sessions_conversation
  ON public.atlas_learning_sessions(conversation_id)
  WHERE status = 'active';

-- 2. Research topics: conversation scoping + fast session lookups
ALTER TABLE public.atlas_research_topics
  ADD COLUMN IF NOT EXISTS conversation_id uuid;

CREATE INDEX IF NOT EXISTS idx_research_session_status
  ON public.atlas_research_topics(learning_session_id, status);

-- 2b. Knowledge entries: track which session/conversation produced them
ALTER TABLE public.atlas_knowledge_entries
  ADD COLUMN IF NOT EXISTS learning_session_id uuid REFERENCES public.atlas_learning_sessions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS conversation_id uuid;

-- 3. Global discovery feeders (topic-discovery, news-pulse) are opt-in now
ALTER TABLE public.atlas_system_settings
  ADD COLUMN IF NOT EXISTS global_discovery_enabled boolean NOT NULL DEFAULT false;

-- 4. The linchpin: session limits enforced at the database layer
CREATE OR REPLACE FUNCTION public.enforce_session_limits()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session public.atlas_learning_sessions%ROWTYPE;
  v_max_topics integer;
  v_max_depth integer;
  v_sibling_count integer;
  v_queued_count integer;
BEGIN
  IF NEW.learning_session_id IS NULL THEN
    RAISE EXCEPTION 'research topic rejected: learning_session_id is required';
  END IF;

  SELECT * INTO v_session
  FROM public.atlas_learning_sessions
  WHERE id = NEW.learning_session_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'research topic rejected: session % not found', NEW.learning_session_id;
  END IF;

  IF v_session.status <> 'active' THEN
    RAISE EXCEPTION 'research topic rejected: session % is % (not active)',
      NEW.learning_session_id, v_session.status;
  END IF;

  IF v_session.expires_at < now() THEN
    UPDATE public.atlas_learning_sessions
    SET status = 'expired', ended_at = now()
    WHERE id = NEW.learning_session_id;
    RAISE EXCEPTION 'research topic rejected: session % expired at %',
      NEW.learning_session_id, v_session.expires_at;
  END IF;

  SELECT max_topics_per_session, max_research_depth
  INTO v_max_topics, v_max_depth
  FROM public.atlas_system_settings
  LIMIT 1;
  v_max_topics := COALESCE(v_max_topics, 3);
  v_max_depth := COALESCE(v_max_depth, 2);

  IF v_session.topic_count >= v_max_topics THEN
    RAISE EXCEPTION 'research topic rejected: session % reached max_topics_per_session (%)',
      NEW.learning_session_id, v_max_topics;
  END IF;

  IF COALESCE(NEW.depth_level, 0) > v_max_depth THEN
    RAISE EXCEPTION 'research topic rejected: depth_level % exceeds max_research_depth (%)',
      NEW.depth_level, v_max_depth;
  END IF;

  IF NEW.parent_id IS NOT NULL THEN
    SELECT count(*) INTO v_sibling_count
    FROM public.atlas_research_topics
    WHERE parent_id = NEW.parent_id;
    IF v_sibling_count >= 2 THEN
      RAISE EXCEPTION 'research topic rejected: parent % already has % sub-topics (max 2)',
        NEW.parent_id, v_sibling_count;
    END IF;
  END IF;

  -- Circuit breaker: a session can never accumulate a runaway queue
  SELECT count(*) INTO v_queued_count
  FROM public.atlas_research_topics
  WHERE learning_session_id = NEW.learning_session_id
    AND status = 'queued';
  IF v_queued_count >= 15 THEN
    RAISE EXCEPTION 'research topic rejected: session % has % queued topics (circuit breaker)',
      NEW.learning_session_id, v_queued_count;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_session_limits ON public.atlas_research_topics;
CREATE TRIGGER trg_enforce_session_limits
  BEFORE INSERT ON public.atlas_research_topics
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_session_limits();

CREATE OR REPLACE FUNCTION public.increment_session_topic_count()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.atlas_learning_sessions
  SET topic_count = topic_count + 1
  WHERE id = NEW.learning_session_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_increment_session_topic_count ON public.atlas_research_topics;
CREATE TRIGGER trg_increment_session_topic_count
  AFTER INSERT ON public.atlas_research_topics
  FOR EACH ROW
  EXECUTE FUNCTION public.increment_session_topic_count();

-- 5. Cancel legacy runaway backlog (orphans from the old global pipeline)
UPDATE public.atlas_research_topics
SET status = 'cancelled', updated_at = now()
WHERE status IN ('queued', 'researching', 'processing');

UPDATE public.atlas_research_queue
SET status = 'cancelled'
WHERE status IN ('queued', 'processing');

-- Close any lingering sessions from before enforcement existed
UPDATE public.atlas_learning_sessions
SET status = 'expired', ended_at = now()
WHERE status = 'active';

-- 6. Fix memory_vectors dimensions: legacy embeddings were fake (hash-based)
-- and the column was vector(1536) while match_brain_vectors takes vector(768),
-- so similarity search could never run. Standardize on 768 (real Gemini
-- embeddings, truncated + normalized) and rebuild via generate-embeddings.
DROP INDEX IF EXISTS idx_memory_vectors_embedding;
DELETE FROM public.memory_vectors;
ALTER TABLE public.memory_vectors DROP COLUMN IF EXISTS embedding;
ALTER TABLE public.memory_vectors ADD COLUMN embedding vector(768);
CREATE INDEX idx_memory_vectors_embedding
  ON public.memory_vectors
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);
