// Display only; stored project names remain the filter and API keys.
// Relative import: the markdown test tier has no @open-walnut aliases.
import { askProjectDisplay } from '../../../src/core/sessions/ask-list';
import { orgDisplayTitle } from '../../../src/core/org/org-tree';

export function projectDisplayName(project: string | undefined | null): string {
  const name = project ?? '';
  return name === '' ? 'Inbox' : askProjectDisplay(name);
}

/** What owns a session: its task, or at least the project the session record carries. */
export interface SessionOwner { title?: string; project?: string; org_role?: string; org_name?: string }

/** A session's title as shown: the CEO's or a VP's session reads as its node, and a session named
 *  after its agent's project (an ask's placeholder) reads as that project's display name. */
export function sessionDisplayName(title: string, owner?: SessionOwner | null): string {
  if (owner?.org_role === 'main' || owner?.org_role === 'lead') {
    return orgDisplayTitle({ title: owner.title ?? title, project: owner.project, org_role: owner.org_role, org_name: owner.org_name });
  }
  const project = owner?.project;
  return project && title.trim().toLowerCase() === project.trim().toLowerCase() ? projectDisplayName(title) : title;
}

/** A note's reference to a task: "<project> / <task>", or the task alone where the two read the
 *  same (an ask's placeholder, "Quick question · Mentor", once and not twice). */
export function taskReferenceLabel(task: { title: string; project?: string; org_role?: string; org_name?: string }): string {
  const title = orgDisplayTitle(task);
  if (!task.project) return title;
  const project = projectDisplayName(task.project);
  return project.toLowerCase() === title.toLowerCase() ? title : `${project} / ${title}`;
}

/** The place a task is shown to live: the main task sits in the org (its stored project is the ask
 *  project it chats in, which would read "Quick question" over "CEO"); any other task, its project. */
export function taskProjectLabel(task: { project?: string; org_role?: string }): string {
  return task.org_role === 'main' ? 'Org' : projectDisplayName(task.project);
}
