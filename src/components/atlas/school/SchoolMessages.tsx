/**
 * Messages (`Atlas School Beta.dc.html`, "Beskeder"): the student's LearnIT
 * conversations, read-only. Atlas reads the latest message of each; it sends
 * nothing, so a reply happens on LearnIT, which "Reply on LearnIT" opens.
 */
import { useState } from 'react';
import { hhmm, shortDate, startOfDay } from '@/lib/betaSchool';
import { useSchoolSync } from '@/lib/betaSchoolSync';
import { openExternal } from '@/components/atlas-ui/answerViews/openExternal';
import { NeedsSchool, SyncLine } from './SchoolBits';
import type { SchoolTab } from './schoolTabs';

const when = (ms: number | null, now: number) => (ms === null ? '' : startOfDay(ms) === startOfDay(now) ? hhmm(ms) : shortDate(ms));

export function SchoolMessages({ now, onTab }: { now: number; onTab: (t: SchoolTab) => void }) {
  const sync = useSchoolSync();
  const data = sync.moodle.cache?.data ?? null;
  const site = sync.conn?.moodle.site ?? sync.moodle.cache?.site ?? '';
  const threads = [...(data?.conversations ?? [])].sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0));
  const [openId, setOpenId] = useState<number | null>(null);
  const open = threads.find((t) => t.id === openId) ?? threads[0] ?? null;

  if (!sync.conn?.moodle.connected && !data) {
    return <NeedsSchool source="LearnIT" line="Messages come from LearnIT. Connect it and your conversations show here to read; you reply on LearnIT." onTab={onTab} />;
  }
  if (data?.unavailable.includes('messages')) {
    return <p className="b-sc-banner"><b>This site does not share messages with your key.</b> <span>Read them on LearnIT.</span></p>;
  }

  return (
    <div className="b-sc-msgview">
      <div className="b-sc-two b-sc-two--msgs">
        <section className="b-sc-panel b-sc-threads" aria-label="Conversations">
          {threads.map((t) => (
            <button type="button" key={t.id} className={`b-sc-thread${open?.id === t.id ? ' on' : ''}${t.unread ? ' unread' : ''}`} onClick={() => setOpenId(t.id)}>
              <i />
              <span>
                <span className="b-sc-thread-top"><b>{t.name}</b><small>{when(t.lastAt, now)}</small></span>
                <span className="b-sc-thread-sub">{t.lastFromMe ? 'You: ' : ''}{t.lastText || 'No messages'}</span>
                {t.unread ? <span className="b-sc-thread-n">{t.unread} unread</span> : null}
              </span>
            </button>
          ))}
          {!threads.length ? <div className="b-sc-empty">{data ? 'No conversations on LearnIT.' : 'Fetching your messages…'}</div> : null}
        </section>
        {open ? (
          <section className="b-sc-card b-sc-thread-open" aria-label={open.name}>
            <span className="b-sc-muted">{open.members.join(', ') || 'LearnIT'}{open.lastAt ? ` · ${shortDate(open.lastAt)} ${hhmm(open.lastAt)}` : ''}</span>
            <span className="b-sc-h2">{open.name}</span>
            <p className="b-sc-brief">{open.lastText || 'No messages yet.'}</p>
            <p className="b-sc-muted">The latest message in the conversation. Atlas reads LearnIT and sends nothing; you reply there.</p>
            {site ? (
              <button type="button" className="b-btn b-btn--card b-btn--row" onClick={() => void openExternal(`${site}/message/index.php?convid=${open.id}`)}>Reply on LearnIT</button>
            ) : null}
          </section>
        ) : null}
      </div>
      <SyncLine which="moodle" />
    </div>
  );
}
