/**
 * The widget face — one component that every Home widget renders through,
 * from `Atlas Dashboard Beta.dc.html` (`face()` in its script).
 *
 * Density is derived from the span, never guessed from pixels: one row is
 * compact, two rows carry a full body. A card that gets more space fills it
 * with more content (a chart, stats or a side list), never with padding
 * (§04 Widget grid). The slots below are the design's flourishes; a widget
 * passes the ones it has data for and the face lays them out in the order
 * the design uses.
 *
 * `preview` forces one of the four non-default states from
 * `Atlas Widgets Beta.dc.html` — a skeleton, the attention row, the empty
 * face, the offline row over dimmed content — for the widget catalog and
 * sheet. Left undefined (as Home leaves it) the face is exactly the live one.
 * The preview classes live in src/styles/beta/widgetCatalog.css, imported
 * here so a forced state draws correctly wherever the face is used.
 */
import type { ReactNode } from 'react';
import { SPANS, type WidgetSize } from '@/lib/betaHome';
import { skeletonBars, type PreviewState } from '@/lib/betaWidgetCatalog';
import { AtlasIcon } from '../AtlasIcon';
import type { IconName } from '../icons';
import '@/styles/beta/widgetCatalog.css';

export type FaceTone = 'paper' | 'linen' | 'sand' | 'sky' | 'ink' | 'slate' | 'emphasis';

export type FacePreview = PreviewState;

export interface FacePreviewAction { label: string; onClick: () => void }

/** The copy the forced states need; the adapters fill what they can read live, the caller the rest. */
export interface FacePreviewCopy {
  /** The one row the attention state adds. `muted` says the rule does not hold right now. */
  attention?: { text: string; tone?: 'blue' | 'red' | 'muted'; icon?: IconName; action?: FacePreviewAction };
  empty?: { title: string; hint?: string; action?: FacePreviewAction };
  /** After "Offline ·". `dim: false` keeps the content at full strength (local sources). */
  offline?: { text: string; dim?: boolean };
}

export interface FaceRow {
  key: string;
  /** Lead: a time, a ticker, an avatar's initials, a checkbox. */
  lead?: ReactNode;
  /** 58 px lead lane (times, tickers) vs a 30 px chip (avatars, checks). */
  leadKind?: 'lane' | 'chip' | 'check' | 'dot';
  checked?: boolean;
  dotOn?: boolean;
  eyebrow?: string;
  title: ReactNode;
  sub?: ReactNode;
  value?: ReactNode;
  valueTone?: 'up' | 'down' | 'muted' | 'ink';
  pill?: { text: string; tone: 'high' | 'med' | 'low' | 'now' };
  strike?: boolean;
  onClick?: () => void;
}

export interface FaceProps {
  size: WidgetSize;
  label: string;
  /** Right of the label; shown when the card is wide enough. */
  meta?: string;
  tone?: FaceTone;
  /** A reason: the data is a labelled sample, not the user's. */
  sample?: string | false | null;
  value?: ReactNode;
  delta?: ReactNode;
  deltaTone?: 'up' | 'down' | 'muted' | 'blue';
  sub?: ReactNode;
  /** 0–1 progress bar under the hero. */
  bar?: { fraction: number; colour?: string };
  /** Task-style segments: one per item, lit when done. */
  segs?: boolean[];
  /** Hour/day bars, 0–1 each; `hot` marks one. */
  bars?: { values: number[]; hot?: number; goal?: number };
  spark?: number[];
  sparkColour?: string;
  /** Three rings, 0–1 each, with their labels. */
  rings?: { label: string; value: string; fraction: number; colour: string }[];
  rows?: FaceRow[];
  /** Key figures in a row of small tiles. */
  kv?: { t: string; s: string; c?: string }[];
  chips?: { t: string; tone?: 'blue' | 'muted' | 'green' }[];
  note?: string;
  stats?: { t: string; s: string; dot?: string }[];
  foot?: { t: string; s: string }[];
  /** A full-bleed element behind the content (the weather glow, a camera). */
  bleed?: ReactNode;
  /** Replaces the hero block entirely (Now playing, lamps). */
  children?: ReactNode;
  /** After the rows: an input or an action row. */
  tail?: ReactNode;
  onOpen?: () => void;
  /** Extra class on the card. */
  className?: string;
  /** Entrance stagger in ms. */
  delay?: number;
  /** Force a non-default state (catalog and sheet only). */
  preview?: FacePreview;
  previewCopy?: FacePreviewCopy;
}

const TONE_CLASS: Record<FaceTone, string> = {
  paper: '', linen: 'bw--linen', sand: 'bw--sand', sky: 'bw--sky', ink: 'bw--ink', slate: 'bw--slate', emphasis: 'bw--emphasis',
};

/** The empty face's ghost chart: the design's bar heights, %. */
const GHOST = [34, 58, 22, 72, 44, 62, 28];

export function WidgetFace(p: FaceProps) {
  const [cols, rows] = SPANS[p.size];
  const big = rows >= 2, mid = cols >= 3;
  const showMeta = !!p.meta && (big || (mid && p.meta.length <= 16));
  const hasHero = p.value != null && !p.children;
  const nRows = big ? (p.rows?.length ?? 0) : 0;
  const rowsShown = p.rows?.slice(0, Math.min(nRows, 4)) ?? [];
  const dark = p.tone === 'ink' || p.tone === 'slate';
  const pv = p.preview;
  const offline = pv === 'offline' ? (p.previewCopy?.offline ?? { text: 'showing the last reading' }) : null;
  const shell = {
    className: [
      'bw', `bw--${p.size.toLowerCase()}`, TONE_CLASS[p.tone ?? 'paper'], p.onOpen && pv !== 'loading' ? 'clickable' : '', p.className ?? '',
      pv ? `b-wc-pv b-wc-pv--${pv}` : '', offline && offline.dim !== false ? 'b-wc-pv--dim' : '',
    ].filter(Boolean).join(' '),
    style: { gridColumn: `span ${cols}`, gridRow: `span ${rows}`, animationDelay: `${p.delay ?? 0}ms` },
    'data-widget': p.label,
  };

  // Loading: the shell in its own tone and nothing else, so no number shows before it is real.
  if (pv === 'loading') {
    return (
      <div {...shell} aria-busy="true" aria-label={`${p.label}, loading`}>
        <span className="b-wc-pv-sk" aria-hidden>
          {skeletonBars(p.size).map((b, i) => <span key={i} style={{ width: `${b.w}%`, height: b.h }} />)}
        </span>
      </div>
    );
  }

  // Empty: the label, what comes next, and one action when there is a real one.
  if (pv === 'empty') {
    const e = p.previewCopy?.empty ?? { title: 'No data yet', hint: 'Connect a source to begin.' };
    return (
      <div {...shell}>
        <div className="bw-head"><span className="bw-label">{p.label}</span></div>
        <div className={`b-wc-pv-empty${big ? ' tall' : ''}`}>
          {big ? <span className="b-wc-pv-ghost" aria-hidden>{GHOST.slice(0, cols >= 6 ? 7 : 5).map((h, i) => <span key={i} style={{ height: `${h}%` }} />)}</span> : null}
          <span className="b-wc-pv-empty-text">
            <span className="b-wc-pv-empty-t">{e.title}</span>
            {big && e.hint ? <span className="b-wc-pv-empty-h">{e.hint}</span> : null}
          </span>
          {e.action ? (
            <button type="button" className="b-wc-pv-empty-a" onClick={(ev) => { ev.stopPropagation(); e.action?.onClick(); }}>{e.action.label}</button>
          ) : null}
        </div>
      </div>
    );
  }

  // Attention and offline each add one row under the label; nothing else on the card moves.
  const alert = pv === 'attention'
    ? (p.previewCopy?.attention ?? { text: 'Nothing to flag now', tone: 'muted' as const })
    : offline
      ? { text: `Offline · ${offline.text}`, tone: offline.dim === false ? 'muted' as const : 'red' as const, icon: 'offline' as IconName, action: undefined }
      : null;
  const alertIcon: IconName = alert?.icon ?? (alert?.tone === 'muted' ? 'info' : 'sparkle');
  return (
    <div
      {...shell}
      role={p.onOpen ? 'button' : undefined}
      tabIndex={p.onOpen ? 0 : undefined}
      onClick={p.onOpen}
      onKeyDown={p.onOpen ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); p.onOpen?.(); } } : undefined}
      title={p.onOpen ? 'Open' : undefined}
    >
      {p.bleed ? <div className="bw-bleed" aria-hidden>{p.bleed}</div> : null}
      <div className="bw-head">
        <span className="bw-label">{p.label}</span>
        {p.sample ? <span className="sampleB" title={p.sample}>Sample</span> : null}
        {showMeta ? <span className="bw-meta">{p.meta}</span> : null}
      </div>
      {alert ? (
        <span className={`b-wc-pv-alert b-wc-pv-alert--${alert.tone ?? 'blue'}`} role="status" title={alert.text}>
          <i aria-hidden><AtlasIcon name={alertIcon} size={12} weight={2.2} /></i>
          <span>{alert.text}</span>
          {alert.action ? (
            <button type="button" onClick={(ev) => { ev.stopPropagation(); alert.action?.onClick(); }}>{alert.action.label}</button>
          ) : null}
        </span>
      ) : null}
      {p.children}
      {hasHero ? (
        <div className={`bw-hero${big ? '' : ' bw-hero--compact'}`}>
          <span className="bw-value">{p.value}</span>
          {p.delta != null && (mid || big) ? <span className={`bw-delta bw-delta--${p.deltaTone ?? 'muted'}`}>{p.delta}</span> : null}
        </div>
      ) : null}
      {hasHero && p.sub && (mid || big) ? <span className="bw-sub">{p.sub}</span> : null}
      {p.bar && (mid || big) ? (
        <span className="bw-bar"><span style={{ width: `${Math.round(Math.max(0, Math.min(1, p.bar.fraction)) * 100)}%`, background: p.bar.colour ?? 'var(--b-blue)' }} /></span>
      ) : null}
      {p.segs && (mid || big) ? (
        <span className="bw-segs">{p.segs.map((on, i) => <span key={i} className={on ? 'on' : ''} />)}</span>
      ) : null}
      {p.stats && mid ? (
        <span className="bw-stats">
          {p.stats.map((s) => (
            <span key={s.t + s.s}><span className="bw-stat-t"><i style={{ background: s.dot ?? 'var(--b-tertiary)' }} />{s.t}</span><span className="bw-stat-s">{s.s}</span></span>
          ))}
        </span>
      ) : null}
      {p.spark && mid && big ? (
        <svg className="bw-spark" viewBox="0 0 300 54" preserveAspectRatio="none" aria-hidden>
          <polyline points={sparkPoints(p.spark)} fill="none" stroke={p.sparkColour ?? 'var(--b-green-deep)'} strokeWidth="2" vectorEffect="non-scaling-stroke" />
        </svg>
      ) : null}
      {p.bars && mid && big ? (
        <span className="bw-bars">
          {p.bars.goal != null ? <span className="bw-goal" style={{ bottom: `${Math.round(p.bars.goal * 100)}%` }} /> : null}
          {p.bars.values.map((v, i) => (
            <span key={i} className={i === p.bars!.hot ? 'hot' : ''} style={{ height: `${Math.max(8, Math.round(v * 100))}%` }} />
          ))}
        </span>
      ) : null}
      {p.rings && mid ? (
        <span className="bw-rings">
          <svg viewBox="0 0 100 100" aria-hidden>
            {p.rings.slice(0, 3).map((r, i) => {
              const radius = [42, 29, 16][i];
              const c = 2 * Math.PI * radius;
              return (
                <g key={r.label}>
                  <circle cx="50" cy="50" r={radius} fill="none" stroke={dark ? 'rgba(249,247,244,.14)' : 'var(--b-panel)'} strokeWidth="9" />
                  <circle cx="50" cy="50" r={radius} fill="none" stroke={r.colour} strokeWidth="9" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - Math.max(0, Math.min(1, r.fraction)))} transform="rotate(-90 50 50)" />
                </g>
              );
            })}
          </svg>
          <span className="bw-ring-list">
            {p.rings.map((r) => <span key={r.label}><span>{r.label}</span><b>{r.value}</b></span>)}
          </span>
        </span>
      ) : null}
      {rowsShown.length ? (
        <span className="bw-rows">
          {rowsShown.map((r) => (
            <span
              key={r.key}
              className={`bw-row${r.onClick ? ' clickable' : ''}`}
              onClick={r.onClick ? (e) => { e.stopPropagation(); r.onClick?.(); } : undefined}
              role={r.onClick ? 'button' : undefined}
            >
              {r.leadKind === 'check' ? (
                <span className={`bw-check${r.checked ? ' on' : ''}`} aria-hidden>{r.checked ? '✓' : ''}</span>
              ) : r.leadKind === 'dot' ? (
                <span className={`bw-dot${r.dotOn ? ' on' : ''}`} aria-hidden />
              ) : r.leadKind === 'chip' ? (
                <span className="bw-chip">{r.lead}</span>
              ) : r.lead != null ? (
                <span className="bw-lane">{r.lead}</span>
              ) : null}
              <span className="bw-row-main">
                {r.eyebrow ? <span className="bw-row-eyebrow">{r.eyebrow}</span> : null}
                <span className={`bw-row-title${r.strike ? ' strike' : ''}`}>{r.title}</span>
                {r.sub ? <span className="bw-row-sub">{r.sub}</span> : null}
              </span>
              {r.pill ? <span className={`bw-pill bw-pill--${r.pill.tone}`}>{r.pill.text}</span> : null}
              {r.value != null ? <span className={`bw-row-value bw-v--${r.valueTone ?? 'muted'}`}>{r.value}</span> : null}
            </span>
          ))}
        </span>
      ) : null}
      {p.kv && big ? (
        <span className="bw-kv" style={{ gridTemplateColumns: `repeat(${Math.min(p.kv.length, 4)}, minmax(0, 1fr))` }}>
          {p.kv.map((k) => <span key={k.t + k.s}><b style={{ color: k.c }}>{k.t}</b><span>{k.s}</span></span>)}
        </span>
      ) : null}
      {p.chips && (mid || big) ? (
        <span className="bw-chips">
          {p.chips.map((c) => <span key={c.t} className={`bw-chipx bw-chipx--${c.tone ?? 'muted'}`}><i />{c.t}</span>)}
        </span>
      ) : null}
      {p.note && big ? <span className="bw-note"><i>✦</i><span>{p.note}</span></span> : null}
      {p.foot && big ? (
        <span className="bw-foot">{p.foot.map((f) => <span key={f.t + f.s}><b>{f.t}</b><span>{f.s}</span></span>)}</span>
      ) : null}
      {p.tail && big ? <span className="bw-tail" onClick={(e) => e.stopPropagation()}>{p.tail}</span> : null}
    </div>
  );
}

function sparkPoints(values: number[], w = 300, h = 54): string {
  if (values.length < 2) return '';
  const min = Math.min(...values), max = Math.max(...values), span = max - min || 1;
  return values.map((v, i) => `${((i / (values.length - 1)) * w).toFixed(1)},${(h - 6 - ((v - min) / span) * (h - 12)).toFixed(1)}`).join(' ');
}
