/**
 * A change link's status card (ChangePill.tsx opens it): the review on top (its state, title,
 * revision, approvals, checks and what holds it), then the deploy, one row per pipeline stage
 * (ChangeStageRows.tsx), then the way out (the review and the pipeline, opened in a new tab),
 * when it was read and Refresh. Drawn from the generic shape alone (src/core/changes/model.ts):
 * the card knows no service.
 */
import type { ChangeSnapshot } from '../../../../src/core/changes/model';
import { changePillState } from '../../../../src/core/changes/model';
import { timeAgo } from '@/utils/time';
import { ChangeStageRows } from './ChangeStageRows';
import { REVIEW_TONES, REVIEW_WORDS, reviewFacts } from './change-status';

const ERROR_WORDS: Record<NonNullable<ChangeSnapshot['error']>['code'], string> = {
  'signed-out': 'Walnut is signed out of this service.',
  'not-found': 'The service does not know this change.',
  unreachable: 'The service could not be reached.',
  failed: 'The last read failed.',
};

export function ChangeCard({ snap, taskId, refreshing, refreshError, onRefresh }: {
  snap: ChangeSnapshot; taskId: string; refreshing: boolean; refreshError: string | null; onRefresh(): void;
}) {
  const { review, deploy } = snap;
  const headTone = review ? REVIEW_TONES[review.state] : changePillState(snap).tone;
  return (
    <>
      <div className="change-card-head">
        <span className="change-card-label">{snap.label}</span>
        {review && <span className="change-card-badge" data-tone={headTone} data-testid="change-card-state">{REVIEW_WORDS[review.state]}</span>}
      </div>
      {snap.title && <div className="change-card-title" data-testid="change-card-title">{snap.title}</div>}
      {review && (
        <div className="change-card-facts" data-testid="change-card-facts">
          {reviewFacts(review).map((fact) => <span key={fact} className="change-card-fact">{fact}</span>)}
          {review.approvedBy?.length ? <span className="change-card-fact">Approved by {review.approvedBy.join(', ')}</span> : null}
        </div>
      )}
      {review?.waitingOn && <div className="change-card-waiting" data-testid="change-card-waiting">Waiting on {review.waitingOn}</div>}
      {snap.error && (
        <div className="change-card-error" role="status" data-testid="change-card-error">
          {ERROR_WORDS[snap.error.code]} {snap.error.message}
          {snap.checkedAt && <> Below is what it showed {timeAgo(snap.checkedAt, { long: true })}.</>}
        </div>
      )}
      {!snap.checkedAt && !snap.error && <div className="change-card-muted">Not read yet.</div>}
      {deploy ? (
        <section className="change-card-deploy" data-stale={snap.error ? 'true' : undefined}>
          <div className="change-card-deploy-head">
            <span className="change-card-deploy-name">{deploy.pipeline}</span>
            {deploy.commit && <code className="change-card-commit" title={deploy.commit}>{deploy.commit.slice(0, 7)}</code>}
            <span className="change-card-muted">{deploy.stages.length} {deploy.stages.length === 1 ? 'stage' : 'stages'}</span>
          </div>
          {deploy.stages.length > 0 && <ChangeStageRows stages={deploy.stages} taskId={taskId} url={snap.url} />}
        </section>
      ) : review && review.state !== 'closed' && review.state !== 'merged' ? (
        <div className="change-card-muted change-card-deploy-none">Deploy starts once it is merged.</div>
      ) : null}
      <div className="change-card-foot">
        <a href={snap.url} target="_blank" rel="noopener noreferrer" data-testid="change-card-open">Open review</a>
        {deploy?.url && <a href={deploy.url} target="_blank" rel="noopener noreferrer" data-testid="change-card-open-pipeline">Open pipeline</a>}
        <span className="change-card-muted change-card-read" data-testid="change-card-read">
          {refreshError ?? (snap.checkedAt ? `read ${timeAgo(snap.checkedAt, { long: true })}` : '')}
        </span>
        <button type="button" className="change-card-refresh" data-testid="change-card-refresh" disabled={refreshing} onClick={onRefresh}>
          {refreshing ? 'Reading…' : 'Refresh'}
        </button>
      </div>
    </>
  );
}
