/**
 * The Org node's Task rail (2026-10-31, the user picked design 10 of ten: "10, but kind of make the
 * space more effective used, and also make the answer layout if there are space so user can just
 * click ... show the summay of the issue veyr clear, with potentially a more secino"). Beside the
 * chat on a wide page, so the chat keeps its full height; above it on a narrow one.
 *
 *   head     Task | Brief (a lead or Main keeps a Brief), Fold on the Brief
 *   tabs     Pinned (the tasks the user pinned to this node, org-pins.ts), then the home panel's four
 *            names with counts: Needs you, Working, Waiting / snoozed, Completed
 *   Needs you  one row per ask: its summary first, its task and when it was checked, More for the
 *              detail, and the answer right in the row (OrgInlineAnswer); Quote and Snooze small
 *   others   one row per task: its own line (user_status.line, "set by <VP>" when its lead changed it);
 *            Pinned's rows wear their own state's dot, and each row's pin pins it here or takes it off
 *   Brief    the letter its lead or Main keeps (OrgBrief)
 *   Threads  the user's own requests to it, one per subject (OrgThreads)
 *
 * A row in Needs you always says what it asks (askSummary is never empty); a node is never a bare
 * row of its own (the user: "u need to show what are actually waiting").
 */
import '@/styles/org-rail.css';
import { useEffect, useMemo, useState } from 'react';
import type { Task } from '@open-walnut/core';
import { orgDisplayTitle } from '@open-walnut/org-tree';
import { timeAgo } from '@/utils/time';
import { OrgBrief } from './OrgBrief';
import { OrgThreads } from './OrgThreads';
import type { OrgThreadsState } from './useOrgThreads';
import { OrgInlineAnswer, type AnswerFailure, type AnswerSettle } from './OrgInlineAnswer';
import { OrgAlertSnooze } from './OrgAlertSnooze';
import { holdOrder } from './hold-order';
import { writeBriefFolded, type OrgTopView } from './org-brief-model';
import type { BriefFreshness } from '@open-walnut/brief-fresh';
import { ORG_RAIL_TABS, ORG_RAIL_TAB_LABELS, TAB_DOT, rowPinNodes, stateTab, taskTabNote, type OrgRailTab, type OrgTaskTab, type OrgTaskTabs } from './org-task-tabs';
import { isPinnedTo, pinnedNodesOf } from '@open-walnut/org-tree';
import { ThreadPinIcon } from '@/components/sessions/ThreadIcons';
import { snoozeTakesOff } from '@open-walnut/user-status';
import { askSummary, lineSetBy, readStatusLine } from './org-ask-form';
import type { ChannelRow, OrgAlertView } from './org-channels-model';

/** What the rows need from the page to answer in place. */
export interface OrgAnswers {
  /** An answer leaves now: the page counts it answered (the row goes), and the settle says how it went. */
  start: (taskId: string) => AnswerSettle;
  /** The last try that failed, by task: its row is back with the reason. */
  failed: ReadonlyMap<string, AnswerFailure>;
  /** The user saw the failure. */
  seen: (taskId: string) => void;
}

export { TAB_DOT };

function TaskTabBar({ tabs, tab, onPick }: { tabs: OrgTaskTabs; tab: OrgRailTab; onPick: (tab: OrgRailTab) => void }) {
  return (
    <div className="org-task-tabs" role="tablist" aria-label="Tasks by status" data-testid="org-task-tabs">
      {ORG_RAIL_TABS.map((t) => (
        <button
          key={t}
          type="button"
          role="tab"
          aria-selected={tab === t}
          className={`org-task-tab${tab === t ? ' is-on' : ''}`}
          data-testid="org-task-tab"
          data-tab={t}
          onClick={() => onPick(t)}
        >
          {t === 'pinned' ? <ThreadPinIcon size={12} className="org-task-tab-pin" /> : <i style={{ background: TAB_DOT[t] }} />}
          {ORG_RAIL_TAB_LABELS[t]}<span className="org-task-tab-count">{tabs[t].length}</span>
        </button>
      ))}
    </div>
  );
}

/** Pin a row's task to this node, or take the pin off. */
export interface OrgPinning {
  /** The nodes this row shows (rowPinNodes): a pin here names the first, its own. */
  nodes: readonly string[];
  set: (taskId: string, pinned: boolean) => void;
}

/** The pin on a row: lit when the task is pinned to this node; a click pins it or takes it off. */
export function PinToggle({ task, pinning, className = '' }: { task: Task; pinning: OrgPinning; className?: string }) {
  const on = isPinnedTo(task, pinning.nodes);
  return (
    <button
      type="button"
      className={`org-pin-toggle${on ? ' is-on' : ''}${className ? ` ${className}` : ''}`}
      data-testid="org-pin-toggle"
      data-task-id={task.id}
      aria-pressed={on}
      aria-label={on ? `Unpin ${task.title}` : `Pin ${task.title} here`}
      title={on ? 'Pinned here. Click to unpin' : 'Pin it here, to keep it in view'}
      onClick={(e) => { e.stopPropagation(); pinning.set(task.id, !on); }}
    ><ThreadPinIcon size={13} /></button>
  );
}

const EMPTY: Record<OrgRailTab, string> = {
  pinned: 'Nothing pinned here. Pin a task with the pin on its row to keep it in view.',
  needs: 'Nothing needs you here.',
  working: 'Nothing is working here.',
  waiting: 'Nothing is waiting or snoozed here.',
  done: 'Nothing completed in the last week.',
};

/** A tab other than Needs you: one row per task, its own line, when it last moved, its pin. On
 *  Pinned each row wears the dot and the line of its own state. */
function TaskTabList({ tasks, tab, onOpen, now, pinning }: { tasks: readonly Task[]; tab: Exclude<OrgRailTab, 'needs'>; onOpen: (id: string) => void; now: number; pinning: OrgPinning }) {
  if (!tasks.length) return <p className="org-task-empty" data-testid="org-task-empty">{EMPTY[tab]}</p>;
  return (
    <ul className="org-task-list" data-testid="org-task-list" data-tab={tab}>
      {tasks.map((t) => {
        const own: OrgTaskTab = tab === 'pinned' ? stateTab(t) : tab;
        const note = taskTabNote(t, own);
        const setBy = own === 'done' ? null : lineSetBy(readStatusLine(t.user_status));
        const at = own === 'done' ? t.completed_at ?? t.updated_at : t.updated_at;
        return (
          <li key={t.id} className="org-task-item">
            <button type="button" className="org-task-row" data-testid="org-task-row" data-task-id={t.id} data-state={own} onClick={() => onOpen(t.id)} title={note ? `${t.title}\n${note}` : t.title}>
              <i style={{ background: TAB_DOT[own] }} aria-hidden="true" />
              <span className="org-task-text">
                <span className="org-task-title">{orgDisplayTitle(t)}</span>
                {note && <span className="org-task-note" data-testid="org-task-note">{note}</span>}
              </span>
              <span className="org-task-side">
                {at && <span className="org-task-time">{timeAgo(at, { now })}</span>}
                {setBy && <span className="org-set-by" data-testid="org-set-by">{setBy}</span>}
              </span>
            </button>
            <PinToggle task={t} pinning={pinning} />
          </li>
        );
      })}
    </ul>
  );
}

function AskRow({ a, task, vp, onOpen, onQuote, canQuote, answers, snoozeError, onSnoozeFailed, onSnoozeDone, pinning }: {
  pinning: OrgPinning;
  a: OrgAlertView;
  task: Task | undefined;
  vp: string | undefined;
  onOpen: (a: OrgAlertView) => void;
  onQuote: (a: OrgAlertView) => void;
  canQuote: boolean;
  answers: OrgAnswers;
  snoozeError: string | undefined;
  onSnoozeFailed: (taskId: string, error: string) => void;
  onSnoozeDone: (taskId: string) => void;
}) {
  const { summary, more } = askSummary(a);
  const [open, setOpen] = useState(false);
  const failure = answers.failed.get(a.taskId);
  // A failure belongs to the ask it answered: a new ask of the task drops it.
  const askKey = `${a.kind}|${a.source ?? ''}|${a.ask ?? ''}|${a.form?.summary ?? ''}`;
  const [failedFor, setFailedFor] = useState(failure ? askKey : '');
  useEffect(() => {
    if (!failure) return;
    if (!failedFor) { setFailedFor(askKey); return; }
    if (failedFor !== askKey) { setFailedFor(''); answers.seen(a.taskId); }
  }, [failure, failedFor, askKey, answers, a.taskId]);
  return (
    <div className="org-alert org-ask" data-testid="org-alert" data-task-id={a.taskId} data-kind={a.kind} {...(a.source ? { 'data-source': a.source } : {})}>
      {a.via && (
        // The top-level task itself, opened as a task: the subtask's letter or Board choice is not its.
        <div className="org-ask-via-line">
          <a
            className="org-ask-via"
            data-testid="org-ask-via"
            href={`/tasks/${encodeURIComponent(a.via.id)}`}
            title={`Part of ${a.via.title}`}
            onClick={(e) => { e.preventDefault(); onOpen({ ...a, taskId: a.via!.id, title: a.via!.title, source: undefined }); }}
          >{a.via.title} ›</a>
        </div>
      )}
      <div className="org-ask-summary" data-testid="org-ask-summary" title={summary}>{summary}</div>
      <div className="org-ask-meta">
        <a
          className="org-alert-link"
          data-testid="org-alert-link"
          href={`/tasks/${encodeURIComponent(a.taskId)}`}
          title={`Open ${a.title}`}
          onClick={(e) => { e.preventDefault(); onOpen(a); }}
        >{a.title}</a>
        {vp && <span className="org-ask-vp" data-testid="org-ask-vp">{vp}</span>}
        {a.checked && (
          <span className={`org-alert-checked${a.checked.unverified ? ' is-unverified' : ''}`} data-testid="org-alert-checked" data-unverified={a.checked.unverified ? '1' : '0'} title={a.checked.text}>{a.checked.text}</span>
        )}
        <span className="org-ask-tools">
          {more && (
            <button type="button" className="org-ask-tool" data-testid="org-ask-more-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Less' : 'More'}</button>
          )}
          <button
            type="button"
            className="org-ask-tool"
            data-testid="org-alert-quote"
            disabled={!canQuote}
            title={canQuote ? 'Quote it in this chat, to talk it over here' : 'Start a chat here first'}
            onClick={() => onQuote(a)}
          >Quote</button>
          {/* Only where a snooze takes the ask off the user (never a live prompt, never Main's own). */}
          {snoozeTakesOff({ state: 'needs', source: a.kind === 'question' || a.kind === 'permission' ? 'prompt' : a.source }, task?.org_role === 'main') && (
            <OrgAlertSnooze alert={a} current={task?.start_date ?? undefined} onFailed={onSnoozeFailed} onDone={onSnoozeDone} />
          )}
          {snoozeError && <span className="org-alert-snooze-error" data-testid="org-alert-snooze-error" title={snoozeError}>Snooze failed</span>}
          {task && <PinToggle task={task} pinning={pinning} className="org-ask-tool" />}
        </span>
      </div>
      {open && more && <div className="org-ask-more" data-testid="org-ask-more">{more}</div>}
      <OrgInlineAnswer alert={a} task={task} summary={summary} onAnswer={answers.start} {...(failure ? { failure } : {})} />
    </div>
  );
}

/** The asks, one row each. Under the pointer the rows keep their order and a new ask joins at the
 *  end, so a click lands on the row aimed at (as the VP list does). */
function AskList({ alerts, tasks, vpOf, onOpen, onQuote, canQuote, answers, pinning }: {
  pinning: OrgPinning;
  alerts: readonly OrgAlertView[];
  tasks: readonly Task[];
  vpOf: (taskId: string) => string | undefined;
  onOpen: (a: OrgAlertView) => void;
  onQuote: (a: OrgAlertView) => void;
  canQuote: boolean;
  answers: OrgAnswers;
}) {
  const byId = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const [held, setHeld] = useState<string[] | null>(null);
  const shown = useMemo(() => holdOrder(alerts.map((a) => ({ key: a.taskId, a })), held).map((x) => x.a), [alerts, held]);
  /** A snooze write that failed, by task. A snooze that took moves the task to Waiting / snoozed:
   *  its user status says so (src/core/user-status.ts), never this list. */
  const [snoozeFailed, setSnoozeFailed] = useState<ReadonlyMap<string, string>>(new Map());
  const onSnoozeFailed = (taskId: string, error: string) => setSnoozeFailed((m) => new Map(m).set(taskId, error));
  const onSnoozeDone = (taskId: string) => setSnoozeFailed((m) => { if (!m.has(taskId)) return m; const n = new Map(m); n.delete(taskId); return n; });
  return (
    <div className="org-alerts" data-testid="org-alerts" role="region" aria-label="Needs you"
      onPointerEnter={() => setHeld(alerts.map((a) => a.taskId))} onPointerLeave={() => setHeld(null)}>
      {shown.map((a) => (
        <AskRow key={a.taskId} a={a} task={byId.get(a.taskId)} vp={vpOf(a.taskId)} onOpen={onOpen} onQuote={onQuote} canQuote={canQuote} answers={answers} snoozeError={snoozeFailed.get(a.taskId)} onSnoozeFailed={onSnoozeFailed} onSnoozeDone={onSnoozeDone} pinning={pinning} />
      ))}
    </div>
  );
}

export function OrgTaskRail({ row, rows, tasks, tabs, alerts, tab, onTab, view, onView, keepsBrief, briefNew, briefFolded, onBriefFolded, briefFresh, briefUpdating, threads, onThreadFollowUp, contact, title, onOpenAlert, onQuote, canQuote, answers, onOpenTask, now, placement, onPin, width }: {
  row: ChannelRow;
  rows: readonly ChannelRow[];
  tasks: readonly Task[];
  tabs: OrgTaskTabs;
  /** The asks shown (the node's own ask its chat shows is left out there). */
  alerts: readonly OrgAlertView[];
  tab: OrgRailTab;
  onTab: (tab: OrgRailTab) => void;
  view: OrgTopView;
  onView: (view: OrgTopView) => void;
  keepsBrief: boolean;
  briefNew: boolean;
  briefFolded: boolean;
  onBriefFolded: (folded: boolean) => void;
  /** What moved since the Brief was written, and whether its refresh turn is on its way. */
  briefFresh: BriefFreshness | null;
  briefUpdating: boolean;
  /** The node's Threads (useOrgThreads), and a send filed under one of them (null: no chat yet). */
  threads: OrgThreadsState;
  onThreadFollowUp: ((threadId: string, text: string) => Promise<boolean>) | null;
  contact: Task | undefined;
  title: string;
  onOpenAlert: (a: OrgAlertView) => void;
  onQuote: (a: OrgAlertView) => void;
  canQuote: boolean;
  answers: OrgAnswers;
  onOpenTask: (id: string) => void;
  now: number;
  /** Beside the chat (a wide page), or above it. */
  placement: 'side' | 'top';
  /** The side rail's width (the user's, OrgNodeDetail); the CSS default otherwise. */
  width?: string;
  /** Pin a task to this node, or take the pin off. */
  onPin: (taskId: string, nodes: readonly string[], pinned: boolean) => void;
}) {
  const pinning = useMemo<OrgPinning>(() => {
    const nodes = rowPinNodes(row);
    // A pin here names the row's own node; an unpin takes every one of its nodes the task holds.
    return { nodes, set: (id, on) => onPin(id, on ? [row.key] : pinnedNodesOf(tasks.find((t) => t.id === id) ?? {}, nodes), on) };
  }, [row, tasks, onPin]);
  // On the CEO's rail each ask names the VP it is under (a VP is a label over its asks, never a row).
  const vpByTask = useMemo(() => {
    const m = new Map<string, string>();
    if (row.kind === 'main') for (const r of rows) for (const a of r.alerts) if (!m.has(a.taskId)) m.set(a.taskId, `${r.name} VP`);
    return m;
  }, [row.kind, rows]);
  const brief = keepsBrief ? contact?.brief : undefined;
  return (
    <aside className={`org-rail is-${placement}`} data-testid="org-rail" data-placement={placement} {...(width ? { style: { width } } : {})}>
      <div className={`org-top${keepsBrief ? ' has-switch' : ''}`} data-testid="org-top" data-view={view}>
        {keepsBrief && (
          <div className="org-top-switch" role="group" aria-label="Task, Brief or Threads">
            <button type="button" aria-pressed={view === 'task'} className={view === 'task' ? 'is-on' : ''} data-testid="org-top-task" onClick={() => onView('task')}>Task</button>
            <button type="button" aria-pressed={view === 'brief'} className={view === 'brief' ? 'is-on' : ''} data-testid="org-top-brief" onClick={() => onView('brief')}>
              Brief{briefNew && <i className="org-top-new" data-testid="org-top-brief-new"><span className="org-sr-only">, rewritten since you read it</span></i>}
            </button>
            <button type="button" aria-pressed={view === 'threads'} className={view === 'threads' ? 'is-on' : ''} data-testid="org-top-threads" onClick={() => onView('threads')}>Threads</button>
          </div>
        )}
        {/* Its refresh turn is on its way (core/sessions/brief-refresh.ts): the chat and the Brief are being brought up to date. */}
        {view === 'task' && briefUpdating && <span className="org-top-updating" data-testid="org-top-updating">Updating…</span>}
        {view === 'brief' && brief?.text && (
          <button type="button" className="org-top-fold" data-testid="org-brief-fold" aria-expanded={!briefFolded} onClick={() => { onBriefFolded(!briefFolded); writeBriefFolded(!briefFolded); }}>
            {briefFolded ? 'Show all' : 'Fold'}
          </button>
        )}
      </div>
      {view === 'brief' ? (
        <div className="org-rail-body">
          <OrgBrief owner={contact} tasks={tasks} name={title} onOpenTask={onOpenTask} now={now} folded={briefFolded} fresh={briefFresh} updating={briefUpdating} />
        </div>
      ) : view === 'threads' ? (
        <div className="org-rail-body">
          <OrgThreads name={title} state={threads} tasks={tasks} onOpenTask={onOpenTask} onFollowUp={onThreadFollowUp} now={now} />
        </div>
      ) : (
        <div className="org-task-view" data-testid="org-task-view" data-tab={tab}>
          <TaskTabBar tabs={tabs} tab={tab} onPick={onTab} />
          <div className="org-rail-body">
            {tab === 'needs' ? (<>
              {alerts.length > 0 && (
                <AskList alerts={alerts} tasks={tasks} vpOf={(id) => vpByTask.get(id)} onOpen={onOpenAlert} onQuote={onQuote} canQuote={canQuote} answers={answers} pinning={pinning} />
              )}
              {/* Counted in the tab: the contact's own prompt, which the chat shows. */}
              {(alerts.length < tabs.needs.length || !tabs.needs.length) && (
                <p className="org-task-empty" data-testid="org-task-empty">
                  {!tabs.needs.length ? 'Nothing needs you here.' : alerts.length ? `And ${tabs.needs.length - alerts.length} in the chat.` : 'Its ask is in the chat.'}
                </p>
              )}
            </>) : (
              <TaskTabList tasks={tabs[tab]} tab={tab} onOpen={onOpenTask} now={now} pinning={pinning} />
            )}
          </div>
        </div>
      )}
    </aside>
  );
}
