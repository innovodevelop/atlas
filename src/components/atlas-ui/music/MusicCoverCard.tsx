/**
 * The cover card, top right of the full player. Design handoff §5.
 *
 * 96px at rest; on click it expands to `min(312, sectionHeight - 96 - 316)`
 * with a 140px floor, and the sum is recomputed on every resize. The 96 is the
 * card's own top offset and the 316 is the reserved footer height, so a hard
 * 312 collides on any window under ~780px tall.
 *
 * The handoff accepts the collision at the floor. We do not: below 140px of
 * room the card stays at 96 and the expand affordance is disabled with a
 * reason, because a card that silently overlaps the transport is worse than one
 * that says it has no room.
 *
 * Sizing is imperative on purpose. The player re-renders whenever the track,
 * the connection state or the position anchor changes, and an open card must
 * survive all of it — driving width/height through React state would work, but
 * the transform, radius and disc animation all have to move together in the
 * same frame or the vinyl slides out at the wrong size.
 *
 * No metadata on the card, per the handoff. The title and artist live in the
 * footer; repeating them here is what made the old player's head + dock read as
 * two competing headers.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

export type CoverVariant = 'sleeve' | 'vinyl';

interface Props {
  variant: CoverVariant;
  /** Artwork URL — real or a procedural sleeve. Empty renders the well alone. */
  src: string;
  open: boolean;
  onToggle: () => void;
  /** The disc body; `paintChrome` tints it from the palette. Vinyl only. */
  discRef: RefObject<HTMLSpanElement | null>;
  /** Extra context — e.g. that the palette could not be sampled. */
  note?: string;
}

/** Top offset of the card and the reserved footer height, from the handoff. */
const TOP = 96;
const FOOTER = 316;
const MIN = 140;
const MAX = 312;

export function MusicCoverCard({ variant, src, open, onToggle, discRef, note }: Props) {
  const hostRef = useRef<HTMLButtonElement | null>(null);
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const tileRef = useRef<HTMLSpanElement | null>(null);
  const [roomy, setRoomy] = useState(true);

  /**
   * The player section's height, kept by the ResizeObserver below rather than
   * measured per paint.
   *
   * `getBoundingClientRect()` here is a forced synchronous layout, because the
   * previous paint's five inline style writes are still pending. Running it off
   * the raw `resize` event meant one forced layout of the whole fixed `.mp2`
   * subtree per event — i.e. per display frame while a window edge is being
   * dragged — while the sphere was reallocating its backing store on the same
   * events. A ResizeObserver reports the box from inside the layout phase, so
   * the measurement is free and the writes are batched into one per frame.
   */
  const sectionH = useRef(0);

  const paint = useCallback(() => {
    const host = hostRef.current;
    if (!host) return;
    if (!sectionH.current) {
      const sec = host.closest('.mp2');
      sectionH.current = sec ? sec.getBoundingClientRect().height : 0;
    }
    const room = sectionH.current ? sectionH.current - TOP - FOOTER : MAX - 24;
    const fits = room >= MIN;
    setRoomy(fits);
    const expanded = open && fits;
    const S = `${expanded ? Math.max(MIN, Math.min(MAX, room)) : TOP}px`;
    host.style.width = S;
    host.style.height = S;
    if (variant === 'sleeve') host.style.borderRadius = `${expanded ? 30 : 22}px`;
    if (tileRef.current) tileRef.current.style.borderRadius = `${expanded ? 18 : 12}px`;
    if (wrapRef.current) wrapRef.current.style.transform = `translate(${expanded ? '-62%' : '-13%'},-50%)`;
    // The spin is CSS, so the app-wide prefers-reduced-motion block already
    // stops it; this only decides whether it is declared at all.
    if (discRef.current) discRef.current.style.animation = expanded ? 'mp2spin 11s linear infinite' : 'none';
  }, [open, variant, discRef]);

  useLayoutEffect(() => { paint(); }, [paint]);

  // One stable observer for the life of the card: `paint` changes identity on
  // every open/variant toggle, and re-observing on each of those would fire a
  // fresh initial callback and re-measure for nothing.
  const paintRef = useRef(paint);
  paintRef.current = paint;

  useEffect(() => {
    const sec = hostRef.current?.closest('.mp2');
    if (sec && typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver((entries) => {
        const h = entries[0]?.contentRect.height ?? 0;
        // Sub-pixel noise cannot change the outcome — `room` is compared
        // against 140 and clamped to 312 — and every accepted value restarts a
        // 520ms width/height transition on the card.
        if (!h || Math.abs(h - sectionH.current) < 1) return;
        sectionH.current = h;
        paintRef.current();
      });
      ro.observe(sec);
      return () => ro.disconnect();
    }
    // No ResizeObserver: coalesce to one measurement per frame instead.
    let raf = 0;
    const on = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; sectionH.current = 0; paintRef.current(); });
    };
    window.addEventListener('resize', on);
    return () => { window.removeEventListener('resize', on); if (raf) cancelAnimationFrame(raf); };
  }, []);

  const label = !roomy
    ? 'Album artwork — the window is too short to expand it'
    : open ? 'Collapse album artwork' : 'Expand album artwork';
  const title = note ? `${label}. ${note}` : label;

  const sheenAndArt = (
    <>
      {src ? <img className="mp2coverimg" src={src} alt="" /> : null}
      {/* An inset shadow, not a border — the borderless system allows the
          former as a highlight and forbids the latter as a separator. */}
      <span className="mp2coversheen" aria-hidden />
    </>
  );

  if (variant === 'vinyl') {
    return (
      <button
        ref={hostRef}
        type="button"
        className="mp2cover mp2cover-vinyl"
        onClick={onToggle}
        disabled={!roomy}
        aria-label={label}
        aria-expanded={open && roomy}
        title={title}
      >
        <span className="mp2discwrap" ref={wrapRef}>
          <span className="mp2disc" ref={discRef} />
        </span>
        <span className="mp2arttile" ref={tileRef}>{sheenAndArt}</span>
      </button>
    );
  }

  return (
    <button
      ref={hostRef}
      type="button"
      className="mp2cover mp2cover-sleeve"
      onClick={onToggle}
      disabled={!roomy}
      aria-label={label}
      aria-expanded={open && roomy}
      title={title}
    >
      {sheenAndArt}
    </button>
  );
}
