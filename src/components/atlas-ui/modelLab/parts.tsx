import type { ReactNode } from 'react';

/**
 * The small pieces the Model Lab repeats. Kept here so the three views share
 * one vocabulary rather than three near-identical inline shapes — the exact
 * duplication the T1 primitives pass existed to end.
 *
 * Everything below is fill + space. No pill, chip or row carries an outline;
 * state is a tinted background and a colour, per README §1.1.
 */

/** A state chip. `tone` is the meaning, never the decoration. */
export type PillTone = 'ok' | 'warn' | 'off' | 'accent' | 'neutral';

export const Pill = ({ tone = 'neutral', children }: { tone?: PillTone; children: ReactNode }) => (
  <span className={`ml-pill ml-pill-${tone}`}>{children}</span>
);

/** The 10.5px uppercase section label the whole handoff uses. */
export const SecLabel = ({ children }: { children: ReactNode }) => (
  <p className="ml-sec">{children}</p>
);

/**
 * A monospace-ish model id. Not a `<code>` element with a UA background — the
 * recessed fill comes from the paper scale like every other surface here.
 * `strike` marks an id that is named but cannot be invoked; it is paired with a
 * text label everywhere it appears, never left as the only signal.
 */
export const ModelId = ({ id, strike }: { id: string; strike?: boolean }) => (
  <span className={`ml-id${strike ? ' ml-id-struck' : ''}`}>{id}</span>
);

/**
 * A label/value row. `diff` is the comparison view's emphasis: a blue-tinted
 * FILL (`--wash`), which is what replaced every blue outline in this design.
 */
export const Kv = ({ k, v, diff }: { k: ReactNode; v: ReactNode; diff?: boolean }) => (
  <div className={`ml-kv${diff ? ' ml-kv-diff' : ''}`}>
    <span className="ml-kv-k">{k}</span>
    <span className="ml-kv-v">{v}</span>
  </div>
);

/** A caption under a panel — the place this surface admits what it cannot know. */
export const Note = ({ children }: { children: ReactNode }) => (
  <p className="ml-note">{children}</p>
);
