// Settings → Mail → Alerts, "Tell me about bills and deadlines".
//
// One row per user in mail_prefs; no row reads as the design's default, on.
// Rust (mail_flags.rs) reads the same row after every mailbox scan before it
// posts a notification, so the switch takes effect from the next scan and
// needs no window open. Nothing about it leaves the Mac: the flags come from
// the subject and preview a scan already stored, and the notification goes to
// Notification Centre.

import { useCallback, useEffect, useState } from 'react';
import { isTauri, localClient } from '@/integrations/local/localClient';
import { useAuth } from '@/hooks/useAuth';
import { askNotificationPermission } from '@/hooks/useMailIntelligence';

export function useMailAlertsPref() {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const [enabled, setEnabledState] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** macOS refused notifications for Atlas: the switch is stored, but nothing can show. */
  const [blocked, setBlocked] = useState(false);

  useEffect(() => {
    if (!userId || !isTauri()) return;
    let live = true;
    void localClient.from('mail_prefs').select('*').eq('user_id', userId).maybeSingle().then(({ data }) => {
      if (!live || !data) return;
      const v = (data as { alerts_enabled?: unknown }).alerts_enabled;
      setEnabledState(v === true || v === 1);
    });
    return () => { live = false; };
  }, [userId]);

  const setEnabled = useCallback(async (on: boolean) => {
    if (!userId || !isTauri()) { setError('Alerts can be changed in the desktop app.'); return; }
    const before = enabled;
    setEnabledState(on);
    setSaving(true);
    setError(null);
    // localClient has no real upsert: replace the one row.
    const del = await localClient.from('mail_prefs').delete().eq('user_id', userId);
    const ins = del.error ? del : await localClient.from('mail_prefs').insert({ user_id: userId, alerts_enabled: on ? 1 : 0 });
    setSaving(false);
    if (ins.error) {
      setEnabledState(before);
      setError(`The setting was not saved: ${ins.error.message}`);
      return;
    }
    // Turning it on is the user's own click, so this is when macOS asks.
    setBlocked(on ? !(await askNotificationPermission()) : false);
  }, [userId, enabled]);

  return { enabled, saving, error, blocked, setEnabled };
}
