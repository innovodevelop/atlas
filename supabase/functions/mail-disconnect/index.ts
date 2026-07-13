// Disconnects a mail account: revokes the Google grant, deletes the account
// row (messages/alerts cascade). The client can't do this itself because the
// encrypted token never leaves the server.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { decryptToken } from "../_shared/mailShared.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { accountId, userId } = await req.json();
    if (!accountId || !userId) throw new Error("accountId and userId are required");

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: account } = await supabase
      .from("mail_accounts")
      .select("id, user_id, encrypted_refresh_token")
      .eq("id", accountId)
      .eq("user_id", userId)   // ownership check — callers can't disconnect others' accounts
      .single();
    if (!account) throw new Error("Account not found");

    // Best-effort revocation at Google
    if (account.encrypted_refresh_token) {
      try {
        const token = await decryptToken(account.encrypted_refresh_token);
        await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: "POST" });
      } catch (e) {
        console.error("[mail-disconnect] revoke failed (continuing):", e);
      }
    }

    // Cascades to mail_messages + mail_alerts
    const { error } = await supabase.from("mail_accounts").delete().eq("id", accountId);
    if (error) throw error;

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[mail-disconnect]", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
