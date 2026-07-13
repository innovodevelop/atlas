-- Memory v2: unified hybrid recall (see docs/architecture-memory-v2.md)
-- memory_vectors already links ai_memory + atlas_knowledge_entries; this adds
-- query-relevant retrieval on top of it (vector + full-text, scored by
-- relevance x recency x importance) plus access tracking for consolidation.

-- 1. Access tracking (consolidation decays what is never recalled)
ALTER TABLE public.memory_vectors
  ADD COLUMN IF NOT EXISTS last_accessed timestamptz DEFAULT now();

-- 2. Full-text arm of hybrid search
CREATE INDEX IF NOT EXISTS idx_memory_vectors_fts
  ON public.memory_vectors
  USING gin (to_tsvector('english', chunk_text));

-- 3. Unified recall: the ONLY retrieval path chat context should use.
CREATE OR REPLACE FUNCTION public.recall_memories(
  query_embedding vector(768),
  query_text text,
  p_user_id uuid,
  match_count int DEFAULT 12
)
RETURNS TABLE (
  id uuid,
  chunk_text text,
  memory_item_id uuid,
  knowledge_entry_id uuid,
  score float,
  similarity float
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH scored AS (
    SELECT
      mv.id,
      mv.chunk_text,
      mv.memory_item_id,
      mv.knowledge_entry_id,
      -- semantic arm
      (1 - (mv.embedding <=> query_embedding))::float AS sim,
      -- lexical arm (exact names/terms that embeddings miss)
      COALESCE(
        ts_rank(
          to_tsvector('english', mv.chunk_text),
          plainto_tsquery('english', query_text)
        ),
        0
      )::float AS fts,
      -- recency decay, ~45-day half-life
      exp(
        -GREATEST(extract(epoch FROM (now() - mv.created_at)), 0)
        / (86400.0 * 65.0)
      )::float AS recency,
      -- importance normalized to 1-10: ai_memory.importance is already 1-10,
      -- knowledge relevance_score is 0-1
      COALESCE(am.importance::float, LEAST(GREATEST(ake.relevance_score * 10, 1), 10), 5)::float AS importance
    FROM memory_vectors mv
    LEFT JOIN ai_memory am ON am.id = mv.memory_item_id
    LEFT JOIN atlas_knowledge_entries ake ON ake.id = mv.knowledge_entry_id
    WHERE mv.user_id = p_user_id
      AND mv.embedding IS NOT NULL
      AND COALESCE(am.is_fake, false) = false
      AND COALESCE(ake.is_fake, false) = false
  )
  SELECT
    s.id,
    s.chunk_text,
    s.memory_item_id,
    s.knowledge_entry_id,
    -- blended relevance, then shaped (never zeroed) by recency + importance
    (
      (0.65 * s.sim + 0.35 * LEAST(s.fts, 1.0))
      * (0.5 + 0.5 * s.recency)
      * (0.5 + s.importance / 20.0)
    )::float AS score,
    s.sim AS similarity
  FROM scored s
  WHERE s.sim > 0.25 OR s.fts > 0.05
  ORDER BY score DESC
  LIMIT match_count;
END;
$$;

-- 4. Fire-and-forget access bump used by chat-with-memory after a recall
CREATE OR REPLACE FUNCTION public.touch_memory_vectors(p_ids uuid[])
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE memory_vectors SET last_accessed = now() WHERE id = ANY(p_ids);
$$;
