/**
 * Watchlist — the Workshop's stocks body (`AtlasExpanded` 'stocks': the
 * portfolio hero, the lead quote, indices, the watchlist) inside the Beta
 * frame until the Money screen takes the watchlist over. `.focusview` is the
 * Workshop's own class that lets `.exp` sit in flow instead of covering the
 * window.
 */
import { AtlasExpanded } from '@/components/atlas-ui/AtlasExpanded';
import { openTalk } from '@/lib/talkBus';

export function StocksView({ onClose }: { onClose: () => void }) {
  return (
    <div className="b-wv-legacy focusview">
      <AtlasExpanded which="stocks" onClose={onClose} onOpenDrawer={() => openTalk()} sphereState="idle" audioLevel={0} />
    </div>
  );
}
