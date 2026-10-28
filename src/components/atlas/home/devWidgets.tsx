/**
 * The admin Home's developer widgets — Pull requests and Deploys from
 * `Atlas Widgets Beta.dc.html` (left-out features, row 18). The brain reads
 * the repo through this Mac's `gh` login; the faces' words come from
 * lib/betaDevWidgets.ts.
 *
 * Admin edition only: widgets.tsx loads this file lazily behind the edition
 * check, so a consumer build contains none of it.
 *
 * States, by the Widgets sheet's rules: loading until the first answer;
 * dormant (the empty face, saying what it needs) while gh is missing or
 * signed out; offline over the last good reading when GitHub or the brain
 * does not answer; attention when a pull request waits on your review or a
 * workflow's newest run failed. Tapping the card opens the repo's page on
 * GitHub, tapping a row opens that pull request or run.
 */
import { useEffect, useState } from 'react';
import { WidgetFace, type FacePreviewCopy, type FaceRow } from './WidgetFace';
import type { WidgetProps } from './widgets';
import { emptyCopy, liveFaceState } from '@/lib/betaWidgetCatalog';
import { openExternal } from '@/components/atlas-ui/answerViews/openExternal';
import { useGithubDeploys, useGithubPulls } from '@/hooks/useDevWidgets';
import { errorText } from '@/lib/betaDevTools';
import {
  deploysFace, dormantCopy, offlineText, pullsFace,
  type DevFace, type DeploysReport, type DormantCopy, type GhFailure, type PullsReport,
} from '@/lib/betaDevWidgets';

/** Relative times ("12 min ago") re-read once a minute. */
function useNow(ms = 60_000): number {
  const [t, setT] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setT(Date.now()), ms);
    return () => window.clearInterval(id);
  }, [ms]);
  return t;
}

type Ok<T> = Extract<T, { ok: true }>;

interface Query<T> { data: T | undefined; error: unknown; isLoading: boolean }

/** The newest good answer, kept across a check that failed, and what is wrong now. */
function useReading<T extends { ok: boolean; checkedAt: string }>(q: Query<T>) {
  const [kept, setKept] = useState<Ok<T> | null>(null);
  useEffect(() => {
    if (q.data?.ok) setKept(q.data as Ok<T>);
  }, [q.data]);
  const fresh = q.data?.ok ? (q.data as Ok<T>) : null;
  const failure = q.data && !q.data.ok ? (q.data as unknown as GhFailure) : null;
  return {
    good: fresh ?? kept,
    failure,
    // The brain itself did not answer: not running, signed out of Atlas, or too old to know the route.
    brainError: q.error ? errorText(q.error, 120) : null,
    loading: q.isLoading,
  };
}

interface GhFaceProps {
  p: WidgetProps;
  label: string;
  /** null until there is a good answer to draw. */
  face: DevFace | null;
  loading: boolean;
  dormant: DormantCopy | null;
  /** Why the newest check failed, while an older reading (or none) is shown. */
  offline: string | null;
  /** The widget's id in betaHome.ts, for its empty copy when the catalog forces that face. */
  id: string;
}

function GhFace({ p, label, face, loading, dormant, offline, id }: GhFaceProps) {
  const auto = !p.preview && p.autoState
    ? liveFaceState({ loading: loading && !face && !dormant, offline: face ? offline : null, attention: face?.attention ?? null })
    : undefined;
  // Dormant is the empty face wherever it is drawn: there is nothing to show until gh can answer.
  const preview = p.preview ?? (dormant ? 'empty' : auto);
  const copy: FacePreviewCopy | undefined = preview ? {
    attention: face?.attention ? { text: face.attention.text, tone: face.attention.tone, icon: face.attention.icon } : p.previewCopy?.attention,
    empty: dormant ?? p.previewCopy?.empty ?? emptyCopy(id),
    offline: offline ? { text: offline, dim: true } : p.previewCopy?.offline,
  } : undefined;
  const openUrl = face?.openUrl ?? null;
  const rows = face?.rows.map<FaceRow>((r) => {
    const url = r.url;
    return { key: r.key, title: r.title, sub: r.sub, value: r.value, valueTone: r.tone, onClick: url ? () => void openExternal(url) : undefined };
  });
  return (
    <WidgetFace
      label={label}
      size={p.size}
      delay={p.delay}
      tone={p.forceTone ?? 'paper'}
      meta={face?.meta}
      value={face ? face.value : loading ? '…' : '—'}
      delta={face?.delta}
      deltaTone={face?.deltaTone}
      sub={face ? face.sub : offline ?? undefined}
      rows={rows}
      onOpen={openUrl ? () => void openExternal(openUrl) : undefined}
      preview={preview}
      previewCopy={copy}
    />
  );
}

function offlineReason<T extends { checkedAt: string }>(r: { good: T | null; failure: GhFailure | null; brainError: string | null }, now: number): string | null {
  const reason = r.failure?.problem === 'unreachable' ? 'GitHub unreachable' : r.brainError ? `brain not answering (${r.brainError})` : null;
  return reason ? offlineText(reason, r.good?.checkedAt ?? null, now) : null;
}

export function PullRequestsWidget(p: WidgetProps) {
  const now = useNow();
  const r = useReading<PullsReport>(useGithubPulls());
  return (
    <GhFace
      p={p}
      label="Pull requests"
      face={r.good ? pullsFace(r.good, now) : null}
      loading={r.loading}
      dormant={r.failure ? dormantCopy(r.failure) : null}
      offline={offlineReason(r, now)}
      id="pullrequests"
    />
  );
}

export function DeploysWidget(p: WidgetProps) {
  const now = useNow();
  const r = useReading<DeploysReport>(useGithubDeploys());
  return (
    <GhFace
      p={p}
      label="Deploys"
      face={r.good ? deploysFace(r.good, now) : null}
      loading={r.loading}
      dormant={r.failure ? dormantCopy(r.failure) : null}
      offline={offlineReason(r, now)}
      id="deploys"
    />
  );
}

/** The one export widgets.tsx loads lazily: the developer widget for an id. */
export default function DevWidget({ id, ...p }: WidgetProps & { id: string }) {
  return id === 'deploys' ? <DeploysWidget {...p} /> : <PullRequestsWidget {...p} />;
}
