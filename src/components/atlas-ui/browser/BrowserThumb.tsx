import type { TabPreview } from '@/lib/mocks/browser';

/**
 * A tab thumbnail, drawn rather than loaded.
 *
 * THERE IS NO IMAGE HERE, and that is a constraint rather than a shortcut. The
 * design prototype fills this slot with `image-slot.js`, which the handoff
 * excludes from porting, and falls back to exactly the flat construction below
 * — masthead band, hero block, three ink bars. In the app that fallback is the
 * only option: the Tauri CSP is `default-src 'self'`, the app is local-first
 * and has to render with the network off, and a screenshot pipeline for pages
 * Atlas cannot even open would be fiction on top of fiction.
 *
 * So this is the design's own placeholder, promoted to the real treatment. Each
 * site's tokens (`TabPreview`) make the cards distinguishable at a glance
 * without claiming to be a picture of anything.
 *
 * Purely decorative: the tab's title, host and index are real text in the card
 * above it, so this carries no information a screen reader would lose.
 */
export const BrowserThumb = ({ preview }: { preview: TabPreview }) => (
  <span className="br-thumb" style={{ background: preview.bg }} aria-hidden>
    <span
      className="br-thumb-bar"
      style={{ background: preview.bar, height: preview.barHeight }}
    >
      {preview.mark && (
        <span
          className={`br-thumb-mark ${preview.markFont === 'display' ? 'br-thumb-mark-disp' : ''}`}
          style={{ color: preview.markFg, letterSpacing: preview.markTracking }}
        >
          {preview.mark}
        </span>
      )}
    </span>
    <span className="br-thumb-hero" style={{ background: preview.hero, top: preview.heroTop }} />
    <span className="br-thumb-line br-thumb-line-1" style={{ background: preview.ink }} />
    <span className="br-thumb-line br-thumb-line-2" style={{ background: preview.ink }} />
    <span className="br-thumb-line br-thumb-line-3" style={{ background: preview.ink }} />
  </span>
);
