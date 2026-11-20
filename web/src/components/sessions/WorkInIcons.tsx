/**
 * The Work in pill's marks (DraftWorkInPill, WorkInPicker): one per kind of place a task runs.
 *   git     a git worktree from the project's checkout (a branch)
 *   box     a workspace a plugin provider makes (or a legacy isolated workspace)
 *   folder  a folder of yours
 *   host    nothing picked yet (where does it run?)
 */
import type { ReactElement } from 'react';
import type { StartSource } from '@/api/projects';

export type WorkInKind = 'git' | 'box' | 'folder' | 'host';

export function workInKindOf(source: StartSource | null | undefined): WorkInKind {
  if (!source) return 'folder';
  return source.provider === 'git-worktree' ? 'git' : 'box';
}

const PATHS: Record<WorkInKind, ReactElement> = {
  git: (
    <g>
      <circle cx="4.5" cy="3.5" r="1.6" /><circle cx="4.5" cy="12.5" r="1.6" /><circle cx="11.5" cy="5" r="1.6" />
      <path d="M4.5 5.1v5.8M11.5 6.6c0 3.2-7 2.4-7 4.3" />
    </g>
  ),
  box: <path d="M8 1.6 14 4.6v6.8L8 14.4 2 11.4V4.6zM2 4.6l6 3 6-3M8 7.6v6.8" strokeLinejoin="round" />,
  folder: <path d="M1.8 4.2c0-.7.5-1.2 1.2-1.2h3.2l1.5 1.6H13c.7 0 1.2.5 1.2 1.2v6.2c0 .7-.5 1.2-1.2 1.2H3c-.7 0-1.2-.5-1.2-1.2z" />,
  host: <g><rect x="2" y="3" width="12" height="8" rx="1.5" /><path d="M5.5 14h5M8 11v3" /></g>,
};

export function WorkInKindIcon({ kind, className }: { kind: WorkInKind; className?: string }) {
  return (
    <svg className={`work-in-icon is-${kind}${className ? ` ${className}` : ''}`} width="13" height="13" viewBox="0 0 16 16"
      fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true" focusable="false">
      {PATHS[kind]}
    </svg>
  );
}

export function WorkInCheckIcon() {
  return (
    <svg className="work-in-check" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-label="current" role="img">
      <path d="M3.5 8.5l3 3 6-7" />
    </svg>
  );
}

/** "Set up source…": a gear. */
export function WorkInSetupIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.8v1.8M8 12.4v1.8M1.8 8h1.8M12.4 8h1.8M3.6 3.6l1.3 1.3M11.1 11.1l1.3 1.3M3.6 12.4l1.3-1.3M11.1 4.9l1.3-1.3" strokeLinecap="round" />
    </svg>
  );
}
