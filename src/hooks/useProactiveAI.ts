import { useEffect, useState } from "react";
import { localClient as supabase } from '@/integrations/local/localClient';
import { isWindowActive } from "@/hooks/useWindowActivity";

// The shimmed local client's channel handle — enough for stash + removeChannel.
type ChannelHandle = ReturnType<typeof supabase.channel>;

interface AIInsight {
  id: string;
  insight_type: string;
  title: string;
  content: string;
  priority: number;
  is_read: boolean;
  is_spoken: boolean;
  created_at: string;
}

// Surfaces unspoken ai_insights rows exactly once (Phase 4 proactivity).
//
// Why re-query instead of reading the event payload: the local shim's
// `db:changed` events carry `{table, op}` only — `payload.new` is ALWAYS null
// and per-row filters are ignored (see localClient.ts LocalChannel), so the
// old payload-driven handler could never fire. And the brain sidecar writes
// ai_insights via bun:sqlite, which emits no Tauri event at all — hence the
// activity-gated poll as the delivery path for brain-created insights; the
// channel just makes webview-side inserts surface instantly.
const POLL_MS = 60_000;

export const useProactiveAI = () => {
  const [currentInsight, setCurrentInsight] = useState<AIInsight | null>(null);

  useEffect(() => {
    // NOTE: the effect owns the cleanup — the async work below CANNOT return
    // it. Channel is stashed and removed in the effect's own synchronous
    // cleanup, otherwise it leaks on every mount (WKWebView Networking).
    let cancelled = false;
    let checking = false;
    const handled = new Set<string>(); // surfaced this mount, even if the mark-spoken write lags
    const channelRef: { current: ChannelHandle | null } = { current: null };

    const check = async () => {
      if (checking || cancelled) return;
      checking = true;
      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user || cancelled) return;
        // eq() compares raw SQLite rows, where booleans are 0/1 — filtering on
        // `false` would match nothing (String(0) !== "false").
        const { data } = await supabase
          .from("ai_insights")
          .select("*")
          .eq("user_id", user.id)
          .eq("is_spoken", 0)
          .order("created_at", { ascending: true })
          .limit(10);
        // One insight per cycle: bursts drain across ticks instead of
        // machine-gunning speech.
        const next = ((data ?? []) as AIInsight[]).find((i) => !handled.has(i.id));
        if (!next || cancelled) return;
        handled.add(next.id);
        // Mark spoken before surfacing so a remount can't voice it twice.
        await supabase.from("ai_insights").update({ is_spoken: true }).eq("id", next.id);
        if (!cancelled) setCurrentInsight(next);
      } finally {
        checking = false;
      }
    };

    void check();

    channelRef.current = supabase
      .channel("ai-insights")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "ai_insights" },
        () => { void check(); },
      )
      .subscribe();

    const interval = window.setInterval(() => {
      if (isWindowActive()) void check();
    }, POLL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      if (channelRef.current) supabase.removeChannel(channelRef.current);
    };
  }, []);

  return currentInsight;
};
