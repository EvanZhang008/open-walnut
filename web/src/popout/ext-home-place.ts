/**
 * Where the extension's first page starts its next task: the folder, host and project the last
 * task started there took (2026-11-10, the user: "we need to be able to choose which folder"; the
 * composer's launch bar picks them, and the next task starts in the same place until another pick).
 *
 * Kept in this browser only (one small localStorage key), never the words. A place with no folder
 * is no place: the task then works in its own directory and files in the Inbox, as before.
 */
import type { DraftColumn } from '@/components/sessions/draft-column';
import type { HandedLaunch, HandedPlace } from './ext-panel-model';

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

/** Where this draft starts now, for the popup to hand over with its question (createCwd included: it is this launch's). */
export function launchPlaceOf(d: DraftColumn): HandedPlace {
  const project = d.projectSource === 'folder' || d.projectSource === 'user' ? d.projectSource : undefined;
  return {
    cwd: d.cwd, host: d.host ?? null,
    ...(d.hostLabel ? { hostLabel: d.hostLabel } : {}),
    ...(project ? { project: d.project ?? '', projectSource: project } : {}),
    ...(d.cwd && d.createCwd ? { createCwd: true } : {}),
  };
}

/**
 * The draft as the popup's launch left it: its mode, model, engine and Sync pick over the meta, and
 * its place in full (no place handed: the draft keeps its own). The side panel launches this, and
 * makes it its own draft, so the next task and a retry of a failed one start there too.
 */
export function withHandedLaunch(d: DraftColumn, l: HandedLaunch): DraftColumn {
  const meta = {
    ...d.meta,
    ...(l.mode ? { mode: l.mode } : {}),
    ...(l.model ? { model: l.model } : {}),
    ...(l.engine ? { engine: l.engine as DraftColumn['meta']['engine'] } : {}),
    ...(l.sync ? { sync: l.sync } : {}),
  };
  if (!l.place) return { ...d, meta };
  const p = l.place;
  const { hostLabel: _h, project: _p, projectSource: _s, ...rest } = d;
  return {
    ...rest, meta,
    cwd: p.cwd, host: p.host, cwdPinned: !!p.cwd, createCwd: p.createCwd === true,
    ...(p.hostLabel ? { hostLabel: p.hostLabel } : {}),
    ...(p.projectSource ? { project: p.project ?? '', projectSource: p.projectSource } : {}),
  };
}
