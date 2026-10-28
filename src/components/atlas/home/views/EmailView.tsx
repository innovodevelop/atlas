/**
 * Mail — the 'email' key has no screen of its own under the Beta: the Mail
 * screen (`/mail`) is it. This closes the full view and goes there. In an
 * edition without the Mail route the Workshop's mail body stands in, in the
 * Beta frame, so the widget still opens onto the real inbox.
 */
import { useEffect, useRef } from 'react';
import { AtlasExpanded } from '@/components/atlas-ui/AtlasExpanded';
import { openTalk } from '@/lib/talkBus';
import { useBetaNavigate } from '@/lib/viewTransitions';
import { isRoutable } from '@/surfaces';

export function EmailView({ onClose }: { onClose: () => void }) {
  const navigate = useBetaNavigate();
  const routable = isRoutable('/mail');
  const went = useRef(false);
  useEffect(() => {
    if (!routable || went.current) return;
    went.current = true;
    onClose();
    navigate('/mail');
  }, [routable, navigate, onClose]);

  if (routable) return <div className="b-wv-empty">Opening Mail…</div>;
  return (
    <div className="b-wv-legacy focusview">
      <AtlasExpanded which="email" onClose={onClose} onOpenDrawer={() => openTalk()} sphereState="idle" audioLevel={0} />
    </div>
  );
}
