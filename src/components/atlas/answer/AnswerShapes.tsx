/**
 * Two of the Beta Answer screen's shapes (`Atlas Answer Views Beta.dc.html`):
 * the comparison (left-out row 27) and the person (row 28). Both draw only
 * what has already been validated — `parseComparison` and `parsePersonCard`
 * in src/lib/betaAnswer.ts — and nothing the design shows without a source
 * behind it (no score out of a hundred, no job title, no memories invented
 * for a person the mail does not describe).
 */
import { AtlasIcon } from '@/components/atlas/AtlasIcon';
import { initials, personStats, relDay, type Comparison, type PersonCard } from '@/lib/betaAnswer';

/**
 * One card per item, the design's split: its rows, a dot where it is the
 * better of the items on that row, and "Atlas's pick" on the one the answer
 * recommends. The verdict sits under the cards in the answer's own words.
 */
export function ComparisonView({ comparison }: { comparison: Comparison }) {
  const { items, rows, pick, verdict } = comparison;
  const anyBest = rows.some((r) => r.best !== null);
  return (
    <section className="b-answer-cmp" aria-label="Comparison">
      <div className="b-answer-cmp-grid" style={{ ['--n' as string]: items.length }}>
        {items.map((item, i) => (
          <div key={item.name} className={`b-answer-cmp-item${pick === i ? ' pick' : ''}`}>
            <div className="b-answer-cmp-top">
              <span>
                {item.note ? <small>{item.note}</small> : null}
                <b>{item.name}</b>
              </span>
              {pick === i ? <span className="b-answer-cmp-chip">Atlas’s pick</span> : null}
            </div>
            <dl className="b-answer-cmp-rows">
              {rows.map((r) => (
                <div key={r.attribute} className="b-answer-cmp-row">
                  <dt>{r.attribute}</dt>
                  <dd>{r.values[i]}{r.best === i ? <i aria-label="better on this" /> : null}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
      <p className="b-answer-cmp-verdict">
        {anyBest ? <><i aria-hidden />marks the better one on that row. </> : null}
        {verdict}
      </p>
    </section>
  );
}

const KIND_LABEL: Record<PersonCard['recent'][number]['kind'], string> = {
  'mail-in': 'From them',
  'mail-out': 'You wrote',
  meeting: 'Met',
};

/**
 * Who someone is to the user, from this Mac's mail and calendar only: the
 * name and address, how often you write and meet, the last of it, and the
 * next meeting. Mail opens the Mail screen; nothing here is sent anywhere.
 */
export function PersonView({ card, onOpenMail }: { card: PersonCard; onOpenMail?: () => void }) {
  const stats = personStats(card);
  return (
    <section className="b-answer-person" aria-label={card.name}>
      <div className="b-answer-person-main">
        <span className="b-answer-person-av" aria-hidden>{initials(card.name)}</span>
        <span className="b-answer-person-name">{card.name}</span>
        {card.address ? <span className="b-answer-person-sub">{card.address}</span> : null}
        <div className="b-answer-person-stats">
          {stats.map((s) => <div key={s.k}><small>{s.k}</small><b className="b-num">{s.v}</b></div>)}
        </div>
        {card.nextMeeting ? (
          <p className="b-answer-person-next">
            <AtlasIcon name="calendar" size={15} />
            <span>Next: <b>{card.nextMeeting.title}</b>, {relDay(card.nextMeeting.start, new Date(), true)}{card.nextMeeting.location ? ` · ${card.nextMeeting.location}` : ''}</span>
          </p>
        ) : null}
        {card.emails > 0 && onOpenMail ? (
          <div className="b-answer-person-acts">
            <button type="button" className="b-btn b-answer-person-btn" onClick={onOpenMail}><AtlasIcon name="mail" size={15} />Open Mail</button>
          </div>
        ) : null}
      </div>
      <div className="b-answer-person-side">
        <span className="b-answer-person-h">Together recently</span>
        {card.recent.length ? card.recent.map((e) => (
          <div key={`${e.kind}-${e.at}-${e.title}`} className={`b-answer-person-ev b-answer-person-ev--${e.kind}`}>
            <span className="b-num">{relDay(e.at)}</span>
            <i aria-hidden />
            <span>
              <b>{e.title}</b>
              <small>{KIND_LABEL[e.kind]}{e.sub ? ` · ${e.sub}` : ''}</small>
            </span>
          </div>
        )) : <p className="b-answer-person-none">Nothing yet in mail or the calendar.</p>}
        <p className="b-answer-person-fine">This card is read from the mail and calendar on this Mac, and nothing in it was sent anywhere.</p>
      </div>
    </section>
  );
}
