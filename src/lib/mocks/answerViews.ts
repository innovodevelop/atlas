/**
 * Answer-view specimens.
 *
 * These are NOT data. They are sample assistant turns — the raw markdown a
 * generation actually streams — kept so the presentation layer can be reviewed
 * without a running brain sidecar (the brain is desktop-only; in a browser
 * `getBrainEndpoint()` returns null and nothing can be asked at all).
 *
 * The surface never mixes them with a live answer: specimen mode is entered
 * explicitly, the band says "Specimen", and every specimen names the code path
 * that produces its shape. They run through the same `parseAnswer` and the same
 * renderers as a live turn, so a layout bug shows up here exactly as it would
 * in the app.
 *
 * The shapes are taken from what the chat path can emit, read off
 * `supabase/functions/_shared/orchestrator.ts`:
 *   - a streamed prose turn with no tool call (the common case)
 *   - a native `web_search` turn — Claude writes its links inline and the
 *     `citations` SSE event is normally EMPTY on that path
 *   - a bridged-citations turn — the adapter surfaced top-level `citations`,
 *     so the event arrives ahead of the prose
 *   - markdown structure the model writes on its own: tables, lists, code
 *   - the teaching-mode fast path, which returns `{kind:"json"}` with a short
 *     acknowledgement and no stream at all
 *   - a turn that answers by refusing, because the data source is not connected
 *   - an empty generation, which the chat hook replaces with its fallback line
 */
import type { Citation } from '@/types';

export interface AnswerSpecimen {
  id: string;
  /** The answer shape this specimen stands for. */
  label: string;
  question: string;
  /** Exactly what the stream would carry — markdown, unrendered. */
  markdown: string;
  /** What the `{ citations: [...] }` SSE event carried, if anything. */
  citations: Citation[];
  /** The code path in the orchestrator that emits this shape. */
  producedBy: string;
}

export const ANSWER_SPECIMENS: AnswerSpecimen[] = [
  {
    id: 'prose',
    label: 'Prose · no tools',
    question: 'Explain what the brain sidecar does',
    producedBy: 'Streaming pass, tool loop broke on finish_reason "stop" — no tool call, no citations event.',
    markdown: `The brain is a local Bun process that owns the whole chat turn — it is the only thing that talks to the model.

It composes the system prompt from your profile, personality state and whatever memory the query recalls, runs the tool loop, then streams the answer back to the webview over plain SSE on 127.0.0.1. Nothing about the turn leaves the machine except the model call itself.

Because it holds the composed prompt, it is also the only place a turn can be captured for later fine-tuning — the webview never sees that prompt.`,
    citations: [],
  },
  {
    id: 'search',
    label: 'Web search · links inline',
    question: 'What changed in the EU AI Act guidance this month?',
    producedBy: 'Native web_search (web_search_20260209). Claude runs the searches server-side and writes its links into the prose; the citations event is empty on this path.',
    markdown: `Two things moved this month, and only one of them affects a desktop assistant.

The guidance on general-purpose models was published in draft and is open for comment — see the [Commission's own page](https://digital-strategy.ec.europa.eu/en/policies/ai-act) for the text. The transparency obligations were not changed.

- **Draft GPAI guidance** — comment window is open, no obligations start yet
- **Transparency rules** — unchanged from the consolidated text
- **National enforcement** — still with member states, no central register

I would not act on the draft before the comment window closes.`,
    citations: [],
  },
  {
    id: 'citations',
    label: 'Tool result · citations event',
    question: 'Summarise this week in assistive interface research',
    producedBy: 'Tool loop collected `result.citations` (or the adapter bridged top-level `citations`), so the `{citations:[…]}` event is written ahead of the stream.',
    markdown: `Three pieces are worth your time, and they disagree with each other in a useful way.

The first argues that a voice assistant should never render a list; the second measured people and found the opposite for anything above four items. The third is a field report rather than a study, and it is the one I would read first.`,
    citations: [
      { url: 'https://fieldnotes.press/quiet-interface', domain: 'fieldnotes.press', title: 'The quiet interface' },
      { url: 'https://example.org/list-recall-study', domain: 'example.org', title: 'Recall of spoken lists, n=214' },
      { url: 'https://example.com/assistive-ui-notes', domain: 'example.com' },
    ],
  },
  {
    id: 'structured',
    label: 'Structured · table and pairs',
    question: 'Compare the two model tiers I am paying for',
    producedBy: 'Ordinary streaming turn. The markdown table and the label/value list are the model\'s own formatting — nothing in the payload marks them as structure.',
    markdown: `You are paying for two tiers and using one of them properly.

| Tier | Used for | Share of turns |
| --- | --- | --- |
| Chat | Every ordinary turn | 91% |
| Research | Explicit research asks | 9% |

- **Routing rule**: only an explicit research ask reaches the hard tier
- **Fallback**: none — a failed hard-tier call is an error, not a downgrade
- **Embeddings**: local, so they cost nothing per turn

The 9% is where nearly all of the spend sits.`,
    citations: [],
  },
  {
    id: 'code',
    label: 'Code answer',
    question: 'How do I read the brain endpoint from the webview?',
    producedBy: 'Ordinary streaming turn with a fenced block. Fences arrive as content deltas like any other text.',
    markdown: `Ask the Rust side — the port and the per-launch token are handed to the webview, never guessed.

\`\`\`ts
const brain = await getBrainEndpoint();
if (!brain) throw new Error('Atlas brain is only available in the desktop app.');

await fetch(\`\${brain.baseUrl}/chat-with-memory\`, {
  method: 'POST',
  headers: { Authorization: \`Bearer \${token}\`, 'x-sidecar-token': brain.token },
  body: JSON.stringify({ messages }),
});
\`\`\`

Outside Tauri that helper returns null, which is the honest answer rather than a retry loop.`,
    citations: [],
  },
  {
    id: 'memory',
    label: 'Teaching mode · acknowledgement',
    question: 'Remember that I run before six on workout days',
    producedBy: 'Teaching-mode fast path: a single non-streaming call, `memory_store` executed, `{kind:"json"}` returned. There is no stream and never a citation.',
    markdown: `Noted — you run before six on workout days.

I have stored that as a habit rather than a one-off, so it will come back the next time you ask about sleep or training.`,
    citations: [],
  },
  {
    id: 'refusal',
    label: 'No data source',
    question: 'How much did I spend on groceries last month?',
    producedBy: 'Ordinary streaming turn. Nothing failed — the model has no connected source for the question and says so.',
    markdown: `I cannot answer that one yet.

Nothing in Atlas is connected to your bank or card, so there is no spend history to read. Until an account is linked I would be guessing, and a guess about money is worse than no answer.`,
    citations: [],
  },
  {
    id: 'empty',
    label: 'Empty generation',
    question: '.',
    producedBy: 'The stream closed with no content deltas. `useUnifiedChat` substitutes its fallback line; the answer view has nothing to lay out.',
    markdown: '',
    citations: [],
  },
];

export const DEFAULT_SPECIMEN = ANSWER_SPECIMENS[0].id;
