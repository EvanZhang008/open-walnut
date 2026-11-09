/**
 * The words every surface uses for a setup or teardown run of a project script
 * (src/core/workspaces/scripts.ts): the kebab flyout, the preparing column.
 */
import type { WorkspaceScriptRun } from '../../../../src/core/workspaces/types';

export type { WorkspaceScriptRun };

function seconds(run: WorkspaceScriptRun): number | null {
  const a = Date.parse(run.started_at);
  const b = Date.parse(run.ended_at ?? '');
  return Number.isFinite(a) && Number.isFinite(b) && b >= a ? Math.round((b - a) / 1000) : null;
}

export function durationText(s: number): string {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
}

/** "Done in 42s", "Failed: exited with code 1", "Running…", "Did not run: …", "Needs your OK". */
export function scriptRunStatus(run: WorkspaceScriptRun): string {
  const took = seconds(run);
  switch (run.state) {
    case 'running': return 'Running…';
    case 'done': return took === null ? 'Done' : `Done in ${durationText(took)}`;
    case 'failed': return `Failed: ${run.error ?? 'it did not succeed'}`;
    case 'skipped': return run.untrusted ? 'Needs your OK' : `Did not run: ${run.error ?? 'unknown reason'}`;
  }
}

/** When a run ended, so a run again reads apart from the first: "at 14:02", "on Nov 3 at 14:02". */
export function ranAtText(run: WorkspaceScriptRun, now = new Date()): string {
  if (run.state === 'running' || !run.ended_at) return '';
  const at = new Date(run.ended_at);
  if (Number.isNaN(at.getTime())) return '';
  const time = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return at.toDateString() === now.toDateString() ? `at ${time}` : `on ${at.toLocaleDateString([], { month: 'short', day: 'numeric' })} at ${time}`;
}

/** Where the script came from, for a small label. */
export function scriptSourceText(source: WorkspaceScriptRun['source']): string {
  return source === 'project' ? "project's scripts" : source;
}
