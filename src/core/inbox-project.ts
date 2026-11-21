/**
 * The Inbox is a real project: every task has one.
 *
 * Until 2026-11-21 a task with no project (`project: ''`) "lived in the Inbox", which had no
 * registry row, no name of its own and no settings. The user asked for every task to have a
 * project ("我觉得我们应该所有东西都应该有一个 project"), so the Inbox is now an ordinary
 * registry row named `Inbox`: local (never claimed by a sync service), never renamed or
 * deleted, its settings editable like any project's. Every write files a missing or empty
 * project there (task-db's taskToRow is the backstop), and the boot migration
 * (inbox-migration.ts) moves the rows an older build left empty.
 *
 * Pure and browser-safe: the web reads it through `@open-walnut/core`.
 */

/** The Inbox project's name (its registry key). */
export const INBOX_PROJECT = 'Inbox';

/**
 * True when `project` names the Inbox: the project itself (any case, as every project name
 * is), or the empty value an older build, an older client or a saved view still sends.
 */
export function isInboxProject(project: string | null | undefined): boolean {
  const name = (project ?? '').trim();
  return name === '' || name.toLowerCase() === 'inbox';
}

/** One project? Case-insensitive (as the registry's COLLATE NOCASE), and '' is the Inbox. */
export function sameProject(a: string | null | undefined, b: string | null | undefined): boolean {
  return projectOrInbox(a).toLowerCase() === projectOrInbox(b).toLowerCase();
}

/**
 * The project as the frozen /api/v1 says it (docs/reference/api-v1.md): `""` for the Inbox, as
 * before it was a project, so an installed phone app that shows one fixed Inbox entry and
 * filters on `""` keeps working. Writes and filters there take both.
 */
export function v1ProjectName(project: string | null | undefined): string {
  return isInboxProject(project) ? '' : (project ?? '').trim();
}

/** The project a write files `project` into: the Inbox (its own spelling) for a missing, empty
 *  or differently cased one, else the name trimmed. */
export function projectOrInbox(project: string | null | undefined): string {
  return isInboxProject(project) ? INBOX_PROJECT : (project ?? '').trim();
}
