-- WS-A auth hardening: tighten the 19 permissive `(true)` policies.
--
-- Triage result: all 19 sit on SYSTEM tables (provider status, learning
-- queue/logs, budget, health). The frontend only ever READS them (verified:
-- no client insert/update/delete anywhere in src/); every write goes through
-- service-role edge functions, which bypass RLS. Therefore:
--   * SELECT policies: keep, but scoped TO authenticated (anon loses access).
--   * INSERT/UPDATE/DELETE `(true)` policies: dropped — they only ever served
--     service-role writers, which don't need policies at all.
-- Additive-only in spirit: no columns dropped, service paths unaffected.

-- atlas_system_settings ------------------------------------------------------
DROP POLICY IF EXISTS "Anyone can read system settings" ON public.atlas_system_settings;
CREATE POLICY "Authenticated can read system settings"
  ON public.atlas_system_settings FOR SELECT TO authenticated USING (true);
-- (writes: service-role only — edge functions)
DROP POLICY IF EXISTS "Anyone can update system settings" ON public.atlas_system_settings;
DROP POLICY IF EXISTS "Anyone can insert system settings" ON public.atlas_system_settings;

-- atlas_provider_status ------------------------------------------------------
DROP POLICY IF EXISTS "Anyone can read provider status" ON public.atlas_provider_status;
CREATE POLICY "Authenticated can read provider status"
  ON public.atlas_provider_status FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "Anyone can update provider status" ON public.atlas_provider_status;
DROP POLICY IF EXISTS "Anyone can insert provider status" ON public.atlas_provider_status;

-- validation_logs ------------------------------------------------------------
DROP POLICY IF EXISTS "Anyone can view validation logs" ON public.validation_logs;
CREATE POLICY "Authenticated can view validation logs"
  ON public.validation_logs FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "Anyone can insert validation logs" ON public.validation_logs;

-- memory_synthesis_logs ------------------------------------------------------
DROP POLICY IF EXISTS "Anyone can view synthesis logs" ON public.memory_synthesis_logs;
CREATE POLICY "Authenticated can view synthesis logs"
  ON public.memory_synthesis_logs FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "Anyone can insert synthesis logs" ON public.memory_synthesis_logs;

-- atlas_research_queue -------------------------------------------------------
DROP POLICY IF EXISTS "Anyone can view research queue" ON public.atlas_research_queue;
CREATE POLICY "Authenticated can view research queue"
  ON public.atlas_research_queue FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "Anyone can insert to research queue" ON public.atlas_research_queue;
DROP POLICY IF EXISTS "Anyone can update research queue" ON public.atlas_research_queue;
DROP POLICY IF EXISTS "Anyone can delete from research queue" ON public.atlas_research_queue;

-- atlas_brain_runs -----------------------------------------------------------
DROP POLICY IF EXISTS "Anyone can view brain runs" ON public.atlas_brain_runs;
CREATE POLICY "Authenticated can view brain runs"
  ON public.atlas_brain_runs FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "Anyone can insert brain runs" ON public.atlas_brain_runs;
DROP POLICY IF EXISTS "Anyone can update brain runs" ON public.atlas_brain_runs;

-- atlas_error_logs -----------------------------------------------------------
DROP POLICY IF EXISTS "Anyone can view error logs" ON public.atlas_error_logs;
CREATE POLICY "Authenticated can view error logs"
  ON public.atlas_error_logs FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "Anyone can create error logs" ON public.atlas_error_logs;

-- atlas_health_metrics -------------------------------------------------------
DROP POLICY IF EXISTS "Anyone can view health metrics" ON public.atlas_health_metrics;
CREATE POLICY "Authenticated can view health metrics"
  ON public.atlas_health_metrics FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "Anyone can insert health metrics" ON public.atlas_health_metrics;

-- atlas_usage_history --------------------------------------------------------
DROP POLICY IF EXISTS "Anyone can view usage history" ON public.atlas_usage_history;
CREATE POLICY "Authenticated can view usage history"
  ON public.atlas_usage_history FOR SELECT TO authenticated USING (true);

-- atlas_budget_settings ------------------------------------------------------
DROP POLICY IF EXISTS "Anyone can view budget settings" ON public.atlas_budget_settings;
CREATE POLICY "Authenticated can view budget settings"
  ON public.atlas_budget_settings FOR SELECT TO authenticated USING (true);
-- `UPDATE USING (true)` let ANYONE change spending limits — the worst of the 19.
DROP POLICY IF EXISTS "Anyone can update budget settings" ON public.atlas_budget_settings;
DROP POLICY IF EXISTS "Anyone can insert budget settings" ON public.atlas_budget_settings;
