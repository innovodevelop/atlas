/**
 * Keeps the music going on every screen.
 *
 * The Beta shell mounts this once, the way it mounts Clock's ringing dialog:
 * mounting it boots the music queue store (src/hooks/useMusicQueue.ts) for
 * the run, so when a record ends on Mail or Home the next one in Up next
 * starts, and ducking and Wind down follow Atlas wherever it is. It draws
 * nothing, and it subscribes to nothing that renders: the store holds the
 * music bridge open only while Atlas's engine holds a record.
 */
import { useEffect } from 'react';
import { bootMusicQueue } from '@/hooks/useMusicQueue';

export default function MusicDriver() {
  useEffect(() => bootMusicQueue(), []);
  return null;
}
