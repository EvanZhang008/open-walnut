/**
 * The folded team on a leader's row (worker-fold.ts; design 2 of ten, 2026-11-11): one quiet line
 * under the title ("9 workers  1 needs you": only who needs the user is counted), which opens a short tree
 * below the row. Each tree line opens its task; its action at the line's end takes that worker out
 * as a row of its own (an up arrow off a line), or puts it back (the arrow down). Icons, not words:
 * the user found the words too wordy and picked design 7 of ten, with the control at the END of the
 * line and a hint the moment the pointer is on it (2026-11-11: "一定要放到后面 ... 立马就显示一个
 * hover over"), so the hint is data-fold-tip drawn at once by fold-tip.ts, never a native title with its delay.
 */
import { useEffect } from 'react';
import type { Task } from '@open-walnut/core';
import * as ICONS from '../common/Icons';
import { orgDisplayTitle } from '@open-walnut/org-tree';
import { taskUserState } from '@/utils/session-status';
import { foldMixLine, stateSectionKey, type FoldEntry, foldStateWords } from './worker-fold';
import { installFoldTip } from './fold-tip';
import '@/styles/worker-fold.css';

/** What a section row needs to draw its folded team: TodoPanel's fold state and its writers. */
export interface WorkerFoldCtl {
  trees: ReadonlyMap<string, readonly FoldEntry[]>;
  /** Leaders drawn only for their workers (not in this view themselves). */
  quiet: ReadonlySet<string>;
  /** Leaders drawn above their own section: id -> that section. */
  movedFrom: ReadonlyMap<string, string>;
  isOpen(hostId: string): boolean;
  toggleOpen(hostId: string): void;
  /** Show one worker as a row of its own (on), or fold it back (off). */
  separate(workerId: string, on: boolean): void;
  /** Show every worker of a leader as rows (on), or fold them all back (off). */
  showTeam(hostId: string, on: boolean): void;
  /** A row shown separately that could fold back: its leader, and whether its whole team is out. */
  foldBackOf(task: Task): { leader: Task; team: boolean } | null;
}

/** One control's words: its accessible name and the hint shown at once on hover or focus. */
function tipProps(words: string) {
  return { 'aria-label': words, 'data-fold-tip': words };
}

export function workerWord(n: number): string {
  return `${n} ${n === 1 ? 'worker' : 'workers'}`;
}

/** The leader row's line: a disclosure with the count, then how many need the user (none: nothing). */
export function FoldSummaryLine({ host, entries, ctl }: { host: Task; entries: readonly FoldEntry[]; ctl: WorkerFoldCtl }) {
  const open = ctl.isOpen(host.id);
  const needs = foldMixLine(entries);
  return (
    <span className="worker-fold-line" data-testid="worker-fold-line">
      <button
        type="button"
        className={`worker-fold-toggle${open ? ' is-open' : ''}`}
        data-testid="worker-fold-toggle"
        aria-expanded={open}
        title={open ? 'Hide the team' : 'Show the team'}
        onClick={(e) => { e.stopPropagation(); ctl.toggleOpen(host.id); }}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <span className="worker-fold-chevron" aria-hidden="true">{ICONS.ICON_CHEVRON_RIGHT}</span>
        {workerWord(entries.length)}
      </button>
      {needs ? <span className="worker-fold-mix" data-testid="worker-fold-mix">{needs}</span> : null}
    </span>
  );
}

/** The open tree under a leader's row. */
export function FoldTree({ host, entries, ctl, focusedTaskId, onOpen, twoLine }: {
  host: Task;
  entries: readonly FoldEntry[];
  ctl: WorkerFoldCtl;
  focusedTaskId?: string | null;
  onOpen(task: Task): void;
  twoLine: boolean;
}) {
  useEffect(installFoldTip, []);
  const folded = entries.filter((e) => !e.out).length;
  const canFoldBack = entries.some((e) => e.out && ctl.foldBackOf(e.task));
  return (
    <div className={`worker-fold-tree${twoLine ? '' : ' is-one-line'}`} data-testid="worker-fold-tree" data-host-id={host.id} role="list" aria-label={`${orgDisplayTitle(host)} team`}>
      {entries.map(({ task, depth, out }) => {
        const key = stateSectionKey(task);
        // Out because the user showed it separately (it can fold back), or because its section
        // never folds (Needs you, Watching): that one only says where it is. A line names the
        // state by the section it is drawn in, in that section's own words.
        const back = out ? ctl.foldBackOf(task) : null;
        return (
          <div data-peek-row=""
            key={task.id}
            role="listitem"
            className={`worker-fold-item${out ? ' is-out' : ''}${focusedTaskId === task.id ? ' is-focused' : ''}`}
            // Not data-task-id: that names a task's own row everywhere (locate, drag, counts).
            data-fold-task-id={task.id}
            data-testid="worker-fold-item"
            style={depth ? { paddingLeft: 4 + depth * 16 } : undefined}
          >
            <button type="button" className="worker-fold-open" title={orgDisplayTitle(task)} onClick={(e) => { e.stopPropagation(); onOpen(task); }}>
              <span className={`worker-fold-icon worker-fold-icon-${key}`} aria-hidden="true">
                {ICONS.sectionRowIcon(key, key === 'done', task.phase, false, taskUserState(task))}
              </span>
              <span className="worker-fold-title">{orgDisplayTitle(task)}</span>
              {back ? null : <span className="worker-fold-state">{out ? `${foldStateWords(key)} · in the list` : foldStateWords(key)}</span>}
            </button>
            {!out || back ? (
              <button
                type="button"
                className="worker-fold-action"
                data-testid={back ? 'worker-fold-back' : 'worker-fold-separate'}
                {...tipProps(back ? `Put back into ${orgDisplayTitle(back.leader)}` : 'Take out: show as its own row in the list')}
                onClick={(e) => {
                  e.stopPropagation();
                  if (!back) ctl.separate(task.id, true);
                  else if (back.team) ctl.showTeam(back.leader.id, false);
                  else ctl.separate(task.id, false);
                }}
                onKeyDown={(e) => e.stopPropagation()}
              >{back ? ICONS.ICON_FOLD_PUT_BACK : ICONS.ICON_FOLD_TAKE_OUT}</button>
            ) : null}
          </div>
        );
      })}
      {folded > 0 || canFoldBack ? (
        <div className="worker-fold-foot">
          <button
            type="button"
            className="worker-fold-all"
            data-testid={folded > 0 ? 'worker-fold-show-all' : 'worker-fold-all-back'}
            {...tipProps(folded > 0 ? `Take out all ${entries.length}: each its own row in the list` : 'Put all back into the team')}
            onClick={(e) => { e.stopPropagation(); ctl.showTeam(host.id, folded > 0); }}
            onKeyDown={(e) => e.stopPropagation()}
          >{folded > 0 ? ICONS.ICON_FOLD_TAKE_OUT : ICONS.ICON_FOLD_PUT_BACK}<span>All</span></button>
        </div>
      ) : null}
    </div>
  );
}

/** A worker row shown separately: the put-back arrow at the row's end, beside its start button. */
export function FoldBackButton({ task, ctl }: { task: Task; ctl: WorkerFoldCtl }) {
  useEffect(installFoldTip, []);
  const back = ctl.foldBackOf(task);
  if (!back) return null;
  return (
    <button
      type="button"
      className="worker-fold-row-back"
      data-testid="worker-fold-row-back"
      {...tipProps(back.team ? `Put the whole team back into ${orgDisplayTitle(back.leader)}` : `Put back into ${orgDisplayTitle(back.leader)}`)}
      onClick={(e) => { e.stopPropagation(); if (back.team) ctl.showTeam(back.leader.id, false); else ctl.separate(task.id, false); }}
      onKeyDown={(e) => e.stopPropagation()}
    >{ICONS.ICON_FOLD_PUT_BACK}</button>
  );
}
