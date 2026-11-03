/**
 * A click on the project name of a task row (2026-11-03, the user: "if user click the project I
 * thik it shoud do a filter on the project show all in this project", then "and kind of expand
 * all secitino"). The panel's own Project filter takes that one project, the view shows every
 * task of it (the All view, every status section open), and clearing the Project chip puts the
 * view back as it was: the tab, and the sections' open state, neither of which the jump writes.
 *
 * This file is the pure half: what a jump holds and when it is still on. TodoPanel keeps it
 * with usePageView, so a reload while it is on comes back the same, as the filter does.
 */
import { STATUS_SECTION_ORDER, type StatusSectionKey } from './status-sections';

export interface ProjectJump {
  /** The project the row named; `''` = Inbox. */
  project: string;
  /** The status sections' open state while the jump is on: all open at the start, then the user's own folds. */
  open: Record<StatusSectionKey, boolean>;
  /** A tab picked while the jump is on (null = the All view); the saved tab is left alone. */
  section: string | null;
}

export function allSectionsOpen(): Record<StatusSectionKey, boolean> {
  return Object.fromEntries(STATUS_SECTION_ORDER.map((k) => [k, true])) as Record<StatusSectionKey, boolean>;
}

export function startProjectJump(project: string, prev: ProjectJump | null): ProjectJump {
  return { project, open: allSectionsOpen(), section: prev?.section ?? null };
}

/** The jump is on while the Project filter is exactly its project; any other set (cleared, widened, another project) ends it. */
export function projectJumpHolds(jump: ProjectJump | null, projects: readonly string[]): jump is ProjectJump {
  return !!jump && projects.length === 1 && projects[0] === jump.project;
}

/** The view the panel shows while the jump is on. */
export function projectJumpSection(jump: ProjectJump): string {
  return jump.section ?? 'all';
}

export function isProjectJump(v: unknown): v is ProjectJump | null {
  if (v === null) return true;
  if (!v || typeof v !== 'object') return false;
  const j = v as Partial<ProjectJump>;
  return typeof j.project === 'string'
    && (j.section === null || typeof j.section === 'string')
    && !!j.open && typeof j.open === 'object'
    && STATUS_SECTION_ORDER.every((k) => typeof (j.open as Record<string, unknown>)[k] === 'boolean');
}
