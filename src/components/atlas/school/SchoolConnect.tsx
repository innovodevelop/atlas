/**
 * Your school — where the design connects Lectio, LearnIT and itslearning
 * (`Atlas School Beta.dc.html`, "Forbind").
 *
 * Atlas has no connector for any of them, so this view says so and lists
 * what would arrive once one exists. No sign-in buttons, no pairing code, no
 * feed field: a control here would pretend to connect something. Each line
 * says what the feature needs; nothing more.
 */
const PROVIDERS = [
  { name: 'Lectio', who: 'Danish gymnasiums', how: 'Lectio has no API. It would take its calendar feed for the schedule and a browser extension, signed in as you, for assignments, materials and messages.' },
  { name: 'LearnIT', who: 'ITU · Moodle', how: 'It would sign in on ITU’s own page, so Atlas never sees your password.' },
  { name: 'itslearning', who: 'Many schools', how: 'It would sign in on itslearning’s own page, so Atlas never sees your password.' },
];

const WAITING = [
  { name: 'Schedule', line: 'Your lessons, rooms and teachers, with cancellations and changes marked.' },
  { name: 'Assignments', line: 'What is set and when it is due, laid out by Atlas so the work is ready to start.' },
  { name: 'Messages', line: 'Teacher threads, which you would answer yourself.' },
  { name: 'Materials', line: 'Everything your teachers shared, per course.' },
  { name: 'Grades and absence', line: 'Marks per subject, their trend, and your absence against the limit.' },
  { name: 'Exams', line: 'Countdowns, with revision readiness per topic.' },
];

export function SchoolConnect() {
  return (
    <div className="b-sc-connect">
      <section className="b-sc-connect-hero" data-beta-tone="ink">
        <span className="b-eyebrow b-eyebrow--onink">Not connected</span>
        <p>Atlas can’t read your school yet. There is no connector for Lectio, LearnIT or itslearning, so nothing on this screen comes from your school. What is here is yours, kept on this Mac.</p>
      </section>
      <div className="b-sc-providers">
        {PROVIDERS.map((p) => (
          <section key={p.name} className="b-sc-card b-sc-provider" aria-label={p.name}>
            <div className="b-sc-provider-head">
              <span><b>{p.name}</b><span>{p.who}</span></span>
              <span className="b-status b-status--paused"><i />Not available</span>
            </div>
            <p className="b-sc-muted">{p.how}</p>
          </section>
        ))}
      </div>
      <section className="b-sc-panel" aria-label="Waiting on a connection">
        <span className="b-sc-h3">Waiting on a connection</span>
        {WAITING.map((w) => (
          <div key={w.name} className="b-sc-waiting"><b>{w.name}</b><span>{w.line}</span></div>
        ))}
      </section>
    </div>
  );
}
