import { useCallback, useEffect, useState } from 'react';
import { Brain, RefreshCw, ShieldAlert, Trash2, UserX } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { deleteAccount, getToken, LOCAL_DATA_DIR } from '@/lib/authClient';
import { getBrainEndpoint } from '@/lib/brainClient';
import { clearPersistedCache } from '@/App';
import { useToast } from '@/hooks/use-toast';

// Memory management & erasure ("the right to be forgotten", Phase 3). Lists the
// user's stored memories from the local brain sidecar and exposes per-row
// Forget plus a typed-confirmation Delete-everything. All destructive calls go
// through the brain routes (/memory/forget, /memory/erase-all) rather than the
// raw DB shim so vectors and index mirrors are cleaned up in the same breath.
// Deleting the account is a separate action with its own phrase: wiping this Mac
// and closing the account are different intents, and merging them would destroy
// data (or an account) the user never asked to lose. Account deletion therefore
// leaves local data alone by default — as privacy §9 / terms §8 promise — and
// offers the wipe as an explicit opt-in that runs only after the server call
// has succeeded.

interface StoredMemory {
  id: string;
  key: string;
  category: string;
  memory_type: string;
  importance: number;
  mention_count: number;
  preview: string;
  created_at: string;
}

const ERASE_PHRASE = 'DELETE';
const CLOSE_ACCOUNT_PHRASE = 'CLOSE ACCOUNT';

// A socket that accepts but never answers (a wedged sidecar, a stalled SQLite
// write) would otherwise spin the destructive buttons forever, so every call is
// bounded. Erasing a large corpus is legitimately slow — dozens of tables plus
// the FTS/vector mirrors — so it gets a far longer ceiling than a read.
const BRAIN_TIMEOUT_MS = 15_000;
const ERASE_TIMEOUT_MS = 120_000;

// Same local-sidecar fetch pattern as useBrainSearch. `token` overrides the
// stored session token for the one call that has to outlive it (the opt-in
// local erase runs after the account — and the session — is gone).
async function brainPost(
  path: string,
  body: unknown,
  { token, timeoutMs = BRAIN_TIMEOUT_MS }: { token?: string; timeoutMs?: number } = {},
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- brain sidecar returns free-form JSON; `unknown` here would force a cast at every call site without adding safety
): Promise<{ data: any; error: Error | null }> {
  const brain = await getBrainEndpoint();
  if (!brain) return { data: null, error: new Error('Memory management is only available in the desktop app.') };
  const abort = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; abort.abort(); }, timeoutMs);
  try {
    const res = await fetch(`${brain.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token ?? getToken() ?? ''}`, 'x-sidecar-token': brain.token },
      body: JSON.stringify(body),
      signal: abort.signal,
    });
    const data = await res.json();
    return res.ok ? { data, error: null } : { data: null, error: new Error(data.error || 'Request failed') };
  } catch (e) {
    if (timedOut) {
      // We gave up on the response, not on the work: the sidecar may still be
      // committing. Saying so is the difference between "nothing happened" and
      // "we don't know yet".
      return {
        data: null,
        error: new Error(
          `Atlas's memory service didn't answer within ${Math.round(timeoutMs / 1000)}s. It may still be working — ` +
          `refresh to see what actually changed.`,
        ),
      };
    }
    return { data: null, error: e instanceof Error ? e : new Error(String(e)) };
  } finally {
    clearTimeout(timer);
  }
}

export function MemoryPrivacyPanel() {
  const [memories, setMemories] = useState<StoredMemory[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [forgettingId, setForgettingId] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [isErasing, setIsErasing] = useState(false);
  const [accountConfirmText, setAccountConfirmText] = useState('');
  const [alsoEraseLocal, setAlsoEraseLocal] = useState(false);
  const [isClosingAccount, setIsClosingAccount] = useState(false);
  const { toast } = useToast();

  const load = useCallback(async () => {
    setIsLoading(true);
    const { data, error } = await brainPost('/memory/list', {});
    if (error) {
      setLoadError(error.message);
      setMemories([]);
    } else {
      setLoadError(null);
      setMemories((data?.memories ?? []) as StoredMemory[]);
    }
    setIsLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const forget = async (m: StoredMemory) => {
    setForgettingId(m.id);
    const { data, error } = await brainPost('/memory/forget', { id: m.id });
    setForgettingId(null);
    if (error) {
      toast({ title: 'Forget failed', description: error.message, variant: 'destructive' });
      return;
    }
    setMemories((prev) => prev.filter((x) => x.id !== m.id));
    toast({ title: 'Forgotten', description: `"${m.key}" removed (${data?.vectors ?? 0} vectors cleaned up).` });
  };

  const eraseAll = async () => {
    if (confirmText !== ERASE_PHRASE) return;
    setIsErasing(true);
    const { data, error } = await brainPost('/memory/erase-all', { confirm: true }, { timeoutMs: ERASE_TIMEOUT_MS });
    setIsErasing(false);
    setConfirmText('');
    if (error) {
      toast({ title: 'Erase failed', description: error.message, variant: 'destructive' });
      return;
    }
    const total = Object.values((data?.deleted ?? {}) as Record<string, number>).reduce((a, b) => a + b, 0);
    setMemories([]);
    // The query cache mirrors profile/tasks/notes/calendar rows we just deleted,
    // in memory AND in localStorage — leaving either behind would keep them
    // readable (and, for the persisted copy, writable straight back to disk).
    clearPersistedCache();
    toast({
      title: 'All data deleted',
      description: `${total} rows erased — memories, knowledge, transcripts, profile, notes, tasks, mail and everything else Atlas stored for your account on this Mac.`,
    });
  };

  // Account first, local erase second — the reverse of the obvious order, and
  // deliberate. The account call is the fallible one (/api/account/delete can
  // be undeployed or unreachable); the local wipe is the irreversible one. Doing
  // the wipe first meant a failed request left the user with no data AND an
  // account they still had. It also contradicted privacy §9 / terms §8, which
  // promise that deleting the account "does not touch the data on your device" —
  // so the wipe is opt-in and never runs on a path where the server call failed.
  // The brain authenticates by decoding the JWT locally (services/atlas-brain/
  // src/index.ts requireUser) rather than checking D1, so the token captured
  // before teardown still works once the account row is gone.
  const closeAccount = async () => {
    if (accountConfirmText !== CLOSE_ACCOUNT_PHRASE) return;
    const token = getToken() ?? undefined; // captured before deleteAccount ends the session
    setIsClosingAccount(true);
    const { error: accountError, signedOut } = await deleteAccount();
    if (accountError) {
      setIsClosingAccount(false);
      toast({
        // Not "account not deleted" — on a dropped connection the server may
        // have committed anyway, and the client can't know which happened.
        title: "Couldn't complete account deletion",
        // On the signed-out path this screen is gone until the user signs back
        // in, so name the folder here too — otherwise the only pointer to the
        // local corpus disappears with the session.
        description: signedOut
          ? `${accountError} Nothing on this Mac was touched — to erase it without signing in, delete ${LOCAL_DATA_DIR}.`
          : `${accountError} Nothing on this Mac was touched.`,
        variant: 'destructive',
      });
      return;
    }
    if (!alsoEraseLocal) {
      setIsClosingAccount(false);
      setAccountConfirmText('');
      toast({
        title: 'Account deleted',
        description: `Your Atlas account is permanently gone. Everything Atlas stored on this Mac is untouched — delete ${LOCAL_DATA_DIR} to remove it.`,
      });
      return;
    }
    const { data, error: localError } = await brainPost('/memory/erase-all', { confirm: true }, { token, timeoutMs: ERASE_TIMEOUT_MS });
    setIsClosingAccount(false);
    setAccountConfirmText('');
    if (localError) {
      toast({
        title: 'Account deleted, local data still here',
        description: `Your account is gone, but this Mac couldn't be erased (${localError.message}). Delete ${LOCAL_DATA_DIR} to remove it.`,
        variant: 'destructive',
      });
      return;
    }
    const total = Object.values((data?.deleted ?? {}) as Record<string, number>).reduce((a, b) => a + b, 0);
    setMemories([]);
    clearPersistedCache();
    toast({
      title: 'Account deleted',
      description: `Your Atlas account is permanently gone and ${total} rows were erased from Atlas's database on this Mac.`,
    });
  };

  return (
    <div className="col gap16">
      <div className="fx ac jb">
        <div>
          <h3 className="t14 fw6 fx ac gap8" style={{ color: 'hsl(240 30% 20%)', marginBottom: 6 }}>
            <Brain className="i16" />What Atlas remembers
          </h3>
          <p className="fs12 m0" style={{ color: 'hsl(240 20% 50%)', lineHeight: 1.5 }}>
            Everything is stored locally on this Mac. Forget a single memory, erase all your data, or delete your
            account below.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={isLoading}>
          <RefreshCw className={`w-4 h-4 mr-2 ${isLoading ? 'animate-spin' : ''}`} />Refresh
        </Button>
      </div>

      {loadError && (
        <div className="gpanel fs12" style={{ padding: 14, color: 'var(--negative)' }}>{loadError}</div>
      )}

      {!loadError && !isLoading && memories.length === 0 && (
        <div className="gpanel fs12" style={{ padding: 14, color: 'hsl(240 20% 50%)' }}>
          No memories stored yet. Atlas saves facts you share in conversation.
        </div>
      )}

      <div className="col" style={{ gap: 8, maxHeight: 420, overflowY: 'auto' }}>
        {memories.map((m) => (
          <div className="fx ac jb gpanel" key={m.id} style={{ padding: '10px 14px', gap: 12 }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="fx ac gap8">
                <p className="t14 fw6 trunc m0" style={{ color: 'hsl(240 30% 20%)' }}>{m.key}</p>
                <Badge variant="outline" className="fs12">{m.category}</Badge>
              </div>
              <p className="fs12 trunc m0" style={{ color: 'hsl(240 20% 50%)' }}>{m.preview}</p>
              <p className="fs12 m0" style={{ color: 'hsl(240 20% 60%)' }}>
                importance {m.importance ?? '—'} · mentioned {m.mention_count ?? 1}× · {new Date(m.created_at).toLocaleDateString()}
              </p>
            </div>
            <button
              className="xbtn fx ac jc"
              title="Forget this memory"
              onClick={() => forget(m)}
              disabled={forgettingId === m.id}
              style={{ opacity: forgettingId === m.id ? 0.5 : 1 }}
            >
              <Trash2 className="i14" />
            </button>
          </div>
        ))}
      </div>

      <div className="gpanel col gap10" style={{ padding: 14, border: '1px solid hsl(0 70% 60% / .35)' }}>
        <h4 className="t14 fw6 fx ac gap8 m0" style={{ color: 'var(--negative)' }}>
          <ShieldAlert className="i16" />Delete all my data
        </h4>
        {/* Enumerated because the erase really is total: /memory/erase-all wipes
            every table in Atlas's database that carries a user_id, not just the
            memory ones. Under-describing a destructive action is as bad as
            over-promising deletion. */}
        <p className="fs12 m0" style={{ color: 'hsl(240 20% 50%)', lineHeight: 1.5 }}>
          Permanently deletes <strong>everything</strong> Atlas stored for your account in its database on this Mac:
          every memory, learned knowledge entry, conversation transcript and session context — and also your profile,
          life events, notes, tasks, calendar events, watchlist and weather settings, mail accounts and messages,
          agents, schedules, runs and their steps, insights, research topics and citations, and Atlas's learned
          personality. Your account itself stays (delete it below), and API keys in the macOS Keychain are untouched.
          This cannot be undone. Type <strong>{ERASE_PHRASE}</strong> to confirm.
        </p>
        <div className="fx ac gap8">
          <Input
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder={`Type ${ERASE_PHRASE} to confirm`}
            className="max-w-[220px]"
          />
          <Button
            variant="destructive"
            size="sm"
            onClick={eraseAll}
            disabled={confirmText !== ERASE_PHRASE || isErasing}
          >
            {isErasing ? <RefreshCw className="w-4 h-4 mr-2 animate-spin" /> : <Trash2 className="w-4 h-4 mr-2" />}
            Delete everything
          </Button>
        </div>
      </div>

      <div className="gpanel col gap10" style={{ padding: 14, border: '1px solid hsl(0 70% 60% / .35)' }}>
        <h4 className="t14 fw6 fx ac gap8 m0" style={{ color: 'var(--negative)' }}>
          <UserX className="i16" />Delete my account
        </h4>
        <p className="fs12 m0" style={{ color: 'hsl(240 20% 50%)', lineHeight: 1.5 }}>
          Permanently deletes your Atlas account (email, password and plan) from our servers, so you can no longer sign
          in anywhere. Everything Atlas stores on this Mac stays where it is unless you tick the box below. This cannot
          be undone. Type <strong>{CLOSE_ACCOUNT_PHRASE}</strong> to confirm.
        </p>
        <div className="fx gap8" style={{ alignItems: 'flex-start' }}>
          <Checkbox
            id="erase-local-with-account"
            checked={alsoEraseLocal}
            onCheckedChange={(checked) => setAlsoEraseLocal(!!checked)}
            disabled={isClosingAccount}
            style={{ marginTop: 2 }}
          />
          <label htmlFor="erase-local-with-account" className="fs12" style={{ color: 'hsl(240 20% 50%)', lineHeight: 1.5, cursor: 'pointer' }}>
            Also erase Atlas's local database on this Mac — memories, learned knowledge, transcripts, session context,
            profile, life events, notes, tasks and mail. Runs only if the account is deleted first.
            <br />
            <strong>This is your only chance to do it from inside Atlas:</strong> once the account is gone you can't sign
            in again to reach this screen.
            <br />
            Not covered: Spotify and API keys in the macOS Keychain, and anything else outside Atlas's database. To
            remove those too, delete <code>{LOCAL_DATA_DIR}</code> and the <code>atlas-music</code> / <code>atlas-core</code>{' '}
            Keychain items.
          </label>
        </div>
        <div className="fx ac gap8">
          <Input
            value={accountConfirmText}
            onChange={(e) => setAccountConfirmText(e.target.value)}
            placeholder={`Type ${CLOSE_ACCOUNT_PHRASE} to confirm`}
            className="max-w-[220px]"
          />
          <Button
            variant="destructive"
            size="sm"
            onClick={closeAccount}
            disabled={accountConfirmText !== CLOSE_ACCOUNT_PHRASE || isClosingAccount}
          >
            {isClosingAccount ? <RefreshCw className="w-4 h-4 mr-2 animate-spin" /> : <UserX className="w-4 h-4 mr-2" />}
            Delete account
          </Button>
        </div>
      </div>
    </div>
  );
}

export default MemoryPrivacyPanel;
