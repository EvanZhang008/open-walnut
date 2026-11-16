/**
 * Which recorded folder a start on a host may take when it names none (2026-10-31: a
 * lead on the Mac created a task with host "clouddev" and no cwd; the start took the
 * lead's Mac folder through the parent chain and died on "Working directory no longer
 * exists on clouddev: /Users/...").
 *
 * A task stores a cwd but no host, and so does a project's `default_cwd`: both are
 * folders on the project's default host. A folder rides only to the host it lives on:
 *   - a task's (or an ancestor's) recorded cwd lives on the host one of that task's
 *     sessions ran in it; a cwd no session ran in yet lives on this Mac (the machine the
 *     server runs on) when the folder is here and the other host lacks it, else on the
 *     project's default host, or on the named host when that folder exists there (a cwd
 *     someone set for it before any session ran);
 *   - `default_cwd` lives on `default_host`.
 * 2026-11-16: the Walnut project's default_host moved from the Mac to clouddev, and two
 * tasks made days before, still waiting for a start, kept the Mac checkout as their cwd.
 * Read as a folder on the (new) default host, both starts died on "Working directory no
 * longer exists on clouddev". A folder missing everywhere still counts as the default
 * host's, so its start fails loudly (or create_cwd makes it) instead of moving elsewhere.
 * A start that names another host takes neither: it runs in the task's own directory
 * there (the host's daemon makes it), never in a path from another machine.
 *
 * Every place that fills a launch cwd from the record goes through here; the ratchet
 * tests/core/sessions/launch-place-ratchet.test.ts fails on a new one that does not.
 */
import { normalizeHost } from '../transfer/planner.js';
import type { Task } from '../types.js';

const LOCAL = '__local__';

type Chain = Pick<Task, 'id' | 'project' | 'cwd' | 'parent_task_id' | 'workspace'>;

/** The host a session of task `ownerId` last ran in `cwd` (or below it); undefined when none did. */
async function hostWhereRan(ownerId: string, cwd: string): Promise<string | undefined> {
  try {
    const { getSessionsForTask } = await import('../session-tracker.js');
    const dir = cwd.replace(/\/+$/, '');
    const ran = (await getSessionsForTask(ownerId))
      .filter((s) => s.cwd && (s.cwd === dir || s.cwd.startsWith(`${dir}/`)))
      .sort((a, b) => (b.lastActiveAt ?? b.startedAt ?? '').localeCompare(a.lastActiveAt ?? a.startedAt ?? ''));
    if (ran[0]) return normalizeHost(ran[0].host);
  } catch { /* no session store: nothing ran */ }
  return undefined;
}

/** The host `cwd` (recorded on task `ownerId`) lives on: where its sessions ran in it, else the project's default host. */
export async function hostOfRecordedCwd(ownerId: string, cwd: string, defaultHost: string | undefined): Promise<string> {
  return (await hostWhereRan(ownerId, cwd)) ?? normalizeHost(defaultHost);
}

/** Whether a recorded folder (task `ownerId`'s, no workspace) is a place on `host`. */
async function recordLivesOn(place: { cwd: string; ownerId: string }, host: string | undefined, defaultHost: string | undefined): Promise<boolean> {
  const h = normalizeHost(host);
  const ran = await hostWhereRan(place.ownerId, place.cwd);
  // Where its sessions ran, or the same path on `host`.
  if (ran !== undefined) return ran === h || (await folderOnHost(h, place.cwd)) === true;
  // No session ran in it yet: a folder on this Mac belongs here unless `host` has it too.
  if (h !== LOCAL && (await folderOnHost(LOCAL, place.cwd)) === true) return (await folderOnHost(h, place.cwd)) === true;
  // The default host's, or a folder set by hand on `host`.
  return normalizeHost(defaultHost) === h || (await folderOnHost(h, place.cwd)) === true;
}

/**
 * The task's recorded cwd (its own, else the nearest ancestor's in the same project,
 * a ready workspace first), when it lives on `host`; undefined otherwise.
 */
export async function recordedCwdOnHost(task: Chain, host: string | undefined, defaultHost: string | undefined): Promise<string | undefined> {
  const { recordedPlace } = await import('./task-start.js');
  const place = await recordedPlace(task);
  if (!place) return undefined;
  // A ready workspace names its own host (workspaceStartPlace).
  if (place.host) return place.host === normalizeHost(host) ? place.cwd : undefined;
  return await recordLivesOn(place, host, defaultHost) ? place.cwd : undefined;
}

type ExistsProbe = (host: string, dir: string) => Promise<boolean | undefined>;
let existsProbe: ExistsProbe | null = null;
/** Test seam: whether a folder exists on a host. */
export function __setFolderExistsForTesting(p: ExistsProbe | null): void { existsProbe = p; }

const probed = new Map<string, { at: number; is: boolean }>();
/**
 * Whether `dir` is a folder on `host`: on this Mac a stat; elsewhere asked of the host's daemon
 * within 3 s, a folder found kept 30 s (one start resolves its place several times); undefined when it
 * cannot say.
 */
async function folderOnHost(host: string | undefined, dir: string): Promise<boolean | undefined> {
  const h = normalizeHost(host);
  if (existsProbe) return existsProbe(h, dir);
  if (h === LOCAL) {
    try { return (await import('node:fs')).statSync(dir).isDirectory(); } catch { return false; }
  }
  const key = `${h}\0${dir}`;
  const hit = probed.get(key);
  if (hit && Date.now() - hit.at < 30_000) return hit.is;
  let is: boolean | undefined;
  try {
    const { DaemonFileReader } = await import('../daemon-file-reader.js');
    let timer: ReturnType<typeof setTimeout> | undefined;
    is = await Promise.race([
      new DaemonFileReader(h).stat(dir).then((st) => !!st),
      new Promise<undefined>((r) => { timer = setTimeout(() => r(undefined), 3_000); timer.unref?.(); }),
    ]);
    if (timer) clearTimeout(timer);
  } catch {
    is = undefined;
  }
  // Only a folder found is kept: one made a moment later, or a host back from a reconnect, is asked again.
  if (is) { if (probed.size > 500) probed.clear(); probed.set(key, { at: Date.now(), is }); }
  return is;
}

/**
 * An ancestor's recorded folder gives way to the session that creates the task when
 * that session runs on another host (2026-11-05: a worker on clouddev created a review
 * task; its lead's Mac folder came down the parent chain, the start took the Mac, and
 * load placement sent it to another Mac without the brief the worker wrote on clouddev).
 * The task's own folder, and a ready workspace, never give way; nor does a folder on the
 * Mac for work that needs the Mac's tools (`macTools`), or a folder the task names a
 * path in (`paths`): the work is about that folder's files.
 */
export async function ancestorFolderYields(
  task: Chain, callerHost: string | undefined, defaultHost: string | undefined,
  opts: { macTools?: boolean; paths?: readonly string[] } = {},
): Promise<boolean> {
  const { recordedPlace } = await import('./task-start.js');
  const place = await recordedPlace(task);
  if (!place || place.ownerId === task.id || place.host) return false;
  const dir = place.cwd.replace(/\/+$/, '');
  if (opts.paths?.some((p) => p === dir || p.startsWith(`${dir}/`))) return false;
  const lives = await hostOfRecordedCwd(place.ownerId, place.cwd, defaultHost);
  if (lives === normalizeHost(callerHost)) return false;
  return !(opts.macTools && lives === '__local__');
}

/**
 * Where a start that names no host runs from the record: the folder, and the host when the record
 * names one (a ready workspace). Such a start runs on the project's default host, so a plain
 * recorded folder that is not a place there (it lives on this Mac, or its sessions ran on another
 * host, and the default host lacks it) gives way: the caller's place or the project's default_cwd
 * applies. A folder missing everywhere stays, so its start fails loudly or create_cwd makes it.
 */
export async function unnamedStartPlace(task: Chain, defaultHost: string | undefined): Promise<{ cwd: string; host?: string } | undefined> {
  const { recordedPlace } = await import('./task-start.js');
  const place = await recordedPlace(task);
  if (!place) return undefined;
  if (place.host) return { cwd: place.cwd, host: place.host };
  return await recordLivesOn(place, defaultHost, defaultHost) ? { cwd: place.cwd } : undefined;
}

/** The project's default_cwd, when the start runs on its default_host. */
export function defaultCwdOnHost(meta: { default_cwd?: string; default_host?: string } | null | undefined, host: string | undefined): string | undefined {
  if (!meta?.default_cwd) return undefined;
  return normalizeHost(meta.default_host) === normalizeHost(host) ? meta.default_cwd : undefined;
}
