/**
 * When a reading arrived — for the offline row's "last reading 12 min ago".
 *
 * The shared polls (sharedStore.ts) keep the last good reading across a
 * failed refresh but do not record when it arrived, and widening their
 * snapshot would ripple into every data hook and its tests. They do not need
 * to: a reading is a fresh object on every successful fetch and the same
 * object until the next one, and a poll only fetches while something is
 * subscribed and drawing it. So the first moment anything asks about an
 * object is, to within a render, the moment it arrived. A WeakMap remembers
 * that moment without keeping old readings alive.
 */
const seen = new WeakMap<object, number>();

export function seenAt(reading: object, now: number = Date.now()): number {
  const at = seen.get(reading);
  if (at != null) return at;
  seen.set(reading, now);
  return now;
}
