/**
 * The answer parser — turns one assistant turn into the blocks the answer view
 * renders.
 *
 * WHY A PARSER AND NOT A WIDGET PLANNER. `Atlas Answer Views.dc.html` composes
 * an answer out of *dashboard widgets* — the prototype picks `agenda`, `wnow`,
 * `port`… from a 50-entry widget table and lays them on a 12-column grid. The
 * app cannot produce that: the chat path
 * (`supabase/functions/_shared/orchestrator.ts` → the brain sidecar's
 * `/chat-with-memory`) returns exactly two things over SSE — a stream of
 * OpenAI-shaped content deltas, and an optional `{ citations: [...] }` event
 * ahead of them. There is no answer→widget plan in the payload, and there is no
 * widget registry to resolve one against (see the SIZE note in
 * `primitives/Card.tsx`: the dashboard's ten cards are a hardcoded list).
 *
 * So the grid is real and the geometry is the design's; what fills it is the
 * model's own text, segmented. Every card below is something the assistant
 * actually wrote. Nothing here invents a value, a delta or a caption.
 */
import type { Citation } from '@/types';

export type AnswerBlock =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'bullets'; ordered: boolean; items: string[] }
  | { kind: 'pairs'; items: Array<{ label: string; value: string }> }
  | { kind: 'quote'; text: string }
  | { kind: 'code'; lang: string | null; code: string }
  | { kind: 'table'; head: string[]; rows: string[][] };

export interface AnswerSource {
  url: string;
  domain: string;
  title?: string;
  snippet?: string;
  /** How the app learned about it — the SSE citations event, or a link in the prose. */
  via: 'citation' | 'inline';
}

export interface ParsedAnswer {
  /**
   * The band headline. `lead` renders in ink, `accent` in Atlas Blue — the
   * design's two-tone treatment. Derived from the answer's own first sentence
   * (rule in `splitHeadline`), never written for it.
   */
  headline: { lead: string; accent: string } | null;
  blocks: AnswerBlock[];
  sources: AnswerSource[];
  words: number;
}

const HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/;
const BULLET = /^\s{0,3}[-*+]\s+(.*)$/;
const ORDERED = /^\s{0,3}\d+[.)]\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const FENCE = /^\s{0,3}```(.*)$/;
const TABLE_SEP = /^\s{0,3}\|?[\s:-]*-{2,}[\s|:-]*$/;
const LINK = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
const BARE_URL = /https?:\/\/[^\s<>"{}|\\^`[\]]+/g;

/**
 * A bullet counts as a label/value pair when the label is bold, or when it is
 * short enough that a colon is plainly acting as a separator rather than as
 * punctuation inside a sentence. Both bounds are deliberately tight: a list of
 * prose sentences that happen to contain colons must stay a list, because
 * rendering it as a stat table would put emphasis on text the model never
 * emphasised.
 */
const PAIR_BOLD = /^\s*\*\*(.+?)\*\*\s*[:—–-]\s*(.+)$/;
const PAIR_PLAIN = /^\s*([^:]{1,28}):\s+(.+)$/;

function pairOf(item: string): { label: string; value: string } | null {
  const bold = item.match(PAIR_BOLD);
  if (bold) return { label: bold[1].trim(), value: bold[2].trim() };
  const plain = item.match(PAIR_PLAIN);
  if (plain && plain[1].trim().split(/\s+/).length <= 4 && item.length <= 120) {
    return { label: plain[1].trim(), value: plain[2].trim() };
  }
  return null;
}

/** `**bold**`, `` `code` ``, `[text](url)` stripped — for counting and headlines. */
export function stripMarkdown(text: string): string {
  return text
    .replace(LINK, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|\W)[*_]([^*_]+)[*_](\W|$)/g, '$1$2$3')
    .replace(/\s+/g, ' ')
    .trim();
}

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/**
 * The headline split. The design's headline is two-tone: an opening clause in
 * ink and a closing clause in blue ("Four things matter today — " / "the 14:00
 * briefing most."). The only honest way to get that from a real answer is to
 * cut the answer's own first sentence at its last dash or comma; when there is
 * no such break the whole sentence is the lead and the accent is empty, which
 * renders as a plain headline rather than an invented flourish.
 */
export function splitHeadline(firstSentence: string): { lead: string; accent: string } {
  const s = firstSentence.trim();
  const dash = Math.max(s.lastIndexOf(' — '), s.lastIndexOf(' – '), s.lastIndexOf(' - '));
  if (dash > 0 && dash < s.length - 4) {
    return { lead: `${s.slice(0, dash + 3)}`, accent: s.slice(dash + 3) };
  }
  const comma = s.lastIndexOf(', ');
  if (comma > 12 && comma < s.length - 8) {
    return { lead: `${s.slice(0, comma + 2)}`, accent: s.slice(comma + 2) };
  }
  return { lead: s, accent: '' };
}

function firstSentence(text: string): string {
  const flat = stripMarkdown(text);
  const m = flat.match(/^[\s\S]*?[.!?](?=\s|$)/);
  const sentence = (m ? m[0] : flat).trim();
  // A headline that runs past ~150 characters is a paragraph; the band clamps
  // it rather than letting it push the grid off-screen.
  return sentence.length > 150 ? `${sentence.slice(0, 147).trimEnd()}…` : sentence;
}

/** Line scanner. Deliberately small: this reads model prose, not arbitrary CommonMark. */
export function parseBlocks(markdown: string): AnswerBlock[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const blocks: AnswerBlock[] = [];
  let para: string[] = [];

  const flushPara = () => {
    const text = para.join(' ').trim();
    para = [];
    if (text) blocks.push({ kind: 'paragraph', text });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const fence = line.match(FENCE);
    if (fence) {
      flushPara();
      const lang = fence[1].trim() || null;
      const body: string[] = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i])) body.push(lines[i++]);
      blocks.push({ kind: 'code', lang, code: body.join('\n') });
      continue;
    }

    if (!line.trim()) { flushPara(); continue; }

    const heading = line.match(HEADING);
    if (heading) {
      flushPara();
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2].trim() });
      continue;
    }

    const quote = line.match(QUOTE);
    if (quote) {
      flushPara();
      const body = [quote[1]];
      while (i + 1 < lines.length && QUOTE.test(lines[i + 1])) body.push(lines[++i].match(QUOTE)![1]);
      blocks.push({ kind: 'quote', text: body.join(' ').trim() });
      continue;
    }

    // A pipe table needs its separator row on the next line; without it the
    // pipes are just characters in a sentence.
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      flushPara();
      const cells = (row: string) =>
        row.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|')) rows.push(cells(lines[i++]));
      i--;
      blocks.push({ kind: 'table', head, rows });
      continue;
    }

    const bullet = line.match(BULLET);
    const ordered = line.match(ORDERED);
    if (bullet || ordered) {
      flushPara();
      const isOrdered = !!ordered && !bullet;
      const items: string[] = [(bullet ?? ordered)![1].trim()];
      while (i + 1 < lines.length) {
        const nextLine = lines[i + 1];
        const next = isOrdered ? nextLine.match(ORDERED) : nextLine.match(BULLET);
        if (next) { items.push(next[1].trim()); i++; continue; }
        // A wrapped continuation line belongs to the item above it.
        if (nextLine.trim() && /^\s{2,}\S/.test(nextLine)) { items[items.length - 1] += ` ${nextLine.trim()}`; i++; continue; }
        break;
      }
      const pairs = items.map(pairOf);
      if (items.length >= 2 && pairs.every(Boolean)) {
        blocks.push({ kind: 'pairs', items: pairs as Array<{ label: string; value: string }> });
      } else {
        blocks.push({ kind: 'bullets', ordered: isOrdered, items });
      }
      continue;
    }

    para.push(line.trim());
  }
  flushPara();
  return blocks;
}

function collectSources(markdown: string, citations?: Citation[] | null): AnswerSource[] {
  const out: AnswerSource[] = [];
  const seen = new Set<string>();

  for (const c of citations ?? []) {
    if (!c?.url || seen.has(c.url)) continue;
    seen.add(c.url);
    out.push({
      url: c.url,
      domain: c.domain || domainOf(c.url),
      title: c.title,
      snippet: c.snippet,
      via: 'citation',
    });
  }

  // Claude's native web_search writes its links into the prose rather than into
  // the citations event (orchestrator, "with native search this list is
  // normally empty"), so the inline links ARE the citation list on that path.
  for (const m of markdown.matchAll(LINK)) {
    const url = m[2];
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ url, domain: domainOf(url), title: m[1], via: 'inline' });
  }
  for (const url of markdown.match(BARE_URL) ?? []) {
    const clean = url.replace(/[.,;:)\]]+$/, '');
    if (seen.has(clean)) continue;
    seen.add(clean);
    out.push({ url: clean, domain: domainOf(clean), via: 'inline' });
  }
  return out;
}

export function parseAnswer(markdown: string, citations?: Citation[] | null): ParsedAnswer {
  const text = markdown ?? '';
  const blocks = parseBlocks(text);
  const lead = blocks.find((b) => b.kind === 'paragraph' || b.kind === 'heading');
  const headline = lead
    ? splitHeadline(firstSentence(lead.kind === 'heading' ? lead.text : lead.text))
    : null;
  const flat = stripMarkdown(text);
  return {
    headline: headline && headline.lead ? headline : null,
    blocks,
    sources: collectSources(text, citations),
    words: flat ? flat.split(/\s+/).length : 0,
  };
}

/**
 * The band subline — the design's `spoken` line under the headline.
 *
 * It is the rest of the answer's opening paragraph once the headline sentence
 * has been taken out of it, or the second paragraph when the first was a single
 * sentence. When the answer has neither, the subline is empty and the band
 * renders without one; there is nothing else true to put there.
 */
export function answerSubline(blocks: AnswerBlock[]): string {
  const paras = blocks.filter((b): b is Extract<AnswerBlock, { kind: 'paragraph' }> => b.kind === 'paragraph');
  if (paras.length === 0) return '';
  const first = stripMarkdown(paras[0].text);
  const m = first.match(/^[\s\S]*?[.!?](?=\s|$)/);
  const rest = m ? first.slice(m[0].length).trim() : '';
  const out = rest || (paras[1] ? stripMarkdown(paras[1].text) : '');
  return out.length > 260 ? `${out.slice(0, 257).trimEnd()}…` : out;
}

// ---------------------------------------------------------------------------
// Layout

export interface PlannedCard {
  block: AnswerBlock;
  /** Columns on the design's 12-column grid. */
  cols: number;
  /** Row spans; only tall cards (lists, code, tables) claim more than one. */
  rows: number;
}

/**
 * Block sequence → grid plan.
 *
 * The design ships eight named layouts (`hero`, `split`, `strip`, `mosaic`…)
 * and the prototype picks one at random, because a prototype with no real
 * answer has nothing else to size against. Here the answer decides: a lead
 * paragraph is wide, a list is a column, code and tables take the full width.
 * Same 12-column grid, same radii and gaps — sized by content instead of dice.
 */
export function planCards(blocks: AnswerBlock[]): PlannedCard[] {
  let seenBody = false;
  return blocks.map((block) => {
    switch (block.kind) {
      case 'heading':
        return { block, cols: 12, rows: 1 };
      case 'code':
      case 'table':
        return { block, cols: 12, rows: 2 };
      case 'paragraph': {
        const long = block.text.length > 260;
        const cols = !seenBody ? 12 : long ? 8 : 6;
        seenBody = true;
        return { block, cols, rows: long ? 2 : 1 };
      }
      case 'bullets':
        seenBody = true;
        return { block, cols: block.items.length > 4 ? 6 : 4, rows: block.items.length > 3 ? 2 : 1 };
      case 'pairs':
        seenBody = true;
        return { block, cols: 4, rows: block.items.length > 3 ? 2 : 1 };
      case 'quote':
        seenBody = true;
        return { block, cols: 6, rows: 1 };
      default:
        return { block, cols: 6, rows: 1 };
    }
  });
}

/** Human label for a block — the card's uppercase eyebrow. */
export function blockLabel(block: AnswerBlock): string {
  switch (block.kind) {
    case 'heading': return 'Section';
    case 'paragraph': return 'Answer';
    case 'bullets': return block.ordered ? 'Steps' : 'Points';
    case 'pairs': return 'Detail';
    case 'quote': return 'Atlas said';
    case 'code': return block.lang ? `Code · ${block.lang}` : 'Code';
    case 'table': return 'Table';
    default: return 'Answer';
  }
}
