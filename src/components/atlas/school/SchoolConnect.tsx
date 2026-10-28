/**
 * Your school — the connect screen (`Atlas School Beta.dc.html`, "Forbind").
 *
 * Two real connections and one that cannot be made:
 *
 *   - Lectio: the student pastes the link from Lectio → Skema → Abonnér. It is
 *     a private link (anyone holding it can read the schedule), so Rust checks
 *     it by fetching it once and keeps it in the macOS Keychain; the field is
 *     cleared the moment it is handed over and the link never comes back.
 *   - LearnIT (Moodle): the site's address and a security key the student
 *     creates in Moodle (Preferences → Security keys). Rust checks the key
 *     against the site and keeps it in the Keychain. Atlas never asks for the
 *     Moodle password; a site that issues no keys to students says so here.
 *   - itslearning: its API is for partners only, so it stays "Not available".
 *
 * Each card says what leaves the Mac. Disconnect deletes the Keychain item and
 * what was cached from it.
 */
import { useState } from 'react';
import { shortDate, hhmm } from '@/lib/betaSchool';
import {
  LEARNIT_SITE, connectLectio, connectMoodle, disconnectLectio, disconnectMoodle, refreshLectio, refreshMoodle, useSchoolSync,
} from '@/lib/betaSchoolSync';
import type { SchoolToast } from './useSchoolHooks';

const when = (ms: number) => `${shortDate(ms)} · ${hhmm(ms)}`;

function Status({ on, busy }: { on: boolean; busy: boolean }) {
  if (busy) return <span className="b-sc-state b-sc-state--busy">Checking…</span>;
  return <span className={`b-sc-state${on ? ' b-sc-state--on' : ''}`}>{on ? 'Connected' : 'Not connected'}</span>;
}

export function SchoolConnect({ onToast }: { onToast: SchoolToast }) {
  const sync = useSchoolSync();
  const [link, setLink] = useState('');
  const [site, setSite] = useState(LEARNIT_SITE);
  const [token, setToken] = useState('');
  const [lectioErr, setLectioErr] = useState<string | null>(null);
  const [moodleErr, setMoodleErr] = useState<string | null>(null);
  const [lectioBusy, setLectioBusy] = useState(false);
  const [moodleBusy, setMoodleBusy] = useState(false);

  const lectioOn = !!sync.conn?.lectio;
  const moodleOn = !!sync.conn?.moodle.connected;
  const lessons = sync.lectio.cache?.lessons.length ?? 0;
  const moodleData = sync.moodle.cache?.data ?? null;

  const addLectio = async () => {
    const value = link;
    // The link is a capability: it leaves this field as soon as it is handed to Rust.
    setLink('');
    setLectioBusy(true);
    setLectioErr(null);
    const err = await connectLectio(value);
    setLectioBusy(false);
    if (err) { setLectioErr(err); return; }
    onToast('Lectio is connected. Your schedule is here.');
  };

  const addMoodle = async () => {
    const key = token;
    setToken('');
    setMoodleBusy(true);
    setMoodleErr(null);
    const err = await connectMoodle(site, key);
    setMoodleBusy(false);
    if (err) { setMoodleErr(err); return; }
    onToast('LearnIT is connected.');
  };

  const dropLectio = async () => {
    const err = await disconnectLectio();
    if (err) setLectioErr(err); else onToast('Lectio is disconnected. The link is gone from this Mac.');
  };

  const dropMoodle = async () => {
    const err = await disconnectMoodle();
    if (err) setMoodleErr(err); else onToast('LearnIT is disconnected. The key is gone from this Mac.');
  };

  return (
    <div className="b-sc-connect">
      <section className="b-sc-connect-hero" data-beta-tone="ink">
        <span className="b-eyebrow b-eyebrow--onink">How this works</span>
        <p>Atlas never sees your school password. You give it a calendar link from Lectio and a key you make in LearnIT, both kept in this Mac’s Keychain, and Atlas only reads.</p>
      </section>

      {!sync.desktop ? (
        <p className="b-sc-banner"><b>Only in the Atlas app.</b> <span>Lectio and LearnIT are read by the app on your Mac, which keeps the link and the key in the Keychain. This window cannot.</span></p>
      ) : null}

      <div className="b-sc-providers">
        <section className="b-sc-card b-sc-provider" aria-label="Lectio">
          <div className="b-sc-provider-head">
            <span><b>Lectio</b><span>Danish gymnasiums · calendar feed</span></span>
            <Status on={lectioOn} busy={lectioBusy || sync.lectio.phase === 'syncing'} />
          </div>
          <p className="b-sc-muted">Lectio has no API. Your schedule comes from its calendar feed: lessons, rooms, teachers, and what is cancelled or changed. Assignments, messages and grades are not in the feed.</p>
          {lectioOn ? (
            <>
              <p className="b-sc-provider-line">
                {sync.lectio.cache ? `${lessons} ${lessons === 1 ? 'lesson' : 'lessons'} · updated ${when(sync.lectio.cache.fetchedAt)}` : 'Fetching your schedule…'}
              </p>
              {sync.lectio.error ? <p className="b-sc-err" role="alert">{sync.lectio.error}</p> : null}
              <div className="b-sc-row-actions">
                <button type="button" className="b-btn b-btn--card b-btn--row" disabled={sync.lectio.phase === 'syncing'} onClick={() => void refreshLectio()}>{sync.lectio.phase === 'syncing' ? 'Refreshing…' : 'Refresh'}</button>
                <button type="button" className="b-sc-disconnect" onClick={() => void dropLectio()}>Disconnect</button>
              </div>
            </>
          ) : (
            <form className="b-sc-connect-form" onSubmit={(e) => { e.preventDefault(); if (link.trim()) void addLectio(); }}>
              <label className="b-sc-step">
                <span>Calendar link</span>
                <input
                  className="b-sc-field b-num"
                  value={link}
                  onChange={(e) => setLink(e.target.value)}
                  placeholder="Lectio → Skema → Abonnér → copy the link"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={!sync.desktop || lectioBusy}
                />
              </label>
              <button type="submit" className="b-btn b-btn--primary b-btn--row" disabled={!sync.desktop || lectioBusy || !link.trim()}>{lectioBusy ? 'Checking the link…' : 'Connect Lectio'}</button>
              {lectioErr ? <p className="b-sc-err" role="alert">{lectioErr}</p> : null}
            </form>
          )}
          <p className="b-sc-leaves">What leaves this Mac: a request to lectio.dk for your calendar, when School opens and every hour while it is open. The link stays in the Keychain.</p>
        </section>

        <section className="b-sc-card b-sc-provider" aria-label="LearnIT">
          <div className="b-sc-provider-head">
            <span><b>LearnIT</b><span>{moodleOn && sync.conn?.moodle.site ? sync.conn.moodle.site.replace(/^https:\/\//, '') : 'ITU · Moodle'}</span></span>
            <Status on={moodleOn} busy={moodleBusy || sync.moodle.phase === 'syncing'} />
          </div>
          <p className="b-sc-muted">Assignments, materials, messages and grades from Moodle, read with a security key you create yourself. Atlas only reads: it hands nothing in and sends no messages.</p>
          {moodleOn ? (
            <>
              <p className="b-sc-provider-line">
                {moodleData
                  ? `${moodleData.site.user ? `${moodleData.site.user} · ` : ''}${moodleData.courses.length} ${moodleData.courses.length === 1 ? 'course' : 'courses'} · updated ${when(sync.moodle.cache?.fetchedAt ?? 0)}`
                  : 'Fetching your courses…'}
              </p>
              {moodleData?.unavailable.length ? (
                <p className="b-sc-muted">This site does not share {moodleData.unavailable.join(', ')} with your key.</p>
              ) : null}
              {sync.moodle.error ? <p className="b-sc-err" role="alert">{sync.moodle.error}</p> : null}
              <div className="b-sc-row-actions">
                <button type="button" className="b-btn b-btn--card b-btn--row" disabled={sync.moodle.phase === 'syncing'} onClick={() => void refreshMoodle()}>{sync.moodle.phase === 'syncing' ? 'Refreshing…' : 'Refresh'}</button>
                <button type="button" className="b-sc-disconnect" onClick={() => void dropMoodle()}>Disconnect</button>
              </div>
            </>
          ) : (
            <form className="b-sc-connect-form" onSubmit={(e) => { e.preventDefault(); if (site.trim() && token.trim()) void addMoodle(); }}>
              <label className="b-sc-step">
                <span>1 · Site</span>
                <input className="b-sc-field b-num" value={site} onChange={(e) => setSite(e.target.value)} placeholder={LEARNIT_SITE} autoComplete="off" spellCheck={false} disabled={!sync.desktop || moodleBusy} />
              </label>
              <label className="b-sc-step">
                <span>2 · Security key</span>
                <input
                  className="b-sc-field b-num"
                  type="password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="Moodle → Preferences → Security keys"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={!sync.desktop || moodleBusy}
                />
              </label>
              <p className="b-sc-muted">Make the key on the site under Preferences → Security keys (the Moodle mobile web service). Never paste your password here.</p>
              <button type="submit" className="b-btn b-btn--primary b-btn--row" disabled={!sync.desktop || moodleBusy || !site.trim() || !token.trim()}>{moodleBusy ? 'Checking the key…' : 'Connect LearnIT'}</button>
              {moodleErr ? <p className="b-sc-err" role="alert">{moodleErr}</p> : null}
            </form>
          )}
          <p className="b-sc-leaves">What leaves this Mac: read-only calls to the Moodle site with your key, when School opens, every hour while it is open, and when you open a material. The key stays in the Keychain.</p>
        </section>

        <section className="b-sc-card b-sc-provider" aria-label="itslearning">
          <div className="b-sc-provider-head">
            <span><b>itslearning</b><span>Many schools</span></span>
            <span className="b-sc-state">Not available</span>
          </div>
          <p className="b-sc-muted">itslearning only opens its API to partner companies, so there is no way for Atlas to read it on your behalf.</p>
        </section>
      </div>

      <section className="b-sc-panel" aria-label="What each connection brings">
        <span className="b-sc-h3">What each connection brings</span>
        <div className="b-sc-waiting"><b>Schedule</b><span>From Lectio: lessons, rooms and teachers, with cancellations and changes marked.</span></div>
        <div className="b-sc-waiting"><b>Exams</b><span>From Lectio’s schedule when a lesson is an exam, plus any you add yourself.</span></div>
        <div className="b-sc-waiting"><b>Assignments</b><span>From LearnIT, and Atlas lays each one out when you ask it to prepare it.</span></div>
        <div className="b-sc-waiting"><b>Materials and messages</b><span>From LearnIT, read-only. You reply on LearnIT yourself.</span></div>
        <div className="b-sc-waiting"><b>Grades</b><span>From LearnIT. Absence has no source: Lectio has no API and its feed carries none.</span></div>
      </section>
    </div>
  );
}
