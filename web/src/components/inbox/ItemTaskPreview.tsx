import { useEffect, useState } from 'react';
import { previewItemTask, type InboxTaskCandidate, type InboxTaskPreview } from '@/api/human-inbox-items';
import { PHASE_TEXT, timeText } from './item-receipt-model';
import { taskPath } from '@/utils/task-path';
import { lineStart } from '@/utils/time';
import { projectDisplayName } from '@/utils/project-display';
import { EmptyState, LoadingState, UnavailableState } from '@/components/common/EmptyState';

export function ItemTaskPreview({ letterId, itemId, task, onBack, onNavigate }: {
  letterId: string; itemId: string; task: InboxTaskCandidate; onBack: () => void; onNavigate: (to: string) => void;
}) {
  const [detail, setDetail] = useState<InboxTaskPreview>();
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const abort = new AbortController(); setError(false); setDetail(undefined);
    previewItemTask(letterId, itemId, task.id, abort.signal).then(next => {
      if (!abort.signal.aborted && next.id === task.id) setDetail(next);
    }).catch(() => { if (!abort.signal.aborted) setError(true); });
    return () => abort.abort();
  }, [letterId, itemId, task.id, attempt]);
  return <div className="hii-task-preview">
    <button type="button" className="btn btn-sm hib-row-btn" onClick={onBack}>Back to tasks</button>
    <h3>{task.title}</h3>
    <p>{projectDisplayName(task.project)} · {PHASE_TEXT[detail?.phase ?? task.phase] ?? task.phase}</p>
    <details><summary>Task ID</summary><code>{task.id}</code></details>
    {error ? <UnavailableState size="section" title="Couldn't load task details" onRetry={() => setAttempt(n => n + 1)} retryLabel="Try again" />
      : !detail ? <LoadingState size="section" title="Loading task details…" /> : <>
        <h4>Work goal and description</h4>{detail.description
          ? <div className="hii-task-description">{detail.description}</div>
          : <EmptyState size="row" title="No work goal recorded" />}
        <h4>Recent activity</h4>
        {detail.activity?.length ? detail.activity.map((a, index) => <p key={index}>{a.text}<small>{lineStart(timeText(a.at))}</small></p>) : <UnavailableState size="row" title="Activity unavailable" />}
      </>}
    <button type="button" className="btn btn-sm hib-row-btn" onClick={() => onNavigate(taskPath(task.id))}>Open task</button>
  </div>;
}
