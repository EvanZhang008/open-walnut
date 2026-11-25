/**
 * A change link's status card (ChangePill.tsx opens it), read top down:
 *   head      the change's name, its review state and facts, its title
 *   now       the one thing to read first (change-status.ts changeHeadline): where it stands, what
 *             holds it, and who moves it next (a person, or time), with the other stages that ask
 *             for a look under it
 *   deploy    the pipeline, its track and its stages (ChangeDeployView.tsx)
 *   foot      when it was read, Refresh, and the ways out (the review, the pipeline)
 * Drawn from the generic shape alone (src/core/changes/model.ts): the card knows no service.
 */
import { useState } from 'react';
import { useMinuteValue } from '@/utils/minute-clock';
import type { ChangeSnapshot } from '../../../../src/core/changes/model';
import { timeAgo } from '@/utils/time';
import { ChangeDeployView } from './ChangeDeployView';
import { OutIcon } from './ChangeIcons';
import { badge } from '@/components/common/badge';
import { REVIEW_TONES, REVIEW_WORDS, changeHeadline, deployIssueWords, reviewFacts } from './change-status';

const ERROR_WORDS: Record<NonNullable<ChangeSnapshot['error']>['code'], string> = {
  'signed-out': 'Walnut is signed out of this service.',
  'not-found': 'The service does not know this change.',
  unreachable: 'The service could not be reached.',
  failed: 'The last read failed.',
};

/** A read older than this says so: the watcher reads a moving change every 10 to 15 minutes, so
 *  half an hour means it missed two reads. */
const STALE_MS = 30 * 60_000;

export function ChangeCard({ snap, taskId, refreshing, refreshError, onRefresh }: {
  snap: ChangeSnapshot; taskId: string; refreshing: boolean; refreshError: string | null; onRefresh(): void;
}) {
  const { review, deploy } = snap;
  const now = changeHeadline(snap);
  const [focus, setFocus] = useState<{ stage: string; ask: number } | undefined>();
  const stale = useMinuteValue((at) => !!snap.checkedAt && at - Date.parse(snap.checkedAt) > STALE_MS);
  const facts = review ? reviewFacts(review) : [];
  if (review?.approvedBy?.length) facts.push(`by ${review.approvedBy.join(', ')}`);
  return (
    <>
      <header className="change-card-head">
        {snap.title && <div className="change-card-title wn-title" data-testid="change-card-title">{snap.title}</div>}
        <div className="change-card-head-line">
          <a className="change-card-label" href={snap.url} target="_blank" rel="noopener noreferrer" title="Open the review">{snap.label}</a>
          {review && <span className={`${badge(REVIEW_TONES[review.state] === 'blocked' ? 'error' : REVIEW_TONES[review.state] === 'waiting' ? 'warning' : 'neutral')} change-card-state`} data-tone={REVIEW_TONES[review.state]} data-testid="change-card-state"><span>{REVIEW_WORDS[review.state]}</span></span>}
          {facts.length > 0 && <span className="change-card-facts" data-testid="change-card-facts">{facts.join(' · ')}</span>}
        </div>
      </header>

      {snap.error && (
        <div className="change-card-error" role="status" data-testid="change-card-error">
          {ERROR_WORDS[snap.error.code]} {snap.error.message}
          {snap.checkedAt && <> Below is what it showed {timeAgo(snap.checkedAt, { long: true })}.</>}
        </div>
      )}

      {!snap.error && snap.deployIssue && deploy && (
        <div className="change-card-error" role="status" data-testid="change-card-deploy-issue">
          {deployIssueWords(snap.deployIssue)}. Below is the last deploy it read.
        </div>
      )}

      {snap.checkedAt ? (
        <section className="change-card-now" data-tone={now.tone} data-testid="change-card-now">
          <div className="change-card-now-title">{now.title}</div>
          {now.detail && <div className="change-card-now-detail" data-testid="change-card-now-detail">{now.detail}</div>}
          {now.next && (
            <div className="change-card-next-row">
              <span className="change-card-next" data-person={now.next.person ? 'true' : undefined} data-testid="change-card-next">{now.next.text}</span>
              {now.stage && now.next.person && deploy && (
                <button type="button" className="change-card-action" data-testid="change-card-look" onClick={() => setFocus((f) => ({ stage: now.stage!, ask: (f?.ask ?? 0) + 1 }))}>
                  Open {now.stage}
                </button>
              )}
            </div>
          )}
          {!deploy && review && review.state !== 'closed' && review.state !== 'merged' && (
            <div className="change-card-next-row">
              <span className="change-card-now-sub">Deploy starts once it is merged</span>
              <a className="change-card-action" href={snap.url} target="_blank" rel="noopener noreferrer" data-testid="change-card-open-review">Open review <OutIcon /></a>
            </div>
          )}
          {now.also.length > 0 && (
            <div className="change-card-also">
              <span className="change-card-also-label">Meanwhile</span>
              <ul>{now.also.map((line) => <li key={line}>{line}</li>)}</ul>
            </div>
          )}
        </section>
      ) : !snap.error && <div className="change-card-now change-card-muted">Not read yet</div>}

      {deploy && <ChangeDeployView deploy={deploy} taskId={taskId} url={snap.url} stale={!!snap.error || !!snap.deployIssue} focus={focus} now={now.stage} />}

      <footer className="change-card-foot">
        <span className="change-card-read" data-stale={stale ? 'true' : undefined} data-testid="change-card-read">
          {refreshError ?? (snap.checkedAt ? `Read ${timeAgo(snap.checkedAt, { long: true })}` : '')}
        </span>
        <button type="button" className="change-card-refresh" data-testid="change-card-refresh" disabled={refreshing} onClick={onRefresh}>
          {refreshing ? 'Reading…' : 'Refresh'}
        </button>
        <span className="change-card-links">
          {deploy?.url && <a href={deploy.url} target="_blank" rel="noopener noreferrer" data-testid="change-card-open-pipeline">Pipeline <OutIcon /></a>}
          {(deploy || review?.state === 'closed' || review?.state === 'merged') && <a href={snap.url} target="_blank" rel="noopener noreferrer" data-testid="change-card-open">Review <OutIcon /></a>}
        </span>
      </footer>
    </>
  );
}
