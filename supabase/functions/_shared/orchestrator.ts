/**
 * Chat orchestration — extracted from chat-with-memory (WS-B B1) so BOTH the
 * edge function and the local voice gateway (Bun sidecar) run the same brain.
 *
 * Runtime-neutral by design:
 *  - No `serve`, no CORS, no Request/Response — callers adapt transport.
 *  - No direct env access except via aiGateway (the Bun gateway shims
 *    `globalThis.Deno.env` over process.env).
 *  - No `https:` imports — Supabase clients are injected via ChatDeps.
 */

import {
  isLearningEnabled,
  detectLearningIntent,
  recordSuccess,
  recordError,
  logLearningSession,
  isProviderHealthy,
  isLovableAIEnabled,
} from "./providerStatus.ts";
import { aiChatCompletion, hasAIKey, generateEmbedding } from "./aiGateway.ts";
import { selectModel } from "./providerRouting.ts";
import { findOrCreateSession } from "./learningGuards.ts";
import {
  DEFAULT_PERSONALITY,
  composePersonality,
  detectSeriousTopic,
  type PersonalityContext,
  type PersonalityState,
} from "./personality.ts";

// ---------------------------------------------------------------------------
// Types

export interface Memory {
  key: string;
  value: unknown;
  category: string;
  importance: number;
}

export interface LifeEvent {
  event_type: string;
  event_date: string;
  description: string;
  sentiment: string;
}

export interface UserProfile {
  first_name: string | null;
  nickname: string | null;
  birthday: string | null;
  timezone: string;
  communication_style: string;
}

export interface KnowledgeEntry {
  topic: string;
  content: unknown;
  category: string;
}

export interface ToolCall {
  id: string;
  type: string;
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatMessage {
  role: string;
  content: string;
}

/** Injected dependencies — the caller owns client construction and auth. */
export interface ChatDeps {
  /** User-scoped Supabase client (anon key + user JWT — RLS applies). */
  supabase: any;
  /** service-role client for system tables (provider status, learning). */
  systemDb: any;
  userId: string;
  /** The caller's verified JWT — forwarded to internal function calls. */
  userToken: string;
  supabaseUrl: string;
  /**
   * The Rust control port, when this process was handed one.
   *
   * Absent whenever the brain runs standalone rather than as a Tauri sidecar,
   * and absent in the voice gateway. When absent, no desktop tools are declared
   * at all — the model is never shown a capability it cannot exercise.
   */
  control?: ToolContext["control"];
  /** Op names the port advertises; drives which desktop tools get declared. */
  controlCaps?: string[];
  /** Working-memory session id (edge fn: x-session-id header). */
  sessionId?: string;
  /**
   * Query embedder. MUST be the same model that produced the stored vectors —
   * cosine across two embedding models is meaningless. The brain sidecar
   * injects its local multilingual-e5 embedder; callers that omit it fall back
   * to the gateway's (Gemini) embedder, which only matches legacy vectors.
   */
  embed?: (text: string) => Promise<number[]>;
  /**
   * Persisted personality state (atlas_personality). The brain sidecar injects
   * it; callers that omit it (voice gateway, edge fns) fall back to
   * DEFAULT_PERSONALITY and behave exactly as before Phase 4.
   */
  personality?: PersonalityState;
}

export interface ChatOptions {
  messages: ChatMessage[];
  source?: string;
  enableTools?: boolean;
  teachingMode?: boolean;
  systemPromptOverride?: string | null;
  conversationId?: string | null;
}

/**
 * Everything a caller needs to persist this generation for later fine-tuning
 * (the brain sidecar writes it to chat_turns). The composed system prompt is
 * the load-bearing part — it existed only inside this function before, and an
 * SFT example without the prompt it was generated under is unusable.
 */
export interface TurnCapture {
  systemPrompt: string;
  /** Logical model id (providerRouting) — mapModel resolves the concrete one. */
  model: string;
  /** Intermediate tool-loop messages: assistant tool_calls + tool results, in order. */
  toolMessages: Array<{ role: string; content: string; tool_calls?: unknown }>;
}

export type ChatResult =
  | { kind: "json"; body: unknown; capture?: TurnCapture }
  | { kind: "stream"; stream: ReadableStream<Uint8Array>; citations: string[]; capture?: TurnCapture }
  | { kind: "error"; status: number; message: string; reason?: string };

// ---------------------------------------------------------------------------
// Provider configuration

// No provider endpoints are addressed here — aiGateway owns the chat endpoint
// and selectModel() owns the model id. Retrieval (search *and* page reading) is
// Claude's own server-side web_search, so no third-party fetch backend remains.

/**
 * Claude's server-side web search. Declared through the `anthropicTools`
 * passthrough on the chat body; the adapter forwards it to the Messages API and
 * Claude runs the searches itself — there is no client execution step.
 */
export const ANTHROPIC_WEB_SEARCH_TOOL = {
  type: "web_search_20260209",
  name: "web_search",
} as const;

/** Tool names Claude serves natively — never client-executed when available. */
const NATIVE_SEARCH_TOOLS = new Set(["web_search", "deep_research"]);

/**
 * Native search only exists on the Anthropic adapter, so it is gated on that
 * key. Read directly (not via aiGateway) so the adapter's contract with this
 * file stays the single `anthropicTools` body field.
 */
export function hasNativeWebSearch(): boolean {
  try {
    const env = (globalThis as { Deno?: { env?: { get(k: string): string | undefined } } }).Deno?.env;
    return !!env?.get("ANTHROPIC_API_KEY");
  } catch {
    return false;
  }
}

/**
 * One OpenAI-shaped function declaration.
 *
 * Declared explicitly rather than inferred: without it TypeScript narrows
 * `ATLAS_TOOLS` to a union of the three literal shapes it happens to contain,
 * and `buildAtlasTools` cannot then append a tool with different parameters.
 */
export interface ToolDecl {
  type: string;
  function: {
    name: string;
    description: string;
    parameters: {
      type: string;
      properties: Record<string, unknown>;
      required: string[];
    };
  };
}

// Available tools that Atlas can use
export const ATLAS_TOOLS: ToolDecl[] = [
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the web for current information on a topic. Use this when the user asks about recent events, news, or information you're not certain about.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search query" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "deep_research",
      description: "Conduct comprehensive research on a topic with multiple sources. Use for complex questions requiring detailed analysis.",
      parameters: {
        type: "object",
        properties: {
          topic: { type: "string", description: "The topic to research" },
          depth: { type: "string", enum: ["quick", "comprehensive", "exhaustive"], description: "How deep to research" },
        },
        required: ["topic"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "memory_store",
      description: "Store an important fact, feeling, or personal insight about the user. Use when they share anything personal - identity, emotions, relationships, dreams, fears, values, or life experiences. Be attentive to the emotional depth behind what they share.",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string", description: "A short, meaningful identifier for this memory" },
          value: { type: "string", description: "The information to remember, including emotional context when relevant" },
          category: {
            type: "string",
            enum: [
              // Personal Identity
              "identity",      // Who they are - name, age, origin, background
              "personality",   // Character traits, temperament, quirks, how they describe themselves
              "values",        // Ethics, principles, what matters deeply to them
              "beliefs",       // Worldview, philosophy, spirituality, convictions

              // Emotional Landscape
              "feelings",      // Current emotional states, recurring emotions, mood patterns
              "fears",         // Anxieties, worries, things they avoid, insecurities
              "dreams",        // Aspirations, hopes, bucket list, future visions
              "joys",          // What makes them happy, passions, sources of pleasure

              // Relationships & Social
              "relationships", // Family, friends, colleagues, pets, significant others
              "social",        // Social preferences, interaction style, communication needs

              // Life Context
              "work",          // Career, job, professional goals, work challenges
              "health",        // Physical/mental health, wellness, fitness
              "habits",        // Daily routines, patterns, rituals, quirks
              "preferences",   // Likes/dislikes, tastes, favorites

              // Experiences
              "memories",      // Past experiences, formative moments, nostalgia
              "events",        // Upcoming or recent life events, milestones
              "achievements",  // Accomplishments, wins, proud moments
            ],
            description: "Category that best captures the emotional/personal significance of this memory",
          },
          importance: {
            type: "number",
            description: "How important is this memory? 1-10 scale. Identity/personality/values = 9-10, feelings/fears/dreams = 8-9, relationships = 7-8, preferences/habits = 5-6",
          },
        },
        required: ["key", "value", "category"],
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Desktop tools (the Rust control port)
//
// FIVE DOMAIN TOOLS, NOT THIRTY-ONE OPS. The control port exposes 31 ops (20
// read, 6 write, 3 actuate, 2 approval), and declaring one tool each would be
// the obvious translation and the wrong one:
//
//   - Cost. Thirty-one verbose schemas is several thousand prompt tokens on
//     EVERY turn, against ~1.5k for five.
//   - Selection quality, which matters more, and which is the reason the shape
//     did NOT change when the write tier arrived. Thirty similarly-shaped names
//     measurably degrade a model's tool choice — it deliberates, burns output
//     tokens, and picks badly. Five domains, then a short action enum INSIDE
//     one domain, is a much easier decision. Adding `atlas_tasks_create` and
//     friends would have been the cheap way to add writes and the one that
//     makes every OTHER tool call worse.
//
// Schema shape is a FLAT object: `action` plus a union of optional params. Not
// oneOf — it inflates the schema and Anthropic's tool handling deals with it
// poorly. Rust validates and returns an error naming what was missing, so the
// model self-corrects in one iteration. Cheap prompt, strict validator.
//
// PROGRESSIVE DISCLOSURE: only domains whose ops the port actually advertises
// are declared. A user with no Spotify connected never sees atlas_music, which
// is both cheaper and honest — a tool that cannot run is a lie the model will
// act on.

/** (tool, action) -> control-port op. The ONLY place this mapping lives. */
const ATLAS_TOOL_OPS: Record<string, Record<string, string>> = {
  atlas_music: {
    status: "music.status",
    search: "music.search",
    library: "music.library_tracks",
    playlists: "music.playlists",
    playlist_tracks: "music.playlist_tracks",
    now_playing: "music.now_playing",
    play: "music.play",
    pause: "music.pause",
    volume: "music.volume",
  },
  atlas_mail: {
    list_threads: "mail.list_threads",
    read_thread: "mail.read_thread",
    archive: "mail.archive",
    mark_read: "mail.mark_read",
  },
  atlas_finance: {
    status: "portfolio.status",
    summary: "portfolio.summary",
    holdings: "portfolio.holdings",
    history: "portfolio.history",
    allocation: "portfolio.allocation",
  },
  atlas_data: {
    weather: "data.weather",
    stocks: "data.stocks",
    news: "data.news",
  },
  atlas_lists: {
    tasks: "tasks.list",
    notes: "notes.list",
    events: "events.list",
    watchlist: "watchlist.list",
    create_task: "tasks.create",
    update_task: "tasks.update",
    create_note: "notes.create",
    update_note: "notes.update",
    create_event: "events.create",
    add_to_watchlist: "watchlist.add",
  },
};

/**
 * Every op above that CHANGES something, listed rather than inferred.
 *
 * Two callers need this and neither can derive it safely. `buildAtlasTools`
 * uses it to build a read-only tool set for the background digest, and
 * `executeTool` uses it as a second, structural refusal so a hallucinated
 * action name cannot reach a mutating op from a context that was never shown
 * one. Guessing from the op name ("create/update/add/play/…") would work today
 * and quietly stop working the first time somebody adds `tasks.bulk_apply`.
 *
 * `is_a_read_or_a_write_and_never_neither` in toolLoop.test.ts asserts the
 * classification is TOTAL over ATLAS_TOOL_OPS, so a new op cannot be added
 * without landing on one side of this line.
 */
const ATLAS_MUTATING_OPS: ReadonlySet<string> = new Set([
  "tasks.create", "tasks.update",
  "notes.create", "notes.update",
  "events.create",
  "watchlist.add",
  "music.play", "music.pause", "music.volume",
  "mail.archive", "mail.mark_read",
]);

/**
 * Domain descriptions.
 *
 * TWO VARIANTS PER DOMAIN, chosen by what the port actually advertised. The
 * read-only sentences ("this cannot start, stop or change playback") were true
 * when 20 read ops were the whole surface and become a lie the moment
 * `music.play` is reachable — but they are still true for a user whose port
 * does not advertise it, and for the background digest, which is handed the
 * read-only tool set on purpose. A single description could only be right for
 * one of those two worlds.
 */
const ATLAS_TOOL_DESCRIPTIONS: Record<string, { read: string; write: string }> = {
  atlas_music: {
    read: "Read what is playing and search the user's own music library. Read-only: this cannot start, stop or change playback.",
    write: "Read what is playing, search the user's music library, and control playback (play, pause, volume).",
  },
  atlas_mail: {
    read: "Read the user's mail that Atlas has already synced locally. Read-only: this cannot send, archive or change anything.",
    write: "Read the user's synced mail, and request to archive a thread or mark it read. Archiving and marking read ALWAYS require the user to confirm first — they never take effect from this tool call alone. This still cannot send or delete anything.",
  },
  atlas_finance: {
    read: "Read the user's linked brokerage portfolio — value, holdings, history, allocation. Read-only.",
    write: "Read the user's linked brokerage portfolio — value, holdings, history, allocation. Read-only.",
  },
  atlas_data: {
    read: "Look up current weather, stock quotes or news headlines.",
    write: "Look up current weather, stock quotes or news headlines.",
  },
  atlas_lists: {
    read: "Read the user's own tasks, notes, calendar events or stock watchlist from the local database.",
    write: "Read and edit the user's own tasks, notes, calendar events and stock watchlist in the local database. Creating and updating take effect immediately and are recorded; there is no delete here, so removing something is the user's own job.",
  },
};

/**
 * Extra params per domain, beyond `action`.
 *
 * `for` is the list of actions a parameter belongs to, and it is enforced:
 * a parameter is declared only when at least one of its actions is reachable.
 * Without it, adding the write params would show a read-only install a `symbol`
 * and a `due_date` field for operations its port never advertised — the same
 * dishonesty progressive disclosure exists to prevent, one level down. A param
 * with no `for` belongs to the whole domain.
 *
 * FLAT, NOT oneOf, as before: Rust owns validation and its errors name the
 * offending field, so the model self-corrects in one iteration. The `for` lists
 * here are a prompt-side hint, never the check.
 */
interface AtlasParam { for?: string[]; schema: Record<string, unknown> }

const ATLAS_TOOL_PARAMS: Record<string, Record<string, AtlasParam>> = {
  atlas_music: {
    query: { for: ["search"], schema: { type: "string", description: "Search text. Only for action=search." } },
    playlist_id: { for: ["playlist_tracks"], schema: { type: "string", description: "Only for action=playlist_tracks." } },
    limit: { schema: { type: "number", description: "Maximum items to return." } },
    uri: {
      for: ["play"],
      schema: {
        type: "string",
        description: "Only for action=play. A single Spotify track or episode URI (spotify:track:… or spotify:episode:…). Album, artist and playlist URIs are refused — expand them with action=playlist_tracks or action=search first. Omit to resume what is already loaded.",
      },
    },
    level: {
      for: ["volume"],
      schema: {
        type: "number",
        minimum: 0,
        maximum: 1,
        // Spelled out as well as bounded: the bound is a hint the model may
        // ignore, and the specific mistake here — reading "50%" as 50 — is a
        // refusal in Rust rather than a clamp, precisely because clamping 50
        // would mean full volume at 3am.
        description: "Only for action=volume. A FRACTION between 0 and 1 (0.5 is half volume), not a percentage. Values outside 0–1 are refused rather than clamped.",
      },
    },
  },
  atlas_mail: {
    thread_id: { for: ["read_thread", "archive", "mark_read"], schema: { type: "string", description: "Which thread. Required for read_thread, archive and mark_read." } },
    limit: { for: ["list_threads"], schema: { type: "number", description: "Maximum threads to list." } },
  },
  atlas_finance: {},
  atlas_data: {
    city: { for: ["weather"], schema: { type: "string", description: "Only for action=weather." } },
    symbols: { for: ["stocks"], schema: { type: "array", items: { type: "string" }, description: "Only for action=stocks." } },
    category: { for: ["news"], schema: { type: "string", description: "Only for action=news." } },
  },
  atlas_lists: {
    limit: { for: ["tasks", "notes", "events", "watchlist"], schema: { type: "number", description: "Maximum items to return." } },
    id: {
      for: ["update_task", "update_note"],
      schema: { type: "string", description: "Which row to change. Required for update_task and update_note. Get it from action=tasks or action=notes — never invent one." },
    },
    title: {
      for: ["create_task", "update_task", "create_note", "update_note", "create_event"],
      schema: { type: "string", description: "Up to 200 characters." },
    },
    content: {
      for: ["create_note", "update_note"],
      schema: { type: "string", description: "Note body, up to 5000 characters. Pass null on update_note to clear it." },
    },
    completed: { for: ["update_task"], schema: { type: "boolean", description: "Only for action=update_task." } },
    priority: { for: ["create_task", "update_task"], schema: { type: "string", enum: ["low", "medium", "high"] } },
    due_date: {
      for: ["create_task", "update_task"],
      schema: {
        type: "string",
        description: "A date (2026-08-10) or a datetime WITH an offset (2026-08-10T14:00:00+02:00 or …Z). A datetime without an offset is refused, because guessing the zone would move the deadline. Pass null on update_task to clear it.",
      },
    },
    start_time: {
      for: ["create_event"],
      schema: { type: "string", description: "Required for action=create_event. Same format rule as due_date: a date, or a datetime carrying an offset." },
    },
    end_time: { for: ["create_event"], schema: { type: "string", description: "Optional. Same format rule as start_time." } },
    location: { for: ["create_event"], schema: { type: "string", description: "Only for action=create_event. Up to 200 characters." } },
    description: { for: ["create_event"], schema: { type: "string", description: "Only for action=create_event. Up to 2000 characters." } },
    attendees: { for: ["create_event"], schema: { type: "array", items: { type: "string" }, description: "Only for action=create_event. Up to 25 names or addresses." } },
    symbol: { for: ["add_to_watchlist"], schema: { type: "string", description: "Only for action=add_to_watchlist. A ticker such as AAPL or BRK.B." } },
    name: { for: ["add_to_watchlist"], schema: { type: "string", description: "Only for action=add_to_watchlist. The company name, if known." } },
  },
};

/**
 * Tool declarations for the desktop capabilities that are actually reachable.
 *
 * `caps` is the op-name list from the control port's /v1/capabilities. Pass
 * null or [] — the standalone-brain case, where there is no Tauri sidecar and
 * therefore no port — and NO desktop tools are declared at all.
 */
export function buildAtlasTools(
  caps: string[] | null,
  opts: { allowMutating?: boolean } = {},
): ToolDecl[] {
  const base = [...ATLAS_TOOLS];
  if (!caps || caps.length === 0) return base;

  // Default true: a chat turn has a human in it. The background digest passes
  // false and gets a strictly read-only surface — not because Rust would let it
  // through (writes are RunAudited on the background profile, so they WOULD
  // run), but because a process that wakes on a timer with nobody watching has
  // no business creating rows, and the cheapest way to guarantee that is never
  // to describe the capability. executeTool refuses it again structurally.
  const allowMutating = opts.allowMutating !== false;

  const available = new Set(caps);
  for (const [tool, actions] of Object.entries(ATLAS_TOOL_OPS)) {
    const usable = Object.entries(actions).filter(
      ([, op]) => available.has(op) && (allowMutating || !ATLAS_MUTATING_OPS.has(op)),
    );
    if (usable.length === 0) continue;

    const usableActions = new Set(usable.map(([a]) => a));
    const mutates = usable.some(([, op]) => ATLAS_MUTATING_OPS.has(op));

    const properties: Record<string, unknown> = {
      action: {
        type: "string",
        enum: usable.map(([a]) => a),
        description: "Which operation to perform.",
      },
    };
    for (const [param, decl] of Object.entries(ATLAS_TOOL_PARAMS[tool])) {
      if (decl.for && !decl.for.some((a) => usableActions.has(a))) continue;
      properties[param] = decl.schema;
    }

    base.push({
      type: "function",
      function: {
        name: tool,
        description: ATLAS_TOOL_DESCRIPTIONS[tool][mutates ? "write" : "read"],
        parameters: { type: "object", properties, required: ["action"] },
      },
    });
  }
  return base;
}

/** Resolve a desktop tool call to its op, or explain precisely why it cannot. */
export function resolveAtlasOp(
  tool: string,
  action: unknown,
): { op: string } | { error: string } {
  const actions = ATLAS_TOOL_OPS[tool];
  if (!actions) return { error: `Unknown tool: ${tool}` };
  if (typeof action !== "string") {
    return { error: `${tool} requires an "action" — one of: ${Object.keys(actions).join(", ")}` };
  }
  const op = actions[action];
  // Name the valid actions rather than just refusing: the model corrects in one
  // iteration instead of guessing, which is the whole reason the schema is
  // permissive and the validator strict.
  if (!op) {
    return { error: `${tool} has no action "${action}". Valid actions: ${Object.keys(actions).join(", ")}` };
  }
  return { op };
}

/** True for any op that changes something. See ATLAS_MUTATING_OPS. */
export function isMutatingAtlasOp(op: string): boolean {
  return ATLAS_MUTATING_OPS.has(op);
}

/** Every op the tool layer can reach, for tests that assert totality. */
export function atlasToolOpNames(): string[] {
  return Object.values(ATLAS_TOOL_OPS).flatMap((actions) => Object.values(actions));
}

/**
 * The tool result for a call the desktop parked in the approvals queue.
 *
 * THIS IS THE MOST IMPORTANT STRING IN THIS FILE. An approval-tier call returns
 * HTTP 200 with `ok: true`, because queueing succeeded — and the single worst
 * outcome of this whole milestone is Claude reading that success and telling the
 * user "done, I archived it" about a thread that is still sitting in the inbox
 * waiting for them to tap yes. The user then stops checking, and Atlas has lied
 * about the state of their mailbox.
 *
 * So the payload is written to make that sentence hard to produce:
 *   - `performed: false` and `changed_anything: false` are the first things the
 *     model reads, before any prose it could skim as confirmation.
 *   - the message OPENS with "NOT DONE." — a tool result whose first two words
 *     are a negation is very hard to summarise as a completion.
 *   - the forbidden verbs are named explicitly. Naming them beats "be careful",
 *     because the failure is a specific word choice, not a vague attitude.
 *   - it says not to call again. Without that, a model that reads the result as
 *     a soft failure retries, and the user gets two identical cards to answer.
 *
 * There is no `retryable` key at all here: this is not an error, and marking it
 * retryable in either direction invites the loop.
 */
export function approvalPendingResult(data: Record<string, unknown>): Record<string, unknown> {
  const summary = typeof data.action_summary === "string" ? data.action_summary : "the requested action";
  const expires = typeof data.expires_at === "string" ? data.expires_at : null;
  return {
    status: "awaiting_approval",
    performed: false,
    changed_anything: false,
    message:
      "NOT DONE. Nothing has happened yet and nothing will happen unless the user says yes. " +
      `Atlas has put one request in front of the user for them to approve: ${summary}. ` +
      "Tell the user what you are asking permission for and that it is waiting on them. " +
      'Do NOT say it is done, archived, marked, sent, played, changed, updated or handled — none of that is true yet. ' +
      "Do not call this tool again for the same thing; a second call only adds a second request for the user to answer." +
      (expires ? ` The request expires at ${expires} if they do not answer.` : ""),
    reason: typeof data.reason === "string" ? data.reason : undefined,
    reason_code: typeof data.reason_code === "string" ? data.reason_code : undefined,
    approval_id: typeof data.approval_id === "string" ? data.approval_id : undefined,
  };
}

/** Shape-check on the port's success envelope: is this a queued approval? */
function isAwaitingApproval(data: unknown): data is Record<string, unknown> {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { status?: unknown }).status === "awaiting_approval"
  );
}

/**
 * Wall-clock budget for ALL tool work in one turn, in ms.
 *
 * Iteration count alone is a poor bound: six iterations of a slow op is still a
 * hung stream. Voice gets far less because a spoken turn that stalls for twenty
 * seconds is a broken conversation, where a text turn merely feels slow.
 */
export function toolTimeBudgetMs(source?: string): number {
  return source === "voice" ? 8_000 : 20_000;
}

// ---------------------------------------------------------------------------
// Prompt building

function getTimeOfDay(timezone: string): string {
  try {
    const now = new Date();
    const hour = parseInt(now.toLocaleString("en-US", { hour: "numeric", hour12: false, timeZone: timezone }));
    if (hour >= 5 && hour < 12) return "morning";
    if (hour >= 12 && hour < 17) return "afternoon";
    if (hour >= 17 && hour < 21) return "evening";
    return "night";
  } catch {
    return "day";
  }
}

function isBirthday(birthday: string | null): boolean {
  if (!birthday) return false;
  const today = new Date();
  const bday = new Date(birthday);
  return today.getMonth() === bday.getMonth() && today.getDate() === bday.getDate();
}

export function buildPersonalizedPrompt(
  profile: UserProfile | null,
  memories: Memory[],
  upcomingEvents: LifeEvent[],
  recentEvents: LifeEvent[],
  knowledgeBank: KnowledgeEntry[],
  hasTools: boolean,
  styleNotes: Array<{ key: string; value: unknown }> = [],
  conversationSummaries: Array<{ key: string; value: unknown; created_at: string }> = [],
  personality: PersonalityState = DEFAULT_PERSONALITY,
  personalityCtx: PersonalityContext = {}
): string {
  const userName = profile?.nickname || profile?.first_name || "there";
  const timeOfDay = profile?.timezone ? getTimeOfDay(profile.timezone) : "day";
  const isBirthdayToday = profile?.birthday ? isBirthday(profile.birthday) : false;
  const style = profile?.communication_style || "casual";

  let memoryContext = "";
  if (memories.length > 0) {
    memoryContext = `\n## What You Remember About ${userName}\n${memories.map(m => `- ${m.key}: ${JSON.stringify(m.value)}`).join("\n")}`;
  }

  let knowledgeContext = "";
  if (knowledgeBank.length > 0) {
    knowledgeContext = `\n## Knowledge Bank (Things You've Learned)\n${knowledgeBank.map(k => `- [${k.category}] ${k.topic}: ${JSON.stringify(k.content)}`).join("\n")}`;
  }

  let styleContext = "";
  if (styleNotes.length > 0) {
    styleContext = `\n## Communication Preferences You've Learned\nAdapt how you talk based on these observations:\n${styleNotes.map(s => `- ${s.key}: ${JSON.stringify(s.value)}`).join("\n")}`;
  }

  let summaryContext = "";
  if (conversationSummaries.length > 0) {
    summaryContext = `\n## Recent Conversations (for continuity — reference naturally, don't recite)\n${conversationSummaries.map(s => `- ${new Date(s.created_at).toLocaleDateString()}: ${JSON.stringify(s.value)}`).join("\n")}`;
  }

  let eventsContext = "";
  if (upcomingEvents.length > 0 || recentEvents.length > 0) {
    eventsContext = "\n## Life Events to Be Aware Of";
    if (upcomingEvents.length > 0) {
      eventsContext += `\nUpcoming:\n${upcomingEvents.map(e => `- ${e.event_date}: ${e.description} (${e.sentiment})`).join("\n")}`;
    }
    if (recentEvents.length > 0) {
      eventsContext += `\nRecent (follow up on these):\n${recentEvents.map(e => `- ${e.description}`).join("\n")}`;
    }
  }

  const toolInstructions = hasTools ? `
## Tools Available
You have access to powerful tools that you SHOULD USE ACTIVELY:

1. **web_search**: Search the web for current information.
   - USE THIS when asked about: recent events, news, current prices, today's weather, sports scores, stock prices, anything time-sensitive
   - USE THIS when the user says: "search", "look up", "find out", "what's happening", "latest", "current", "today"
   - USE THIS when you're not 100% certain about a fact
   - USE THIS to read a specific link the user gives you — search for the page and use what it returns

2. **deep_research**: Comprehensive research with multiple sources.
   - USE THIS when asked to: research, investigate, analyze, compare, "tell me everything about"
   - USE THIS for complex questions requiring thorough analysis

3. **memory_store**: Save important facts about the user.
   - USE THIS when they share: personal details, preferences, names, dates, important events

CRITICAL INSTRUCTIONS:
- DO NOT make up information. If you're unsure, USE web_search.
- DO NOT say "I don't have access to current information" - you DO have access via web_search.
- When asked about anything current, recent, or real-time, ALWAYS use web_search first.
- Be proactive about using tools - don't wait to be explicitly asked.` : "";

  // Personality/style is composed from bounded trait state (personality.ts)
  // instead of the old hardcoded block that mandated humour unconditionally —
  // the ctx gates suppress it when the moment is wrong. The composed block ends
  // mid-bullet-list so the contextual bullets below continue it.
  const personalityBlock = composePersonality(personality, personalityCtx);

  return `You are Atlas, a genuinely caring AI assistant who knows ${userName} personally.

${personalityBlock}
- Use ${style} tone
- It's ${timeOfDay} for them, greet appropriately if starting a conversation
${isBirthdayToday ? "- 🎂 TODAY IS THEIR BIRTHDAY! Wish them happy birthday warmly and make it special!" : ""}
${toolInstructions}
${memoryContext}
${styleContext}
${summaryContext}
${knowledgeContext}
${eventsContext}

## What You Can Help With
- Email management and organization
- Calendar and scheduling
- Stock market and investments
- Travel planning
- Document management
- General knowledge and conversation
- Remembering personal details and following up on life events
- Research and deep learning on topics (use tools when needed!)

## Memory Instructions
Pay deep attention to what ${userName} shares. Use memory_store to capture:

**Identity & Soul:**
- Who they are at their core (identity)
- Personality traits they reveal ("I'm usually the one who...", "I tend to...")
- Values and what matters to them ("That's important to me because...")
- Beliefs and worldview ("I believe that...")

**Emotional Depth:**
- Feelings behind facts ("I love X" → category: joys, "I worry about" → category: fears)
- Dreams and aspirations ("I've always wanted...", "Someday I hope...")
- Fears and anxieties ("I'm afraid of...", "What keeps me up at night...")
- Sources of joy ("Nothing makes me happier than...")

**Life & Relationships:**
- Names, relationships, and the stories behind them
- Work challenges and career dreams
- Health concerns and wellness goals
- Habits, routines, and why they matter

**Importance Scoring:**
- identity/personality/values/beliefs → importance: 9
- feelings/fears/dreams/joys → importance: 8
- relationships → importance: 7
- work/health/events → importance: 6
- preferences/habits → importance: 5

Be genuine, warm, and emotionally attentive. You're not just storing data - you're truly getting to know a person.`;
}

// ---------------------------------------------------------------------------
// Tools

/**
 * What `executeTool` needs from its host.
 *
 * INJECTED, NOT IMPORTED. This file is deliberately runtime-neutral — the brain
 * sidecar and the voice gateway both import it — so it must not reach for the
 * brain's control client directly. `control` is structurally typed here for the
 * same reason: this module never learns which implementation it got.
 */
export interface ToolContext {
  userId: string | null;
  supabase: any;
  /** The desktop control port, when one is reachable. Absent = no desktop tools. */
  control?: {
    call(
      op: string,
      args: unknown,
      opts: {
        deadline: number;
        userId?: string;
        userToken?: string;
        profile?: "interactive" | "background";
      },
    ): Promise<{ ok: true; data: unknown } | { ok: false; error: { code: string; message: string; retryable: boolean } }>;
  };
  /** Absolute epoch-ms ceiling for ALL tool work in this turn. */
  deadline: number;
  /** The caller's own JWT. Only mail ops need it; forwarded uniformly. */
  userToken?: string;
  /**
   * Which caller the desktop should assume. OMITTING IT IS NOT NEUTRAL: Rust
   * reads an absent profile as `background`, which cannot actuate. Anything
   * driven by a live human turn must say `interactive` or music will silently
   * turn into approval cards.
   */
  profile?: "interactive" | "background";
  /**
   * Second, structural refusal of mutating ops. `false` for the background
   * digest. Defaults to allowed, so every existing caller is unchanged.
   */
  allowMutating?: boolean;
}

export async function executeTool(
  toolCall: ToolCall,
  ctx: ToolContext,
): Promise<{ name: string; result: unknown }> {
  const { userId, supabase } = ctx;
  const { name, arguments: argsStr } = toolCall.function;
  // Arguments can be missing or malformed when a retired tool replays from a
  // stored transcript — the adapter re-declares such names with an empty
  // schema. Degrade to {} so the switch answers with its unknown-tool marker
  // instead of throwing the whole chat turn away.
  let args: Record<string, any> = {};
  try {
    args = argsStr ? JSON.parse(argsStr) : {};
  } catch {
    args = {};
  }

  console.log(`[orchestrator] Executing tool: ${name}`, args);

  // Desktop tools go to the control port. Handled before the switch because
  // they are dispatched by PREFIX rather than by exact name — the switch below
  // stays the list of tools this module implements itself.
  if (name.startsWith("atlas_")) {
    if (!ctx.control) {
      // Should be unreachable: buildAtlasTools only declares these when the
      // port advertised the ops. Answer honestly rather than throwing, because
      // an exception here discards the whole turn.
      return {
        name,
        result: { error: "The desktop is not reachable from this process, so that cannot be checked right now." },
      };
    }

    const resolved = resolveAtlasOp(name, args.action);
    if ("error" in resolved) return { name, result: { error: resolved.error } };

    // Structural refusal, independent of what was declared. buildAtlasTools
    // already withheld these actions from a read-only context, but a model can
    // emit an action name it was never shown — from replayed history, or from
    // guessing — and for the background digest "the schema did not mention it"
    // is not a strong enough guarantee to rest a write on.
    if (ctx.allowMutating === false && isMutatingAtlasOp(resolved.op)) {
      return {
        name,
        result: {
          error: "This runs in the background with nobody watching, so it can only read. Report what you found instead of changing anything.",
          retryable: false,
        },
      };
    }

    // Strip `action` — it selected the op and is not a parameter of it.
    const { action: _action, ...opArgs } = args;

    // Identity travels in the ENVELOPE, not in opArgs. Rust injects user_id into
    // every query itself and rejects a caller-supplied one, which is what makes
    // "the model picked whose tasks to edit" unreachable rather than merely
    // validated. Nothing here may move it into the args.
    const r = await ctx.control.call(resolved.op, opArgs, {
      deadline: ctx.deadline,
      userId: ctx.userId ?? undefined,
      userToken: ctx.userToken,
      profile: ctx.profile,
    });
    if (r.ok) {
      // A queued approval arrives as a SUCCESS — queueing worked — and must not
      // be narrated as the action having happened. See approvalPendingResult.
      if (isAwaitingApproval(r.data)) return { name, result: approvalPendingResult(r.data) };
      return { name, result: r.data };
    }
    return {
      name,
      result: { error: r.error.message, retryable: r.error.retryable },
    };
  }

  switch (name) {
    // Search runs inside the model (web_search_20260209), so these are declared
    // via `anthropicTools` and stripped from the client tool list. A call can
    // still arrive from replayed history — answer with a marker rather than
    // standing up a second search backend.
    case "web_search": {
      if (hasNativeWebSearch()) {
        return { name, result: { handled_natively: true, note: "Web search already ran server-side; use those results." } };
      }
      return { name, result: { error: "Web search not available", suggestion: "I'll answer based on my training data" } };
    }

    case "deep_research": {
      if (hasNativeWebSearch()) {
        return { name, result: { handled_natively: true, note: "Research already ran server-side via web search; use those results." } };
      }
      return { name, result: { error: "Deep research not available", suggestion: "I'll provide what I know from my training" } };
    }

    case "memory_store": {
      if (userId) {
        const { error } = await supabase.from("ai_memory").upsert({
          user_id: userId,
          key: args.key,
          value: args.value,
          category: args.category,
          memory_type: "fact",
          importance: 7,
          updated_at: new Date().toISOString(),
        }, { onConflict: "user_id,key" });

        if (error) {
          return { name, result: { error: error.message } };
        }
        return { name, result: { success: true, message: `Remembered: ${args.key}` } };
      }
      return { name, result: { error: "Cannot store memory without user ID" } };
    }

    default:
      return { name, result: { error: `Unknown tool: ${name}` } };
  }
}

// ---------------------------------------------------------------------------
// Fire-and-forget side channels (learning, session context, summaries)

async function triggerKnowledgeExtraction(
  supabaseUrl: string,
  conversation: ChatMessage[],
  userId: string | null,
  source: string,
  systemDb: any,
  learningIntent: ReturnType<typeof detectLearningIntent>,
  conversationId: string | null,
  userToken: string,
) {
  try {
    const learningSettings = await isLearningEnabled(systemDb);

    if (!learningSettings.enabled) {
      console.log("[orchestrator] Learning is disabled, skipping knowledge extraction");
      return;
    }

    if (!learningIntent.hasIntent) {
      console.log("[orchestrator] No learning intent detected, skipping knowledge extraction");
      return;
    }

    const isHealthy = await isProviderHealthy(systemDb, "lovable_ai");
    if (!isHealthy) {
      console.log("[orchestrator] Primary AI provider unhealthy, skipping knowledge extraction");
      return;
    }

    // Containment: everything learned from this chat belongs to one session,
    // scoped to the conversation and its topic budget.
    const session = await findOrCreateSession(systemDb, {
      userId,
      conversationId,
      rootTopic: learningIntent.topic || "general",
      triggerType: source === "voice" ? "voice" : "text",
    });

    await logLearningSession(systemDb, {
      userId: userId || undefined,
      sessionId: session?.id,
      triggerType: source === "voice" ? "voice" : "text",
      intentDetected: learningIntent.intentType,
      topicRequested: learningIntent.topic,
      status: "started",
      maxTopicsAllowed: learningSettings.maxTopics,
    });

    console.log(`[orchestrator] Triggering knowledge extraction for topic: ${learningIntent.topic || "general"} (session: ${session?.id})`);

    fetch(`${supabaseUrl}/functions/v1/atlas-knowledge`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Forward the caller's JWT — atlas-knowledge derives identity from it.
        Authorization: `Bearer ${userToken}`,
      },
      body: JSON.stringify({
        conversation,
        source,
        learningTopic: learningIntent.topic,
        maxTopics: learningSettings.maxTopics,
        learningSessionId: session?.id ?? null,
        conversationId,
      }),
    }).catch(e => console.log("[orchestrator] Knowledge extraction trigger failed:", e));
  } catch (e) {
    console.log("[orchestrator] Could not trigger knowledge extraction:", e);
  }
}

// Summarize longer conversations into ai_memory (category conversation_summary)
// so the next chat can pick up where this one left off. Cheap model, one call,
// fire-and-forget — never blocks the response stream.
async function summarizeConversation(
  supabase: any,
  userId: string,
  conversationId: string | null,
  messages: ChatMessage[]
) {
  try {
    if (messages.length < 10) return;

    const transcript = messages
      .slice(-30)
      .map(m => `${m.role}: ${String(m.content).slice(0, 400)}`)
      .join("\n");

    const response = await aiChatCompletion({
      model: selectModel("summary"),
      messages: [
        {
          role: "system",
          content: "Summarize this conversation in 2-3 sentences: main topics, decisions made, and anything the user said they'd do next. Output only the summary.",
        },
        { role: "user", content: transcript },
      ],
      stream: false,
    });
    if (!response.ok) return;
    const data = await response.json();
    const summary = data.choices?.[0]?.message?.content?.trim();
    if (!summary) return;

    const key = `conversation_${conversationId || new Date().toISOString().slice(0, 10)}`;
    await supabase.from("ai_memory").upsert({
      user_id: userId,
      key,
      value: summary,
      category: "conversation_summary",
      memory_type: "fact",
      importance: 5,
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id,key" });
    console.log("[orchestrator] Stored conversation summary");
  } catch (e) {
    console.log("[orchestrator] Conversation summary failed:", e);
  }
}

// Track session context for working memory
async function trackSessionContext(
  supabase: any,
  userId: string,
  sessionId: string,
  messages: ChatMessage[]
) {
  try {
    const latestUserMessage = messages.filter(m => m.role === "user").pop();
    if (!latestUserMessage) return;

    const content = latestUserMessage.content.toLowerCase();
    const contextEntries: Array<{
      context_type: string;
      content: Record<string, unknown>;
      confidence: number;
    }> = [];

    // Detect topics
    const topicPatterns: Record<string, string[]> = {
      "work": ["work", "job", "office", "meeting", "project", "deadline", "boss", "colleague"],
      "health": ["health", "doctor", "sick", "exercise", "gym", "sleep", "tired", "medicine"],
      "relationships": ["friend", "family", "partner", "wife", "husband", "kids", "parents"],
      "finance": ["money", "budget", "invest", "stock", "savings", "expense", "pay"],
      "travel": ["trip", "vacation", "flight", "hotel", "travel", "destination"],
      "learning": ["learn", "study", "course", "book", "research", "understand"],
    };

    for (const [topic, keywords] of Object.entries(topicPatterns)) {
      if (keywords.some(kw => content.includes(kw))) {
        contextEntries.push({
          context_type: "topic",
          content: { topic, message_excerpt: content.slice(0, 100) },
          confidence: 0.8,
        });
      }
    }

    // Detect emotional signals
    const emotionPatterns: Record<string, string[]> = {
      "happy": ["happy", "excited", "great", "wonderful", "amazing", "love it"],
      "stressed": ["stressed", "worried", "anxious", "overwhelmed", "nervous"],
      "sad": ["sad", "disappointed", "upset", "frustrated", "down"],
      "curious": ["curious", "wondering", "interested", "want to know", "tell me about"],
    };

    for (const [emotion, keywords] of Object.entries(emotionPatterns)) {
      if (keywords.some(kw => content.includes(kw))) {
        contextEntries.push({
          context_type: "emotion",
          content: { emotion, detected_from: content.slice(0, 50) },
          confidence: 0.7,
        });
      }
    }

    // Detect goals/intents
    if (content.includes("want to") || content.includes("need to") || content.includes("trying to") || content.includes("help me")) {
      const goalMatch = content.match(/(want to|need to|trying to|help me)\s+(.{10,60})/);
      if (goalMatch) {
        contextEntries.push({
          context_type: "goal",
          content: { intent: goalMatch[2].trim() },
          confidence: 0.8,
        });
      }
    }

    if (contextEntries.length > 0) {
      const insertData = contextEntries.map(entry => ({
        user_id: userId,
        session_id: sessionId,
        context_type: entry.context_type,
        content: entry.content,
        confidence: entry.confidence,
        expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(), // 30 minutes
      }));

      await supabase.from("session_context").insert(insertData);
      console.log(`[orchestrator] Tracked ${contextEntries.length} context entries`);
    }
  } catch (e) {
    console.log("[orchestrator] Session context tracking error:", e);
  }
}

// Get active session context. Also surfaces the most recent detected emotion
// (written by trackSessionContext with 30-min expiry) in structured form — it
// gates humour in composePersonality, and reusing this load avoids a second
// query for the same rows.
async function getSessionContext(
  supabase: any,
  userId: string,
  sessionId: string
): Promise<{ block: string; emotion: string | null }> {
  try {
    const { data: contexts } = await supabase
      .from("session_context")
      .select("context_type, content, confidence")
      .eq("user_id", userId)
      .eq("session_id", sessionId)
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false })
      .limit(10);

    if (!contexts || contexts.length === 0) return { block: "", emotion: null };

    // Rows are newest-first, so the first emotion entry is the current one.
    const emotionRow = contexts.find((c: any) => c.context_type === "emotion");
    const emotion = typeof emotionRow?.content?.emotion === "string" ? emotionRow.content.emotion : null;

    const contextSummary = contexts.map((c: any) =>
      `[${c.context_type}] ${JSON.stringify(c.content)}`
    ).join("\n");

    return { block: `\n## Current Conversation Context (Working Memory)\n${contextSummary}`, emotion };
  } catch (e) {
    console.log("[orchestrator] Failed to get session context:", e);
    return { block: "", emotion: null };
  }
}

// ---------------------------------------------------------------------------
// Main orchestration

export async function runChat(deps: ChatDeps, opts: ChatOptions): Promise<ChatResult> {
  const { supabase, systemDb, userId, userToken, supabaseUrl, control, controlCaps } = deps;
  const {
    messages,
    source = "text_chat",
    enableTools = true,
    teachingMode = false,
    systemPromptOverride = null,
    conversationId = null,
  } = opts;

  if (!hasAIKey()) {
    return { kind: "error", status: 500, message: "No AI key configured (ANTHROPIC_API_KEY)" };
  }

  // Check if Lovable AI is enabled (master kill switch)
  const lovableAIStatus = await isLovableAIEnabled(systemDb);
  if (!lovableAIStatus.enabled) {
    console.log("[orchestrator] Lovable AI is disabled");
    return {
      kind: "error",
      status: 503,
      message: lovableAIStatus.reason || "AI features have been disabled to conserve credits",
      reason: "lovable_ai_disabled",
    };
  }

  const sessionId = deps.sessionId || `session_${Date.now()}`;

  // Semantic recall input: the latest user message drives what we remember
  const recallQueryText: string = [...(messages || [])].reverse().find(
    (m) => m.role === "user" && typeof m.content === "string"
  )?.content ?? "";

  // Parallelize all database queries for faster response - including session context
  const [profileResult, memoriesResult, knowledgeResult, upcomingResult, recentResult, sessionContextResult, styleResult, summaryResult, recallResult] = await Promise.all([
    supabase.from("profiles").select("first_name, nickname, birthday, timezone, communication_style").eq("user_id", userId).single(),
    supabase.from("ai_memory").select("key, value, category, importance").eq("user_id", userId).eq("is_fake", false).order("importance", { ascending: false }).limit(10),
    supabase.from("atlas_knowledge_entries").select("topic, content, category").eq("user_id", userId).eq("is_fake", false).order("relevance_score", { ascending: false }).limit(15),
    (() => {
      const today = new Date().toISOString().split("T")[0];
      const weekFromNow = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
      return supabase.from("user_life_events").select("event_type, event_date, description, sentiment").eq("user_id", userId).gte("event_date", today).lte("event_date", weekFromNow);
    })(),
    (() => {
      const today = new Date().toISOString().split("T")[0];
      const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
      return supabase.from("user_life_events").select("event_type, event_date, description, sentiment").eq("user_id", userId).eq("should_follow_up", true).gte("event_date", twoWeeksAgo).lt("event_date", today);
    })(),
    getSessionContext(supabase, userId, sessionId),
    supabase.from("ai_memory").select("key, value").eq("user_id", userId).eq("category", "communication_style").order("updated_at", { ascending: false }).limit(5),
    supabase.from("ai_memory").select("key, value, created_at").eq("user_id", userId).eq("category", "conversation_summary").order("created_at", { ascending: false }).limit(3),
    // Unified semantic recall: hybrid vector+FTS retrieval scored by
    // relevance x recency x importance (memory v2). Embed-then-recall runs
    // inside this arm so it stays parallel; failures degrade to static context.
    recallQueryText.length > 2
      ? (async () => {
          try {
            const queryEmbedding = await (deps.embed ?? generateEmbedding)(recallQueryText);
            const { data, error } = await supabase.rpc("recall_memories", {
              query_embedding: queryEmbedding,
              query_text: recallQueryText,
              p_user_id: userId,
              match_count: 10,
            });
            if (error) throw error;
            return data || [];
          } catch (e) {
            console.error("[orchestrator] recall failed, static context only:", e);
            return [];
          }
        })()
      : Promise.resolve([]),
  ]);

  const sessionContext =
    sessionContextResult && typeof sessionContextResult === "object"
      ? (sessionContextResult as { block: string; emotion: string | null })
      : { block: "", emotion: null };

  const profile: UserProfile | null = profileResult.data;
  const memories: Memory[] = memoriesResult.data || [];
  const knowledgeBank: KnowledgeEntry[] = (knowledgeResult.data || []) as KnowledgeEntry[];
  const upcomingEvents: LifeEvent[] = upcomingResult.data || [];
  const recentEvents: LifeEvent[] = recentResult.data || [];

  console.log("[orchestrator] Processing chat for user:", userId);
  console.log("[orchestrator] Memories count:", memories.length);
  console.log("[orchestrator] Tools enabled:", enableTools, "teaching:", teachingMode);

  const hasTools = enableTools && !teachingMode;

  // Build personalized prompt and append session context (working memory)
  const styleNotes = ((styleResult as { data?: Array<{ key: string; value: unknown }> }).data || []);
  const conversationSummaries = ((summaryResult as { data?: Array<{ key: string; value: unknown; created_at: string }> }).data || []);

  // Humour gates for composePersonality. All three are discrete state that
  // flips rarely within a session — the composed prompt stays byte-stable for
  // Claude's cached prefix except when a gate actually changes:
  //  - emotion: latest session_context emotion row (30-min expiry, prior turn);
  //  - terse: the user's recent messages are short/clipped (needs ≥2 messages
  //    so a lone "hi" opener doesn't gate);
  //  - seriousTopic: narrow keyword scan (personality.ts) of the latest message.
  const recentUserTexts = messages
    .filter((m) => m.role === "user" && typeof m.content === "string")
    .slice(-3)
    .map((m) => m.content);
  const avgUserLen = recentUserTexts.length
    ? recentUserTexts.reduce((s, t) => s + t.length, 0) / recentUserTexts.length
    : 0;
  // `terse` deliberately needs a STRONG, sustained signal: ≥3 recent messages
  // averaging under 25 chars, and every one of them short. A loose threshold
  // (e.g. avg < 40 over 2 messages) flips around the boundary during ordinary
  // chat, and each flip rewrites the top of the system block — which is the
  // cached prefix, so every flip costs a full cache miss. Requiring unanimity
  // makes the gate move only when the user genuinely switches to clipped
  // replies, and back only when they genuinely stop.
  const terse =
    recentUserTexts.length >= 3 &&
    avgUserLen < 25 &&
    recentUserTexts.every((t) => t.length < 40);
  const personalityCtx: PersonalityContext = {
    emotion: sessionContext.emotion,
    terse,
    seriousTopic: detectSeriousTopic(recentUserTexts[recentUserTexts.length - 1] ?? ""),
  };

  const systemPrompt = systemPromptOverride || buildPersonalizedPrompt(profile, memories, upcomingEvents, recentEvents, knowledgeBank, hasTools, styleNotes, conversationSummaries, deps.personality ?? DEFAULT_PERSONALITY, personalityCtx);

  // Per-turn context goes in a SECOND system message, never onto systemPrompt.
  //
  // This split is what makes prompt caching work at all: the adapter puts the
  // cache breakpoint on system[0] (see toAnthropicRequest), so system[0] must
  // be byte-identical turn to turn. Recalled memories are a function of the
  // latest user message and the session block changes as the conversation
  // moves — concatenating either onto the stable prompt (the previous
  // behaviour) changed the cached prefix every turn, which meant a permanent
  // cache_read of 0 plus the 1.25x write premium on the whole prompt, every
  // turn. The adapter hoists all system-role messages into the top-level
  // `system` array in order, so nothing here reaches the wire as an unsupported
  // in-messages system entry.
  let volatileContext = "";

  // Query-relevant recalled memories (memory v2)
  const recalled = (recallResult || []) as Array<{ id: string; chunk_text: string; score: number }>;
  if (recalled.length > 0) {
    volatileContext +=
      "## Relevant memories for this message\n" +
      recalled.map((r) => `- ${r.chunk_text}`).join("\n");
    // Fire-and-forget access bump — consolidation decays what never recalls
    supabase.rpc("touch_memory_vectors", { p_ids: recalled.map((r) => r.id) })
      .then(() => {}, () => {});
  }

  if (sessionContext.block) {
    volatileContext += sessionContext.block;
  }

  const conversationMessages = [
    { role: "system", content: systemPrompt },
    ...(volatileContext ? [{ role: "system", content: volatileContext }] : []),
    ...messages,
  ];

  // TurnCapture exists for SFT: an example is only usable with the prompt it
  // was actually generated under, and the model saw stable + volatile. The
  // split above is a caching concern, not a data-model change.
  const capturedSystemPrompt = volatileContext
    ? `${systemPrompt}\n\n${volatileContext}`
    : systemPrompt;

  const allToolResults: Array<{ name: string; result: unknown; citations?: string[] }> = [];
  // 3 -> 6 now that desktop tools exist. A realistic sequence needs three by
  // itself (search -> read the result -> answer), and one malformed-args
  // correction eats another; three left no room to recover from a single
  // mistake. The real safety bound is the wall clock below, not this count.
  let maxToolIterations = teachingMode ? 0 : 6;
  const turnDeadline = Date.now() + toolTimeBudgetMs(source);
  const currentMessages = [...conversationMessages];

  // Detect learning intent once — it drives both the model tier below and the
  // fire-and-forget knowledge extraction after the stream starts.
  const latestUserMessage = messages.filter((m) => m.role === "user").pop();
  const learningIntent = latestUserMessage
    ? detectLearningIntent(latestUserMessage.content)
    : { hasIntent: false } as ReturnType<typeof detectLearningIntent>;

  // Difficulty tiering: only an explicit research ask pays for the hard tier.
  const chatModel = selectModel(
    learningIntent.hasIntent && learningIntent.intentType === "research" ? "deep_research" : "chat",
  );

  // Search runs inside Claude (web_search_20260209). Declare it through the
  // adapter passthrough and drop the client-side twins from the function list —
  // a duplicate "web_search" name would be rejected by the Messages API. Without
  // an Anthropic key the function tools stay, and executeTool degrades.
  const nativeSearch = hasNativeWebSearch();
  // buildAtlasTools, not ATLAS_TOOLS: desktop tools are added only for ops the
  // control port actually advertised. No port -> identical to before.
  const declaredTools = buildAtlasTools(controlCaps ?? null);
  const chatTools = hasTools
    ? nativeSearch
      ? declaredTools.filter((t) => !NATIVE_SEARCH_TOOLS.has(t.function.name))
      : declaredTools
    : undefined;
  const anthropicTools = hasTools && nativeSearch ? [ANTHROPIC_WEB_SEARCH_TOOL] : undefined;
  console.log("[orchestrator] Model:", chatModel, "native web_search:", nativeSearch);

  // TEACHING MODE: Fast path - skip tool checking, single non-streaming call
  if (teachingMode) {
    console.log("[orchestrator] Teaching mode: fast path (no tool loop)");

    // Teaching mode only captures memories and acknowledges — cheap tier.
    const teachModel = selectModel("memory");
    const teachResponse = await aiChatCompletion({
      model: teachModel,
      messages: currentMessages,
      tools: [{
        type: "function",
        function: {
          name: "memory_store",
          description: "Store an important fact about the user",
          parameters: {
            type: "object",
            properties: {
              key: { type: "string" },
              value: { type: "string" },
              category: { type: "string", enum: ["preference", "fact", "relationship", "event", "work", "health", "personal", "values"] },
            },
            required: ["key", "value", "category"],
          },
        },
      }],
      tool_choice: "auto",
      stream: false,
    });

    if (!teachResponse.ok) {
      const status = teachResponse.status;
      if (status === 429) return { kind: "error", status: 429, message: "Rate limits exceeded" };
      if (status === 402) return { kind: "error", status: 402, message: "Payment required" };
      return { kind: "error", status: 500, message: `AI gateway error: ${status}` };
    }

    const teachData = await teachResponse.json();
    const choice = teachData.choices?.[0];
    const responseText = choice?.message?.content || "I understand. Tell me more.";

    const toolCalls = choice?.message?.tool_calls;
    if (toolCalls && toolCalls.length > 0) {
      for (const tc of toolCalls) {
        if (tc.function?.name === "memory_store") {
          try {
            const args = JSON.parse(tc.function.arguments);
            console.log("[orchestrator] Teaching mode: storing memory", args);
            await supabase.from("ai_memory").upsert({
              user_id: userId,
              key: args.key,
              value: args.value,
              category: args.category,
              memory_type: "fact",
              importance: 7,
              updated_at: new Date().toISOString(),
            }, { onConflict: "user_id,key" });
          } catch (e) {
            console.error("[orchestrator] Memory store error:", e);
          }
        }
      }
    }

    return {
      kind: "json",
      body: { response: responseText, message: responseText },
      capture: { systemPrompt: capturedSystemPrompt, model: teachModel, toolMessages: [] },
    };
  }

  // Tool execution loop - non-streaming request first to check for tool calls
  while (maxToolIterations > 0) {
    console.log("[orchestrator] Making AI request, iteration:", 4 - maxToolIterations);

    const checkResponse = await aiChatCompletion({
      model: chatModel,
      messages: currentMessages,
      tools: chatTools,
      tool_choice: chatTools ? "auto" : undefined,
      // Deliberately no `anthropicTools` here: this pass exists only to harvest
      // client tool calls and its prose is discarded, so letting Claude search
      // here would pay for results nothing reads. The streaming call below owns
      // web search.
      stream: false,
    });

    if (!checkResponse.ok) {
      const errorText = await checkResponse.text();
      await recordError(systemDb, "lovable_ai", checkResponse.status, errorText);

      if (checkResponse.status === 429) return { kind: "error", status: 429, message: "Rate limits exceeded, please try again later." };
      if (checkResponse.status === 402) return { kind: "error", status: 402, message: "Payment required, please add funds to your workspace." };
      return { kind: "error", status: 500, message: `AI gateway error: ${checkResponse.status}` };
    }

    await recordSuccess(systemDb, "lovable_ai");

    const checkData = await checkResponse.json();
    const choice = checkData.choices?.[0];

    if (!choice) {
      return { kind: "error", status: 500, message: "No response from AI" };
    }

    // Native web_search citations live in Claude's web_search_tool_result blocks.
    // If the adapter surfaces them on the OpenAI-shaped body (top-level
    // `citations`), collect them; otherwise the list stays empty — never assume
    // the shape exists.
    const bridgedCitations = Array.isArray(checkData.citations) ? checkData.citations : [];
    if (bridgedCitations.length > 0) {
      allToolResults.push({ name: "web_search", result: null, citations: bridgedCitations });
    }

    const toolCalls = choice.message?.tool_calls;

    if (!toolCalls || toolCalls.length === 0 || choice.finish_reason === "stop") {
      console.log("[orchestrator] No tool calls, proceeding to stream response");
      break;
    }

    console.log("[orchestrator] Tool calls detected:", toolCalls.length);

    const toolResults: Array<{ tool_call_id: string; role: string; content: string }> = [];

    for (const toolCall of toolCalls) {
      console.log("[orchestrator] Executing tool:", toolCall.function.name);
      // Refuse client-side rather than hang. The model reads this as a result
      // and narrates it ("I ran out of time checking that"), which is a far
      // better turn than a stream that stalls until something upstream gives
      // up. executeTool re-checks the deadline too — belt and braces, since a
      // long-running earlier call in this same batch can consume it.
      const result =
        Date.now() >= turnDeadline
          ? {
              name: toolCall.function.name,
              result: { error: "The turn's time budget ran out before this could be checked.", retryable: false },
            }
          : await executeTool(toolCall, {
              userId,
              supabase,
              control,
              deadline: turnDeadline,
              userToken,
              // A chat or voice turn is BY DEFINITION a human waiting for an
              // answer, which is the whole content of the interactive claim.
              // Omitting it would make Rust assume background and turn every
              // "play this" into an approval card the user has to tap while
              // already sitting in front of the app.
              profile: "interactive",
            });

      if (result.result && typeof result.result === "object" && "citations" in result.result) {
        const citations = (result.result as any).citations;
        if (Array.isArray(citations) && citations.length > 0) {
          allToolResults.push({ ...result, citations });
        }
      }

      toolResults.push({
        tool_call_id: toolCall.id,
        role: "tool",
        content: JSON.stringify(result.result),
      });
    }

    currentMessages.push({
      role: "assistant",
      content: choice.message.content || "",
      tool_calls: toolCalls,
    } as any);
    currentMessages.push(...toolResults as any);

    maxToolIterations--;
  }

  // Citations emitted up-front as an SSE event. Claude's own web_search
  // citations arrive inside the streamed content blocks, which this function
  // passes through untouched — so with native search this list is normally
  // empty and the UI relies on the inline links Claude writes.
  const allCitations = allToolResults.flatMap(r => r.citations || []);
  console.log("[orchestrator] Total citations collected:", allCitations.length);

  // Now stream the final response — the pass that may run native web search.
  const streamResponse = await aiChatCompletion({
    model: chatModel,
    messages: currentMessages,
    anthropicTools,
    stream: true,
  });

  if (!streamResponse.ok) {
    const errorText = await streamResponse.text();
    console.error("[orchestrator] Stream error:", streamResponse.status, errorText);
    await recordError(systemDb, "lovable_ai", streamResponse.status, errorText);
    return { kind: "error", status: 500, message: `AI gateway error: ${streamResponse.status}` };
  }

  await recordSuccess(systemDb, "lovable_ai");

  console.log("[orchestrator] Learning intent:", learningIntent.hasIntent ? learningIntent.intentType : "none");

  // Fire-and-forget: knowledge extraction, session context, summaries
  if (messages.length >= 2 && supabaseUrl && learningIntent.hasIntent) {
    // systemDb: learning settings/session tables are system-level (no user RLS).
    triggerKnowledgeExtraction(supabaseUrl, messages, userId, source, systemDb, learningIntent, conversationId, userToken);
  }

  trackSessionContext(supabase, userId, sessionId, messages).catch(e =>
    console.log("[orchestrator] Session tracking error:", e)
  );
  summarizeConversation(supabase, userId, conversationId, messages).catch(e =>
    console.log("[orchestrator] Summary error:", e)
  );

  // Prepend citations as a custom SSE event, then pass the AI stream through.
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const reader = streamResponse.body!.getReader();
  const encoder = new TextEncoder();

  (async () => {
    try {
      if (allCitations.length > 0) {
        const citationEvent = `data: ${JSON.stringify({ citations: allCitations })}\n\n`;
        await writer.write(encoder.encode(citationEvent));
      }
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        await writer.write(value);
      }
    } catch (e) {
      console.error("[orchestrator] Stream processing error:", e);
    } finally {
      await writer.close();
    }
  })();

  return {
    kind: "stream",
    stream: readable,
    citations: allCitations,
    capture: {
      systemPrompt: capturedSystemPrompt,
      model: chatModel,
      // Everything appended past the initial prompt+history is this turn's
      // tool loop (assistant tool_calls + tool results).
      toolMessages: currentMessages.slice(conversationMessages.length) as Array<{
        role: string; content: string; tool_calls?: unknown;
      }>,
    },
  };
}
