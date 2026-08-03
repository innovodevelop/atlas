import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { AuthSphere, type OrbState } from './AuthSphere';
import { useAtlasSpeech } from '@/hooks/useAtlasSpeech';
import {
  ATLAS_PERMISSIONS,
  readOnboarding,
  requestPermission,
  writeOnboarding,
  type PermissionId,
} from '@/lib/atlasPermissions';

// First-run consent, in the same scene as the login screen so the two feel like
// one conversation rather than a login followed by a settings dialog.
//
// Why this screen exists: macOS used to fire its permission prompts mid-launch
// with no explanation, and a brand-new account then landed on an empty
// dashboard. Atlas now says what it needs and why FIRST, and only asks the
// system for the things you left switched on.

type Stage = 'intro' | 'choosing' | 'asking' | 'done';

const LINES = {
  intro: 'Before we start — here is what I would like access to, and why.',
  revisit: 'Here is what you allowed me. Change anything you like.',
  choosing: 'Switch off anything you would rather I did not have. You can change it later.',
  asking: 'Thank you. macOS will ask you to confirm a couple of these.',
  done: 'That is everything. Let me show you around.',
};

const AtlasPermissions = () => {
  const navigate = useNavigate();
  const speech = useAtlasSpeech();
  const [stage, setStage] = useState<Stage>('intro');
  const [orb, setOrb] = useState<OrbState>('idle');
  const [asking, setAsking] = useState<PermissionId | null>(null);
  const [granted, setGranted] = useState<Partial<Record<PermissionId, boolean>>>({});

  // The stored consent record, read ONCE on mount. Settings → Permissions makes
  // this screen a revisit surface, so it has to open on the answers the user
  // actually gave. Seeding from `defaultOn` regardless — as it did while the
  // screen was first-run-only and the bug was unreachable — showed the wrong
  // state and then wrote it back on Continue, silently revoking (for example)
  // a proactive-digest consent that Settings had just rendered as "Allowed".
  const [record] = useState(() => readOnboarding());
  const revisiting = record !== null;

  const [choices, setChoices] = useState<Record<PermissionId, boolean>>(() => {
    const stored = record?.choices;
    return Object.fromEntries(
      ATLAS_PERMISSIONS.map((p) => [
        p.id,
        typeof stored?.[p.id] === 'boolean' ? stored[p.id] : p.defaultOn,
      ]),
    ) as Record<PermissionId, boolean>;
  });

  // Atlas opens the conversation, then hands over to the list.
  useEffect(() => {
    setOrb('speaking');
    speech.speak(revisiting ? LINES.revisit : LINES.intro);
    const t = window.setTimeout(() => setStage('choosing'), 1500);
    return () => window.clearTimeout(t);
    // speech is stable (useCallback); intentionally run once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (speech.done) setOrb('idle');
  }, [speech.done]);

  const toggle = (id: PermissionId) =>
    setChoices((c) => ({ ...c, [id]: !c[id] }));

  const selectedCount = useMemo(
    () => Object.values(choices).filter(Boolean).length,
    [choices],
  );

  const finish = useCallback(async () => {
    setStage('asking');
    setOrb('thinking');
    speech.speak(LINES.asking);

    // Ask the OS only for what is still switched on, one at a time so the user
    // can connect each system dialog to the row it came from.
    const results: Partial<Record<PermissionId, boolean>> = {};
    for (const perm of ATLAS_PERMISSIONS) {
      if (!choices[perm.id]) continue;
      setAsking(perm.id);
      // Sequential BY DESIGN: firing these in parallel would stack unexplained
      // system dialogs, which is precisely the behaviour this screen replaces.
      results[perm.id] = await requestPermission(perm.id);
    }
    setAsking(null);
    setGranted(results);

    // Record what the user actually chose, not what we hoped they would.
    writeOnboarding(choices);
    setStage('done');
    setOrb('speaking');
    speech.speak(LINES.done);
    window.setTimeout(() => navigate('/'), 2200);
  }, [choices, navigate, speech]);

  // First run: "Not now" is an answer — decline everything and record it, so
  // the onboarding gate does not ask again. On a REVISIT it is a cancel: the
  // user came here from Settings to look, and writing all-false would wipe the
  // consents they already gave without them choosing anything.
  const skip = () => {
    if (!revisiting) {
      const none = Object.fromEntries(
        ATLAS_PERMISSIONS.map((p) => [p.id, false]),
      ) as Record<PermissionId, boolean>;
      writeOnboarding(none);
    }
    navigate('/');
  };

  return (
    <div className="ascene" data-screen-label="Atlas — Permissions">
      <AuthSphere orbState={orb} />
      <div className="avig" />
      <div className="ascrim" />
      <span className="alogo">atlas</span>

      <div className="agrid">
        <div className="aleft">
          <p className="amsg">
            {speech.words.map((w, i) => (
              <span key={i} className="awd">
                {w}{' '}
              </span>
            ))}
            {speech.speaking && <span className="acaret" />}
          </p>
          <p className="asub">
            {stage === 'choosing'
              ? LINES.choosing
              : stage === 'asking'
                ? 'Answering the system prompts…'
                : ''}
          </p>
        </div>

        <div className="aright">
          <div className={`aans${stage !== 'intro' ? ' on' : ''}`}>
            <ul className="permlist">
              {ATLAS_PERMISSIONS.map((p) => {
                const on = choices[p.id];
                const busy = asking === p.id;
                const result = granted[p.id];
                return (
                  <li key={p.id} className={`permrow${on ? ' on' : ''}`}>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={on}
                      aria-label={`${p.title}. ${p.blurb}`}
                      className="permtog"
                      disabled={stage === 'asking' || stage === 'done'}
                      onClick={() => toggle(p.id)}
                    >
                      <span className="permknob" />
                    </button>
                    <div className="permtext">
                      <span className="permtitle">
                        {p.title}
                        {busy && <Loader2 className="i16 animate-spin" />}
                        {result === false && (
                          <em className="permdenied">not granted</em>
                        )}
                      </span>
                      <span className="permblurb">{on ? p.blurb : p.withoutIt}</span>
                    </div>
                  </li>
                );
              })}
            </ul>

            {stage === 'choosing' && (
              <div className="afoot">
                <button className="aenter" onClick={finish}>
                  {revisiting
                    ? `Save ${selectedCount} selected →`
                    : selectedCount > 0
                      ? `Continue with ${selectedCount} selected →`
                      : 'Continue without any →'}
                </button>
                <button type="button" className="aswap" onClick={skip}>
                  {revisiting ? 'Cancel' : 'Not now'}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      <p className="aterms">
        Your notes and files stay on this Mac. What Atlas sends for reasoning —
        and where — is set out in the Privacy Policy.
      </p>
    </div>
  );
};

export default AtlasPermissions;
