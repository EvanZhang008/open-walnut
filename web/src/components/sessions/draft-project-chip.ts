/**
 * The draft launch bar's Project chip and the More menu's Project section, as
 * pure data: which words to show and what a click does. No React.
 *
 * The project is not a question the bar asks up front any more: it follows the
 * folder (projectForFolderPick), so the row only STATES it once there is one,
 * and the change control lives in More. A project Start will create is said in
 * so many words ("New project: x"), because creating one is a write.
 */
import type { DraftColumn, FolderClaim } from './draft-column';

type ChipDraft = Pick<DraftColumn, 'project' | 'projectSource' | 'taskId' | 'forkOf' | 'walnut' | 'cwd' | 'aiFields'>;

/** What a click on the chip does. `menu`: opens the draft menu (plain drafts).
 *  `flyout`: opens the project list directly (drafts without More). `none`: a
 *  fact, not a choice (fork). */
export type DraftProjectChipAction = 'menu' | 'flyout' | 'none';

export interface DraftProjectChipModel {
  /** The muted key in front of the name. */
  key: 'Project:' | 'New project:';
  /** '' never reaches here: Inbox is spelled out. */
  name: string;
  isNew: boolean;
  ai: boolean;
  action: DraftProjectChipAction;
  title: string;
}

export interface DraftProjectCtx {
  isKnownProject: (name: string) => boolean;
  /** The draft shows More (and so the Project section lives there). */
  hasMenu: boolean;
  /** What the registry says about a folder (draft-column's folderClaim). Lets
   *  the copy name the folder that actually set the project. */
  claimFor?: (cwd: string) => FolderClaim;
}

function folderName(cwd: string): string {
  return cwd.replace(/\/+$/, '').split('/').pop() || cwd;
}

/** The PARENT folder a folder-set project came from, or null when the picked
 *  folder declares it itself (or the claim no longer matches the row). Saying
 *  "Set by the folder x" for a project x's parent declared is what made a
 *  subfolder's task look deliberately filed somewhere unrelated. */
function inheritedFrom(draft: ChipDraft, claimFor: DraftProjectCtx['claimFor']): string | null {
  if (draft.projectSource !== 'folder' || !draft.project || !draft.cwd || !claimFor) return null;
  const claim = claimFor(draft.cwd);
  if (claim.kind !== 'owned' || !claim.inherited) return null;
  return claim.project.toLowerCase() === draft.project.toLowerCase() ? claim.folder : null;
}

/** Start will create this project (same rule the old pill's "new" badge used). */
export function draftProjectIsNew(draft: ChipDraft, isKnownProject: (name: string) => boolean): boolean {
  return !draft.taskId && !draft.forkOf && !draft.walnut && !!draft.project && !isKnownProject(draft.project);
}

/**
 * The chip, or null when the row says nothing about the project.
 *
 * Shown once a project is set by anyone, including an explicit Inbox pick (''
 * with source 'user'): a choice the user made must stay visible. A bound or fork
 * draft always shows it, since its task already has a project.
 */
export function draftProjectChip(draft: ChipDraft, ctx: DraftProjectCtx): DraftProjectChipModel | null {
  if (draft.walnut) return null;
  const name = draft.project || 'Inbox';
  if (draft.forkOf) {
    return {
      key: 'Project:', name, isNew: false, ai: false, action: 'none',
      title: 'The forked task files as a sibling of the source task, in its project',
    };
  }
  if (draft.taskId) {
    return {
      key: 'Project:', name, isNew: false, ai: false, action: 'flyout',
      title: `This task is filed under ${name}. Picking another project moves the task now.`,
    };
  }
  if (!draft.project && draft.projectSource !== 'user') return null;
  const isNew = draftProjectIsNew(draft, ctx.isKnownProject);
  const ai = !!draft.aiFields?.has('project');
  const where = ctx.hasMenu ? 'Change it in More.' : 'Click to change it.';
  const create = `Starting creates a new project named ${name}.`;
  let title: string;
  if (ai) {
    title = isNew
      ? `Walnut picked a new project, ${name}, from what you typed. Starting creates it. ${where}`
      : `Walnut picked ${name} from what you typed. ${where}`;
  } else if (draft.projectSource === 'user') {
    title = draft.project ? `Your pick. ${where}` : `Your pick: no project. ${where}`;
  } else if (draft.projectSource === 'seed') {
    title = `${isNew ? `${create} ` : ''}Set when this draft opened. ${where}`;
  } else {
    const parent = inheritedFrom(draft, ctx.claimFor);
    title = isNew ? `${create} ${where}`
      : parent ? `Tasks in ${folderName(parent)} and the folders inside it file under ${name}. ${where}`
      : `Tasks from this folder file under ${name}. ${where}`;
  }
  return {
    key: isNew ? 'New project:' : 'Project:', name, isNew, ai,
    action: ctx.hasMenu ? 'menu' : 'flyout', title,
  };
}

/** The More menu's one-line "why this project" under the Project row. */
export function draftProjectProvenance(
  draft: ChipDraft,
  isKnownProject: (name: string) => boolean,
  claimFor?: DraftProjectCtx['claimFor'],
): string {
  const isNew = draftProjectIsNew(draft, isKnownProject);
  if (draft.aiFields?.has('project')) {
    return isNew ? "Walnut's pick from what you typed, created when you start" : "Walnut's pick from what you typed";
  }
  if (draft.projectSource === 'user') return draft.project ? 'Your pick' : 'Your pick: no project';
  if (draft.projectSource === 'seed') return 'Set when this draft opened';
  if (draft.project && draft.projectSource === 'folder') {
    if (isNew) return 'New, created when you start (named after the folder)';
    const parent = inheritedFrom(draft, claimFor);
    return parent ? `Set by the parent folder ${folderName(parent)}` : `Set by the folder ${folderName(draft.cwd)}`;
  }
  if (draft.project) return isNew ? 'New, created when you start' : '';
  // A folder two projects declare sets none; say why instead of implying no
  // folder was picked.
  const claim = draft.cwd && claimFor ? claimFor(draft.cwd) : undefined;
  if (claim?.kind === 'ambiguous') return `Inbox: ${claim.projects.length} projects use the folder ${folderName(claim.folder)}`;
  return 'Inbox until you pick a folder or a project';
}
