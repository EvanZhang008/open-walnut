/**
 * The words every workspace surface shares (pill, kebab row, preparing column),
 * so a state reads the same everywhere.
 */
import type { TaskWorkspace } from '../../../../src/core/workspaces/types';

export type { TaskWorkspace };

export function workspaceOf(task: { workspace?: TaskWorkspace } | null | undefined): TaskWorkspace | undefined {
  const ws = task?.workspace;
  return ws && typeof ws === 'object' && typeof ws.state === 'string' ? ws : undefined;
}

/** Sessions run in it. */
export function isWorkspaceUsable(ws: TaskWorkspace | undefined): boolean {
  return !!ws && (ws.state === 'ready' || ws.state === 'kept') && !!ws.cwd;
}

export function hostName(host: string | undefined): string {
  // The server's own machine: a Mac for most, a Linux box for others.
  return !host || host === '__local__' ? 'this computer' : host;
}

/** A cleanup script running now (the task completed; the workspace is checked once it ends). */
export function cleanupRunning(ws: TaskWorkspace | undefined): boolean {
  return ws?.teardown?.state === 'running' && (ws.state === 'ready' || ws.state === 'kept');
}

/**
 * Why a cleanup kept the workspace, in a sentence: "web has 1 uncommitted change".
 * Files a setup script makes count as changes unless .gitignore lists them, which
 * is the usual reason a workspace with a setup is kept, so it says so.
 */
export function keptText(ws: TaskWorkspace): string {
  const raw = (ws.kept_reason ?? '').trim();
  if (!raw) return 'it still holds work.';
  const parts = raw.split(/;\s*/).map((p) => p.replace(/^([^:]+): (\d+ uncommitted changes?)$/, '$1 has $2').replace(/^([^:]+): (has |its |branch )/, '$1 $2'));
  const text = `${parts.join('; ')}.`.replace(/\.\.$/, '.');
  const fromSetup = ws.setup && /uncommitted change/.test(raw)
    ? ' Files a setup script makes count too, unless .gitignore lists them.' : '';
  return text + fromSetup;
}

/** A ready workspace whose setup is not simply done: running, failed, or waiting for the user's OK. */
export function setupStateText(ws: TaskWorkspace): string | null {
  if (cleanupRunning(ws)) return 'Running cleanup…';
  const s = ws.setup;
  if (!s) return null;
  if (s.state === 'running') return 'Running setup…';
  if (s.state === 'failed') return 'Setup failed';
  if (s.state === 'skipped') return s.untrusted ? 'Setup needs your OK' : 'Setup did not run';
  return null;
}

/** A failed waiting setup holds the person's session (the client twin of decisions.ts setupBlocksLaunch). */
export function setupWaitsForYou(ws: TaskWorkspace | undefined): boolean {
  const s = ws?.setup;
  const unfinished = s?.state === 'failed' || (s?.state === 'skipped' && !!s.untrusted);
  return !!s && unfinished && s.wait !== false && !s.proceed && !!ws?.pending_start && !ws.pending_start.caller_sid;
}

/** The tone of a ready workspace's state: its setup's when that is not simply done. */
export function setupTone(ws: TaskWorkspace): 'busy' | 'warn' | 'error' | null {
  if (cleanupRunning(ws)) return 'busy';
  const s = ws.state === 'ready' ? ws.setup : undefined;
  if (!s || s.state === 'done') return null;
  return s.state === 'running' ? 'busy' : s.state === 'failed' ? 'error' : 'warn';
}

/** One short phrase for the state. */
export function workspaceStateLabel(ws: TaskWorkspace): string {
  switch (ws.state) {
    case 'requested': return 'Not made yet';
    case 'creating': return 'Preparing workspace…';
    case 'ready': return ws.launch_error ? 'Ready, session did not start' : setupStateText(ws) ?? 'Ready';
    case 'failed': return 'Could not be made';
    case 'removing': return 'Removing…';
    case 'removed': return ws.branch_kept ? 'Removed (branch kept)' : 'Removed';
    case 'kept': return 'Kept';
  }
}

/** The pill on a task row; null = no pill. An `ok` pill is drawn as its glyph alone (its text is the tooltip). */
export function workspacePill(ws: TaskWorkspace | undefined): { text: string; tone: 'busy' | 'ok' | 'warn' | 'error'; title: string } | null {
  if (!ws) return null
  // A failed cleanup is the last word on a completed task (its workspace then kept or gone);
  // a workspace in use again (the task reopened) shows its own state.
  if (ws.teardown?.state === 'failed' && (ws.state === 'removed' || ws.state === 'kept')) {
    return { text: 'Cleanup failed', tone: 'warn', title: `Cleanup ${ws.teardown.name}: ${ws.teardown.error ?? 'it did not succeed'}${ws.state === 'kept' ? `\nKept: ${keptText(ws)}` : ''}` }
  }
  if (ws.state === 'removed') return null
  const where = ws.root ?? ws.anchor
  const provider = ws.provider_name ?? ws.provider
  switch (ws.state) {
    case 'creating':
    case 'requested':
      return { text: 'Preparing workspace', tone: 'busy', title: `${provider} on ${hostName(ws.host)}${ws.progress ? `: ${ws.progress}` : ''}` }
    case 'failed':
      return { text: 'Workspace failed', tone: 'error', title: ws.error ?? 'The workspace could not be made' }
    case 'removing':
      return { text: 'Removing workspace', tone: 'busy', title: where }
    case 'kept':
    case 'ready':
      if (cleanupRunning(ws)) return { text: 'Running cleanup', tone: 'busy', title: `Cleanup ${ws.teardown!.name}: running in ${where}` }
      if (ws.state === 'kept') return { text: 'Workspace kept', tone: 'warn', title: `Kept: ${keptText(ws)}\n${where}` }
      if (ws.launch_error) return { text: 'Workspace', tone: 'error', title: `The session could not start: ${ws.launch_error}` }
      {
        const setup = setupStateText(ws)
        const base = `${provider}: ${where}${ws.branch ? `\nbranch ${ws.branch}` : ''}`
        if (setup) {
          const held = !setupWaitsForYou(ws) ? ''
            : ws.setup?.state === 'skipped' ? '\nThe session waits: open the task to allow its setup or start without it.'
              : '\nThe session waits: open the task to run setup again or start anyway.'
          return { text: setup.replace(/…$/, ''), tone: setupTone(ws) ?? 'warn', title: `${setup}\n${base}${held}` }
        }
        return { text: ws.provider === 'git-worktree' ? 'Worktree' : provider, tone: 'ok', title: base }
      }
  }
}
