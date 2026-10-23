import { useCallback, useEffect, useRef, useState } from 'react';
import { localClient as supabase } from '@/integrations/local/localClient';
import { useAuth } from '@/hooks/useAuth';

// Mail intelligence (read-only Gmail scanning — see docs/mail-setup.md).
// Gmail connects, syncs and disconnects through the local gmail_* Rust
// commands (localClient routes the old edge-function names to them); this hook
// reads mail_accounts / mail_messages / mail_alerts, streams new alerts, and
// exposes those actions. IMAP mailboxes the user connected go through the
// imap_* commands (mail_imap.rs) the same way. Only those two kinds are
// syncable or disconnectable here (isUserMailbox): the admin IMAP mailbox
// (mail.rs) is listed too, and both Rust modules refuse it.
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
  // Why the last sync failed, if it did: with status 'error' the user has to
  // act (reconnect); with 'active' it was transient and background sync retries.
  last_error: string | null;
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

const ACCOUNT_COLUMNS = 'id, provider, email_address, status, last_synced_at, last_error';

// The shim returns whole rows regardless of the select() column string, so
// project mail_accounts rows down in JS — this is the only thing standing
// between encrypted_refresh_token and React state. Exported for the shim's
// projection test (localClient.test.ts).
/** A mailbox the user connected themselves (Gmail, or IMAP through
 *  mail_imap.rs, whose ids start "imap:"), as opposed to the admin mailbox
 *  that is also provider 'imap'. Only these get Scan and Disconnect. */
export function isUserMailbox(a: Pick<MailAccount, 'id' | 'provider'>): boolean {
  return a.provider === 'gmail' || (a.provider === 'imap' && a.id.startsWith('imap:'));
}

const isImap = (accountId: string) => accountId.startsWith('imap:');

export interface ImapSettings {
  email: string;
  host: string;
  port?: number;
  username?: string;
  password: string;
}

export function pickAccount(r: Record<string, unknown>): MailAccount {
  return {
    id: r.id as string,
    provider: r.provider as string,
    email_address: r.email_address as string,
    status: r.status as string,
    last_synced_at: (r.last_synced_at as string | null) ?? null,
    last_error: (r.last_error as string | null) ?? null,
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
  // Last connect / sync / disconnect failure, for the UI to show. Cleared when
  // the next attempt starts.
  const [error, setError] = useState<string | null>(null);
  // Teardown for an in-flight connect (event listener + timeout), so an
  // unmount mid-sign-in leaves nothing running. connect() awaits before it
  // registers anything, so it also checks `mounted` after each await: an
  // unmount during those awaits ran this cleanup while it was still null.
  const connectCleanup = useRef<(() => void) | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      connectCleanup.current?.();
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!user) { setIsLoading(false); return; }
    const [accountsRes, messagesRes, alertsRes] = await Promise.all([
      // Scoped to the signed-in user: the local shim doesn't filter rows by
      // user, and per-user Gmail ids mean two local users can each have one.
      supabase.from('mail_accounts').select(ACCOUNT_COLUMNS).eq('user_id', user.id).order('created_at'),
      supabase
        .from('mail_messages')
        .select('id, from_address, subject, snippet, received_at, category, importance, extracted')
        .eq('user_id', user.id)
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
  // click. Google redirects to a loopback listener Rust started for this
  // sign-in (gmail.rs), Rust finishes the flow, answers the browser tab, and
  // emits gmail:status, success or failure. That event ends the wait, not a
  // row-count poll (a reconnect of the same mailbox adds no row, and failures
  // add nothing).
  //
  // Each connect() is one attempt. A newer attempt (or cancel, or unmount)
  // makes an older one stale, and a stale attempt registers nothing after its
  // awaits resolve.
  const attempt = useRef(0);

  // The flow id of the attempt in progress. Rust is told to abandon it when
  // the user presses Cancel, or when this attempt fails before the browser
  // opened (nobody could finish it). NOT on unmount: closing the Mail view
  // while the user is in Google's tab must not kill their sign-in. Rust still
  // finishes it, and the account shows up the next time the view loads.
  const currentFlow = useRef<string | null>(null);
  // Every sign-in this instance started that hasn't ended. Rust keeps an
  // earlier one alive when Connect is clicked again, so finishing that older
  // tab must still count here as connected.
  const myFlows = useRef<Set<string>>(new Set());

  const abandonFlow = useCallback((flow: string | null | undefined) => {
    if (!flow) return;
    if (currentFlow.current === flow) currentFlow.current = null;
    myFlows.current.delete(flow);
    // A no-op in Rust if `flow` already ended.
    void supabase.functions.invoke('mail-oauth-cancel', { body: { flow } });
  }, []);

  const cancelConnect = useCallback(() => {
    attempt.current += 1;
    connectCleanup.current?.();
    setIsConnecting(false);
    for (const flow of [...myFlows.current]) abandonFlow(flow);
  }, [abandonFlow]);

  const connect = useCallback(async () => {
    if (!user) return;
    connectCleanup.current?.();
    const mine = ++attempt.current;
    const stale = () => !mounted.current || mine !== attempt.current;
    let flow: string | undefined;
    setError(null);
    setIsConnecting(true);
    const fail = (message: string) => {
      connectCleanup.current?.();
      abandonFlow(flow);
      setError(message);
      setIsConnecting(false);
    };
    try {
      if (!('__TAURI_INTERNALS__' in window)) throw new Error('Gmail can only be connected in the desktop app.');
      const { data, error } = await supabase.functions.invoke('mail-oauth-start', {
        body: { provider: 'gmail', userId: user.id },
      });
      flow = data?.flow;
      if (stale()) {
        abandonFlow(flow);
        return;
      }
      if (error || !data?.authUrl) throw new Error(error?.message ?? 'No auth URL returned');
      currentFlow.current = flow ?? null;
      if (flow) myFlows.current.add(flow);

      const { listen } = await import('@tauri-apps/api/event');
      const unlisten = await listen<{ flow: string | null; connected: boolean; error: string | null }>(
        'gmail:status',
        ({ payload }) => {
          // Every hook instance hears every gmail:status. React only to
          // sign-ins this instance started.
          const f = payload.flow;
          if (!f || !myFlows.current.has(f)) return;
          if (payload.connected) {
            // Any of them connecting ends the wait.
            myFlows.current.clear();
            currentFlow.current = null;
            connectCleanup.current?.();
            setIsConnecting(false);
            refresh();
          } else if (f === flow) {
            fail(payload.error ?? 'Connecting Gmail failed.');
          } else {
            // An earlier tab ended without connecting; the latest is still live.
            myFlows.current.delete(f);
          }
        },
      );
      if (stale()) {
        unlisten();
        abandonFlow(flow);
        return;
      }
      // A backstop only. Rust gives up at oauth::FLOW_TTL (10 min) and says
      // so over gmail:status; waiting longer here means a redirect accepted
      // just before that deadline can still finish its token exchange and
      // report success, instead of racing a webview timer.
      const timeout = window.setTimeout(
        () => fail('Timed out waiting for Google. Please try again.'),
        12 * 60 * 1000,
      );
      connectCleanup.current = () => {
        unlisten();
        window.clearTimeout(timeout);
        connectCleanup.current = null;
      };

      const { openUrl } = await import('@tauri-apps/plugin-opener');
      if (stale()) {
        abandonFlow(flow);
        return;
      }
      await openUrl(data.authUrl);
    } catch (e) {
      console.error('[mail] connect failed:', e);
      if (stale()) abandonFlow(flow);
      else fail(e instanceof Error ? e.message : String(e));
    }
  }, [user, refresh, abandonFlow]);

  const disconnect = useCallback(async (accountId: string) => {
    if (!user) return;
    setError(null);
    const { error } = await supabase.functions.invoke(isImap(accountId) ? 'imap-disconnect' : 'mail-disconnect', {
      body: { accountId, userId: user.id },
    });
    if (error) setError(error.message);
    refresh();
  }, [user, refresh]);

  const acknowledge = useCallback(async (alertId: string) => {
    setAlerts((prev) => prev.filter((a) => a.id !== alertId));
    await supabase.from('mail_alerts').update({ acknowledged: true }).eq('id', alertId);
  }, []);

  // Sync one user mailbox: the given one, else the first active one, else
  // any (a sync is how an 'error' mailbox recovers, and the Rust command
  // reports why if it can't). Never the admin IMAP mailbox: it syncs through
  // mail.rs, and gmail_sync / imap_sync both refuse it.
  const syncNow = useCallback(async (accountId?: string) => {
    if (!user) return;
    const own = accounts.filter(isUserMailbox);
    const target = accountId
      ? own.find((a) => a.id === accountId)
      : own.find((a) => a.status === 'active') ?? own[0];
    if (!target) return;
    setError(null);
    const { error } = await supabase.functions.invoke(isImap(target.id) ? 'imap-sync' : 'mail-sync', {
      body: { accountId: target.id, userId: user.id },
    });
    if (error) setError(error.message);
    refresh();
  }, [user, accounts, refresh]);

  // Connect an IMAP mailbox. Rust logs in once before saving anything, so a
  // wrong password fails here with the server's verdict, then the first scan
  // runs straight away rather than at the next 15-minute tick.
  const connectImap = useCallback(async (settings: ImapSettings): Promise<boolean> => {
    if (!user) return false;
    setError(null);
    if (!('__TAURI_INTERNALS__' in window)) {
      setError('IMAP mailboxes can only be connected in the desktop app.');
      return false;
    }
    const { data, error } = await supabase.functions.invoke('imap-connect', {
      body: { ...settings, userId: user.id },
    });
    if (error || !data?.accountId) {
      setError(error?.message ?? 'Connecting the mailbox failed.');
      return false;
    }
    const synced = await supabase.functions.invoke('imap-sync', {
      body: { accountId: data.accountId, userId: user.id },
    });
    if (synced.error) setError(synced.error.message);
    refresh();
    return true;
  }, [user, refresh]);

  return {
    accounts,
    messages,
    alerts,
    isLoading,
    isConnecting,
    error,
    // Any active mailbox of any provider (the dashboard narration's "is mail
    // connected"). Not a Gmail signal: use hasGmail for Gmail-specific UI.
    isConnected: accounts.some((a) => a.status === 'active'),
    // Any Gmail row, whatever its status: an 'error' mailbox still needs its
    // Scan / Disconnect actions to recover.
    hasGmail: accounts.some((a) => a.provider === 'gmail'),
    connect,
    connectImap,
    cancelConnect,
    disconnect,
    acknowledge,
    syncNow,
    refresh,
  };
}
