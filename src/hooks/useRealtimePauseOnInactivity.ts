import { useEffect } from 'react';
import { localClient as supabase } from '@/integrations/local/localClient';
import { useWindowActivity } from '@/hooks/useWindowActivity';

// A Mac window left open for hours otherwise keeps the Supabase realtime
// WebSocket live and buffering in the WKWebView Networking process. When the
// window is hidden/blurred we disconnect the realtime socket; supabase-js
// re-joins all existing channels automatically when we reconnect on focus.
// Mount once, near the app root.
export function useRealtimePauseOnInactivity() {
  const active = useWindowActivity();

  useEffect(() => {
    const realtime = supabase.realtime;
    if (!realtime) return;
    if (active) {
      // Reconnect (no-op if already connected); channels rejoin automatically.
      if (!realtime.isConnected()) realtime.connect();
    } else {
      // Close the socket + its buffers while we're not looking.
      if (realtime.isConnected()) realtime.disconnect();
    }
  }, [active]);
}
