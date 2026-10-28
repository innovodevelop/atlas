/**
 * The Entry scene — the two-column page both Beta entry screens are drawn on
 * (`Atlas Entry Beta.dc.html`): the blue aside with the sphere and one line
 * about what leaves this Mac, and the paper main with Atlas's line typing in
 * above whatever the step asks for.
 *
 * The sphere is this screen's talk entry point (handoff `atlas-orb.js`: the
 * page's header sphere is used when there is one), so it registers on the
 * talk bus and the shell's 128 px orb stays hidden — it would otherwise sit
 * on top of the blue aside. Whether tapping it opens Talk is the caller's
 * call (`onSphere`): signed out there is nobody for the brain to answer, so
 * the sign-in screen leaves it as a picture rather than a button that can
 * only say "sign in first".
 *
 * The design draws its own "Atlas" wordmark at the top of the aside; under
 * the Beta shell the top bar already carries one, so the aside leaves that
 * row to the bar. The design's voice toggle is not here either: the Beta
 * entry does not speak (see useTypewriter.ts), so a control to silence it
 * would be a control that does nothing.
 */
import { useEffect, useState, type MouseEvent, type ReactNode } from 'react';
import type { QuickSphereState } from '@/lib/quickSphere';
import { setTalkAnchor } from '@/lib/talkBus';
import { EntrySphere } from './EntrySphere';

export interface EntryStep { label: string; state: 'done' | 'current' | 'todo' }

export interface EntrySceneProps {
  /** Which entry screen, for the page-level styles (`.b-en--auth`, `.b-en--onboarding`). */
  variant: 'auth' | 'onboarding';
  screenLabel: string;
  /** The aside's small uppercase line and the sentence under it. */
  kicker: string;
  line: string;
  /** Omit to follow the state bus. */
  sphereState?: QuickSphereState;
  /** Tapping the sphere: Talk to Atlas. Omit and the sphere is not a control. */
  onSphere?: () => void;
  /** The progress bar above the headline (onboarding only). */
  steps?: EntryStep[];
  eyebrow: string;
  /** The line Atlas is saying: the characters so far, the whole line, and whether it is still arriving. */
  said: string;
  target: string;
  typing: boolean;
  sub: string;
  children: ReactNode;
}

/**
 * Legal pages live on the marketing site; open them in the system browser
 * (the Tauri webview should not navigate away from the app). Falls back to a
 * new tab when running as a plain web page.
 */
async function openLegal(e: MouseEvent, url: string) {
  e.preventDefault();
  try {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(url);
  } catch {
    window.open(url, '_blank', 'noopener');
  }
}

export function EntryScene({ variant, screenLabel, kicker, line, sphereState, onSphere, steps, eyebrow, said, target, typing, sub, children }: EntrySceneProps) {
  const [sphereEl, setSphereEl] = useState<HTMLDivElement | null>(null);
  useEffect(() => { setTalkAnchor(sphereEl); return () => setTalkAnchor(null); }, [sphereEl]);

  return (
    // Declared paper: the shell would otherwise measure the tone from the
    // first opaque background it meets, and the blue aside must not flip the
    // top bar to its on-ink colours over the paper column.
    <div className={`b-en b-en--${variant}`} data-screen-label={screenLabel} data-beta-tone="paper">
      <aside className="b-en-aside">
        <div className="b-en-stage">
          <div className="b-en-sphere" ref={setSphereEl}>
            <EntrySphere state={sphereState} />
            {onSphere ? (
              <button type="button" className="b-en-sphere-talk" aria-label="Talk to Atlas" title="Talk to Atlas · ⌥ Space" onClick={onSphere} />
            ) : null}
          </div>
        </div>
        <div className="b-en-aside-text">
          <span className="b-en-kicker">{kicker}</span>
          <p className="b-en-line">{line}</p>
        </div>
      </aside>

      <main className="b-en-main nosb">
        {steps ? (
          <ol className="b-en-steps" aria-label="Onboarding progress">
            {steps.map((s) => (
              <li key={s.label} className={`b-en-step b-en-step--${s.state}`} aria-current={s.state === 'current' ? 'step' : undefined}>
                <span className="b-en-step-bar" />
                <span className="b-en-step-label">{s.label}</span>
              </li>
            ))}
          </ol>
        ) : null}

        <div className="b-en-body">
          <div className="b-en-head">
            <span className="b-eyebrow">{eyebrow}</span>
            {/* The heading carries the whole line for assistive tech at once;
                the characters arriving two at a time are decoration, hidden
                from it. The status region below announces the line once,
                when it has landed — a live region on the typing itself would
                read it out a fragment at a time. */}
            <h1 className="b-en-h1">
              <span className="b-en-sr">{target}</span>
              <span aria-hidden>
                {said}
                <span className={`b-en-caret${typing ? ' on' : ''}`} />
              </span>
            </h1>
            <p className="b-en-sr" role="status">{typing ? '' : target}</p>
            <p className="b-en-sub">{sub}</p>
          </div>
          {children}
        </div>

        <footer className="b-en-foot">
          <span>helloatlas.dk</span>
          <span className="b-en-foot-links">
            <a href="https://helloatlas.dk/terms" onClick={(e) => void openLegal(e, 'https://helloatlas.dk/terms')}>Terms</a>
            <a href="https://helloatlas.dk/privacy" onClick={(e) => void openLegal(e, 'https://helloatlas.dk/privacy')}>Privacy</a>
          </span>
        </footer>
      </main>
    </div>
  );
}
