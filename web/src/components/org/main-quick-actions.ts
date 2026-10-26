/**
 * Main's quick actions: one click asks Main, the main agent, to tidy the user's work.
 * Each action is one message to Main's session. Every message says the same thing about
 * changes: Main first answers with a numbered list of what it would change, and changes
 * nothing until the user names the items to apply. Pure, so the wording is tested.
 */

export type MainQuickActionId = 'projects' | 'place' | 'triage';

export interface MainQuickAction {
  id: MainQuickActionId;
  label: string;
  /** One line under the label in the menu, and the button's tooltip. */
  hint: string;
}

export const MAIN_QUICK_ACTIONS: readonly MainQuickAction[] = [
  { id: 'projects', label: 'Tidy projects', hint: 'Suggest projects to merge, rename or remove' },
  { id: 'place', label: 'Put tasks in place', hint: 'Find tasks in the wrong project or folder' },
  { id: 'triage', label: 'Triage', hint: 'Stale, duplicate and finished tasks; priorities' },
];

/** What the user is told under the actions: nothing changes on the click itself. */
export const MAIN_QUICK_ACTIONS_NOTE = 'The CEO replies with a list first. Nothing changes until you pick what to apply.';

/** Where the action looks: everything, or one project ('' is the Inbox). */
export type MainQuickActionScope = { project: string } | undefined;

const LEAVE_ALONE = 'Leave Main, the project leads and the Ask projects where they are.';

const CONFIRM = [
  'Do the looking yourself with read calls only: do not message, create, start or edit any task or project until I answer.',
  'Reply with a short numbered list of what you would change, and wait.',
  'I will answer with the numbers to apply (or "all"); then apply exactly those and tell me what changed.',
  'Answer in the language we usually talk in.',
].join(' ');

function scopeLine(scope: MainQuickActionScope): string {
  if (!scope) return '';
  return scope.project ? `Only look at the project "${scope.project}".` : 'Only look at the Inbox (tasks with no project).';
}

function body(id: MainQuickActionId): { head: string; what: string } {
  switch (id) {
    case 'projects':
      return {
        head: 'Quick action: tidy my projects.',
        what: 'Look at every project with its folders and open tasks (project_list, folder_list, task_list). '
          + 'Find projects to merge (the same area, or one that is part of another), to rename, or to remove (empty, or only finished work). '
          + 'For each item say what changes, why, and how many tasks move; say so when a project is synced from another service.',
      };
    case 'place':
      return {
        head: 'Quick action: put my tasks in the right place.',
        what: 'Go through my open tasks (task_list) and find the ones in the wrong project or folder, the Inbox included: '
          + 'a task whose title and description belong to another project, or related tasks that should share a folder. '
          + 'Group the list by where the tasks go: the task, where it is now, where it should go, and why in a few words.',
      };
    case 'triage':
      return {
        head: 'Quick action: triage my open tasks.',
        what: 'Find tasks that are stale (no movement for weeks), duplicates, or already done but still open, and priorities that look wrong '
          + '(the walnut-triage skill says what to look for; group as below). '
          + 'Group the list by action (close, merge, change priority): the task, the action, and why in a few words. '
          + 'Then name the few I should do now.',
      };
  }
}

/** The message Main receives for one action. */
export function quickActionMessage(id: MainQuickActionId, scope?: MainQuickActionScope): string {
  const { head, what } = body(id);
  const where = id === 'projects' ? '' : scopeLine(scope);
  return [head, [where, what].filter(Boolean).join(' '), `${LEAVE_ALONE} ${CONFIRM}`].join('\n\n');
}

/** The actions that make sense for a scope: one project has no projects to merge. */
export function quickActionsFor(scope?: MainQuickActionScope): readonly MainQuickAction[] {
  return scope ? MAIN_QUICK_ACTIONS.filter((a) => a.id !== 'projects') : MAIN_QUICK_ACTIONS;
}
