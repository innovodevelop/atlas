import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";

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

export const useProactiveAI = () => {
  const [currentInsight, setCurrentInsight] = useState<AIInsight | null>(null);

  useEffect(() => {
    // NOTE: the effect owns the cleanup — the async setup below CANNOT return
    // it (its return value is lost). We stash the channel in a ref and remove
    // it from the effect's own cleanup, otherwise the channel leaks on every
    // mount (it accumulates on the single Supabase realtime socket → the
    // WKWebView Networking process balloons over a long session).
    let cancelled = false;
    const channelRef: { current: ChannelHandle | null } = { current: null };

    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user || cancelled) return;

      const channel = supabase
        .channel("ai-insights")
        .on(
          "postgres_changes",
          {
            event: "INSERT",
            schema: "public",
            table: "ai_insights",
            filter: `user_id=eq.${user.id}`,
          },
          async (payload) => {
            const newInsight = payload.new as AIInsight;
            if (!newInsight.is_spoken) {
              setCurrentInsight(newInsight);
              await supabase
                .from("ai_insights")
                .update({ is_spoken: true })
                .eq("id", newInsight.id);
            }
          }
        )
        .subscribe();
      channelRef.current = channel;
      // If the effect was already cleaned up while awaiting getUser, tear down now.
      if (cancelled) supabase.removeChannel(channel);
    })();

    return () => {
      cancelled = true;
      if (channelRef.current) supabase.removeChannel(channelRef.current);
    };
  }, []);

  const clearInsight = useCallback(() => {
    setCurrentInsight(null);
  }, []);

  return currentInsight;
};
