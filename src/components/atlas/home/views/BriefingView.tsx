/**
 * Briefing — one story large, the rest down the side; listen to the
 * briefing, open a story, ask Atlas why it matters.
 *
 * `useNews` for the headlines (stamped while the sample stands in). Listen
 * reads up to six stories aloud through the voice gateway (`useStreamingTTS`),
 * starting with the one on screen, so it is silent outside the desktop app
 * and says so; the sphere on the button speaks while it reads. "Why it
 * matters to you" is not written in advance — the card asks the brain
 * (`askAtlas`) when you tap it and streams the answer. Open hands the story's
 * address to the browser (`openExternal`); the sample's '#' has no Open.
 */
import { useEffect, useRef, useState } from 'react';
import { useNews } from '@/hooks/useNews';
import { useStreamingTTS } from '@/hooks/useStreamingTTS';
import { VeilSphere } from '@/components/atlas/VeilSphere';
import { AtlasIcon } from '@/components/atlas/AtlasIcon';
import { openExternal } from '@/components/atlas-ui/answerViews/openExternal';
import { askAtlas } from '@/lib/askAtlas';
import { briefingOrder, briefingText, readingMinutes, storyUrlOk, whyQuestion } from '@/lib/betaViews';

interface Why { id: string; text: string; busy: boolean; error: string | null }

export function BriefingView() {
  const { news, isFallback, isLoading } = useNews();
  const [idx, setIdx] = useState(0);
  const at = Math.min(idx, Math.max(0, news.length - 1));
  const story = news[at] ?? null;
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const tts = useStreamingTTS({ onError: (e) => setVoiceError(e.message) });
  const [why, setWhy] = useState<Why | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const reading = briefingOrder(news, at);
  const text = briefingText(reading);
  const listen = () => {
    if (tts.isPlaying) { tts.stopPlayback(); return; }
    if (!reading.length) return;
    setVoiceError(null);
    void tts.speak(text);
  };
  const ask = async () => {
    if (!story) return;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    const id = story.id;
    setWhy({ id, text: '', busy: true, error: null });
    try {
      const r = await askAtlas(whyQuestion(story), {
        signal: ac.signal,
        screen: 'briefing',
        onText: (t) => setWhy((w) => (w && w.id === id ? { ...w, text: t } : w)),
      });
      setWhy({ id, text: r.text, busy: false, error: null });
    } catch (e) {
      if (ac.signal.aborted) return;
      setWhy({ id, text: '', busy: false, error: e instanceof Error ? e.message : 'Atlas did not answer.' });
    }
  };
  const whyHere = why && story && why.id === story.id ? why : null;
  const count = reading.length;

  return (
    <section className="b-wv-brief" aria-label="Briefing">
      <article className="b-wv-story">
        {story ? (
          <>
            <span className="b-wv-eyebrow">
              Briefing · {story.category} · {story.source} · {story.time}
              {isFallback ? <span className="b-wv-stamp" title="Sample headlines — the news feed has not answered">Sample</span> : null}
            </span>
            <h1 className="b-wv-story-h">{story.title}</h1>
            <p className="b-wv-story-p">{story.description || 'The source gave no summary. Open the story to read it.'}</p>
            <div className="b-wv-why">
              <strong>Why it matters to you:</strong>{' '}
              {whyHere ? (
                whyHere.error
                  ? <><span className="b-wv-why-err">{whyHere.error}</span> <button type="button" className="b-wv-why-ask" onClick={() => void ask()}>Try again</button></>
                  : <span>{whyHere.text || 'Atlas is reading it…'}{whyHere.busy ? <i className="b-wv-caret" aria-hidden /> : null}</span>
              ) : (
                <button type="button" className="b-wv-why-ask" onClick={() => void ask()}>Ask Atlas</button>
              )}
            </div>
            <div className="b-wv-story-actions">
              <button type="button" className="b-wv-listen" onClick={listen} aria-pressed={tts.isPlaying}>
                <span className="b-wv-listen-sphere"><VeilSphere size="mini" count={2000} ink bg="#1e1e24" state={tts.isPlaying ? 'speaking' : 'idle'} /></span>
                <span className="b-wv-listen-text">
                  <span className="b-wv-listen-l">{tts.isPlaying ? 'Atlas is reading…' : 'Listen to the briefing'}</span>
                  <span className="b-wv-listen-s">
                    {tts.isPlaying
                      ? 'Tap to stop'
                      : `Atlas reads ${count === 1 ? 'this story' : `${count} stories`}, from this one, in about ${readingMinutes(text)} min`}
                  </span>
                </span>
              </button>
              {storyUrlOk(story.url) ? (
                <button type="button" className="b-btn b-wv-open" onClick={() => void openExternal(story.url)}><AtlasIcon name="open" size={16} />Open the story</button>
              ) : null}
            </div>
            {voiceError ? <p className="b-wv-err">{voiceError}</p> : null}
          </>
        ) : (
          <div className="b-wv-empty">{isLoading ? 'Fetching headlines…' : 'No headlines yet.'}</div>
        )}
      </article>
      <aside className="b-wv-stories" aria-label="Headlines">
        <span className="b-wv-stories-t">{news.length ? `${news.length} headlines` : 'Headlines'}</span>
        {news.map((n, i) => (
          <button key={n.id} type="button" className={`b-wv-story-row${story?.id === n.id ? ' on' : ''}`} onClick={() => setIdx(i)} aria-pressed={story?.id === n.id}>
            <span className="b-wv-story-row-tag">{n.category}</span>
            <span className="b-wv-story-row-t">{n.title}</span>
            <span className="b-wv-story-row-s">{n.source} · {n.time}</span>
          </button>
        ))}
      </aside>
    </section>
  );
}
