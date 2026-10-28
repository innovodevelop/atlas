/**
 * "How Atlas works" in the Beta style — the content and the small readings
 * behind its body (`Atlas Architecture Beta.dc.html`).
 *
 * The design's structure and voice, checked against the code before it was
 * copied. Where the design says something the app does not do, this says what
 * the app does instead:
 *  - Speech-to-text and the spoken voice are ElevenLabs (services/voice-gateway
 *    mints the Scribe token and proxies /tts). The design had both on the Mac.
 *  - There is one chat provider at a time, not one per kind of work:
 *    `ATLAS_AI_PROVIDER` picks Anthropic first-party (the default) or Bedrock
 *    in Europe, and the scheduler's background cycle uses the same one
 *    (supabase/functions/_shared/aiGateway.ts).
 *  - Re-stating a fact updates the same row (ON CONFLICT on user + key, the
 *    mention count goes up); nothing keeps a superseded history.
 *  - Up to ten memories go into a request (orchestrator `match_count: 10`).
 * The Workshop page's own sections still name GPT-5, Gemini and Perplexity;
 * that page is left as it was for the flag-off build.
 */
import type { IconName } from '@/components/atlas/icons';
import { QS_STATES, STATE_TINT, TINT, type QuickSphereState } from '@/lib/quickSphere';

export const ARCH_TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'providers', label: 'AI providers' },
  { key: 'memory', label: 'Memory' },
  { key: 'learning', label: 'Learning' },
  { key: 'sphere', label: 'Sphere' },
] as const;
export type ArchTab = (typeof ARCH_TABS)[number]['key'];

/** `/atlas-architecture#memory` opens that section; anything else opens nothing. */
export function archTabFromHash(hash: string): ArchTab | null {
  const k = decodeURIComponent((hash || '').replace(/^#/, '')).trim().toLowerCase();
  return ARCH_TABS.some((t) => t.key === k) ? (k as ArchTab) : null;
}

/** The boxes of "One trip through Atlas", top row left to right, then back along the bottom. */
export const TRIP = {
  speak: { title: 'You speak', body: 'or type, the same way' },
  hear: { title: 'Atlas hears its name', body: 'Catches “Hey Atlas” and notices when you stop, both on this Mac' },
  lookup: { title: 'It looks things up', body: 'Searches what you’ve told it and picks the few bits that matter here' },
  request: { title: 'It writes the request', body: 'Your question, plus those bits, as one block of text' },
  answer: { title: 'It answers you', body: 'Shows the text, moves the sphere, and speaks it' },
  keep: { title: 'It decides what to keep', body: 'Most of a conversation is not worth remembering' },
  write: { title: 'It writes it down', body: 'Into one file, here' },
} as const;
export type TripKey = keyof typeof TRIP;

/** The same trip as a list, for widths the diagram cannot fit. */
export const TRIP_ORDER: readonly TripKey[] = ['speak', 'hear', 'lookup', 'request', 'answer', 'keep', 'write'];

export const STAYS_HERE = ['Your memories', 'The search index', 'The wake word check', 'Knowing when you stop'] as const;

export const TECH_LOCAL_LINE = 'SQLite (atlas.db) · e5 embeddings, on device · Silero VAD · Hey Atlas wake model (ONNX)';

export interface RunsWhere {
  what: string;
  where: string;
  local: boolean;
}

/** "What runs where", in short. */
export const RUNS_WHERE: readonly RunsWhere[] = [
  { what: 'The app you’re looking at', where: 'This Mac', local: true },
  { what: 'Hearing its name, noticing you stopped', where: 'This Mac', local: true },
  { what: 'Memories and search', where: 'This Mac', local: true },
  { what: 'Turning speech into words, and replies into a voice', where: 'ElevenLabs', local: false },
  { what: 'Deciding what to say back', where: 'Anthropic or Bedrock, EU', local: false },
  { what: 'Background summaries and research', where: 'Anthropic or Bedrock, EU', local: false },
  { what: 'Your settings', where: 'This Mac', local: true },
  { what: 'Signing in to your account', where: 'helloatlas.dk', local: false },
];

export const TECH_STACK_LINE =
  'Tauri + React shell · Bun sidecars: atlas-brain (orchestrator, local memory) and voice-gateway (Silero VAD, ElevenLabs proxy) · SQLite · Anthropic Messages API or AWS Bedrock (EU) · account on Cloudflare';

export interface RemoteService {
  name: string;
  tag: string;
  emphasis: boolean;
  body: string;
  sees: string;
  never: string;
  tech: string;
}

/** "Somewhere else": the places a request actually goes. */
export const REMOTE_SERVICES: readonly RemoteService[] = [
  {
    name: 'Anthropic, or AWS Bedrock in Europe',
    tag: 'Every reply',
    emphasis: true,
    body: 'Every reply comes from Claude, through Anthropic directly or through AWS Bedrock in the EU, whichever this Mac is set to. The same one does the background work: summaries and the research you asked for.',
    sees: 'Your question and the memories Atlas chose to include',
    never: 'The memory file, the search index, your settings',
    tech: 'ATLAS_AI_PROVIDER · Messages API (default) or Bedrock eu-central-1 · web-search turns go to Anthropic either way',
  },
  {
    name: 'ElevenLabs',
    tag: 'While you talk',
    emphasis: false,
    body: 'Your voice, both ways. While a voice session is open your speech streams there and comes back as words; each reply goes there as text and comes back as speech.',
    sees: 'What you say in a voice session, and the replies it speaks',
    never: 'Your memories, the search index, typed questions',
    tech: 'Scribe realtime (single-use token from the voice gateway) · /tts proxied by the voice gateway',
  },
];

export interface LocalPart {
  icon: IconName;
  title: string;
  body: string;
  tech: string;
}

/** "Kept here": what never goes online, and why it has to be local. */
export const LOCAL_PARTS: readonly LocalPart[] = [
  {
    icon: 'memory',
    title: 'The memory file',
    body: 'One database on your disk holding every fact, preference and person Atlas has learned. You can back it up, or delete it.',
    tech: 'SQLite atlas.db, in ~/Library/Application Support',
  },
  {
    icon: 'search',
    title: 'Search by meaning',
    body: 'Ask about “the pitch” and it finds the note that says “Innovo deck”. The maths behind that runs locally, so nobody else ever indexes what you told it.',
    tech: 'multilingual-e5 embeddings (ONNX) in the brain sidecar · cosine + keyword rerank',
  },
  {
    icon: 'mic',
    title: 'Listening for its name',
    body: 'Until you say “Hey Atlas”, nothing the microphone hears leaves this Mac. The check runs here, on a model small enough to run all the time. (Teach is the exception: while its microphone is on, speech streams to ElevenLabs and Atlas listens for its name in the words.)',
    tech: 'Hey Atlas wake model, onnxruntime-web',
  },
  {
    icon: 'activity',
    title: 'Knowing when you’ve stopped',
    body: 'Atlas waits for a real pause rather than a fixed timer, and stops talking the moment you start. Both have to react in milliseconds, which rules out a round trip.',
    tech: 'Silero VAD in the voice gateway, barge-in',
  },
];

export interface MemoryKind {
  n: string;
  title: string;
  body: string;
  /** The one that lasts: drawn in the emphasis fill, with the real categories under it. */
  lasting: boolean;
}

export const MEMORY_KINDS: readonly MemoryKind[] = [
  { n: '01', title: 'This conversation', body: 'What you’ve said in the last few minutes. Held in the moment, gone when the conversation ends.', lasting: false },
  { n: '02', title: 'What it fetched', body: 'Up to ten memories pulled in because they looked relevant to what you just asked. Assembled fresh each turn, then dropped.', lasting: false },
  { n: '03', title: 'What it keeps', body: 'Facts filed under a category, each with a sense of how much it matters. This is the file on your disk.', lasting: true },
];

export interface LearningStep {
  key: string;
  title: string;
  body: string;
  example: string;
}

export const LEARNING_STEPS: readonly LearningStep[] = [
  { key: 'notice', title: 'Notice', body: 'Something you said looks worth keeping', example: '“My sister Ana is moving to Porto in March.”' },
  { key: 'file', title: 'File it', body: 'Given a category and a weight, then written to the file on this Mac', example: 'Relationships · Ana, sister · moving to Porto in March · importance 0.7' },
  { key: 'reconcile', title: 'Reconcile', body: 'Saying it again updates the same memory instead of adding a second one', example: 'The newer line about Ana replaces the older one, and Atlas notes it has now heard it twice.' },
  { key: 'recall', title: 'Recall', body: 'Next time it’s relevant, it comes back into the request', example: 'You ask about flights in March. Atlas suggests Porto.' },
];

export interface SphereStateInfo {
  state: QuickSphereState;
  name: string;
  body: string;
}

/** Every state the sphere has, in the design's order, with what it means. */
export const SPHERE_STATES: readonly SphereStateInfo[] = [
  { state: 'idle', name: 'Resting', body: 'Slow drift. Nothing is happening.' },
  { state: 'waking', name: 'Waking', body: 'It heard its name. A session is opening.' },
  { state: 'listening', name: 'Listening', body: 'Reacting to your voice in real time.' },
  { state: 'thinking', name: 'Thinking', body: 'The request has left. This is the honest wait.' },
  { state: 'speaking', name: 'Speaking', body: 'The reply is being spoken.' },
  { state: 'working', name: 'Working', body: 'A job is running without you.' },
  { state: 'success', name: 'Done', body: 'A task you asked for finished.' },
  { state: 'alert', name: 'Needs you', body: 'Something failed, or needs a decision.' },
  { state: 'muted', name: 'Muted', body: 'The microphone is off. Nothing is being heard.' },
  { state: 'dissolving', name: 'Ending', body: 'The session is closing.' },
];

/** The engine's own state list, so a state added there and not here shows up in a test. */
export const ENGINE_STATES: readonly QuickSphereState[] = QS_STATES;

/** The dot beside a state: the engine's own tint, or the neutral paper for none. */
export function sphereStateColor(state: QuickSphereState): string {
  const key = STATE_TINT[state];
  if (!key) return '#c8c3bb';
  const [r, g, b] = TINT[key];
  return `rgb(${r}, ${g}, ${b})`;
}

/** The hero's isometric stack, top to bottom (phase 3's layers, unchanged). */
export const HERO_LAYERS = [
  { label: 'You · voice and screen', tone: 'blue' },
  { label: 'Wake word · on device', tone: 'blue-soft' },
  { label: 'Agent and limits', tone: 'paper' },
  { label: 'Memory · on this Mac', tone: 'paper' },
  { label: 'Connections', tone: 'sand' },
  { label: 'Reasoning model · remote', tone: 'ink' },
] as const;

/** "Running on this Mac · 4 local · 2 remote", counted from the cards below it. */
export function archEyebrow(local = LOCAL_PARTS.length, remote = REMOTE_SERVICES.length): string {
  return `Running on this Mac · ${local} local · ${remote} remote`;
}

/**
 * The two labels on the dashed line in the trip diagram. The design had the
 * reply spoken "here, not out there"; the voice is ElevenLabs, so the reply
 * line says so.
 */
export const EDGE = {
  leaves: { title: 'Leaves: the request', body: 'Your question and the memories Atlas picked. In a voice session, your speech too.' },
  returns: { title: 'Comes back: the reply', body: 'Text. To speak it, Atlas sends it to ElevenLabs and plays the voice that comes back.' },
} as const;

export interface MemoryFact {
  value: string;
  title: string;
  body: string;
}

/**
 * The three figures under "Three kinds of memory". The count is the brain's
 * own list (`/memory/list`, the hook Core's Memory tab reads); while it loads,
 * or outside the desktop app where there is no brain to ask, it is a dash
 * and the line under it says why rather than showing a zero.
 */
export function memoryFacts(
  memory: { state: 'loading' | 'ready' | 'unavailable' | 'error'; count: number; message?: string | null },
): MemoryFact[] {
  const ready = memory.state === 'ready';
  const keptBody = ready
    ? 'On this Mac, in one file'
    : memory.state === 'loading' ? 'Reading the memory file…' : (memory.message || 'The memory file could not be read.');
  return [
    { value: ready ? memoryCountLabel(memory.count) : '—', title: 'Memories kept', body: keptBody },
    { value: 'Up to 10', title: 'Fetched per turn', body: 'Only the ones that look relevant' },
    { value: '0', title: 'Copies uploaded', body: 'The file itself never leaves' },
  ];
}

/** The Sphere section's technical line, from the budgets the engine actually uses. */
export function sphereTechLine(demoCount: number, miniCount: number): string {
  return `QuickSphere · veil mode · canvas 2D · ${demoCount.toLocaleString('en-US')} points here, ${miniCount.toLocaleString('en-US')} in a small sphere · one settled frame under reduced motion`;
}

/** "412", or "500+" once the brain's list limit is reached. */
export function memoryCountLabel(n: number, cap = 500): string {
  return n >= cap ? `${cap}+` : String(Math.max(0, n));
}

/** The categories under "What it keeps": the most used first, then "+ N more". */
export function topCategories(byCategory: Readonly<Record<string, readonly unknown[]>>, n = 7): { shown: string[]; more: number } {
  const keys = Object.keys(byCategory)
    .filter((k) => k)
    .sort((a, b) => (byCategory[b]?.length ?? 0) - (byCategory[a]?.length ?? 0) || a.localeCompare(b));
  return { shown: keys.slice(0, n).map((k) => k.replace(/_/g, ' ')), more: Math.max(0, keys.length - n) };
}
