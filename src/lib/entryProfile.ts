/**
 * The name the sign-up conversation asks for, kept.
 *
 * "What should I call you?" is the first thing the Entry design asks a new
 * account, and the Workshop screen threw the answer away: `useAuth().signUp`
 * takes a display name and ignores it, because the Cloudflare account server
 * stores no profile. So Home went on greeting a brand-new user as "there"
 * thirty seconds after they had said their name.
 *
 * The answer belongs in the LOCAL profile instead (`profiles` in the app's
 * SQLite DB), which is exactly what Home's greeting, the dock's avatar and the
 * Talk panel already read (`useUserProfile`: nickname, then first_name). It
 * never goes to the account server, so nothing about the name leaves this Mac.
 *
 * Best effort by design. The account exists by the time this runs, and a
 * failed write (the browser preview has no Tauri, a locked DB) must not turn
 * a successful sign-up into an error — the worst case is the old behaviour.
 */
import { localClient } from '@/integrations/local/localClient';
import { callName } from '@/lib/betaEntry';

export interface ProfileNameRow {
  first_name: string | null;
  nickname: string | null;
}

/** The three calls this needs, so the decision can be tested without a DB. */
export interface ProfileStore {
  /** The account's profile row; `undefined` when the read itself failed. */
  find(userId: string): Promise<ProfileNameRow | null | undefined>;
  insert(userId: string, firstName: string): Promise<boolean>;
  update(userId: string, firstName: string): Promise<boolean>;
}

export type RememberResult = 'saved' | 'kept' | 'skipped' | 'failed';

/**
 * Store `name` as the account's first name.
 *
 * A name already on the profile wins (`kept`): this runs once, right after
 * sign-up, and must never overwrite something the user set in Settings.
 * `db_insert` is a plain INSERT with no conflict target (see the note on
 * `upsert` in localClient.ts), so the row is looked up first and updated
 * when it exists rather than inserted twice.
 */
export async function rememberName(userId: string, name: string, store: ProfileStore = localProfileStore): Promise<RememberResult> {
  const first = callName(name);
  if (!userId || !first) return 'skipped';
  try {
    const row = await store.find(userId);
    if (row === undefined) return 'failed';
    if (row && (row.nickname?.trim() || row.first_name?.trim())) return 'kept';
    const ok = row ? await store.update(userId, first) : await store.insert(userId, first);
    return ok ? 'saved' : 'failed';
  } catch {
    return 'failed';
  }
}

/** The app's local DB, through the Supabase-shaped shim. */
export const localProfileStore: ProfileStore = {
  async find(userId) {
    const { data, error } = await localClient
      .from<ProfileNameRow | null>('profiles')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();
    return error ? undefined : data ?? null;
  },
  async insert(userId, firstName) {
    const { error } = await localClient.from('profiles').insert({ user_id: userId, first_name: firstName });
    return !error;
  },
  async update(userId, firstName) {
    const { error } = await localClient.from('profiles').update({ first_name: firstName }).eq('user_id', userId);
    return !error;
  },
};
