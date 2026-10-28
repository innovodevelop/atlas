/**
 * The brain's SSE line format, in one place. `useUnifiedChat` and `askAtlas`
 * both read `/chat` streams; this is the shape they agree on:
 *
 *   data: {"citations":[...]}                  first, optional
 *   data: {"choices":[{"delta":{"content":"…"}}]}   text, many
 *   data: [DONE]                                end
 *
 * Comments (`: beat`) and blank lines are skipped.
 */
export interface BrainCitation { url: string; title?: string }

export type BrainEvent =
  | { kind: 'text'; delta: string }
  | { kind: 'citations'; citations: BrainCitation[] }
  | { kind: 'done' };

export function parseBrainLine(line: string): BrainEvent | null {
  if (line.endsWith('\r')) line = line.slice(0, -1);
  if (line.startsWith(':') || line.trim() === '') return null;
  if (!line.startsWith('data: ')) return null;
  const json = line.slice(6).trim();
  if (json === '[DONE]') return { kind: 'done' };
  let parsed: { citations?: (string | BrainCitation)[]; choices?: { delta?: { content?: string } }[] };
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (parsed.citations) {
    return { kind: 'citations', citations: parsed.citations.map((c) => (typeof c === 'string' ? { url: c } : c)) };
  }
  const delta = parsed.choices?.[0]?.delta?.content;
  return delta ? { kind: 'text', delta } : null;
}
