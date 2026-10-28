/**
 * What the Beta Home remembers.
 *
 * Which widgets, in what order, at what size: the `dashboard_layout` table,
 * shared with the Workshop dashboard through `useDashboardLayout` and
 * translated by src/lib/betaHomeSync.ts. Layout (Stage · Grid · Centred) and
 * the Home settings: this machine's localStorage under `atlas:beta_home`,
 * because they describe this window, not the account.
 *
 * Until the user edits anything the table holds the Workshop's defaults; the
 * Beta then shows the handoff's starting Home instead, and the first edit
 * writes the whole result so the two never disagree afterwards.
 */
import { useCallback, useMemo, useState } from 'react';
import { useDashboardLayout } from './useDashboardLayout';
import {
  DEFAULT_HOME, DEFAULT_SETTINGS, PREFS_KEY, cycleSetting, parsePrefs,
  type HomeLayout, type HomePrefs, type HomeSettings, type HomeSlot,
} from '@/lib/betaHome';
import { diffForTable, slotsFromTable, toTableId } from '@/lib/betaHomeSync';

function readPrefs(): HomePrefs {
  try { return parsePrefs(window.localStorage.getItem(PREFS_KEY)); } catch { return parsePrefs(null); }
}

function writePrefs(p: HomePrefs): void {
  try { window.localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* private window: the session keeps it */ }
}

export interface HomeDraft { slots: HomeSlot[]; layout: HomeLayout; settings: HomeSettings }

export function useBetaHome() {
  const { slots: tableSlots, reorder, setVisibility, setSize, resetLayout } = useDashboardLayout();
  const [prefs, setPrefs] = useState<HomePrefs>(readPrefs);
  const [saving, setSaving] = useState(false);

  const untouched = useMemo(() => tableSlots.every((s) => s.id.startsWith('default-')), [tableSlots]);
  const tableHome = useMemo(() => slotsFromTable(tableSlots), [tableSlots]);
  const slots = useMemo<HomeSlot[]>(() => (untouched ? DEFAULT_HOME.map((s) => ({ ...s })) : tableHome), [untouched, tableHome]);

  const savePrefs = useCallback((p: HomePrefs) => { setPrefs(p); writePrefs(p); }, []);

  /** Done in the editor: prefs now, then the table mutations. */
  const apply = useCallback(async (draft: HomeDraft) => {
    savePrefs({ layout: draft.layout, settings: draft.settings });
    // From the untouched state everything is written, plus a hide for each
    // Workshop default the handoff's Home does not show.
    const before = untouched ? [] : slots;
    const d = diffForTable(before, draft.slots);
    if (untouched) {
      for (const s of tableHome) if (!draft.slots.some((n) => n.id === s.id)) d.visibility.push({ widgetId: toTableId(s.id), visible: false });
      d.order = draft.slots.map((s) => toTableId(s.id));
    }
    if (!d.order && !d.sizes.length && !d.visibility.length) return;
    setSaving(true);
    try {
      for (const v of d.visibility) await setVisibility.mutateAsync(v);
      for (const s of d.sizes) await setSize.mutateAsync(s);
      if (d.order) await reorder.mutateAsync(d.order);
    } finally {
      setSaving(false);
    }
  }, [savePrefs, untouched, slots, tableHome, setVisibility, setSize, reorder]);

  const cycle = useCallback((key: keyof HomeSettings) => {
    savePrefs({ ...prefs, settings: cycleSetting(prefs.settings, key) });
  }, [prefs, savePrefs]);

  const setLayout = useCallback((layout: HomeLayout) => savePrefs({ ...prefs, layout }), [prefs, savePrefs]);

  /** Back to the handoff's Home and the default settings. */
  const reset = useCallback(async () => {
    savePrefs({ layout: 'stage', settings: DEFAULT_SETTINGS });
    setSaving(true);
    try { await resetLayout(); } finally { setSaving(false); }
  }, [savePrefs, resetLayout]);

  return { slots, layout: prefs.layout, settings: prefs.settings, saving, apply, cycle, setLayout, reset };
}

export type BetaHome = ReturnType<typeof useBetaHome>;
