import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { getLeaderPresence, subscribeLeaderPresence } from '@/api/leader-presence';
import { copyTextRobust } from '@/utils/clipboard';
import type { InboxItemAction, InboxItemReceipt, InboxLetterItem, InboxTaskCandidate } from '@/api/human-inbox-items';
import { actionText, accountText, currentTaskText, itemActions, latestReceipt, mailDateText, readHistoryText, receiptText, retryTaskAction, timeText } from './item-receipt-model';
import { useItemExecution } from './useItemExecution';
import { ItemConfirmation } from './ItemConfirmation';
import { ItemTaskSelector } from './ItemTaskSelector';
import { clearItemDraft, rememberInboxReturn, useItemDraft } from './item-drafts';

export function EmailItem({ letterId, item, duplicateLabels, canOpenMail = false, onNavigate }: {
  letterId: string; item: InboxLetterItem; duplicateLabels: ReadonlySet<string>; canOpenMail?: boolean; onNavigate: (to: string) => void;
}) {
  const { state, prepare, execute, direct, check } = useItemExecution(letterId, item);
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState('');
  const draftKey = JSON.stringify([letterId, item.id]);
  const [selector, setSelector] = useItemDraft<InboxItemAction | undefined>(draftKey, 'selector', undefined);
  const [selectorOpen, setSelectorOpen] = useItemDraft(draftKey, 'selectorOpen', false);
  const navigate = (to: string) => { rememberInboxReturn(letterId); onNavigate(to); };
  const summary = useRef<HTMLDivElement>(null);
  const [truncated, setTruncated] = useState(false);
  useLayoutEffect(() => {
    const el = summary.current;
    if (!el || expanded) return;
    const measure = () => setTruncated(el.scrollHeight > el.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure); observer.observe(el);
    return () => observer.disconnect();
  }, [item.summary, expanded]);
  const [confirmation, setConfirmation] = useItemDraft<{ actionId: string; target?: InboxTaskCandidate; retry?: InboxItemReceipt; again?: boolean } | undefined>(draftKey, 'confirmation', undefined);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const actions = itemActions(item);
  const damaged = !!item.unavailableReason || item.actions?.length > 0 && !actions.length;
  const read = latestReceipt(state.receipts, 'read');
  const task = latestReceipt(state.receipts, 'task');
  const retryAction = retryTaskAction(item, task);
  const retryLabel = task?.recovery.includes('retry_create') ? 'Review creation retry' : 'Retry start';
  const ai = latestReceipt(state.receipts, 'ai');
  const presence = useSyncExternalStore(subscribeLeaderPresence, getLeaderPresence, getLeaderPresence);
  const blocked = !presence.answers ? { code: 'primary_unavailable', message: 'Last saved status. Connect to the primary Walnut to act.' }
    : state.restrictions.find(r => ['unsupported', 'primary_unavailable', 'source_unavailable', 'item_unavailable'].includes(r.code));
  const local = state.restrictions.some(r => r.code === 'local_only');
  const readBusy = !!state.submitting.read || !!state.uncertain.read || read?.status === 'pending';
  const taskBusy = !!state.submitting.task || !!state.uncertain.task || task?.status === 'pending';
  const observation = state.readObservation ?? item.readObservation;
  const readDone = read?.status === 'success';
  const readHistory = readHistoryText(read, local || !actions.some(a => a.id === read?.actionId));
  const readNotice = blocked?.message || (local ? 'Available on Mac only' : damaged ? 'Email actions unavailable' : '');
  const readCurrent = observation ? `${observation.read ? 'Already read' : 'Unread'} · Last observed ${timeText(observation.observedAt)}` : 'Current read status unavailable';
  const readStatus = [state.submitting.read ? 'Submitting…' : readHistory, readNotice, !readNotice ? readCurrent : ''].filter(Boolean).join(' · ');
  function closeConfirm() { clearItemDraft(draftKey, 'confirm:'); setConfirmation(undefined); trigger.current?.focus({ preventScroll: true }); }
  function copySource() {
    const text = `Account: ${item.source?.account ?? 'Unavailable'}\nMessage: ${item.source?.message ?? 'Unavailable'}`;
    void copyTextRobust(text).then(result => setCopied(result === 'failed' ? 'Could not copy. Select the source text instead.' : 'Copied'));
  }
  function click(action: InboxItemAction, button: HTMLButtonElement) {
    trigger.current = button;
    if (action.kind === 'reply_ai') { void direct(action.id, `ai:${action.id}`); return; }
    if (action.intent === 'mark_read') {
      if (readDone) setConfirmation({ actionId: action.id, again: true });
      else void direct(action.id, 'read');
    } else if (action.intent === 'create_task') setConfirmation({ actionId: action.id });
    else { setSelector(action); setSelectorOpen(true); }
  }
  return <article className="hii-item" data-item-id={item.id} aria-label={item.subject}>
    <h3 className="hii-subject">{item.subject}</h3>
    <div ref={summary} className={`hii-summary${expanded ? ' hii-summary-expanded' : ''}`}>{item.summary || 'Email summary unavailable'}</div>
    {(truncated || expanded) && <button type="button" className="hib-row-btn hii-summary-toggle" aria-expanded={expanded}
      aria-label={`${expanded ? 'Show less' : 'Show more'} for ${item.subject}`} onClick={() => setExpanded(v => !v)}>{expanded ? 'Show less' : 'Show more'}</button>}
    <div className="hii-source"><span>Mail</span><span>{accountText(item, duplicateLabels)}</span>
      <span>{item.display?.sender?.name || item.display?.sender?.address || 'Sender unavailable'}</span>
      <span>{mailDateText(item.display?.sentAt)}</span>
      {canOpenMail && item.source?.account && item.source?.message && !damaged
        ? <button type="button" className="hib-row-btn" aria-label={`Open email for ${item.subject}`} title="Open this original email"
          onClick={() => onNavigate(`/mail?${new URLSearchParams({ account: item.source.account, message: item.source.message, readOnly: '1' })}`)}>Open email</button>
        : null}
    </div>
    <details className="hii-source-details"><summary>Source details</summary>
      {!canOpenMail && <p>Mail page unavailable. Copy the source below.</p>}
      <p>{item.display?.sender?.address}</p><p>Original date: {item.display?.sentAt || 'Date unavailable'}</p>
      <p>Account: <code>{item.source?.account || 'Unavailable'}</code></p><p>Message: <code>{item.source?.message || 'Unavailable'}</code></p>
      <button type="button" className="hib-row-btn" aria-label={`Copy source for ${item.subject}`} onClick={copySource}>Copy source</button>
      {copied && <p>{copied}</p>}
    </details>
    <div className="hii-actions">
      {actions.map(action => {
        const mail = action.kind === 'op' && action.intent === 'mark_read';
        const work = action.kind === 'op' && !mail;
        const aiReceipt = [...state.receipts].reverse().find(r => r.intent === 'reply_ai' && r.actionId === action.id);
        const busy = mail ? readBusy : work ? taskBusy : !!state.submitting[`ai:${action.id}`] || !!state.uncertain[`ai:${action.id}`] || aiReceipt?.status === 'pending' || aiReceipt?.status === 'success';
        const done = work && !!task && (task.status === 'success' || !!task.taskId || task.delivery === 'unconfirmed');
        const label = mail ? state.submitting.read ? 'Marking read…' : observation?.read ? 'Already read' : readDone ? 'Mark read again'
          : read?.recovery.includes('retry_mark_read') ? 'Retry mark read' : actionText(action)
          : actionText(action);
        return <button type="button" key={action.id} className={`hii-action hii-action-${mail ? 'read' : work ? 'task' : 'ai'}`}
          aria-label={`${label} for ${item.subject}`} disabled={!!blocked || !state.loaded || busy || mail && (local || !!observation?.read) || !!done}
          title={mail ? local ? 'Marking email read is only available from the console on this Mac.' : observation?.read ? 'Already read' : 'Mark only this email as read. It stays in the mailbox.'
            : action.kind === 'reply_ai' ? "Send this question to the letter's AI. No email or task operation runs." : undefined}
          onClick={e => click(action, e.currentTarget)}>{label}</button>;
      })}
    </div>
    {/* Two compact lanes keep asynchronous outcomes from moving the next item. */}
    <div className="hii-receipts" aria-live="polite" aria-atomic="true">
      <div className="hii-read-status" title={readStatus}>
        <div className={`hii-status-line${read?.status === 'failure' ? ' hii-error' : ''}`}>{state.submitting.read ? 'Submitting…' : readHistory}</div>
        {' '}
        <div className="hii-status-line">{readNotice || readCurrent}</div>
      </div>
      <div className="hii-task-lane">
        <span className={`hii-status-line${task?.status === 'failure' || state.error && state.error !== blocked?.message ? ' hii-error' : ''}`}
          title={[receiptText(task), task?.taskId ? currentTaskText(state.currentTask, state.stale) : '', state.error].filter(Boolean).join(' · ')}>
          {state.submitting.task ? 'Submitting…' : [receiptText(task), task?.taskId ? currentTaskText(state.currentTask, state.stale) : '',
            state.error !== blocked?.message ? state.error : '', state.pollExpired ? 'Still working. Check status.' : '',
            Object.entries(state.submitting).some(([key, value]) => key.startsWith('ai:') && value) ? 'Submitting…' : receiptText(ai)].filter(Boolean).join(' · ')}
        </span>
        {task?.taskId && task.taskCreated !== false && <button type="button" className="hib-row-btn hii-task-link" onClick={() => onNavigate(`/tasks/${encodeURIComponent(task.taskId!)}`)}>{task.intent === 'attach_task' && task.delivery && ['queued', 'deferred'].includes(task.delivery) ? 'Attached · Open task' : 'Open task'}</button>}
      </div>
      <span className="hii-sr-only">{item.subject}</span>
    </div>
    <div className="hii-recovery">
      <button type="button" className="hib-row-btn" onClick={() => void check()} aria-label={`Check status for ${item.subject}`}>Check status</button>
      <button type="button" className={`hib-row-btn hii-retry-slot${retryAction ? '' : ' hii-inert-slot'}`}
        tabIndex={retryAction ? 0 : -1} aria-hidden={!retryAction}
        disabled={taskBusy || !!blocked || !retryAction}
        aria-label={`${retryLabel} for ${item.subject}`} onClick={e => { if (!task || !retryAction) return; trigger.current = e.currentTarget;
          setConfirmation({ actionId: retryAction.id, retry: task }); }}>{retryLabel}</button>
      <details className="hii-receipt-details"><summary>Show details</summary>
        {readHistory && <p className="hii-read-history">{readHistory}</p>}
        <p>Current read status: {readCurrent}</p>
        {task?.taskId && <p className="hii-current-task"><strong>Current task status</strong>: {currentTaskText(state.currentTask, state.stale)}</p>}
        {item.unavailableReason && <p>Email unavailable: {item.unavailableReason}</p>}
        {blocked && <p>{blocked.message}</p>}
        {local && <p>Available on Mac only. Marking email read is only available from the console on this Mac.</p>}
        {state.error && <p className="hii-error">{state.error}</p>}
        {state.pollExpired && <p>Still working. Check status.</p>}
        {state.receipts.map(receipt => <div key={receipt.requestId}>
          <p className={receipt.status === 'failure' ? 'hii-error' : undefined}>{receiptText(receipt)} · {timeText(receipt.updatedAt)}</p>
          {receipt.reason && <p className={receipt.status === 'failure' ? 'hii-error' : undefined}>{receipt.reason}</p>}
          {receipt.input.goal && <p>Confirmed work goal: {receipt.input.goal}</p>}
          {receipt.taskId && <code>Task ID: {receipt.taskId}</code>}
        </div>)}
      </details>
    </div>
    {selector && <ItemTaskSelector open={selectorOpen} letterId={letterId} itemId={item.id} onClose={() => { setSelectorOpen(false); requestAnimationFrame(() => trigger.current?.focus({ preventScroll: true })); }} onNavigate={navigate}
      onChoose={target => { setConfirmation({ actionId: selector.id, target }); setSelectorOpen(false); }} />}
    {confirmation && <ItemConfirmation key={`${confirmation.actionId}:${confirmation.again ?? false}:${!!confirmation.retry}`}
      draftKey={draftKey} item={item} {...confirmation} submitting={confirmation.again ? !!state.submitting.read : !!state.submitting.task}
      prepare={prepare} execute={execute} onClose={closeConfirm} onNavigate={navigate}
      onFind={() => { const action = actions.find(a => a.kind === 'op' && (a.intent === 'find_task' || a.intent === 'attach_task')); if (action) { setSelector(action); setSelectorOpen(true); } }} />}
  </article>;
}
