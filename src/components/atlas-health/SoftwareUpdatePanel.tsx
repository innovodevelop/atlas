import { useEffect, useState } from 'react';
import { CheckCircle2, Download, RefreshCw, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAppUpdater } from '@/hooks/useAppUpdater';

// Software-update settings panel (ship substrate). Checks the signed release
// feed on open, shows what is available (version + release notes), and only
// ever installs after the user explicitly clicks Install — the human approval
// step is part of the "verifying updater" invariant. Errors (offline, bad
// signature, missing feed) are shown verbatim, never swallowed.

export function SoftwareUpdatePanel() {
  const { supported, phase, update, progress, error, check, install } = useAppUpdater();
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);

  // Read the running app's version for the "You're on X" line.
  useEffect(() => {
    if (!supported) return;
    import('@tauri-apps/api/app')
      .then((m) => m.getVersion())
      .then(setCurrentVersion)
      .catch(() => {});
  }, [supported]);

  // Checking is read-only and safe to do automatically; installing never is.
  useEffect(() => {
    if (supported) check();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supported]);

  const pct =
    progress.total && progress.total > 0
      ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100))
      : null;

  return (
    <div className="col gap16">
      <div>
        <h3 className="t14 fw6 fx ac gap8" style={{ color: 'hsl(240 30% 20%)', marginBottom: 6 }}>
          <Download className="i16" />Software update
        </h3>
        <p className="fs12 m0" style={{ color: 'hsl(240 20% 50%)', lineHeight: 1.5 }}>
          Atlas never modifies itself. Updates are downloaded from the release feed, their
          cryptographic signature is verified against the key built into this app, and nothing is
          installed until you approve it here.
        </p>
      </div>

      {!supported && (
        <div className="gpanel fs12" style={{ padding: 14, color: 'hsl(240 20% 50%)' }}>
          Updates are managed by the Atlas desktop app. Open Atlas on your Mac to check for updates.
        </div>
      )}

      {supported && (
        <>
          <div className="fx ac jb gpanel" style={{ padding: 14 }}>
            <div>
              <p className="t14 fw6 m0" style={{ color: 'hsl(240 30% 20%)' }}>
                Atlas {currentVersion ?? '…'}
              </p>
              <p className="fs12 m0 fx ac gap6" style={{ color: 'hsl(240 20% 50%)' }}>
                <ShieldCheck className="i12" />Updates are signature-verified before install
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={check} disabled={phase === 'checking' || phase === 'downloading'}>
              <RefreshCw className={`w-4 h-4 mr-2 ${phase === 'checking' ? 'animate-spin' : ''}`} />
              {phase === 'checking' ? 'Checking…' : 'Check for updates'}
            </Button>
          </div>

          {phase === 'upToDate' && (
            <div className="gpanel fs12 fx ac gap8" style={{ padding: 14, color: 'var(--positive)' }}>
              <CheckCircle2 className="i14" />You're up to date.
            </div>
          )}

          {phase === 'error' && (
            <div className="gpanel col gap8" style={{ padding: 14, border: '1px solid hsl(0 70% 60% / .35)' }}>
              <p className="fs12 m0 fw6" style={{ color: 'var(--negative)' }}>Update check failed</p>
              <p className="fs12 m0" style={{ color: 'hsl(240 20% 50%)', lineHeight: 1.5, wordBreak: 'break-word' }}>
                {error ?? 'Unknown error'}
              </p>
              <p className="fs12 m0" style={{ color: 'hsl(240 20% 60%)' }}>
                If you're offline, try again once you're connected. Atlas keeps running on its current version.
              </p>
            </div>
          )}

          {(phase === 'available' || phase === 'downloading') && update && (
            <div className="gpanel col gap10" style={{ padding: 14 }}>
              <div className="fx ac jb">
                <div>
                  <p className="t14 fw6 m0" style={{ color: 'hsl(240 30% 20%)' }}>
                    Atlas {update.version} is available
                  </p>
                  <p className="fs12 m0" style={{ color: 'hsl(240 20% 50%)' }}>
                    You have {update.currentVersion}
                    {update.date ? ` · released ${update.date.split(' ')[0]}` : ''}
                  </p>
                </div>
                <Button size="sm" onClick={install} disabled={phase === 'downloading'}>
                  <Download className="w-4 h-4 mr-2" />
                  {phase === 'downloading' ? 'Installing…' : 'Download & install'}
                </Button>
              </div>

              {update.notes && (
                <div
                  className="fs12"
                  style={{
                    color: 'hsl(240 20% 45%)', lineHeight: 1.6, whiteSpace: 'pre-wrap',
                    maxHeight: 220, overflowY: 'auto', padding: '10px 12px',
                    background: 'hsl(240 20% 96%)', borderRadius: 10,
                  }}
                >
                  {update.notes}
                </div>
              )}

              {phase === 'downloading' && (
                <div className="col gap6">
                  <div style={{ height: 6, borderRadius: 3, background: 'hsl(240 20% 92%)', overflow: 'hidden' }}>
                    <div
                      style={{
                        height: '100%', borderRadius: 3, background: 'hsl(var(--acc))',
                        width: pct !== null ? `${pct}%` : '30%',
                        transition: 'width .2s ease',
                        ...(pct === null ? { animation: 'pulse 1.2s ease-in-out infinite' } : {}),
                      }}
                    />
                  </div>
                  <p className="fs12 m0" style={{ color: 'hsl(240 20% 55%)' }}>
                    {pct !== null
                      ? `${pct}% · ${(progress.downloaded / 1024 / 1024).toFixed(1)} MB of ${((progress.total ?? 0) / 1024 / 1024).toFixed(1)} MB`
                      : `${(progress.downloaded / 1024 / 1024).toFixed(1)} MB downloaded — verifying & installing`}
                  </p>
                </div>
              )}
            </div>
          )}

          {phase === 'installed' && (
            <div className="gpanel col gap6" style={{ padding: 14, border: '1px solid hsl(var(--acc) / .3)' }}>
              <p className="t14 fw6 m0 fx ac gap8" style={{ color: 'hsl(var(--acc))' }}>
                <CheckCircle2 className="i16" />Update installed
              </p>
              <p className="fs12 m0" style={{ color: 'hsl(240 20% 50%)', lineHeight: 1.5 }}>
                The signature was verified and the new version is ready. Quit and reopen Atlas to
                start using it.
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default SoftwareUpdatePanel;
