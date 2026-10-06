/**
 * One kanban card's view model (spec 6): title, ticket and sev chips, the live
 * status line (the 6 item 3 table), the summary that is newer, the waiting on
 * line (wait lanes only), the foot (last activity, stale, changed, unread)
 * and the leader's suggestion. Pure: no React, no DOM. Unit-pinned in
 * tests/web/kanban-model.test.ts.
 */
import type { Task } from '@open-walnut/core';
import {
  displayedSummary, laneById, placeCard, summaryHash,
  type BoardCard, type BoardCardWriter, type BoardKanbanSeenCard, type BoardLane, type BoardTeamEntry,
} from '../../../../../src/core/boards/board-lanes';
import { deriveDisplayStatus, resolveTaskSessionId } from '@/utils/session-status';
import type { ProcessStatus } from '@/types/session';
import type { BoardSignal, LiveStatus } from '../board-overview-model';
import type { KanbanPromptRequest } from './kanban-contract';
import { STALE_AFTER_MS } from './kanban-contract';
import { absoluteText, agoText, clockText, durationText, latestIso } from './kanban-time';
import { cardChange, cutTitle, footOf, writerLead, writerText, type KanbanCardChange, type KanbanFootChange } from './kanban-changes-model';

/** What the session-status store knows, plus the open prompt's request (G3). */
export type KanbanLive = LiveStatus & {
  pendingPermissionRequestId?: string | null;
  pendingPermissionDetail?: string | null;
  sessionId?: string | null;
};

export type KanbanTone = 'red' | 'amber' | 'green' | 'violet' | 'grey';

export type KanbanStatusKind =
  | 'question' | 'plan' | 'permission' | 'error' | 'handed-back' | 'board-signal' | 'worker-below'
  | 'still-open' | 'turn-ended' | 'running' | 'waiting-until' | 'waiting' | 'done' | 'idle' | 'stopped'
  | 'no-session' | 'loading';

export interface KanbanStatus {
  text: string;
  tone: KanbanTone;
  kind: KanbanStatusKind;
  tooltip: string;
  /** A prompt the card answers in place (this task's, or a nested worker's). */
  prompt?: KanbanPromptRequest;
  /** A red board signal: where its click goes on the Page. */
  signalTarget?: { kind: 'choice' | 'thread'; id: string };
}

export interface KanbanCardSummary {
  text: string;
  source: 'card' | 'task';
  at?: string;
  /** `From the leader, 15:02` / `From the worker, 14:10` under the full text. */
  tooltip: string;
}

export interface KanbanCardWaiting {
  kind: 'text' | 'add-who' | 'parked';
  text?: string;
  /** formatWaitUntil of a WAITING task's wait_until. */
  until?: string;
}

export interface KanbanCardFoot {
  activeText: string;
  activeTooltip: string;
  /** `Stale 3d`, or `Waiting 3d` in a wait lane. */
  stale?: string;
  staleTooltip?: string;
  changed?: KanbanFootChange;
  unread: boolean;
}

export interface KanbanSuggestion {
  lane: string;
  laneName: string;
  by: string;
  at: string;
  /** `Leader suggests Mitigating`. */
  text: string;
}

export interface KanbanCardVM {
  taskId: string;
  title: string;
  ticket?: { tag: string; value: string };
  /** The `sev:` value ('1', '2', ...). */
  sev?: string;
  /** Open subtasks, when this card is itself a leader (`Leader · N`). */
  leaderCount?: number;
  lane: string;
  laneKind: BoardLane['kind'] | '';
  source: 'explicit' | 'auto';
  completedAfterMove: boolean;
  /** Valid only for the lane shown (rank_lane == lane). */
  rank?: number;
  status: KanbanStatus;
  needsYou: boolean;
  running: boolean;
  activity: string;
  hasSession: boolean;
  sessionId?: string;
  isComplete: boolean;
  summary?: KanbanCardSummary;
  waiting?: KanbanCardWaiting;
  foot: KanbanCardFoot;
  /** Changed since the user last looked (8.4): drives the `Changed` chip. */
  changed: boolean;
  change?: KanbanCardChange;
  suggestion?: KanbanSuggestion;
  createdAt: string;
  /** For the done lane order: max(completed_at, lane_at). */
  doneAt: string;
  /** The store has not delivered the task yet: a title-only skeleton keeping its lane. */
  loading: boolean;
  /** What the "seen" baseline stores for this card. */
  snapshot: BoardKanbanSeenCard;
}

/** A nested worker's red reason, rolled up into its direct parent's card. */
export interface KanbanNestedNeed {
  taskId: string;
  title: string;
  text: string;
  prompt?: KanbanPromptRequest;
}

export interface KanbanCardInput {
  taskId: string;
  /** null = the store has not delivered it yet. */
  task: Task | null;
  entry?: BoardTeamEntry;
  card?: BoardCard | null;
  lanes: readonly BoardLane[];
  live: KanbanLive | null;
  /** This task's own board signals (unanswered choice, due reminder, new thread message). */
  signals?: readonly BoardSignal[];
  nested?: KanbanNestedNeed | null;
  openSubtasks?: number;
  ownerId: string;
  titleOf: (id: string) => string;
  /** The card's baseline entry; `hasBaseline` false = the user never looked (nothing is changed). */
  baseline?: BoardKanbanSeenCard;
  hasBaseline: boolean;
  baselineAt?: string | null;
  now: number;
  formatWaitUntil?: (iso: string) => string;
  /** Is this page element id a choice (else a thread)? For a reminder's click target. */
  isChoice?: (id: string) => boolean;
  /** R3-02: this user's own phase write (Complete, Reopen, Undo) is pending: an automatic move is theirs. */
  humanPhase?: boolean;
}

const defaultWaitUntil = (iso: string) => new Date(iso).toLocaleString();

export function tagValue(tags: readonly string[] | undefined, ...keys: string[]): { tag: string; value: string } | undefined {
  for (const tag of tags ?? []) {
    const i = tag.indexOf(':');
    if (i <= 0) continue;
    const k = tag.slice(0, i).trim().toLowerCase();
    const v = tag.slice(i + 1).trim();
    if (v && keys.includes(k)) return { tag, value: v };
  }
  return undefined;
}

function firstLine(s: string | null | undefined): string {
  return (s ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
}

function permissionStatus(tool: string, detail: string | undefined): Pick<KanbanStatus, 'text' | 'kind' | 'tooltip'> {
  const kind: KanbanStatusKind = tool === 'AskUserQuestion' ? 'question' : tool === 'ExitPlanMode' ? 'plan' : 'permission';
  const text = kind === 'question' ? 'Needs you: question' : kind === 'plan' ? 'Needs you: approve plan' : `Needs you: approve ${tool}`;
  // N24: a question names itself when its text is known; else the tooltip says how to read it.
  const fallback = kind === 'question' ? 'Needs you: a worker asked a question. Click to read it and answer.' : text;
  return { text, kind, tooltip: detail ? (kind === 'question' ? `Question: ${detail}` : `${tool}: ${detail}`) : fallback };
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** A card's board signals in the status line's words: `1 unanswered choice`. */
export function kanbanSignalText(signals: readonly BoardSignal[]): string {
  if (signals.length === 0) return '';
  const first = signals[0];
  const same = signals.filter((s) => s.kind === first.kind);
  if (first.kind === 'reminder') return plural(same.length, 'reminder due', 'reminders due');
  if (first.kind === 'choice') return plural(same.length, 'unanswered choice', 'unanswered choices');
  return plural(same.reduce((n, s) => n + s.count, 0), 'new message', 'new messages');
}

/**
 * The red reason of a task, or null: a prompt, an error, a hand back (the
 * worker moved its own task to NEED_ACTION after the last message into it),
 * a board signal. Shared by a card and the nested workers rolled into it.
 */
export function redReasonOf(
  task: Task,
  live: KanbanLive | null,
  card: BoardCard | null | undefined,
  signals: readonly BoardSignal[] = [],
  isChoice?: (id: string) => boolean,
): KanbanStatus | null {
  const done = task.phase === 'COMPLETE';
  const sessionId = resolveTaskSessionId(task) ?? undefined;
  const ps = (sessionId ? live?.process_status : undefined) as ProcessStatus | undefined;
  const tool = live?.pendingPermissionTool || '';
  const display = ps ? deriveDisplayStatus(ps, tool ? { requestId: tool } : null) : null;
  if (display === 'waiting') {
    const detail = live?.pendingPermissionDetail || undefined;
    const prompt: KanbanPromptRequest = {
      sessionId: live?.sessionId || sessionId || '', toolName: tool,
      ...(live?.pendingPermissionRequestId ? { requestId: live.pendingPermissionRequestId } : {}),
      ...(detail ? { detail } : {}),
    };
    return { ...permissionStatus(tool, detail), tone: 'red', prompt };
  }
  if (display === 'error' && !done) { // an error after the work completed is not the user's to fix
    const msg = firstLine(live?.errorMessage);
    const text = msg ? `Error: ${msg}` : 'Error: the session stopped';
    return { text, tone: 'red', kind: 'error', tooltip: live?.errorMessage?.trim() || text };
  }
  const handedBack = card?.handed_back_at;
  if (task.phase === 'NEED_ACTION' && handedBack && (!task.last_session_update || Date.parse(handedBack) > Date.parse(task.last_session_update))) {
    return { text: 'Needs you: handed back', tone: 'red', kind: 'handed-back', tooltip: 'The worker handed this task back to you' };
  }
  if (signals.length > 0) {
    const first = signals[0];
    const kind: 'choice' | 'thread' = first.kind === 'reminder' ? (isChoice?.(first.id) ? 'choice' : 'thread') : first.kind;
    const text = `Needs you: ${kanbanSignalText(signals)}`;
    return { text, tone: 'red', kind: 'board-signal', tooltip: [text, ...signals.map((s) => s.title || s.id)].join('\n'), signalTarget: { kind, id: first.id } };
  }
  return null;
}

function capitalize(s: string): string {
  const a = s.trim();
  return a ? a.charAt(0).toUpperCase() + a.slice(1) : '';
}

function liveDisplay(hasSession: boolean, live: KanbanLive | null): ReturnType<typeof deriveDisplayStatus> | null {
  const ps = (hasSession ? live?.process_status : undefined) as ProcessStatus | undefined;
  if (!ps) return null;
  const tool = live?.pendingPermissionTool || '';
  return deriveDisplayStatus(ps, tool ? { requestId: tool } : null);
}

/** The status line when no red reason holds (the rest of the 6 item 3 table). */
function quietStatus(
  task: Task, live: KanbanLive | null, hasSession: boolean, laneKind: string, now: number, fmt: (iso: string) => string,
): KanbanStatus {
  const display = liveDisplay(hasSession, live);
  const at = (verb: string, iso: string | null | undefined, tone: KanbanTone, kind: KanbanStatusKind): KanbanStatus => {
    const text = agoText(verb, iso, now) || verb;
    const abs = absoluteText(iso);
    return { text, tone, kind, tooltip: abs ? `${text}\n${abs}` : text };
  };
  if (laneKind === 'done' && task.phase !== 'COMPLETE') {
    return { text: 'Task still open', tone: 'amber', kind: 'still-open', tooltip: 'This card is in a done lane, but its task is not complete' };
  }
  if (task.phase === 'NEED_ACTION' && hasSession && display !== 'running') {
    return at('Turn ended', task.phase_changed_at || live?.statusUpdatedAt, 'amber', 'turn-ended');
  }
  if (display === 'running') {
    const activity = capitalize(live?.activity ?? '');
    const text = activity ? `Running: ${activity}` : 'Running';
    return { text, tone: 'green', kind: 'running', tooltip: text };
  }
  if (task.phase === 'WAITING') {
    if (task.wait_until) {
      const text = `Waiting until ${fmt(task.wait_until)}`;
      return { text, tone: 'violet', kind: 'waiting-until', tooltip: `${text}\n${absoluteText(task.wait_until)}` };
    }
    return { text: 'Waiting', tone: 'violet', kind: 'waiting', tooltip: 'Waiting until something happens' };
  }
  if (task.phase === 'COMPLETE') return at('Done', task.completed_at, 'green', 'done');
  if (display === 'idle') return at('Idle', live?.statusUpdatedAt, 'amber', 'idle');
  if (hasSession) return { text: 'Stopped', tone: 'grey', kind: 'stopped', tooltip: 'The session is not running' };
  return { text: 'No session', tone: 'grey', kind: 'no-session', tooltip: 'No session yet' };
}

/** The whole status line of a card (spec 6 item 3): red reasons first, then the quiet rows. */
export function cardStatus(
  task: Task, live: KanbanLive | null, card: BoardCard | null | undefined, laneKind: string,
  opts: { signals?: readonly BoardSignal[]; nested?: KanbanNestedNeed | null; now: number; formatWaitUntil?: (iso: string) => string; isChoice?: (id: string) => boolean },
): KanbanStatus {
  const red = redReasonOf(task, live, card, opts.signals ?? [], opts.isChoice);
  if (red) return red;
  const hasSession = !!resolveTaskSessionId(task);
  const n = opts.nested;
  if (n) {
    const prompt = n.prompt ? { ...n.prompt, fromTaskId: n.taskId, fromTitle: n.title } : undefined;
    return { text: 'Needs you: worker below', tone: 'red', kind: 'worker-below', tooltip: `${n.title}: ${n.text}`, ...(prompt ? { prompt } : {}) };
  }
  return quietStatus(task, live, hasSession, laneKind, opts.now, opts.formatWaitUntil ?? defaultWaitUntil);
}

/** One card's view model. A task the store has not delivered yet is a loading card that keeps its lane. */
/** The tooltip line of a card that completed after it was placed in another lane. */
export function completedHereText(laneName: string): string {
  return `Completed after it was placed in ${laneName}, so it moved here`;
}

export function buildCardVM(i: KanbanCardInput): KanbanCardVM {
  const { task, card, lanes, now } = i;
  const fmt = i.formatWaitUntil ?? defaultWaitUntil;
  const phase = task?.phase ?? i.entry?.phase ?? '';
  const completedAt = task?.completed_at ?? i.entry?.completed_at;
  const sessionId = task ? resolveTaskSessionId(task) ?? undefined : undefined;
  const hasSession = !!sessionId;
  const hasHadSession = hasSession || (task?.session_ids?.length ?? 0) > 0;
  const placed = placeCard(card, { phase, completed_at: completedAt, hasHadSession }, lanes);
  const laneKind: KanbanCardVM['laneKind'] = laneById(lanes, placed.lane)?.kind ?? '';
  const isComplete = phase === 'COMPLETE';
  const rank = card?.rank !== undefined && card.rank_lane === placed.lane ? card.rank : undefined;
  const doneAt = latestIso(completedAt, card?.lane_at);
  const createdAt = task?.created_at ?? '';
  const base = {
    taskId: i.taskId, lane: placed.lane, laneKind, source: placed.source, completedAfterMove: placed.completedAfterMove,
    ...(rank !== undefined ? { rank } : {}), isComplete, createdAt, doneAt,
  };
  if (!task) {
    return {
      ...base, title: i.titleOf(i.taskId) || '', loading: true, needsYou: false, running: false, activity: '',
      hasSession: false, changed: false,
      status: { text: 'Loading', tone: 'grey', kind: 'loading', tooltip: 'Loading this task' },
      foot: { activeText: '', activeTooltip: '', unread: false },
      snapshot: { lane: placed.lane, summaryHash: '' },
    };
  }
  const live = i.live;
  const display = liveDisplay(hasSession, live);
  const running = display === 'running';
  const quiet = cardStatus(task, live, card, laneKind, { signals: i.signals, nested: i.nested, now, formatWaitUntil: fmt, isChoice: i.isChoice });
  // C12 (spec 4.2): a card someone placed, completed later, says why it sits in the done lane.
  const placedIn = placed.completedAfterMove && card?.lane ? laneById(lanes, card.lane)?.name : undefined;
  const status = placedIn ? { ...quiet, tooltip: `${quiet.tooltip}\n${completedHereText(placedIn)}` } : quiet;
  const ds = displayedSummary(card, task.summary);
  // R3-03: the list payload carries no summary; until it is read the card's summary is not known,
  // so it is neither a change nor a baseline (the empty hash makes the server read the task).
  const summaryKnown = task.summary !== undefined || (task as { has_summary?: boolean }).has_summary === false;
  const sumHash = summaryKnown ? summaryHash(ds?.text ?? '') : summaryHash('');
  const summaryBy: BoardCardWriter | undefined = ds ? (ds.source === 'card' ? ds.by : `task:${task.id}`) : undefined;
  let summary: KanbanCardSummary | undefined;
  if (ds) {
    const who = ds.source === 'task' ? 'the worker' : writerText(ds.by, i.ownerId, i.titleOf, task.id) || 'the board';
    const clock = clockText(ds.at, now);
    summary = { text: ds.text, source: ds.source, ...(ds.at ? { at: ds.at } : {}), tooltip: `${ds.text}\n\nFrom ${who}${clock ? `, ${clock}` : ''}` };
  }
  let waiting: KanbanCardWaiting | undefined;
  if (laneKind === 'wait') {
    const until = phase === 'WAITING' && task.wait_until ? fmt(task.wait_until) : undefined;
    const kind = card?.waiting_on ? 'text' : placed.source === 'explicit' ? 'add-who' : 'parked';
    waiting = { kind, ...(card?.waiting_on ? { text: card.waiting_on } : {}), ...(until ? { until } : {}) };
  }
  // N11: the foot's time is the ticket's own progress; a board write (a lane move, a leader's
  // summary) is not activity, it shows as the change label in the same row instead.
  const activeAt = latestIso(hasSession ? live?.statusUpdatedAt : null, task.phase_changed_at, task.last_session_update,
    task.completed_at, card?.worker_summary_at) || createdAt;
  const foot: KanbanCardFoot = {
    activeText: agoText('Active', activeAt, now), activeTooltip: activeAt ? `Last activity ${absoluteText(activeAt)}` : '',
    unread: !!task.unread,
  };
  const parked = phase === 'WAITING' && !!task.wait_until && Date.parse(task.wait_until) > now;
  if (laneKind !== 'done' && !isComplete && !running && !parked) {
    const progressAt = latestIso(hasSession ? live?.statusUpdatedAt : null, task.phase_changed_at, card?.worker_summary_at) || createdAt;
    const t = Date.parse(progressAt);
    if (Number.isFinite(t) && now - t > STALE_AFTER_MS) {
      foot.stale = durationText(laneKind === 'wait' ? 'Waiting' : 'Stale', progressAt, now);
      foot.staleTooltip = `No progress since ${absoluteText(progressAt)}`;
      // N11: `Stale 3d` already says when the ticket last moved; never `Active just now` beside it.
      foot.activeText = '';
    }
  }
  const ticket = tagValue(task.tags, 'ticket', 'ticket-id');
  const lanePlacedAt = placed.source === 'explicit' ? card?.lane_at
    : card?.lane_auto?.lane === placed.lane && !placed.completedAfterMove ? card.lane_auto.at : completedAt;
  const change = cardChange({
    taskId: task.id, label: ticket?.value || cutTitle(task.title), lanes, lane: placed.lane, source: placed.source,
    laneAt: lanePlacedAt, laneBy: placed.source === 'explicit' ? card?.lane_by : i.humanPhase ? 'human' : undefined, card, unread: !!task.unread,
    summaryHash: sumHash, summaryKnown, summaryAt: ds?.at, summaryBy, createdAt, baseline: i.baseline, hasBaseline: i.hasBaseline,
    baselineAt: i.baselineAt, ownerId: i.ownerId, titleOf: i.titleOf, now,
  });
  const sug = card?.lane_suggested;
  const sugLane = sug ? laneById(lanes, sug.lane) : undefined;
  let suggestion: KanbanSuggestion | undefined;
  if (sug && sugLane && sugLane.id !== placed.lane) {
    const actor = writerText(`task:${sug.by}`, i.ownerId, i.titleOf, task.id);
    suggestion = { lane: sugLane.id, laneName: sugLane.name, by: sug.by, at: sug.at, text: `${writerLead(actor)} suggests ${sugLane.name}` };
  }
  // N15: the suggestion row says it with its buttons; the foot does not say it again.
  const footChange = change && suggestion ? footOf(change.items.filter((x) => x.kind !== 'suggestion')) : change?.foot;
  if (footChange) foot.changed = footChange;
  const sev = tagValue(task.tags, 'sev')?.value;
  return {
    ...base, title: task.title, ...(ticket ? { ticket } : {}), ...(sev ? { sev } : {}),
    ...(i.openSubtasks ? { leaderCount: i.openSubtasks } : {}),
    status, needsYou: status.tone === 'red', running, activity: running ? capitalize(live?.activity ?? '') : '',
    hasSession, ...(sessionId ? { sessionId } : {}), ...(summary ? { summary } : {}), ...(waiting ? { waiting } : {}),
    foot, changed: !!change, ...(change ? { change } : {}), ...(suggestion ? { suggestion } : {}), loading: false,
    snapshot: { lane: placed.lane, summaryHash: sumHash, ...(card?.output_at ? { outputAt: card.output_at } : {}), unread: !!task.unread },
  };
}
