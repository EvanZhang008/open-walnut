/**
 * What a completed task's workspace cleanup tells the person: only what went
 * wrong. A workspace kept (and why), or a cleanup script that failed, is told; a
 * cleanup that went well says nothing (2026-11-20, Evan: the cleanup notification
 * "其实是不需要的"); the task row and its Workspace row still show it.
 *
 * useCleanupNotices.ts reads it from the task rows the page already has.
 */
import { keptText, type TaskWorkspace } from './workspace-text';
import { scriptRunStatus } from './script-run-text';

export interface CleanupNotice {
  severity: 'info' | 'success' | 'warning';
  title: string;
  body: string;
  key: string;
}

function quoted(title: string | undefined): string {
  const t = (title ?? '').trim();
  return t ? `“${t.length > 60 ? `${t.slice(0, 59)}…` : t}”` : 'The task';
}

/** The change from `prev` to `next` worth a toast, if any. */
export function cleanupNotice(taskId: string, title: string | undefined, prev: TaskWorkspace | undefined, next: TaskWorkspace | undefined): CleanupNotice | null {
  if (!prev || !next) return null;
  const td = next.teardown;
  const ended = (next.state === 'removed' || next.state === 'kept') && prev.state !== next.state && prev.state !== 'removed';
  if (!ended) return null;
  // Only a cleanup of a completion speaks here; a person's own Remove has its own dialog.
  if (next.removal?.trigger === 'manual' || prev.removal?.trigger === 'manual') return null;
  const script = td && td.state !== 'running' && td.ended_at && (!prev.teardown || prev.teardown.started_at === td.started_at || prev.teardown.state === 'running') ? td : undefined;
  const lastLine = script?.output?.trim().split('\n').pop()?.trim();
  const scriptLine = !script ? ''
    : script.state === 'done' ? `Cleanup ${script.name}: ${scriptRunStatus(script)}. `
      : script.state === 'failed' ? `Cleanup ${script.name} failed${typeof script.exit_code === 'number' ? ` (exit ${script.exit_code})` : ''}${lastLine ? `: “${lastLine.length > 120 ? `${lastLine.slice(0, 119)}…` : lastLine}”` : script.error ? `: ${script.error}` : ''}. `
        : `Cleanup ${script.name} did not run: ${script.error ?? 'it was skipped'}. `;
  const failed = script?.state === 'failed';
  const outputWhere = failed ? ' Its output is under Workspace in the task\'s menu.' : '';
  if (next.state === 'removed') {
    if (!failed) return null;
    return {
      severity: 'warning', key: `cleanup-removed:${taskId}`,
      title: `Cleanup ${script!.name} failed; workspace removed`,
      body: `${scriptLine}The workspace of ${quoted(title)} was removed anyway, since nothing in it would be lost${next.branch_kept ? '; its branch was kept, since it has commits found nowhere else' : ''}.${outputWhere}`,
    };
  }
  return {
    severity: 'warning', key: `cleanup-kept:${taskId}`,
    title: failed ? `Cleanup ${script!.name} failed; workspace kept` : 'Workspace kept',
    body: `${scriptLine}The workspace of ${quoted(title)} was kept: ${keptText(next)}${outputWhere}`,
  };
}

/** Tasks whose setup this page started again: its end is told (the run is a job, not in the terminal). */
const watchedSetups = new Set<string>();
export function watchSetupRun(taskId: string): void { watchedSetups.add(taskId); }
/** The "Setup started" toast of each task, taken down when its end is told. */
const startedToasts = new Map<string, string>();
export function noteSetupStartedToast(taskId: string, id: string): void { startedToasts.set(taskId, id); }
export function takeSetupStartedToast(taskId: string): string | undefined {
  const id = startedToasts.get(taskId);
  startedToasts.delete(taskId);
  return id;
}
/** The run again was refused: nothing of it is told. */
export function unwatchSetupRun(taskId: string): void { watchedSetups.delete(taskId); }

/** "Setup Install", but "Project setup" as it is (never "Setup Project setup"). */
function setupLabel(name: string): string {
  return /\bsetup\b/i.test(name) ? name : `Setup ${name}`;
}

/** A setup run again from this page ended. */
export function setupNotice(taskId: string, title: string | undefined, prev: TaskWorkspace | undefined, next: TaskWorkspace | undefined): CleanupNotice | null {
  const was = prev?.setup;
  const now = next?.setup;
  // A setup the first session does not wait for runs unseen beside it: its start and end are told too.
  const background = now?.wait === false;
  if (!watchedSetups.has(taskId) && !background) return null;
  if (!now) return null;
  if (now.state === 'running') {
    const startedNow = !(was?.state === 'running' && was.started_at === now.started_at);
    if (!startedNow || !background || watchedSetups.has(taskId)) return null;
    watchedSetups.add(taskId);
    return {
      severity: 'info', key: `setup-started:${taskId}:${now.started_at}`,
      title: `${setupLabel(now.name)} runs in the background`,
      body: `The session of ${quoted(title)} started without waiting for it: what it installs may not be there yet. A pop-up like this one says how it went, and Workspace in the task's menu keeps its output.`,
    };
  }
  // It ended now: it was running, or a whole new run came and went between two rows.
  if (was?.state !== 'running' && was?.started_at === now.started_at) return null;
  watchedSetups.delete(taskId);
  if (now.state === 'done') {
    return { severity: 'success', key: `setup-ended:${taskId}:${now.started_at}`, title: `${setupLabel(now.name)} done`, body: `${scriptRunStatus(now)} in the workspace of ${quoted(title)}.` };
  }
  return {
    severity: 'warning', key: `setup-ended:${taskId}:${now.started_at}`,
    title: `${setupLabel(now.name)} ${now.state === 'failed' ? 'failed' : 'did not run'}`,
    body: `${now.error ?? scriptRunStatus(now)}. Its output is under Workspace in the task's menu.`,
  };
}

/** Tests only. */
export function __resetSetupWatch(): void { watchedSetups.clear(); }
