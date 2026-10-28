/**
 * What Atlas wrote for a calendar event ("Prepare", Beta row 9) or a task
 * ("Research", row 10), and when a task was handed to Atlas — the
 * `atlas_item_notes` table, one row per item, on this Mac.
 *
 * `ask` streams the brain's answer onto the card while it is written and
 * saves it when it is done; a failed or cancelled ask saves nothing, so a
 * card never shows half a note as if it were the note. What leaves the Mac
 * is what `askAtlas` sends: the question, which carries only the item's own
 * fields (built in src/lib/betaViews.ts), to the AI provider the brain uses.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { localClient as supabase } from '@/integrations/local/localClient';
import { askAtlas } from '@/lib/askAtlas';
import { useAuth } from './useAuth';

export type NoteKind = 'event' | 'task';

export interface ItemNote {
  id: string;
  item_id: string;
  body: string | null;
  noted_at: string | null;
  delegated_at: string | null;
}

export interface AskState { itemId: string; text: string; busy: boolean; error: string | null }

export function useItemNotes(kind: NoteKind) {
  const { user } = useAuth();
  const [notes, setNotes] = useState<Record<string, ItemNote>>({});
  const [asking, setAsking] = useState<AskState | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    if (!user) { setNotes({}); return; }
    const { data } = await supabase.from('atlas_item_notes').select('*').eq('user_id', user.id).eq('item_kind', kind);
    const next: Record<string, ItemNote> = {};
    for (const r of (data ?? []) as ItemNote[]) next[r.item_id] = r;
    setNotes(next);
  }, [user, kind]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => () => abortRef.current?.abort(), []);

  /** Write fields onto an item's row: update when it exists, insert when not (the local upsert is not one). */
  const save = useCallback(async (itemId: string, patch: Partial<Pick<ItemNote, 'body' | 'noted_at' | 'delegated_at'>>): Promise<string | null> => {
    if (!user) return 'Sign in to keep notes.';
    // Update by the item's own key first, whatever this hook has loaded: a
    // row written before the first read landed (or by another screen) is
    // still found, so the insert below never trips the UNIQUE key.
    const upd = await supabase.from('atlas_item_notes').update(patch)
      .eq('user_id', user.id).eq('item_kind', kind).eq('item_id', itemId).select();
    if (upd.error) return upd.error.message;
    let rows = (upd.data ?? []) as ItemNote[];
    if (!rows.length) {
      const ins = await supabase.from('atlas_item_notes').insert({ user_id: user.id, item_kind: kind, item_id: itemId, ...patch }).select();
      if (ins.error) return ins.error.message;
      rows = (ins.data ?? []) as ItemNote[];
    }
    const row = rows[0];
    if (row) setNotes((n) => ({ ...n, [itemId]: row }));
    return null;
  }, [user, kind]);

  /** Ask the brain for this item's note; streams into `asking`, saved on success. */
  const ask = useCallback(async (itemId: string, question: string, screen: string) => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setAsking({ itemId, text: '', busy: true, error: null });
    try {
      const r = await askAtlas(question, {
        signal: ac.signal,
        screen,
        onText: (t) => setAsking((a) => (a && a.itemId === itemId ? { ...a, text: t } : a)),
      });
      const body = r.text.trim();
      if (!body) throw new Error('Atlas sent an empty note.');
      const err = await save(itemId, { body, noted_at: new Date().toISOString() });
      setAsking(err ? { itemId, text: body, busy: false, error: `Written but not saved: ${err}` } : null);
    } catch (e) {
      if (ac.signal.aborted) return;
      setAsking({ itemId, text: '', busy: false, error: e instanceof Error ? e.message : 'Atlas did not answer.' });
    }
  }, [save]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    setAsking(null);
  }, []);

  /** Forget the note (and, for a task, keep the hand-off): the row stays, the body goes. */
  const clear = useCallback(async (itemId: string) => save(itemId, { body: null, noted_at: null }), [save]);

  return { notes, asking, ask, cancel, save, clear, reload: load };
}
