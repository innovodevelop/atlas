/**
 * POST /mail/draft — Atlas Mail's one AI pass: read a thread from the local
 * atlas.db, ask Claude for a reply body. HARD CONTAINMENT (mirrors /research
 * in learningRoutes.ts): exactly ONE AI call per request, no recursion, no
 * self-fetch, no follow-up questions to itself.
 *
 * This route never touches the Cloudflare mail worker and never sends
 * anything — it only reads `mail_threads`/`mail_messages` and returns text.
 * Persisting the result as a `mail_drafts` row (state 'proposed') is the
 * hook's job (useAtlasMail.draft), not this route's — see the mail contract
 * §7. `model`/`prompt_version` are handed back so the hook can store the real
 * provenance on that row and the audit event; they must never be constants
 * the UI could mistake for a fabricated confidence score.
 */

import { aiChatCompletion, hasAIKey } from "../../../supabase/functions/_shared/aiGateway.ts";
import { selectModel } from "../../../supabase/functions/_shared/providerRouting.ts";
import type { LocalDb } from "./localDb.ts";

interface Deps {
  db: LocalDb;
  requireUser: (req: Request) => { userId: string; email: string; token: string };
  json: (body: unknown, status?: number) => Response;
}

// Bumped whenever the prompt below changes meaning, not wording — the audit
// trail records this per draft so a reviewer years from now can tell which
// prompt generation produced a given reply.
const MAIL_DRAFT_PROMPT_VERSION = "mail-draft-v1";

// mail_messages.extracted is a JSON TEXT column (db_schema.sql); this route
// reads via raw SQL rather than the QueryBuilder, so it parses it itself.
function parseExtracted(raw: string): { direction?: string; body_text?: string | null } {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

function parseParticipants(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function createMailDraftHandlers({ db, requireUser, json }: Deps) {
  // POST /mail/draft {threadId, instruction?, tone?, previousDraft?}
  // Returns { body, model, promptVersion } — never writes to the db and never
  // rejects with anything but a legible {error} the hook can surface.
  async function draft(req: Request): Promise<Response> {
    const { userId } = requireUser(req);
    const body = (await req.json().catch(() => ({}))) as {
      threadId?: unknown;
      instruction?: unknown;
      tone?: unknown;
      previousDraft?: unknown;
    };

    const threadId = typeof body.threadId === "string" ? body.threadId : null;
    if (!threadId) return json({ error: "threadId is required" }, 400);

    // Local mail_threads.id (not the worker's provider_thread_id) — see the
    // mail contract §4.3. Scoped to the caller's own rows the same way every
    // other route here scopes by userId.
    const thread = db._db
      .query(`SELECT id, subject, participants FROM mail_threads WHERE id = ? AND user_id = ?`)
      .get(threadId, userId) as { id: string; subject: string | null; participants: string } | null;
    if (!thread) return json({ error: "Thread not found" }, 404);

    if (!hasAIKey()) return json({ error: "No AI key configured — set ATLAS_AI_PROVIDER=bedrock with AWS credentials, or ANTHROPIC_API_KEY" }, 500);

    // Oldest first — the model needs to read the exchange in the order it
    // happened to reply in context, the same order MailReadingPane renders.
    const rows = db._db
      .query(
        `SELECT from_address, extracted FROM mail_messages
         WHERE thread_id = ? AND user_id = ? ORDER BY received_at ASC LIMIT 30`,
      )
      .all(threadId, userId) as Array<{ from_address: string | null; extracted: string }>;

    const transcript = rows
      .map((m) => {
        const ex = parseExtracted(m.extracted);
        const who = ex.direction === "outbound" ? "Atlas (sent)" : (m.from_address ?? "sender");
        const text = (ex.body_text ?? "").trim().slice(0, 4000);
        return text ? `${who}: ${text}` : null;
      })
      .filter((line): line is string => line != null)
      .join("\n---\n");

    const participants = parseParticipants(thread.participants);
    const instruction = typeof body.instruction === "string" ? body.instruction.trim() : "";
    const tone = typeof body.tone === "string" ? body.tone.trim() : "";
    const previousDraft = typeof body.previousDraft === "string" ? body.previousDraft.trim() : "";

    const system =
      "You are drafting an email reply for a human to review before it is sent — you never send mail " +
      "yourself and must not write as though the message has already gone out. Write only the reply body: " +
      "no subject line, no signature block, no meta-commentary about the draft. Default to a concise, " +
      "professional register; follow an explicit tone instruction if one is given.";

    const userPrompt = [
      `Subject: ${thread.subject ?? "(no subject)"}`,
      `Participants: ${participants.length ? participants.join(", ") : "(unknown)"}`,
      transcript ? `Thread so far:\n${transcript}` : "Thread so far: (no prior messages)",
      tone && `Tone: ${tone}`,
      previousDraft && `Revise this previous draft:\n${previousDraft}`,
      instruction && `Instruction: ${instruction}`,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n\n");

    const res = await aiChatCompletion({
      // Own logical task name (falls through providerRouting's default to the
      // "standard" tier) rather than reusing "chat" — reply drafting is a
      // distinct cost/quality lane worth routing independently later.
      model: selectModel("mail_draft"),
      messages: [
        { role: "system", content: system },
        { role: "user", content: userPrompt },
      ],
      stream: false,
    });
    if (!res.ok) return json({ error: `AI gateway error (${res.status})` }, 500);

    const data = (await res.json().catch(() => null)) as
      | { model?: string; choices?: Array<{ message?: { content?: string } }> }
      | null;
    const draftBody = data?.choices?.[0]?.message?.content;
    if (typeof draftBody !== "string" || !draftBody.trim()) {
      return json({ error: "The model returned an empty draft" }, 500);
    }

    // `data.model` is the provider's own echo of what actually answered
    // (Claude adapter fills it from the Messages API response) — recording
    // that instead of the logical routing id is what lets the audit trail
    // answer "which model wrote this" after providerRouting's mapping moves on.
    const model = typeof data?.model === "string" && data.model ? data.model : selectModel("mail_draft");

    return json({ body: draftBody.trim(), model, promptVersion: MAIL_DRAFT_PROMPT_VERSION });
  }

  return { draft };
}
