/**
 * Where the extension's first page starts its next task: the folder, host and project the last
 * task started there took (2026-11-10, the user: "we need to be able to choose which folder"; the
 * composer's launch bar picks them, and the next task starts in the same place until another pick).
 *
 * Kept in this browser only (one small localStorage key), never the words. A place with no folder
 * is no place: the task then works in its own directory and files in the Inbox, as before.
 */
import type { DraftColumn } from '@/components/sessions/draft-column';

export const HOME_PLACE_KEY = 'walnut-ext-home-place';

/** The part of a draft row that says where its task starts. */
export type HomePlace = Pick<DraftColumn, 'cwd' | 'host'> & Partial<Pick<DraftColumn, 'hostLabel' | 'project' | 'projectSource' | 'cwdPinned'>>;

const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.length <= max ? v : undefined);

/** A stored place, read strictly: anything malformed is no place. */
export function parseHomePlace(raw: string | null): HomePlace | null {
  if (!raw) return null;
  let o: unknown;
  try { o = JSON.parse(raw); } catch { return null; }
  if (!o || typeof o !== 'object') return null;
  const r = o as Record<string, unknown>;
  const cwd = str(r.cwd, 4096) ?? '';
  const project = str(r.project, 200);
  // A project the person picked with no folder still counts; a folder-made one goes with its folder.
  const userProject = r.projectSource === 'user' && project !== undefined;
  if (!cwd && !userProject) return null;
  const host = str(r.host, 300) || null;
  const hostLabel = str(r.hostLabel, 300);
  return {
    cwd, host,
    ...(cwd ? { cwdPinned: true } : {}),
    ...(hostLabel ? { hostLabel } : {}),
    ...(project !== undefined && (cwd || userProject) ? { project, projectSource: (r.projectSource === 'user' ? 'user' : 'folder') as DraftColumn['projectSource'] } : {}),
  };
}

/** The place a launch took, to keep: its folder and host, and the project when a folder or the person set it. */
export function homePlaceOf(d: DraftColumn): HomePlace | null {
  const userProject = d.projectSource === 'user';
  if (!d.cwd && !userProject) return null;
  return {
    cwd: d.cwd, host: d.host ?? null,
    ...(d.hostLabel ? { hostLabel: d.hostLabel } : {}),
    ...((d.cwd && d.projectSource === 'folder') || userProject ? { project: d.project ?? '', projectSource: d.projectSource } : {}),
  };
}

function storage(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

export function readHomePlace(): HomePlace | null {
  try { return parseHomePlace(storage()?.getItem(HOME_PLACE_KEY) ?? null); } catch { return null; }
}

/** Keep where this launch started; a launch with no place forgets the last one. */
export function writeHomePlace(d: DraftColumn): void {
  const place = homePlaceOf(d);
  try {
    const ls = storage();
    if (!ls) return;
    if (place) ls.setItem(HOME_PLACE_KEY, JSON.stringify(place));
    else ls.removeItem(HOME_PLACE_KEY);
  } catch { /* storage off or full: the next task starts in its own folder */ }
}
