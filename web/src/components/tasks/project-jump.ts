/**
 * A click on the project name of a task row (2026-11-03, the user: "if user click the project I
 * thik it shoud do a filter on the project show all in this project", then "and kind of expand
 * all secitino"). The panel's own Project filter takes that one project, the view shows every
 * task of it in the tab the user is on (every status section open), and clearing the Project chip
 * puts the sections' open state back, which the jump never writes. A tab the user picks inside the
 * jump stays theirs when it ends; with none picked, the tab is the one the click came from. The
 * sections' folds inside a jump live in a fold store of their own (TodoPanel, LS_JUMP_SECTIONS_KEY),
 * opened whole when a jump starts and folded by the one fold rule (section-fold-rule.ts).
 *
 * The tab stays (2026-11-04, the user: "if I click the project name in one pin group, should keep
 * in the same pin group, people can go to all if they need, we don't auto go to all"): the jump
 * filters the group the click came from, and the tab bar's All count says what else there is.
 *
 * This file is the pure half: what a jump holds and when it is still on. TodoPanel keeps it
 * with usePageView, so a reload while it is on comes back the same, as the filter does.
 */
export interface ProjectJump {
  /** The project the row named; `''` = Inbox. */
  project: string;
  /** A tab picked while the jump is on (null = the saved tab, the one the click came from). */
  section: string | null;
}

export function startProjectJump(project: string, prev: ProjectJump | null): ProjectJump {
  return { project, section: prev?.section ?? null };
}

/** The jump is on while the Project filter is exactly its project; any other set (cleared, widened, another project) ends it. */
export function projectJumpHolds(jump: ProjectJump | null, projects: readonly string[]): jump is ProjectJump {
  return !!jump && projects.length === 1 && projects[0] === jump.project;
}

/** The view the panel shows while the jump is on: the tab picked inside it, else the saved tab. */
export function projectJumpSection(jump: ProjectJump, saved: string): string {
  return jump.section ?? saved;
}

export function isProjectJump(v: unknown): v is ProjectJump | null {
  if (v === null) return true;
  if (!v || typeof v !== 'object') return false;
  const j = v as Partial<ProjectJump>;
  return typeof j.project === 'string'
    && (j.section === null || typeof j.section === 'string');
}
