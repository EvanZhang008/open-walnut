/**
 * Pure selection logic of the commit view (SessionCommitDialog): which files and
 * hunks start checked, toggling, and the payload / diff text built from a pick.
 *
 * The rule the view keeps: only what the daemon positively attributed to THIS
 * session starts checked. A hunk someone else wrote, or one whose writer is
 * unknown, starts unchecked and is marked; the user may still check it.
 */
import { ApiError } from '@/api/client';
import type { CommitHunk, CommitPlanFile, CommitPlanRepo, CommitSelection, FileOwner, HunkOwner } from '@/api/session-commit';

/** Per file: 'whole' (offered as one piece) or the set of chosen hunk ids. */
export type RepoSelection = Map<string, 'whole' | Set<string>>;

/** A file the view can split into hunk checkboxes. */
export function isSplittable(file: CommitPlanFile): boolean {
  return file.kind === 'text' && Array.isArray(file.hunks) && file.hunks.length > 0;
}

/** The checked state when the view opens: this session's hunks and files only. */
export function defaultSelection(repo: CommitPlanRepo): RepoSelection {
  const sel: RepoSelection = new Map();
  for (const f of repo.files) {
    if (!f.session) continue;
    if (isSplittable(f)) {
      const mine = new Set((f.hunks ?? []).filter((h) => h.owner === 'mine').map((h) => h.id));
      if (mine.size) sel.set(f.path, mine);
    } else if (f.owner === 'mine') {
      sel.set(f.path, 'whole');
    }
  }
  return sel;
}

export function fileCheckState(file: CommitPlanFile, sel: RepoSelection): 'all' | 'some' | 'none' {
  const s = sel.get(file.path);
  if (!s) return 'none';
  if (s === 'whole') return 'all';
  const total = file.hunks?.length ?? 0;
  if (s.size === 0) return 'none';
  return s.size >= total ? 'all' : 'some';
}

/** Check or uncheck a whole file (all its hunks). A partly checked file becomes fully checked. */
export function toggleFile(file: CommitPlanFile, sel: RepoSelection): RepoSelection {
  const next: RepoSelection = new Map(sel);
  if (fileCheckState(file, sel) === 'all') {
    next.delete(file.path);
  } else if (isSplittable(file)) {
    next.set(file.path, new Set((file.hunks ?? []).map((h) => h.id)));
  } else {
    next.set(file.path, 'whole');
  }
  return next;
}

export function toggleHunk(file: CommitPlanFile, hunkId: string, sel: RepoSelection): RepoSelection {
  const next: RepoSelection = new Map(sel);
  const cur = sel.get(file.path);
  const set = new Set(cur instanceof Set ? cur : cur === 'whole' ? (file.hunks ?? []).map((h) => h.id) : []);
  if (set.has(hunkId)) set.delete(hunkId); else set.add(hunkId);
  if (set.size) next.set(file.path, set); else next.delete(file.path);
  return next;
}

/** Checked hunks of a file, in file order. */
export function chosenHunks(file: CommitPlanFile, sel: RepoSelection): CommitHunk[] {
  const s = sel.get(file.path);
  if (!s || !file.hunks) return [];
  if (s === 'whole') return file.hunks;
  return file.hunks.filter((h) => s.has(h.id));
}

/** The commit request's `selections`: whole files, or the chosen hunks themselves. */
export function buildSelections(repo: CommitPlanRepo, sel: RepoSelection): CommitSelection[] {
  const out: CommitSelection[] = [];
  for (const f of repo.files) {
    const s = sel.get(f.path);
    if (!s) continue;
    if (isSplittable(f)) {
      const hunks = chosenHunks(f, sel);
      if (hunks.length) out.push({ path: f.path, mode: 'hunks', hunks });
    } else {
      out.push({ path: f.path, mode: 'whole' });
    }
  }
  return out;
}

export function selectedCount(repo: CommitPlanRepo, sel: RepoSelection): { files: number; hunks: number } {
  let files = 0;
  let hunks = 0;
  for (const f of repo.files) {
    const st = fileCheckState(f, sel);
    if (st === 'none') continue;
    files++;
    hunks += isSplittable(f) ? chosenHunks(f, sel).length : 0;
  }
  return { files, hunks };
}

function strip(line: string): string {
  return line.replace(/\r?\n$/, '');
}

/** One hunk as unified-diff lines (context ' ', removed '-', added '+'). */
export function hunkDiffLines(h: CommitHunk): Array<{ sign: ' ' | '-' | '+'; text: string }> {
  return [
    ...h.before.map((t) => ({ sign: ' ' as const, text: strip(t) })),
    ...h.oldLines.map((t) => ({ sign: '-' as const, text: strip(t) })),
    ...h.newLines.map((t) => ({ sign: '+' as const, text: strip(t) })),
    ...h.after.map((t) => ({ sign: ' ' as const, text: strip(t) })),
  ];
}

/** The selected change as diff text for the "Suggest" model call, clipped to `max` chars. */
export function selectedDiffText(repo: CommitPlanRepo, sel: RepoSelection, max = 20_000): { diff: string; files: string[] } {
  const parts: string[] = [];
  const files: string[] = [];
  for (const f of repo.files) {
    if (fileCheckState(f, sel) === 'none') continue;
    files.push(f.path);
    if (!isSplittable(f)) {
      parts.push(`--- ${f.path} (${f.status}, ${f.kind === 'deleted' ? 'deleted' : 'whole file'})`);
      continue;
    }
    parts.push(`--- a/${f.path}\n+++ b/${f.path}`);
    for (const h of chosenHunks(f, sel)) {
      parts.push(`@@ -${h.oldStart + 1},${h.oldLines.length} +${h.newStart + 1},${h.newLines.length} @@`);
      parts.push(hunkDiffLines(h).map((l) => l.sign + l.text).join('\n'));
    }
  }
  const diff = parts.join('\n');
  return { diff: diff.length > max ? diff.slice(0, max) : diff, files };
}

export function hunkOwnerLabel(owner: HunkOwner): string {
  if (owner === 'mine') return 'This session';
  if (owner === 'other') return 'Not this session';
  if (owner === 'mixed') return 'Mixed writers';
  return 'Writer unknown';
}

export function fileOwnerLabel(owner: FileOwner): string {
  if (owner === 'mine') return 'This session';
  if (owner === 'mixed') return 'Mixed';
  if (owner === 'other') return 'Not this session';
  return 'Writer unknown';
}

/** Why a session file cannot be split (shown beside it). */
export function fileKindNote(file: CommitPlanFile): string | null {
  switch (file.kind) {
    case 'binary': return 'Binary file, committed whole';
    case 'large': return 'Too large to split, committed whole';
    case 'symlink': return 'Symlink';
    case 'filtered': return 'Stored through a git filter, committed whole';
    case 'deleted': return 'Deleted';
    default: return null;
  }
}

/** Why the daemon claimed less of a session file than the session may have written. */
export function reasonNote(reason?: string): string | null {
  if (reason === 'partial') return 'Some of its edits could not be matched to the file, so they are not claimed';
  if (reason === 'shell') return 'A shell command wrote part of this file, so those lines are not claimed';
  if (reason === 'too-large') return 'The diff is too large to attribute line by line';
  if (reason === 'replay') return "The session's edits could not be replayed against the file";
  return null;
}

export function stepLabel(step: string): string {
  switch (step) {
    case 'queued': case 'starting': case 'checking': return 'Checking the repository';
    case 'building': return 'Building the commit';
    case 'pre-commit': return 'Running the pre-commit hook';
    case 'commit-msg': return 'Running the commit-msg hook';
    case 'committing': return 'Committing';
    case 'updating-index': return 'Updating the index';
    case 'pushing': return 'Pushing';
    case 'creating-pr': return 'Opening the pull request';
    default: return step;
  }
}

export function errorText(err: unknown): string {
  if (err instanceof ApiError) return err.message || `Request failed (${err.status})`;
  return err instanceof Error ? err.message : String(err);
}
