/**
 * The record's artwork and the palette read off it.
 *
 * Two things happen here that are easy to get wrong:
 *
 * 1. CORS. Spotify CDN artwork (`i.scdn.co`) displays fine — the app's CSP
 *    allows `img-src … https:` — but reading its pixels needs a CORS-clean
 *    image, and `connect-src` does not include the CDN, so `fetch()` is not an
 *    option either. The DISPLAY images therefore carry no `crossOrigin` (they
 *    can never fail to render), and sampling happens on a SEPARATE
 *    `crossOrigin="anonymous"` probe. If the CDN does not send the header the
 *    probe simply errors and the surface keeps Atlas's own palette; the sleeve
 *    itself is unaffected. One `<img>` doing both jobs would trade a missing
 *    palette for a missing cover.
 *
 * 2. HONESTY. `atlasCover.read` is total — it returns a *copy* of the fallback
 *    on failure, which is indistinguishable from a successful read of a
 *    fallback-coloured image. So it is called with a sentinel and the result
 *    compared, and `sampled: false` is reported upward. The surface says so
 *    rather than quietly claiming "every colour comes from the record" while
 *    showing Atlas Blue.
 *
 * Neither the artwork nor the palette is ever refetched: the URL is the one
 * `useMusicPlayer` already normalised out of the Spotify payload.
 */
import { useEffect, useState } from 'react';
import { FALLBACK_PALETTE, make, read, type CoverPalette } from '@/lib/atlasCover';
import type { Track } from '@/hooks/useMusicPlayer';

export interface CoverArt {
  /** What every `<img>` on the surface renders: real artwork or a sleeve. */
  src: string;
  /** The tones the chrome derives from. */
  palette: CoverPalette;
  /** False when `palette` is Atlas's own because sampling was not possible. */
  sampled: boolean;
  /** True when there was no artwork and `atlasCover.make` stood in. */
  procedural: boolean;
}

const BLANK: CoverArt = { src: '', palette: FALLBACK_PALETTE, sampled: false, procedural: false };

/**
 * Impossible as a real read: `read` pushes `light` toward [255,252,246] and
 * `deep` toward [10,9,14], so no artwork can produce these.
 */
const SENTINEL: CoverPalette = { deep: [1, 2, 3], mid: [4, 5, 6], light: [7, 8, 9] };

const isSentinel = (p: CoverPalette): boolean =>
  p.light[0] === 7 && p.light[1] === 8 && p.light[2] === 9 && p.deep[0] === 1 && p.mid[0] === 4;

/**
 * `make` is ~262k RNG steps plus two large blurs, and it holds no cache of its
 * own by design. Memoise per track; bounded so a long session cannot grow it.
 */
const SLEEVES = new Map<string, string>();
const ART = new Map<string, CoverArt>();

function bound<T>(m: Map<string, T>, max: number): void {
  while (m.size > max) {
    const first = m.keys().next();
    if (first.done) return;
    m.delete(first.value);
  }
}

function proceduralSleeve(seed: string): string {
  const hit = SLEEVES.get(seed);
  if (hit != null) return hit;
  const url = make(seed, FALLBACK_PALETTE);
  SLEEVES.set(seed, url);
  bound(SLEEVES, 12);
  return url;
}

export function useCoverArt(track: Track | null): CoverArt {
  const trackId = track?.id ?? null;
  const artUrl = track?.artUrl ?? null;
  const [art, setArt] = useState<CoverArt>(BLANK);

  useEffect(() => {
    if (!trackId) { setArt(BLANK); return; }

    const cached = ART.get(trackId);
    if (cached) { setArt(cached); return; }

    const src = artUrl || proceduralSleeve(trackId);
    const procedural = !artUrl;
    // Publish the sleeve before the palette lands so the wash paints on the
    // first frame; the palette crossfades in from Atlas Blue behind it.
    setArt({ src, palette: FALLBACK_PALETTE, sampled: false, procedural });
    if (!src) return;

    let live = true;
    const settle = (next: CoverArt) => {
      if (!live) return;
      ART.set(trackId, next);
      bound(ART, 24);
      setArt(next);
    };

    const probe = new Image();
    probe.crossOrigin = 'anonymous';
    probe.onload = () => {
      const p = read(probe, SENTINEL);
      const ok = !isSentinel(p);
      settle({ src, palette: ok ? p : FALLBACK_PALETTE, sampled: ok, procedural });
    };
    probe.onerror = () => settle({ src, palette: FALLBACK_PALETTE, sampled: false, procedural });
    probe.src = src;

    return () => {
      live = false;
      probe.onload = null;
      probe.onerror = null;
    };
  }, [trackId, artUrl]);

  return art;
}
