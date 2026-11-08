/**
 * A New task starts in the home folder when nobody picked one (2026-11-11, the user: "Files and
 * New task default to the HOME directory"). Before, a fresh draft opened with no folder, the
 * first Send opened "Choose folder and host", and every later New task needed a click on the
 * "~ · Local" chip.
 *
 * The default is a fact, not a guess: it is the same folder on every open (this machine's home),
 * so the pill reads "Folder/Host: ~ · Local" before Send and a click on it still changes it. It is
 * not a pin (`cwdPinned` stays false), so a project's own folder, a task's folder or the AI's
 * pick from the typed words still moves it. It names no project: the draft stays in the Inbox
 * until the user or the folder rule picks one (the 2026-09-02 rule that a fresh draft never
 * pre-picks a project still holds).
 *
 * The absolute home when this window knows it (the working-dirs answer's `localHome`, so the
 * quick chip and the folder's launch memory match), else `~`, which the launch route expands for
 * a local start.
 */
import { knownHomeOf } from '@/utils/home-folder';
import { withDirLaunchMemory, type DraftColumn } from './draft-column';

/** The folder a New task with no pick starts in: this machine's home. */
export function homeDraftFolder(): string {
  return knownHomeOf(null) ?? '~';
}

/** True for a draft that launches into a folder of its own choosing (not an Ask, a fork or a lead's chat). */
function takesHomeDefault(d: DraftColumn): boolean {
  return !d.cwd && !d.walnut && !d.forkOf && !d.orgLead;
}

/** `d` in the home folder when it has no folder yet; any other draft unchanged. */
export function withHomeFolder(d: DraftColumn): DraftColumn {
  if (!takesHomeDefault(d)) return d;
  const cwd = homeDraftFolder();
  return {
    ...d,
    cwd,
    host: null,
    hostLabel: undefined,
    cwdPinned: false,
    // A 'clear' of an AI folder goes back here, not to no folder.
    openedCwd: cwd,
    openedHost: null,
    meta: d.metaTouched ? d.meta : withDirLaunchMemory(d.meta, cwd, null),
  };
}

/**
 * True while the draft's folder is still the home default nobody chose: not pinned by a pick, and
 * still the folder it opened on. Its folder picker then opens on the recent folders, as it did for
 * a draft with no folder, not in edit mode on the home's listing (the picker's "edit this
 * selection" view is for a folder that was chosen; the home default stands in for no choice).
 */
export function onHomeDefault(d: Pick<DraftColumn, 'cwd' | 'host' | 'cwdPinned' | 'openedCwd'>): boolean {
  return !d.cwdPinned && !d.host && !!d.cwd && d.cwd === d.openedCwd && (d.cwd === homeDraftFolder() || d.cwd === '~');
}
