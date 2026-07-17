-- WS-A auth hardening: cron targets now require an x-cron-secret header
-- (verified in-code by _shared/auth.ts requireCronSecret). The secret value
-- lives in Supabase Vault under the name 'cron_secret' — created out-of-band,
-- NEVER in a committed migration — and the same value is set as the
-- CRON_SECRET edge-function secret.
--
-- cron.schedule() with an existing jobname replaces that job, so these three
-- statements upgrade the jobs created in 20260704000000 / 20260713110000.

select cron.schedule(
  'daily-usage-snapshot',
  '0 0 * * *',
  $$
  select net.http_post(
    url := 'https://gdhdqetwlinlpimpxokp.supabase.co/functions/v1/record-usage-snapshot',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer sb_publishable_S61yeN-dxwAUzLwVzEAavA_rcDdBrmL',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);

select cron.schedule(
  'atlas-daily-digest',
  '0 6 * * *',
  $$
  select net.http_post(
    url := 'https://gdhdqetwlinlpimpxokp.supabase.co/functions/v1/atlas-daily-digest',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer sb_publishable_S61yeN-dxwAUzLwVzEAavA_rcDdBrmL',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);

select cron.schedule(
  'mail-sync-15min',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := 'https://gdhdqetwlinlpimpxokp.supabase.co/functions/v1/mail-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer sb_publishable_S61yeN-dxwAUzLwVzEAavA_rcDdBrmL',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);
