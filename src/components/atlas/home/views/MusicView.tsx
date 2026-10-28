/**
 * Music — the Beta Music screen is phase 4 work still to come. Until it has
 * a route, the Workshop's full player (`AtlasExpanded` 'music', a portal that
 * covers the window with its own Close) is the listening room; its Close and
 * Esc come back here. Once `/music` is routable this hands over to it.
 */
import { useEffect, useRef } from 'react';
import { AtlasExpanded } from '@/components/atlas-ui/AtlasExpanded';
import { openTalk } from '@/lib/talkBus';
import { useBetaNavigate } from '@/lib/viewTransitions';
import { isRoutable } from '@/surfaces';

export function MusicView({ onClose }: { onClose: () => void }) {
  const navigate = useBetaNavigate();
  const routable = isRoutable('/music');
  const went = useRef(false);
  useEffect(() => {
    if (!routable || went.current) return;
    went.current = true;
    onClose();
    navigate('/music');
  }, [routable, navigate, onClose]);

  if (routable) return <div className="b-wv-empty">Opening Music…</div>;
  return (
    <>
      <div className="b-wv-empty">The listening room is open over Home. Close it, or press Esc, to come back.</div>
      <AtlasExpanded which="music" onClose={onClose} onOpenDrawer={() => openTalk()} sphereState="idle" audioLevel={0} />
    </>
  );
}
