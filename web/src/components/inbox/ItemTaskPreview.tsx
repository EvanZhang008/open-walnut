import { useEffect, useState } from 'react';
import { previewItemTask, type InboxTaskCandidate, type InboxTaskPreview } from '@/api/human-inbox-items';
import { PHASE_TEXT, timeText } from './item-receipt-model';

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
    <button type="button" className="hib-row-btn" onClick={onBack}>Back to tasks</button>
    <h3>{task.title}</h3>
    <p>{task.project || 'Inbox'} · {PHASE_TEXT[detail?.phase ?? task.phase] ?? task.phase}</p>
    <details><summary>Task ID</summary><code>{task.id}</code></details>
    {error ? <p>Could not load task details <button type="button" className="hib-row-btn" onClick={() => setAttempt(n => n + 1)}>Try again</button></p>
      : !detail ? <p>Loading task details…</p> : <>
        <h4>Work goal and description</h4><div className="hii-task-description">{detail.description || 'No work goal recorded'}</div>
        <h4>Recent activity</h4>
        {detail.activity?.length ? detail.activity.map((a, index) => <p key={index}>{a.text}<small>{timeText(a.at)}</small></p>) : <p>Activity unavailable</p>}
      </>}
    <button type="button" className="hib-row-btn" onClick={() => onNavigate(`/tasks/${encodeURIComponent(task.id)}`)}>Open task</button>
  </div>;
}
