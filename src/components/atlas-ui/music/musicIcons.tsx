/**
 * The player's transport glyphs, taken verbatim from the design handoff
 * (`Atlas Music Player v2.dc.html`).
 *
 * Not lucide. Every glyph on this surface is a FILLED silhouette sized against
 * an 84px play button and a 54px skip; lucide's stroked equivalents read as a
 * different weight entirely at that scale, and the play triangle needs the
 * handoff's optical `margin-left` to sit centred in its circle.
 */
interface G {
  /** Rendered box in px. The viewBox is always 0 0 24 24. */
  size: number;
  className?: string;
}

const box = (size: number) => ({ viewBox: '0 0 24 24', width: size, height: size, fill: 'currentColor', 'aria-hidden': true } as const);

export const PauseGlyph = ({ size, className }: G) => (
  <svg {...box(size)} className={className}>
    <rect x="6" y="4.5" width="4.2" height="15" rx="1.4" />
    <rect x="13.8" y="4.5" width="4.2" height="15" rx="1.4" />
  </svg>
);

/** `nudge` is the handoff's optical centring: 4px at 34, 3px at 24, 2px at 20. */
export const PlayGlyph = ({ size, className, nudge = 4 }: G & { nudge?: number }) => (
  <svg {...box(size)} className={className} style={{ marginLeft: nudge }}>
    <path d="M7 4.5v15a1 1 0 0 0 1.5.87l12-7.5a1 1 0 0 0 0-1.74l-12-7.5A1 1 0 0 0 7 4.5z" />
  </svg>
);

export const PrevGlyph = ({ size, className }: G) => (
  <svg {...box(size)} className={className}>
    <path d="M6 5h2.4v14H6zM20 5.6v12.8a1 1 0 0 1-1.53.85l-9.2-6.4a1 1 0 0 1 0-1.7l9.2-6.4A1 1 0 0 1 20 5.6z" />
  </svg>
);

export const NextGlyph = ({ size, className }: G) => (
  <svg {...box(size)} className={className}>
    <path d="M15.6 5H18v14h-2.4zM4 5.6v12.8a1 1 0 0 0 1.53.85l9.2-6.4a1 1 0 0 0 0-1.7L5.53 4.75A1 1 0 0 0 4 5.6z" />
  </svg>
);

export const ShuffleGlyph = ({ size, className }: G) => (
  <svg {...box(size)} className={className}>
    <path d="M14.8 4.2 21 8l-6.2 3.8V9.4c-2.3.1-3.6 1.4-4.8 3.1-1.5 2.1-3.3 4.5-7 4.5v-2.6c2.2 0 3.3-1.4 4.6-3.2C9 8.9 10.9 6.9 14.8 6.8V4.2Z" />
    <path d="M3 7c2.3 0 3.9 1 5.2 2.5L6.5 11.6C5.6 10.6 4.6 9.6 3 9.6V7Z" />
    <path d="M14.8 15.2c1 .9 1.9 1 2.4 1v-2.4L23.4 18 17.2 21.8v-2.6c-2.1 0-3.7-.9-5-2.2l1.6-1.8Z" />
  </svg>
);

export const VolumeGlyph = ({ size, className }: G) => (
  <svg {...box(size)} className={className}>
    <path d="M4 9.5h3.2L12 5.4v13.2L7.2 14.5H4z" />
    <path d="M15.4 8.6a4.6 4.6 0 0 1 0 6.8l1.5 1.6a6.8 6.8 0 0 0 0-10l-1.5 1.6z" />
  </svg>
);

export const HeartGlyph = ({ size, className }: G) => (
  <svg {...box(size)} className={className}>
    <path d="M12 20.7l-1.4-1.3C5.4 14.7 2 11.6 2 7.9 2 5.1 4.2 3 7 3c1.7 0 3.3.8 4.3 2.1C12.7 3.8 14.3 3 16 3c2.8 0 5 2.1 5 4.9 0 3.7-3.4 6.8-8.6 11.5L12 20.7z" />
  </svg>
);

export const QueueGlyph = ({ size, className }: G) => (
  <svg {...box(size)} className={className}>
    <path d="M3 6h13v2.2H3zM3 11h13v2.2H3zM3 16h9v2.2H3zM18.4 10.4h2.2v6.1a2.9 2.9 0 1 1-2.2-2.8v-3.3z" />
  </svg>
);
