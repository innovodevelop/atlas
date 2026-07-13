-- Mail intelligence (plan Part 4a): read-only scanning of connected mailboxes.
-- Categorization lives ONLY inside Atlas (the mailbox is never modified).
-- Refresh tokens are AES-GCM encrypted with the MAIL_TOKEN_KEY edge secret;
-- message bodies are NOT stored — only headers, snippet and AI extraction.

-- Connected mail accounts
CREATE TABLE public.mail_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('gmail', 'outlook', 'imap')),
  email_address text NOT NULL,
  encrypted_refresh_token text,          -- AES-GCM, key = MAIL_TOKEN_KEY secret
  sync_cursor text,                      -- gmail historyId / graph delta link
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'error', 'disconnected')),
  last_error text,
  last_synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider, email_address)
);

-- Scanned messages: metadata + classification only, never full bodies
CREATE TABLE public.mail_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES public.mail_accounts(id) ON DELETE CASCADE,
  provider_message_id text NOT NULL,
  from_address text,
  subject text,
  snippet text,
  received_at timestamptz,
  category text NOT NULL DEFAULT 'other'
    CHECK (category IN ('bills', 'important', 'documents', 'personal', 'newsletters', 'other')),
  importance real NOT NULL DEFAULT 0,    -- 0-1 from the classifier
  extracted jsonb NOT NULL DEFAULT '{}'::jsonb,  -- {payee, amount, currency, due_date, doc_type, ...}
  has_attachments boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, provider_message_id)
);

-- Proactive alerts surfaced on the dashboard / notifications / speech
CREATE TABLE public.mail_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  message_id uuid REFERENCES public.mail_messages(id) ON DELETE CASCADE,
  alert_type text NOT NULL CHECK (alert_type IN ('bill', 'deadline', 'important', 'document')),
  title text NOT NULL,
  body text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  acknowledged boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Short-lived OAuth state (PKCE verifier lives server-side only)
CREATE TABLE public.mail_oauth_states (
  state text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider text NOT NULL,
  code_verifier text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_mail_messages_user_recent ON public.mail_messages (user_id, received_at DESC);
CREATE INDEX idx_mail_alerts_user_unacked ON public.mail_alerts (user_id, acknowledged, created_at DESC);

-- RLS: owner-only. Edge functions use the service role; the app reads as the user.
ALTER TABLE public.mail_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mail_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mail_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mail_oauth_states ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own mail accounts" ON public.mail_accounts
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own mail messages" ON public.mail_messages
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own mail alerts" ON public.mail_alerts
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
-- oauth states: service-role only (no user policies on purpose)

-- The refresh token must never reach the client, even the owner's:
REVOKE SELECT (encrypted_refresh_token) ON public.mail_accounts FROM authenticated, anon;

-- Realtime stream for new alerts (frontend subscribes, notifies, speaks)
ALTER PUBLICATION supabase_realtime ADD TABLE public.mail_alerts;

-- Sync every 15 minutes (also doubles as free-tier keep-alive)
SELECT cron.schedule(
  'mail-sync-15min',
  '*/15 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://gdhdqetwlinlpimpxokp.supabase.co/functions/v1/mail-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer sb_publishable_S61yeN-dxwAUzLwVzEAavA_rcDdBrmL'
    ),
    body := '{}'::jsonb
  );
  $$
);
