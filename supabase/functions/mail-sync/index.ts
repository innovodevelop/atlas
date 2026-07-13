// Mail scanner (plan Part 4a). Cron every 15 min + on-connect first run.
// READ-ONLY: fetches new Gmail messages incrementally, classifies them with
// Gemini (category/importance/bill fields), parses PDF/image attachments of
// likely bills/documents, and raises mail_alerts for anything that matters.
// Bodies are never stored — only headers, snippet, and the AI extraction.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { aiChatCompletion, aiDocumentExtract, hasAIKey } from "../_shared/aiGateway.ts";
import { decryptToken, googleAccessToken, type SupabaseClient } from "../_shared/mailShared.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const FIRST_RUN_DAYS = 30;
const MAX_MESSAGES_PER_RUN = 60;      // budget cap per sync run
const MAX_ATTACHMENT_PARSES = 5;      // deep document parses per run
const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;

interface GmailHeader { name: string; value: string }
interface GmailMessagePart {
  mimeType?: string;
  filename?: string;
  body?: { attachmentId?: string; size?: number; data?: string };
  parts?: GmailMessagePart[];
}
interface GmailMessage {
  id: string;
  snippet?: string;
  internalDate?: string;
  payload?: GmailMessagePart & { headers?: GmailHeader[] };
}

interface Classification {
  category: "bills" | "important" | "documents" | "personal" | "newsletters" | "other";
  importance: number;
  bill?: { payee?: string; amount?: number; currency?: string; due_date?: string };
  reason?: string;
}

function header(msg: GmailMessage, name: string): string {
  return msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function collectAttachments(part: GmailMessagePart | undefined, out: Array<{ id: string; filename: string; mimeType: string; size: number }>) {
  if (!part) return;
  if (part.body?.attachmentId && part.filename) {
    out.push({
      id: part.body.attachmentId,
      filename: part.filename,
      mimeType: part.mimeType || "application/octet-stream",
      size: part.body.size || 0,
    });
  }
  for (const p of part.parts || []) collectAttachments(p, out);
}

async function gmailFetch(accessToken: string, path: string): Promise<Response> {
  return await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

// Classify a batch of messages in one Gemini call (JSON out).
async function classifyBatch(
  items: Array<{ index: number; from: string; subject: string; snippet: string }>,
): Promise<Record<number, Classification>> {
  const response = await aiChatCompletion({
    model: "google/gemini-2.5-flash",
    messages: [
      {
        role: "system",
        content:
          `You classify emails for a personal assistant. For each email return: ` +
          `category ("bills" = invoices/payment requests/subscription charges, "important" = deadlines/appointments/personal-action-needed, ` +
          `"documents" = contracts/tickets/statements/attachments worth keeping, "personal" = real humans writing personally, ` +
          `"newsletters" = marketing/digests, "other"), importance 0.0-1.0, and for bills the fields ` +
          `payee/amount/currency/due_date (ISO date) when stated. ` +
          `Respond ONLY with a JSON array: [{"index": n, "category": "...", "importance": 0.0, "bill": {...} | null, "reason": "few words"}]`,
      },
      {
        role: "user",
        content: items
          .map((i) => `#${i.index}\nFrom: ${i.from}\nSubject: ${i.subject}\nSnippet: ${i.snippet}`)
          .join("\n\n"),
      },
    ],
  });
  if (!response.ok) throw new Error(`Classifier error: ${response.status}`);
  const data = await response.json();
  const content = data.choices?.[0]?.message?.content || "[]";
  const jsonMatch = content.match(/\[[\s\S]*\]/);
  const parsed: Array<Classification & { index: number }> = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
  const byIndex: Record<number, Classification> = {};
  const validCategories = ["bills", "important", "documents", "personal", "newsletters", "other"];
  for (const c of parsed) {
    byIndex[c.index] = {
      category: validCategories.includes(c.category) ? c.category : "other",
      importance: Math.min(Math.max(c.importance ?? 0, 0), 1),
      bill: c.bill || undefined,
      reason: c.reason,
    };
  }
  return byIndex;
}

async function syncAccount(supabase: SupabaseClient, account: {
  id: string; user_id: string; email_address: string;
  encrypted_refresh_token: string; sync_cursor: string | null;
}) {
  const refreshToken = await decryptToken(account.encrypted_refresh_token);
  const accessToken = await googleAccessToken(refreshToken);

  // Which message ids are new?
  let messageIds: string[] = [];
  let newCursor: string | null = account.sync_cursor;

  if (account.sync_cursor) {
    // Incremental via history API
    const histRes = await gmailFetch(
      accessToken,
      `history?startHistoryId=${account.sync_cursor}&historyTypes=messageAdded&maxResults=100`,
    );
    if (histRes.status === 404) {
      // historyId too old — fall through to a shallow re-list
      newCursor = null;
    } else if (histRes.ok) {
      const hist = await histRes.json();
      newCursor = hist.historyId || account.sync_cursor;
      messageIds = (hist.history || [])
        .flatMap((h: { messagesAdded?: Array<{ message: { id: string } }> }) => h.messagesAdded || [])
        .map((m: { message: { id: string } }) => m.message.id);
    } else {
      throw new Error(`history fetch failed: ${histRes.status}`);
    }
  }

  if (!newCursor) {
    // First run (or stale cursor): recent mail only
    const listRes = await gmailFetch(
      accessToken,
      `messages?maxResults=${MAX_MESSAGES_PER_RUN}&q=newer_than:${FIRST_RUN_DAYS}d`,
    );
    if (!listRes.ok) throw new Error(`message list failed: ${listRes.status}`);
    const list = await listRes.json();
    messageIds = (list.messages || []).map((m: { id: string }) => m.id);
    const profRes = await gmailFetch(accessToken, "profile");
    newCursor = profRes.ok ? String((await profRes.json()).historyId ?? "") : null;
  }

  messageIds = [...new Set(messageIds)].slice(0, MAX_MESSAGES_PER_RUN);

  // Skip already-scanned messages
  if (messageIds.length > 0) {
    const { data: existing } = await supabase
      .from("mail_messages").select("provider_message_id")
      .eq("account_id", account.id).in("provider_message_id", messageIds);
    const known = new Set((existing || []).map((e: { provider_message_id: string }) => e.provider_message_id));
    messageIds = messageIds.filter((id) => !known.has(id));
  }

  let alertsCreated = 0;
  let attachmentParses = 0;

  // Fetch metadata, classify in batches of 10
  for (let batchStart = 0; batchStart < messageIds.length; batchStart += 10) {
    const batchIds = messageIds.slice(batchStart, batchStart + 10);
    const messages: GmailMessage[] = [];
    for (const id of batchIds) {
      const res = await gmailFetch(accessToken, `messages/${id}?format=full`);
      if (res.ok) messages.push(await res.json());
    }
    if (messages.length === 0) continue;

    const classifications = await classifyBatch(
      messages.map((m, i) => ({
        index: i,
        from: header(m, "From"),
        subject: header(m, "Subject"),
        snippet: m.snippet || "",
      })),
    ).catch((e) => {
      console.error("[mail-sync] classification failed:", e);
      return {} as Record<number, Classification>;
    });

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const cls = classifications[i] ?? { category: "other" as const, importance: 0 };
      const attachments: Array<{ id: string; filename: string; mimeType: string; size: number }> = [];
      collectAttachments(msg.payload, attachments);

      let extracted: Record<string, unknown> = cls.bill ? { ...cls.bill } : {};

      // Deep-parse the first parseable attachment on bills/documents
      const parseable = attachments.find(
        (a) => ["application/pdf", "image/png", "image/jpeg"].includes(a.mimeType) && a.size > 0 && a.size <= MAX_ATTACHMENT_BYTES,
      );
      if (
        parseable &&
        (cls.category === "bills" || cls.category === "documents") &&
        attachmentParses < MAX_ATTACHMENT_PARSES
      ) {
        attachmentParses++;
        try {
          const attRes = await gmailFetch(accessToken, `messages/${msg.id}/attachments/${parseable.id}`);
          if (attRes.ok) {
            const att = await attRes.json();
            const base64 = String(att.data || "").replace(/-/g, "+").replace(/_/g, "/");
            const answer = await aiDocumentExtract(
              `Extract from this document as JSON only: {"doc_type": "invoice|receipt|contract|ticket|statement|other", ` +
                `"payee": string|null, "amount": number|null, "currency": string|null, "due_date": "YYYY-MM-DD"|null, ` +
                `"reference": string|null, "summary": "one sentence"}`,
              parseable.mimeType,
              base64,
            );
            const jsonMatch = answer.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              extracted = { ...JSON.parse(jsonMatch[0]), ...extracted, parsed_attachment: parseable.filename };
            }
          }
        } catch (e) {
          console.error(`[mail-sync] attachment parse failed (${parseable.filename}):`, e);
        }
      }

      const receivedAt = msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : null;
      const { data: inserted, error: insertError } = await supabase
        .from("mail_messages")
        .insert({
          user_id: account.user_id,
          account_id: account.id,
          provider_message_id: msg.id,
          from_address: header(msg, "From").slice(0, 500),
          subject: header(msg, "Subject").slice(0, 500),
          snippet: (msg.snippet || "").slice(0, 500),
          received_at: receivedAt,
          category: cls.category,
          importance: cls.importance,
          extracted,
          has_attachments: attachments.length > 0,
        })
        .select("id")
        .single();
      if (insertError) {
        console.error("[mail-sync] insert failed:", insertError.message);
        continue;
      }

      // Alerts: bills always; other categories only when clearly important
      let alertType: "bill" | "deadline" | "important" | "document" | null = null;
      if (cls.category === "bills") alertType = "bill";
      else if (extracted.due_date) alertType = "deadline";
      else if (cls.category === "important" && cls.importance >= 0.7) alertType = "important";
      else if (cls.category === "documents" && cls.importance >= 0.7) alertType = "document";

      if (alertType) {
        const amount = extracted.amount ? ` — ${extracted.amount} ${extracted.currency ?? ""}`.trimEnd() : "";
        const due = extracted.due_date ? `, due ${extracted.due_date}` : "";
        const payee = (extracted.payee as string) || header(msg, "From").replace(/<.*>/, "").trim();
        const { error: alertError } = await supabase.from("mail_alerts").insert({
          user_id: account.user_id,
          message_id: inserted.id,
          alert_type: alertType,
          title:
            alertType === "bill" ? `Bill from ${payee}${amount}${due}`
            : alertType === "deadline" ? `Deadline${due}: ${header(msg, "Subject")}`
            : `${alertType === "document" ? "Document" : "Important"}: ${header(msg, "Subject")}`,
          body: cls.reason || msg.snippet || "",
          payload: { category: cls.category, importance: cls.importance, ...extracted },
        });
        if (!alertError) {
          alertsCreated++;
          // Mirror into ai_insights so the existing proactive pipeline
          // (useProactiveAI) surfaces and SPEAKS the alert — no new voice path.
          if (alertType === "bill" || alertType === "deadline") {
            await supabase.from("ai_insights").insert({
              user_id: account.user_id,
              insight_type: "reminder",
              title: alertType === "bill" ? `New bill from ${payee}` : "New deadline in your mail",
              content:
                alertType === "bill"
                  ? `You received a bill from ${payee}${amount}${due}.`
                  : `Your mail mentions a deadline${due}: ${header(msg, "Subject")}`,
              priority: 5,
            }).then(({ error: e }: { error: unknown }) => {
              if (e) console.error("[mail-sync] insight mirror failed:", e);
            });
          }
        }
      }
    }
  }

  await supabase.from("mail_accounts").update({
    sync_cursor: newCursor,
    last_synced_at: new Date().toISOString(),
    status: "active",
    last_error: null,
  }).eq("id", account.id);

  return { scanned: messageIds.length, alerts: alertsCreated };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    if (!hasAIKey()) throw new Error("No AI key configured (GEMINI_API_KEY)");
    const { userId = null } = await req.json().catch(() => ({}));

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    let query = supabase
      .from("mail_accounts")
      .select("id, user_id, email_address, encrypted_refresh_token, sync_cursor")
      .eq("status", "active")
      .eq("provider", "gmail");
    if (userId) query = query.eq("user_id", userId);
    const { data: accounts, error } = await query;
    if (error) throw error;

    const results = [];
    for (const account of accounts || []) {
      try {
        const result = await syncAccount(supabase, account);
        results.push({ account: account.email_address, ...result });
        console.log(`[mail-sync] ${account.email_address}: ${result.scanned} scanned, ${result.alerts} alerts`);
      } catch (e) {
        const message = e instanceof Error ? e.message : "unknown";
        console.error(`[mail-sync] ${account.email_address} failed:`, message);
        await supabase.from("mail_accounts").update({ status: "error", last_error: message }).eq("id", account.id);
        results.push({ account: account.email_address, error: message });
      }
    }

    return new Response(JSON.stringify({ success: true, accounts: results.length, results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[mail-sync]", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
