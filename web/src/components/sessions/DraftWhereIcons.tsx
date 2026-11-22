/**
 * The new task draft's Project + Where marks (experiment `project_first_start`): one per kind of
 * place a task runs, and the few marks of the Where field and its menus.
 *   git     a git worktree from the project's checkout
 *   box     a workspace a plugin provider makes (or a legacy isolated workspace)
 *   folder  a folder of yours (the project's own, or one you pick)
 *   home    the home folder
 * Search, check, chevron and terminal are the app's own (components/common/Icons).
 */
import type { ReactElement } from 'react';
import type { StartSource } from '@/api/projects';

export type WhereKind = 'git' | 'box' | 'folder' | 'home';

export function whereKindOf(source: StartSource | null | undefined): WhereKind {
  if (!source) return 'folder';
  return source.provider === 'git-worktree' ? 'git' : 'box';
}

const PATHS: Record<WhereKind | 'ban' | 'auto' | 'clock' | 'gone', ReactElement> = {
  git: (
    <g>
      <circle cx="4.5" cy="3.5" r="1.6" /><circle cx="4.5" cy="12.5" r="1.6" /><circle cx="11.5" cy="5" r="1.6" />
      <path d="M4.5 5.1v5.8M11.5 6.6c0 3.2-7 2.4-7 4.3" />
    </g>
  ),
  box: <path d="M8 1.6 14 4.6v6.8L8 14.4 2 11.4V4.6zM2 4.6l6 3 6-3M8 7.6v6.8" strokeLinejoin="round" />,
  folder: <path d="M1.8 4.2c0-.7.5-1.2 1.2-1.2h3.2l1.5 1.6H13c.7 0 1.2.5 1.2 1.2v6.2c0 .7-.5 1.2-1.2 1.2H3c-.7 0-1.2-.5-1.2-1.2z" />,
  home: <path d="M2.5 7.5 8 2.8l5.5 4.7M4 6.5v6.7h8V6.5" strokeLinejoin="round" />,
  ban: <g><circle cx="8" cy="8" r="5.8" /><path d="M3.9 3.9l8.2 8.2" /></g>,
  auto: <path d="M8 1.8l1.4 3.8 3.8 1.4-3.8 1.4L8 12.2 6.6 8.4 2.8 7l3.8-1.4zM12.6 11l.6 1.6 1.6.6-1.6.6-.6 1.6-.6-1.6-1.6-.6 1.6-.6z" strokeLinejoin="round" />,
  clock: <g><circle cx="8" cy="8" r="6" /><path d="M8 4.6V8l2.4 1.6" /></g>,
  gone: (
    <g>
      <path d="M1.8 4.2c0-.7.5-1.2 1.2-1.2h3.2l1.5 1.6H13c.7 0 1.2.5 1.2 1.2v6.2c0 .7-.5 1.2-1.2 1.2H3c-.7 0-1.2-.5-1.2-1.2z" />
      <path d="M2 14 14 2" />
    </g>
  ),
};

/** One mark: a place kind, or `ban` (Auto cannot run here), `auto`, `clock` (Last used), `gone` (not on this host). */
export function WhereIcon({ kind, className, size = 13 }: { kind: keyof typeof PATHS; className?: string; size?: number }) {
  return (
    <svg className={`where-icon is-${kind}${className ? ` ${className}` : ''}`} width={size} height={size} viewBox="0 0 16 16"
      fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true" focusable="false">
      {PATHS[kind]}
    </svg>
  );
}
