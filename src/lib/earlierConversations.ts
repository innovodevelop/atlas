/**
 * "Earlier conversations" on the Beta Voice and Answer screens (left-out row
 * 29, `Atlas Voice Beta.dc.html`).
 *
 * The source is what the app already keeps: every turn the brain answers is
 * written to the local `chat_turns` table (services/atlas-brain/src/localDb.ts
 * `captureChatTurn`), grouped by the conversation id the caller sent — one
 * per voice session, one per Talk session, one per text chat. The brain's
 * `/conversations/*` routes read it back without the system prompts and tool
 * traffic stored beside it; this module validates what they return and words
 * it for the card. Nothing here leaves the Mac.
 */
import { relDay } from './betaAnswer';

export interface ConversationSummary {
  id: string;
  source: string;
  /** The first thing the user said, clipped. */
  title: string;
  /** Questions asked (the user's turns). */
  turns: number;
  startedAt: string;
  lastAt: string;
}

export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
  at: string;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const when = (v: unknown): string | null => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null);

/** The list route's reply, validated; anything malformed is left out rather than guessed at. */
export function parseConversationList(raw: unknown): ConversationSummary[] {
  const rows = typeof raw === 'object' && raw !== null && Array.isArray((raw as { conversations?: unknown }).conversations)
    ? (raw as { conversations: unknown[] }).conversations
    : [];
  return rows.flatMap((r): ConversationSummary[] => {
    if (typeof r !== 'object' || r === null) return [];
    const o = r as Record<string, unknown>;
    const id = str(o.id);
    const title = str(o.title);
    const startedAt = when(o.startedAt);
    const lastAt = when(o.lastAt);
    const turns = typeof o.turns === 'number' && Number.isFinite(o.turns) ? Math.max(0, Math.floor(o.turns)) : 0;
    if (!id || !title || !startedAt || !lastAt || turns === 0) return [];
    return [{ id, source: str(o.source) ?? '', title: title.replace(/\s+/g, ' ').slice(0, 120), turns, startedAt, lastAt }];
  });
}

/** One conversation's turns, oldest first. */
export function parseConversation(raw: unknown): ConversationTurn[] {
  const rows = typeof raw === 'object' && raw !== null && Array.isArray((raw as { turns?: unknown }).turns)
    ? (raw as { turns: unknown[] }).turns
    : [];
  return rows.flatMap((r): ConversationTurn[] => {
    if (typeof r !== 'object' || r === null) return [];
    const o = r as Record<string, unknown>;
    const role = o.role === 'user' || o.role === 'assistant' ? o.role : null;
    const content = str(o.content);
    const at = when(o.at);
    return role && content && at ? [{ role, content, at }] : [];
  });
}

/** Where a conversation happened, from the `source` the caller sent the brain. */
export function sourceLabel(source: string): string {
  if (source === 'voice_chat' || source === 'voice') return 'Voice';
  if (source === 'talk' || source.startsWith('talk:')) return 'Talk';
  if (source === 'text_chat') return 'Chat';
  if (source === 'teaching') return 'Teach';
  return source ? source.charAt(0).toUpperCase() + source.slice(1).replace(/_/g, ' ') : 'Atlas';
}

/**
 * Only conversations that began before the screen opened: the one under way
 * here is "This session", not an earlier one.
 */
export function earlierThan(list: readonly ConversationSummary[], openedAt: number): ConversationSummary[] {
  return list.filter((c) => Date.parse(c.startedAt) < openedAt);
}

/** The design's row: "Voice · 6 turns · 4 min" and "Yesterday". */
export function conversationRow(c: ConversationSummary, now: Date = new Date()): { sub: string; when: string } {
  const mins = Math.max(1, Math.round((Date.parse(c.lastAt) - Date.parse(c.startedAt)) / 60000));
  const day = relDay(c.lastAt, now);
  return {
    sub: `${sourceLabel(c.source)} · ${c.turns} ${c.turns === 1 ? 'turn' : 'turns'} · ${mins} min`,
    // Today gets its time, as the design's "Today, 8:02"; older days do not need one.
    when: day === 'Today' ? relDay(c.lastAt, now, true) : day,
  };
}
