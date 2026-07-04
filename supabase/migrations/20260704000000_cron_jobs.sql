-- Scheduled jobs via pg_cron + pg_net (replaces Lovable Cloud's [[cron_jobs]]).
-- The Authorization header uses the publishable (anon) key — it is public by
-- design and the functions run their own checks.

-- Daily usage snapshot at midnight UTC: aggregates provider stats, enforces
-- the budget auto-disable.
select cron.schedule(
  'daily-usage-snapshot',
  '0 0 * * *',
  $$
  select net.http_post(
    url := 'https://gdhdqetwlinlpimpxokp.supabase.co/functions/v1/record-usage-snapshot',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer sb_publishable_S61yeN-dxwAUzLwVzEAavA_rcDdBrmL"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);

-- Daily digest at 06:00 UTC: one budgeted learning cycle following up on the
-- user's recent conversation topics only.
select cron.schedule(
  'atlas-daily-digest',
  '0 6 * * *',
  $$
  select net.http_post(
    url := 'https://gdhdqetwlinlpimpxokp.supabase.co/functions/v1/atlas-daily-digest',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer sb_publishable_S61yeN-dxwAUzLwVzEAavA_rcDdBrmL"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);
