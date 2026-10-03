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
  return !host || host === '__local__' ? 'this Mac' : host;
}

/** One short phrase for the state. */
export function workspaceStateLabel(ws: TaskWorkspace): string {
  switch (ws.state) {
    case 'requested': return 'Not made yet';
    case 'creating': return 'Preparing workspace…';
    case 'ready': return ws.launch_error ? 'Ready, session did not start' : 'Ready';
    case 'failed': return 'Could not be made';
    case 'removing': return 'Removing…';
    case 'removed': return ws.branch_kept ? 'Removed (branch kept)' : 'Removed';
    case 'kept': return 'Kept';
  }
}

/** The pill on a task row; null = no pill. */
export function workspacePill(ws: TaskWorkspace | undefined): { text: string; tone: 'busy' | 'ok' | 'warn' | 'error'; title: string } | null {
  if (!ws || ws.state === 'removed') return null
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
      return { text: 'Workspace kept', tone: 'warn', title: `Kept: ${ws.kept_reason ?? 'it still holds work'}\n${where}` }
    case 'ready':
      return ws.launch_error
        ? { text: 'Workspace', tone: 'error', title: `The session could not start: ${ws.launch_error}` }
        : { text: ws.provider === 'git-worktree' ? 'Worktree' : provider, tone: 'ok', title: `${provider}: ${where}${ws.branch ? `\nbranch ${ws.branch}` : ''}` }
  }
}
