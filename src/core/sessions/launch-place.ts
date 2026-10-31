/**
 * Which recorded folder a start on a host may take when it names none (2026-10-31: a
 * lead on the Mac created a task with host "clouddev" and no cwd; the start took the
 * lead's Mac folder through the parent chain and died on "Working directory no longer
 * exists on clouddev: /Users/...").
 *
 * A task stores a cwd but no host, and so does a project's `default_cwd`: both are
 * folders on the project's default host. A folder rides only to the host it lives on:
 *   - a task's (or an ancestor's) recorded cwd lives on the host one of that task's
 *     sessions ran in it, else on the project's default host, or on the named host when
 *     that folder exists there (a cwd someone set for it before any session ran);
 *   - `default_cwd` lives on `default_host`.
 * A start that names another host takes neither: it runs in the task's own directory
 * there (the host's daemon makes it), never in a path from another machine.
 *
 * Every place that fills a launch cwd from the record goes through here; the ratchet
 * tests/core/sessions/launch-place-ratchet.test.ts fails on a new one that does not.
 */
import { normalizeHost } from '../transfer/planner.js';
import type { Task } from '../types.js';

type Chain = Pick<Task, 'id' | 'project' | 'cwd' | 'parent_task_id' | 'workspace'>;

/** The host `cwd` (recorded on task `ownerId`) lives on: where its sessions ran in it, else the project's default host. */
export async function hostOfRecordedCwd(ownerId: string, cwd: string, defaultHost: string | undefined): Promise<string> {
  try {
    const { getSessionsForTask } = await import('../session-tracker.js');
    const dir = cwd.replace(/\/+$/, '');
    const ran = (await getSessionsForTask(ownerId))
      .filter((s) => s.cwd && (s.cwd === dir || s.cwd.startsWith(`${dir}/`)))
      .sort((a, b) => (b.lastActiveAt ?? b.startedAt ?? '').localeCompare(a.lastActiveAt ?? a.startedAt ?? ''));
    if (ran[0]) return normalizeHost(ran[0].host);
  } catch { /* no session store: the default host */ }
  return normalizeHost(defaultHost);
}

/**
 * The task's recorded cwd (its own, else the nearest ancestor's in the same project,
 * a ready workspace first), when it lives on `host`; undefined otherwise.
 */
export async function recordedCwdOnHost(task: Chain, host: string | undefined, defaultHost: string | undefined): Promise<string | undefined> {
  const { recordedPlace } = await import('./task-start.js');
  const place = await recordedPlace(task);
  if (!place) return undefined;
  // A ready workspace names its own host (workspaceStartPlace); the rest live on the default host or where they ran.
  const lives = place.host ?? await hostOfRecordedCwd(place.ownerId, place.cwd, defaultHost);
  if (lives === normalizeHost(host)) return place.cwd;
  // A folder set for that host before any session ran in it: there when it exists there.
  return !place.host && await folderExistsOn(host, place.cwd) ? place.cwd : undefined;
}

type ExistsProbe = (host: string, dir: string) => Promise<boolean>;
let existsProbe: ExistsProbe | null = null;
/** Test seam: whether a folder exists on a host. */
export function __setFolderExistsForTesting(p: ExistsProbe | null): void { existsProbe = p; }

/** Whether `dir` is a folder on `host`, asked of its daemon within 3 s; false when it cannot say. */
async function folderExistsOn(host: string | undefined, dir: string): Promise<boolean> {
  const h = normalizeHost(host);
  if (existsProbe) return existsProbe(h, dir);
  try {
    if (h === '__local__') return (await import('node:fs')).existsSync(dir);
    const { DaemonFileReader } = await import('../daemon-file-reader.js');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const st = await Promise.race([
      new DaemonFileReader(h).stat(dir),
      new Promise<null>((r) => { timer = setTimeout(() => r(null), 3_000); timer.unref?.(); }),
    ]);
    if (timer) clearTimeout(timer);
    return !!st;
  } catch {
    return false;
  }
}

/** Where a start that names no host runs from the record: the folder, and the host when the record names one (a ready workspace). */
export async function unnamedStartPlace(task: Chain): Promise<{ cwd: string; host?: string } | undefined> {
  const { recordedPlace } = await import('./task-start.js');
  const place = await recordedPlace(task);
  return place ? { cwd: place.cwd, ...(place.host ? { host: place.host } : {}) } : undefined;
}

/** The project's default_cwd, when the start runs on its default_host. */
export function defaultCwdOnHost(meta: { default_cwd?: string; default_host?: string } | null | undefined, host: string | undefined): string | undefined {
  if (!meta?.default_cwd) return undefined;
  return normalizeHost(meta.default_host) === normalizeHost(host) ? meta.default_cwd : undefined;
}
