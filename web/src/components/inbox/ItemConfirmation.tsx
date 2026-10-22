import { useEffect, useId, useRef, useState } from 'react';
import { useOverlayLayer } from '@/hooks/useOverlayLayer';
import { getLeaderPresence, subscribeLeaderPresence } from '@/api/leader-presence';
import { useSyncExternalStore } from 'react';
import type { InboxFrozenInput, InboxItemPlan, InboxItemPrepareResponse, InboxLetterItem, InboxTaskCandidate, InboxItemReceipt } from '@/api/human-inbox-items';
import { itemError } from '@/api/human-inbox-items';
import { ItemOperationDetails } from './ItemOperationDetails';
import { PHASE_TEXT, mailDateText } from './item-receipt-model';
import { useItemDraft } from './item-drafts';

export function ItemConfirmation({ draftKey, item, actionId, target, retry, again, submitting, prepare, execute, onClose, onFind, onNavigate }: {
  draftKey: string; item: InboxLetterItem; actionId: string; target?: InboxTaskCandidate; retry?: InboxItemReceipt; again?: boolean; submitting: boolean;
  prepare: (id: string, input?: InboxFrozenInput, signal?: AbortSignal) => Promise<InboxItemPrepareResponse>;
  execute: (plan: InboxItemPlan, lane: string) => Promise<unknown>;
  onClose: () => void; onFind: () => void; onNavigate: (to: string) => void;
}) {
  const presence = useSyncExternalStore(subscribeLeaderPresence, getLeaderPresence, getLeaderPresence);
  const root = useRef<HTMLDivElement>(null);
  const goalId = useId();
  const generation = useRef(0);
  const acknowledgedExisting = useRef(false);
  const field = `confirm:${JSON.stringify([actionId, !!retry, !!again])}:`;
  const [title, setTitle] = useItemDraft(draftKey, `${field}title`, retry?.input.title ?? item.subject.slice(0, 120));
  const [goal, setGoal] = useItemDraft(draftKey, `${field}goal`, retry?.input.goal ?? '');
  const [project, setProject] = useItemDraft(draftKey, `${field}project`, retry?.input.project ?? '');
  const [response, setResponse] = useState<InboxItemPrepareResponse>();
  const [plan, setPlan] = useState<InboxItemPlan>();
  const [previousPlan, setPreviousPlan] = useState<InboxItemPlan>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [submitted, setSubmitted] = useState(false);
  const [checked, setChecked] = useState(false);
  const attach = !!target || retry?.intent === 'attach_task';
  const retryCreate = !!retry?.recovery.includes('retry_create');
  const heading = again ? 'Mark read again' : retryCreate ? 'Review creation retry' : retry ? 'Retry start' : attach ? 'Attach to task'
    : response?.existingWork?.status === 'saved' ? 'Review and start existing task' : 'Create and start task';
  const pageRef = useRef<HTMLElement | null>(typeof document === 'undefined' ? null : document.body);
  useOverlayLayer({ open: !submitted, refs: [pageRef], trapFocus: false,
    onClose: reason => { if (reason === 'escape' && !submitting) onClose(); } });
  useEffect(() => {
    const gen = ++generation.current; const abort = new AbortController();
    setLoading(true); setPlan(undefined); setError('');
    const timer = setTimeout(() => {
      const input: InboxFrozenInput = again ? { markReadAgain: true }
        : !checked ? {} : { goal, title, project,
          ...(target ? { selectedTaskId: target.id } : retry?.input.selectedTaskId ? { selectedTaskId: retry.input.selectedTaskId } : {}),
          ...(retry && !retryCreate ? { retryStart: true } : {}) };
      prepare(actionId, input, abort.signal).then(next => {
        if (abort.signal.aborted || gen !== generation.current) return;
        setResponse(next); setPlan(next.plan); setChecked(true);
        if (next.existingWork?.status === 'confirmed' && !acknowledgedExisting.current && !retry) {
          acknowledgedExisting.current = true;
          setGoal(next.existingWork.goal ?? '');
        }
      }).catch(err => { if (!abort.signal.aborted && gen === generation.current) setError(itemError(err).message); })
        .finally(() => { if (gen === generation.current) setLoading(false); });
    }, checked ? 200 : 0);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [actionId, prepare, target?.id, retry, retryCreate, again, goal, title, project, checked, attempt]);
  function change(set: (value: string) => void, value: string) {
    generation.current++; setPreviousPlan(plan); setPlan(undefined); setResponse(old => old && ({ ...old, restrictions: [] })); set(value); setSubmitted(false);
  }
  async function confirm() {
    if (!plan || submitting || submitted) return;
    setSubmitted(true); setError('');
    try { await execute(plan, again ? 'read' : 'task'); }
    catch (err) { setError(itemError(err).message); setPlan(undefined); setSubmitted(false); }
  }
  const restriction = response?.restrictions.find(r => r.code !== 'goal_required');
  const work = response?.existingWork;
  const workLocked = !!work && ['confirmed', 'deleted', 'unavailable'].includes(work.status) && !retry;
  return <div className="hii-confirm" ref={root} aria-label={`${heading} for ${item.subject}`}>
    <h3>{heading}</h3>
    <div className="hii-confirm-source"><strong>Source email</strong><p>{item.subject}</p>
      <p>{item.display?.sender?.name || item.display?.sender?.address || 'Sender unavailable'} · {mailDateText(item.display?.sentAt)}</p>
      <p>{item.display?.accountLabel || 'Account label unavailable'} {item.display?.accountHint}</p>
    </div>
    {work && <div className="hii-existing"><strong>Existing task: {work.task?.title ?? 'Task title unavailable'}</strong>
      {work.task && <p>{work.task.project || 'Inbox'} · {PHASE_TEXT[work.task.phase] ?? work.task.phase}</p>}
      {!retry && work.goal && <p>Confirmed work goal: {work.goal}</p>}
      {!retry && work.task?.description && <p>{work.task.description}</p>}
      <button type="button" className="hib-row-btn" onClick={() => onNavigate(`/tasks/${encodeURIComponent(work.taskId)}`)}>Open existing task</button>
    </div>}
    {target && <div><strong>Selected task</strong><p>{target.title}</p>
      <p>{target.project || 'Inbox'} · {PHASE_TEXT[target.phase] ?? target.phase}</p>
      <button type="button" className="hib-row-btn" onClick={onFind} disabled={submitting || submitted}>Choose another task</button></div>}
    {!again && !attach && !retry && !work && <>
      <label>Task title<input value={title} readOnly={submitting || submitted} onChange={e => change(setTitle, e.target.value)} /></label>
      <label>Project</label><div className="hii-projects" role="group" aria-label="Project">
        {(response?.projects ?? [{ name: '' }]).map(p => <button type="button" key={p.name} aria-pressed={project === p.name}
          className="hib-row-btn" disabled={submitting || submitted} onClick={() => change(setProject, p.name)}>{p.name || 'Inbox'}</button>)}
      </div>
    </>}
    {!again && <label htmlFor={goalId}>Work goal<textarea id={goalId} aria-label="Work goal" rows={3} value={goal} readOnly={submitting || submitted || !!retry || workLocked}
      onChange={e => change(setGoal, e.target.value)} /></label>}
    {!again && !goal.trim() && <p>Add a work goal before continuing.</p>}
    <p>{again ? 'Set this email to read again. The previous receipt is kept.'
      : retryCreate ? 'Retry the original task identity and work goal. A second task will not be created.'
      : retry?.code === 'start_recovery_required' ? 'The previous start is unconfirmed. Confirming cancels that pending start on its host before retrying this same task.'
      : retry ? 'Start the existing task. No new task will be created.'
      : plan?.ops.some(op => op.tool === 'task_send') ? "This sends work to the selected task's conversation."
      : attach || work ? 'This starts work on the selected task.' : 'This creates one task and starts work. Only this email is linked.'}</p>
    {retry && plan?.launch && <p>Fresh launch: {['', 'local', '__local__'].includes(plan.launch.host) ? 'On this Mac' : 'On the configured execution host'}. Review the resolved settings in Operation details.</p>}
    {loading && <p>Preparing action…</p>}
    {restriction && <p className="hii-error">{restriction.message}</p>}
    {error && <p className="hii-error">{error} <button type="button" className="hib-row-btn" onClick={() => setAttempt(n => n + 1)}>Try again</button></p>}
    {plan && <ItemOperationDetails plan={plan} previous={previousPlan} />}
    <div className="hii-confirm-footer">
      <button type="button" className="hib-row-btn" onClick={onClose} title={submitted ? 'Close this view. Submitted work continues.' : undefined}>{submitted ? 'Close' : 'Cancel'}</button>
      <button type="button" className="hib-send-btn" disabled={!presence.answers || !plan || loading || !!restriction || !again && !goal.trim() || submitted || submitting}
        onClick={() => void confirm()}>{submitting ? again ? 'Marking read…' : attach ? 'Attaching…' : 'Creating…'
          : submitted ? 'Submitted' : again ? 'Confirm mark read' : attach ? 'Confirm attachment' : 'Confirm and start'}</button>
    </div>
  </div>;
}
