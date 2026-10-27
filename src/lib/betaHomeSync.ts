/**
 * The Beta Home and the Workshop dashboard share one layout table
 * (`dashboard_layout`: widget_id · position · size · visible), so a widget the
 * user hides or resizes on either Home stays hidden or resized on the other.
 * The two use different widget ids and size names; this is the translation,
 * plus the diff that turns an editor result into table mutations.
 */
import { WIDGET_BY_ID, fromTableSize, toTableSize, type HomeSlot, type TableSize } from './betaHome';

/** Table widget_id → Beta widget id. Ids not listed are the same on both sides. */
export const BETA_ID_FROM_TABLE: Readonly<Record<string, string>> = {
  calendar: 'today',
  stocks: 'watch',
  mail: 'inbox',
  worldclock: 'clock',
};
export const TABLE_ID_FROM_BETA: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(BETA_ID_FROM_TABLE).map(([table, beta]) => [beta, table]),
);

export const toBetaId = (tableId: string): string => BETA_ID_FROM_TABLE[tableId] ?? tableId;
export const toTableId = (betaId: string): string => TABLE_ID_FROM_BETA[betaId] ?? betaId;

export interface TableRow {
  widget_id: string;
  position: number;
  size: string;
  visible: boolean;
}

/** The Beta slots a table holds: visible rows, in position order, known widgets only, clamped to the sizes the widget offers. */
export function slotsFromTable(rows: readonly TableRow[]): HomeSlot[] {
  const out: HomeSlot[] = [];
  for (const r of [...rows].sort((a, b) => a.position - b.position)) {
    if (!r.visible) continue;
    const id = toBetaId(r.widget_id);
    const def = WIDGET_BY_ID.get(id);
    if (!def || out.some((s) => s.id === id)) continue;
    const size = fromTableSize(r.size);
    out.push({ id, size: def.sizes.includes(size) ? size : def.defaultSize });
  }
  return out;
}

export interface TableDiff {
  /** Full visible order, table ids — null when the order did not change. */
  order: string[] | null;
  sizes: { widgetId: string; size: TableSize }[];
  visibility: { widgetId: string; visible: boolean }[];
}

/** The mutations that take the table from `before` to `after`. */
export function diffForTable(before: readonly HomeSlot[], after: readonly HomeSlot[]): TableDiff {
  const sizes: TableDiff['sizes'] = [];
  const visibility: TableDiff['visibility'] = [];
  const beforeById = new Map(before.map((s) => [s.id, s]));
  const afterById = new Map(after.map((s) => [s.id, s]));
  for (const s of after) {
    const prev = beforeById.get(s.id);
    if (!prev) visibility.push({ widgetId: toTableId(s.id), visible: true });
    if (!prev || prev.size !== s.size) sizes.push({ widgetId: toTableId(s.id), size: toTableSize(s.size) });
  }
  for (const s of before) if (!afterById.has(s.id)) visibility.push({ widgetId: toTableId(s.id), visible: false });
  const sameOrder = before.length === after.length && before.every((s, i) => s.id === after[i].id);
  return { order: sameOrder ? null : after.map((s) => toTableId(s.id)), sizes, visibility };
}
