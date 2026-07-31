import { useCallback, useEffect, useState } from 'react';
import { localClient as supabase } from '@/integrations/local/localClient';
import { useAuth } from '@/hooks/useAuth';

// Mail intelligence (read-only Gmail scanning — see docs/mail-setup.md).
// Data lands server-side via the mail-sync cron; this hook reads it, streams
// new alerts over realtime, and exposes the connect/disconnect flow.
// NOTE: mail_accounts.encrypted_refresh_token must never reach React state.
// The local shim ignores select() column lists and returns full rows, so the
// projection is enforced in JS here (pickAccount) — every mail_accounts result
// is mapped through it before landing in state.

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

// The shim returns whole rows regardless of the select() column string, so
// project mail_accounts rows down in JS — this is the only thing standing
// between encrypted_refresh_token and React state. Exported for the shim's
// projection test (localClient.test.ts).
export function pickAccount(r: Record<string, unknown>): MailAccount {
  return {
    id: r.id as string,
    provider: r.provider as string,
    email_address: r.email_address as string,
    status: r.status as string,
    last_synced_at: (r.last_synced_at as string | null) ?? null,
  };
}

// --- Shared alert stream -----------------------------------------------
// The hook is mounted by BOTH the Inbox card (always) and the expanded Mail
// view. Each opening its own channel on the same topic makes two Phoenix
// joins on one socket — a join/rejoin ping-pong that churns the Networking
// process. One module-level channel per user, refcounted across consumers
// (same pattern as useWindowActivity's shared listeners).
type AlertListener = (alerts: MailAlert[]) => void;
let alertListeners: AlertListener[] = [];
let alertChannel: ReturnType<typeof supabase.channel> | null = null;
let alertChannelUserId: string | null = null;
let knownAlertIds: Set<string> | null = null;

// Local realtime events carry no row data, so on every change we re-query the
// open alerts, hand every listener the fresh list, and native-notify only the
// alerts not seen before (the first fetch seeds the set without notifying).
async function refetchAlerts() {
  const { data } = await supabase
    .from('mail_alerts')
    .select('id, alert_type, title, body, payload, acknowledged, created_at')
    .eq('acknowledged', false)
    .order('created_at', { ascending: false })
    .limit(20);
  const alerts = (data as MailAlert[] | null) ?? [];
  const fresh = knownAlertIds ? alerts.filter((a) => !knownAlertIds.has(a.id)) : [];
  knownAlertIds = new Set(alerts.map((a) => a.id));
  for (const l of alertListeners) l(alerts);
  for (const a of fresh) notifyNative('Atlas Mail', a.title);
}

function subscribeAlerts(userId: string, listener: AlertListener): () => void {
  alertListeners.push(listener);
  if (!alertChannel || alertChannelUserId !== userId) {
    if (alertChannel) supabase.removeChannel(alertChannel);
    alertChannelUserId = userId;
    knownAlertIds = null;
    alertChannel = supabase
      .channel(`mail-alerts-${userId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'mail_alerts', filter: `user_id=eq.${userId}` },
        () => {
          void refetchAlerts();
        },
      )
      .subscribe();
  }
  return () => {
    alertListeners = alertListeners.filter((l) => l !== listener);
    if (alertListeners.length === 0 && alertChannel) {
      supabase.removeChannel(alertChannel);
      alertChannel = null;
      alertChannelUserId = null;
      knownAlertIds = null;
    }
  };
}

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
    setAccounts(((accountsRes.data as Record<string, unknown>[] | null) || []).map(pickAccount));
    setMessages((messagesRes.data as MailMessage[]) || []);
    setAlerts((alertsRes.data as MailAlert[]) || []);
    setIsLoading(false);
  }, [user]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Realtime alert stream via the shared refcounted channel (one websocket
  // topic no matter how many components mount this hook). Cleanup is owned
  // by the effect itself.
  useEffect(() => {
    if (!user) return;
    return subscribeAlerts(user.id, (freshAlerts) => {
      setAlerts(freshAlerts);
    });
  }, [user]);

  // One-time connect: open Google's consent in the system browser. Being
  // already signed in there (or Keychain autofill) makes it a single Allow
  // click. The callback page tells the user to come back; we poll briefly.
  const connect = useCallback(async () => {
    if (!user) return;
    setIsConnecting(true);
    try {
      const { data, error } = await supabase.functions.invoke('mail-oauth-start', {
        body: { provider: 'gmail' },
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
        const { data } = await supabase.from('mail_accounts').select(ACCOUNT_COLUMNS);
        const rows = ((data as Record<string, unknown>[] | null) || []).map(pickAccount);
        if (rows.length > accounts.length) {
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
      body: { accountId },
    });
    refresh();
  }, [user, refresh]);

  const acknowledge = useCallback(async (alertId: string) => {
    setAlerts((prev) => prev.filter((a) => a.id !== alertId));
    await supabase.from('mail_alerts').update({ acknowledged: true }).eq('id', alertId);
  }, []);

  const syncNow = useCallback(async () => {
    if (!user) return;
    await supabase.functions.invoke('mail-sync', { body: {} });
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
