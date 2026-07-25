import { useCallback, useEffect, useState } from 'react';
import { Brain, RefreshCw, ShieldAlert, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { getToken } from '@/lib/authClient';
import { getBrainEndpoint } from '@/lib/brainClient';
import { useToast } from '@/hooks/use-toast';

// Memory management & erasure ("the right to be forgotten", Phase 3). Lists the
// user's stored memories from the local brain sidecar and exposes per-row
// Forget plus a typed-confirmation Delete-everything. All destructive calls go
// through the brain routes (/memory/forget, /memory/erase-all) rather than the
// raw DB shim so vectors and index mirrors are cleaned up in the same breath.

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

// Same local-sidecar fetch pattern as useBrainSearch.
async function brainPost(path: string, body: unknown): Promise<{ data: any; error: Error | null }> {
  const brain = await getBrainEndpoint();
  if (!brain) return { data: null, error: new Error('Memory management is only available in the desktop app.') };
  try {
    const res = await fetch(`${brain.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken() ?? ''}`, 'x-sidecar-token': brain.token },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    return res.ok ? { data, error: null } : { data: null, error: new Error(data.error || 'Request failed') };
  } catch (e) {
    return { data: null, error: e instanceof Error ? e : new Error(String(e)) };
  }
}

export function MemoryPrivacyPanel() {
  const [memories, setMemories] = useState<StoredMemory[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [forgettingId, setForgettingId] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [isErasing, setIsErasing] = useState(false);
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
    const { data, error } = await brainPost('/memory/erase-all', { confirm: true });
    setIsErasing(false);
    setConfirmText('');
    if (error) {
      toast({ title: 'Erase failed', description: error.message, variant: 'destructive' });
      return;
    }
    const total = Object.values((data?.deleted ?? {}) as Record<string, number>).reduce((a, b) => a + b, 0);
    setMemories([]);
    toast({ title: 'All data deleted', description: `${total} rows erased across memories, knowledge and transcripts.` });
  };

  return (
    <div className="col gap16">
      <div className="fx ac jb">
        <div>
          <h3 className="t14 fw6 fx ac gap8" style={{ color: 'hsl(240 30% 20%)', marginBottom: 6 }}>
            <Brain className="i16" />What Atlas remembers
          </h3>
          <p className="fs12 m0" style={{ color: 'hsl(240 20% 50%)', lineHeight: 1.5 }}>
            Everything is stored locally on this Mac. Forget a single memory, or erase all your data below.
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
        <p className="fs12 m0" style={{ color: 'hsl(240 20% 50%)', lineHeight: 1.5 }}>
          Permanently deletes every memory, learned knowledge entry, conversation transcript and session context
          stored for your account on this Mac. This cannot be undone. Type <strong>{ERASE_PHRASE}</strong> to confirm.
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
    </div>
  );
}

export default MemoryPrivacyPanel;
