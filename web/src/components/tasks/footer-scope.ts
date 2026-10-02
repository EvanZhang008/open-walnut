import type { Task } from '@open-walnut/core';
import { INBOX_TAB } from './task-tabs';
import { recentActivityTime, type RecentSortMode } from './recent-activity-time';

/** How many rows the Recent feed shows (TodoPanel's recentTasksLive slice). */
export const RECENT_FEED_SIZE = 50;

export interface FooterScopeInput {
  /** The effective section: a tier id (`focus`, `satellite`, `backlog`, `wait`, `ct_*`), `pinned`, `recent`, `tasks` or `all`. */
  section: string;
  tasks: Task[];
  /** '' = every project, INBOX_TAB = the no-project bucket, else a project name. */
  activeProject: string;
  pinnedTaskIds?: Set<string>;
  focusTaskIds?: Set<string>;
  backlogTaskIds?: Set<string>;
  waitTaskIds?: Set<string>;
  customTierIds?: Record<string, Set<string>>;
  /** Members of any registered custom tier (satellite = pinned minus every other tier). */
  customMemberIds: Set<string>;
  hiddenGroups?: Set<string>;
  showCompleted: boolean;
  waitingRevealed: boolean;
  recentSortMode: RecentSortMode;
}

export interface FooterScope {
  /** The tasks the view draws, or would draw once a status hide is lifted (Recent: its feed as currently gated). */
  scope: Task[];
  /** Parked tasks the view would show with "Show waiting" on. */
  waiting: number;
  /** Completed tasks the view would show with "Show completed" on (loaded rows only). */
  completed: number;
  /** True when the scope is the whole board, so the unloaded completed archive belongs in the count too. */
  wholeBoard: boolean;
}

const isDone = (t: Task) => t.status === 'done';
const isParked = (t: Task) => t.phase === 'WAITING';

/**
 * What the footer bar under the task list counts: the status hides of the CURRENT
 * VIEW, not of the whole board. A tier tab counts that tier's tasks (minus hidden
 * groups, which the tier never draws), the Pinned view every pin, Recent its
 * 50-row feed, the Tasks list the project tab, and the stacked All view the project
 * tab plus the cross-project tiers above it. A whole-board number on the Focus tab
 * read as "every parked task on the board is hidden here" (2026-10-01).
 */
export function footerStatusScope(input: FooterScopeInput): FooterScope {
  const { section, tasks, hiddenGroups } = input;
  const drawnInTiers = (t: Task) => !(t.group_id && hiddenGroups?.has(t.group_id));
  const inTier = (ids: Set<string> | undefined) => (t: Task) => !!ids?.has(t.id) && drawnInTiers(t);
  const inPins = inTier(input.pinnedTaskIds);

  if (section === 'recent') return recentScope(input);

  let scope: Task[];
  let wholeBoard = false;
  if (section === 'focus') scope = tasks.filter(inTier(input.focusTaskIds));
  else if (section === 'backlog') scope = tasks.filter(inTier(input.backlogTaskIds));
  else if (section === 'wait') scope = tasks.filter(inTier(input.waitTaskIds));
  else if (section.startsWith('ct_')) scope = tasks.filter(inTier(input.customTierIds?.[section]));
  else if (section === 'satellite') {
    scope = tasks.filter((t) => inPins(t)
      && !input.focusTaskIds?.has(t.id) && !input.backlogTaskIds?.has(t.id) && !input.waitTaskIds?.has(t.id)
      && !input.customMemberIds.has(t.id));
  } else if (section === 'pinned') scope = tasks.filter(inPins);
  else {
    const inProject = (t: Task) => !input.activeProject || (t.project || INBOX_TAB) === input.activeProject;
    wholeBoard = !input.activeProject;
    scope = section === 'all' ? tasks.filter((t) => inProject(t) || inPins(t)) : tasks.filter(inProject);
  }
  let waiting = 0;
  let completed = 0;
  for (const t of scope) {
    if (isParked(t)) waiting += 1;
    if (isDone(t)) completed += 1;
  }
  return { scope, waiting, completed, wholeBoard };
}

/**
 * Recent is a capped feed, so "what would show" depends on the other gate: the
 * parked count walks the feed with every parked task admitted (completed as
 * currently gated) and counts the parked rows inside the first 50; the completed
 * count does the same the other way round. The scope is the feed as it stands.
 */
function recentScope(input: FooterScopeInput): FooterScope {
  const { tasks, recentSortMode, showCompleted, waitingRevealed } = input;
  const at = new Map<string, string>();
  for (const t of tasks) at.set(t.id, recentActivityTime(t, recentSortMode).at);
  const sorted = [...tasks].sort((a, b) => (at.get(b.id) ?? '').localeCompare(at.get(a.id) ?? ''));
  const feed = (admit: (t: Task) => boolean): Task[] => {
    const out: Task[] = [];
    for (const t of sorted) {
      if (!admit(t)) continue;
      out.push(t);
      if (out.length >= RECENT_FEED_SIZE) break;
    }
    return out;
  };
  const completedGate = (t: Task) => !isDone(t) || showCompleted;
  const parkedGate = (t: Task) => !isParked(t) || waitingRevealed;
  const waiting = feed(completedGate).filter(isParked).length;
  const completed = feed(parkedGate).filter(isDone).length;
  return { scope: feed((t) => completedGate(t) && parkedGate(t)), waiting, completed, wholeBoard: false };
}
