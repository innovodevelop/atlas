import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';

// Mail intelligence (read-only Gmail scanning — see docs/mail-setup.md).
// Data lands server-side via the mail-sync cron; this hook reads it, streams
// new alerts over realtime, and exposes the connect/disconnect flow.
// NOTE: mail_accounts.encrypted_refresh_token is column-revoked for clients —
// always select explicit columns from mail_accounts, never `*`.

export interface MailAccount {
  id: string;
  provider: string;
  email_address: string;
  status: string;
  last_synced_at: string | null;
}

export interface MailMessage {
  id: string;
  from_address: string | null;
  subject: string | null;
  snippet: string | null;
  received_at: string | null;
  category: 'bills' | 'important' | 'documents' | 'personal' | 'newsletters' | 'other';
  importance: number;
  extracted: Record<string, unknown>;
}

export interface MailAlert {
  id: string;
  alert_type: 'bill' | 'deadline' | 'important' | 'document';
  title: string;
  body: string | null;
  payload: Record<string, unknown>;
  acknowledged: boolean;
  created_at: string;
}

const ACCOUNT_COLUMNS = 'id, provider, email_address, status, last_synced_at';

async function notifyNative(title: string, body: string) {
  // macOS notification via the Tauri plugin; silently no-op in the browser.
  if (!('__TAURI_INTERNALS__' in window)) return;
  try {
    const { isPermissionGranted, requestPermission, sendNotification } = await import(
      '@tauri-apps/plugin-notification'
    );
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === 'granted';
    if (granted) sendNotification({ title, body });
  } catch {
    /* plugin unavailable — never break the app over a notification */
  }
}

export function useMailIntelligence() {
  const { user } = useAuth();
  const [accounts, setAccounts] = useState<MailAccount[]>([]);
  const [messages, setMessages] = useState<MailMessage[]>([]);
  const [alerts, setAlerts] = useState<MailAlert[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isConnecting, setIsConnecting] = useState(false);
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

  const refresh = useCallback(async () => {
    if (!user) { setIsLoading(false); return; }
    const [accountsRes, messagesRes, alertsRes] = await Promise.all([
      supabase.from('mail_accounts').select(ACCOUNT_COLUMNS).order('created_at'),
      supabase
        .from('mail_messages')
        .select('id, from_address, subject, snippet, received_at, category, importance, extracted')
        .order('received_at', { ascending: false })
        .limit(50),
      supabase
        .from('mail_alerts')
        .select('id, alert_type, title, body, payload, acknowledged, created_at')
        .eq('acknowledged', false)
        .order('created_at', { ascending: false })
        .limit(20),
    ]);
    setAccounts((accountsRes.data as MailAccount[]) || []);
    setMessages((messagesRes.data as MailMessage[]) || []);
    setAlerts((alertsRes.data as MailAlert[]) || []);
    setIsLoading(false);
  }, [user]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Realtime alert stream. Cleanup is owned by the effect itself (the
  // async-setup-returns-cleanup bug is how channels leaked historically).
  useEffect(() => {
    if (!user) return;
    let cancelled = false;

    const channel = supabase
      .channel(`mail-alerts-${user.id}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'mail_alerts', filter: `user_id=eq.${user.id}` },
        (payload) => {
          if (cancelled) return;
          const alert = payload.new as MailAlert;
          setAlerts((prev) => [alert, ...prev].slice(0, 20));
          notifyNative('Atlas Mail', alert.title);
        },
      )
      .subscribe();
    channelRef.current = channel;

    return () => {
      cancelled = true;
      if (channelRef.current) {
        supabase.removeChannel(channelRef.current);
        channelRef.current = null;
      }
    };
  }, [user]);

  // One-time connect: open Google's consent in the system browser. Being
  // already signed in there (or Keychain autofill) makes it a single Allow
  // click. The callback page tells the user to come back; we poll briefly.
  const connect = useCallback(async () => {
    if (!user) return;
    setIsConnecting(true);
    try {
      const { data, error } = await supabase.functions.invoke('mail-oauth-start', {
        body: { userId: user.id, provider: 'gmail' },
      });
      if (error || !data?.authUrl) throw error ?? new Error('No auth URL returned');

      if ('__TAURI_INTERNALS__' in window) {
        const { openUrl } = await import('@tauri-apps/plugin-opener');
        await openUrl(data.authUrl);
      } else {
        window.open(data.authUrl, '_blank', 'noopener');
      }

      // Poll for the account row while the user completes consent (3 min max)
      const started = Date.now();
      const poll = setInterval(async () => {
        const { data: rows } = await supabase.from('mail_accounts').select(ACCOUNT_COLUMNS);
        if ((rows?.length ?? 0) > accounts.length) {
          clearInterval(poll);
          setIsConnecting(false);
          refresh();
        } else if (Date.now() - started > 3 * 60 * 1000) {
          clearInterval(poll);
          setIsConnecting(false);
        }
      }, 3000);
    } catch (e) {
      console.error('[mail] connect failed:', e);
      setIsConnecting(false);
      throw e;
    }
  }, [user, accounts.length, refresh]);

  const disconnect = useCallback(async (accountId: string) => {
    if (!user) return;
    await supabase.functions.invoke('mail-disconnect', {
      body: { accountId, userId: user.id },
    });
    refresh();
  }, [user, refresh]);

  const acknowledge = useCallback(async (alertId: string) => {
    setAlerts((prev) => prev.filter((a) => a.id !== alertId));
    await supabase.from('mail_alerts').update({ acknowledged: true }).eq('id', alertId);
  }, []);

  const syncNow = useCallback(async () => {
    if (!user) return;
    await supabase.functions.invoke('mail-sync', { body: { userId: user.id } });
    refresh();
  }, [user, refresh]);

  return {
    accounts,
    messages,
    alerts,
    isLoading,
    isConnecting,
    isConnected: accounts.some((a) => a.status === 'active'),
    connect,
    disconnect,
    acknowledge,
    syncNow,
    refresh,
  };
}
