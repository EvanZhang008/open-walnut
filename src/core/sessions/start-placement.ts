/**
 * A first start that names no host goes where there is room (core/hosts/placement.ts).
 * Called by startSessionForTask once the launch is resolved: when the host it would use
 * is overloaded and another has room, the start moves there, into the task's directory,
 * with the project's repository set up from a checkout that host already has (`--shared`,
 * so it costs seconds; never the shared checkout's other files: only its committed state).
 * A host with no checkout of it is no place to move for load (2026-11-05: a review task
 * went to a Mac with none of its files). The files the task names outside its folder
 * must be on the host that takes it (hosts/named-paths.ts); when they are on another
 * host than the one the start would use, the start goes there, its repository set up
 * the same way or, with no checkout there, with the steps to clone it as the session's
 * first job. A task in its own directory gets a new own directory there, moved for its
 * files or for load (a fresh task directory holds nothing to carry).
 *
 * Never placed: a start naming a host or a folder, a start that continues or replaces a
 * session (engine switch, move, transfer, recovery), an isolated workspace, a folder of
 * Walnut's own data (notes, the task memory folder), and Mac-only work.
 */
import path from 'node:path';
import { log } from '../../logging/index.js';
import type { SessionEngine, Task } from '../types.js';
import type { PackReply } from '../transfer/daemon-transfer-client.js';

export interface StartPlacement {
  /** Where the start runs ('' = this Mac). */
  host: string;
  from: string;
  moved: boolean;
  reason: string;
  /** The folder the session starts in on that host (moved only). */
  cwd?: string;
  /** The repository was set up there (false: the session's first step does it). */
  setUp?: boolean;
}

/** How long placement may hold a start before it goes ahead where it was (the task_start op waits 130 s). */
function setupBudgetMs(): number {
  const n = Number(process.env.WALNUT_PLACE_SETUP_MS);
  return Number.isFinite(n) && n > 0 ? n : 25_000;
}

/**
 * A move for its files sets the repository up in a window of its own once the host is chosen:
 * under load the checks before it can use most of the shared budget, and staying on a host
 * without the files the task names is the very miss the move is for (2026-11-07, live probe:
 * clouddev had the brief, the set-up ran out of the 25 s budget, and the task started on the
 * Mac without it).
 */
function filesSetupBudgetMs(): number {
  const n = Number(process.env.WALNUT_PLACE_FILES_SETUP_MS);
  return Number.isFinite(n) && n > 0 ? n : 60_000;
}

class PlacementTimeout extends Error {}

/** `work`, or a PlacementTimeout once `deadline` passed. */
async function within<T>(work: Promise<T>, deadline: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new PlacementTimeout(`${what} took longer than the placement budget`)), Math.max(0, deadline - Date.now()));
      timer.unref?.();
    })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Starts that continue, replace or recover a session keep their place. */
const KEEP_SOURCES = new Set(['engine-switch', 'transfer', 'auto-recover', 'recovery', 'restart', 'folder-gone', 'workspace']);

export interface PlaceableLaunch { host?: string; cwd: string; message: string }

export async function placeStartByLoad(
  task: Task,
  params: { host?: string; cwd?: string; workspace?: unknown; startAttemptId?: string; source?: string; message?: string },
  launch: PlaceableLaunch,
  engine: SessionEngine | undefined,
  opts: {
    /**
     * Take the start's slot on the host it moves to, before anything is set up there
     * (sessions/host-admission.ts); a full host throws (HostsFullError) and nothing is made.
     * Returns the release; placement calls it when the move does not happen after all.
     */
    admit?: (host: string) => Promise<(holdMs?: number) => void>;
  } = {},
): Promise<StartPlacement | null> {
  if (params.host !== undefined || params.cwd !== undefined || params.workspace || params.startAttemptId) return null;
  // A task with an isolated workspace (ready or still being made) runs in it, wherever it is.
  if (task.workspace) return null;
  if (params.source && KEEP_SOURCES.has(params.source)) return null;
  const { WALNUT_HOME } = await import('../../constants.js');
  if (!launch.cwd) return null;
  const defaultDataFolder = launch.cwd === WALNUT_HOME || launch.cwd.startsWith(`${WALNUT_HOME.replace(/\/+$/, '')}/`);
  if (defaultDataFolder) return null;
  const sourceHost = launch.host || '__local__';
  const deadline = Date.now() + setupBudgetMs();
  const { choosePlacement, needsMacTools } = await import('../hosts/placement.js');
  let probe: PackReply | null | undefined;
  const moveId = `xf-place-${task.id.slice(0, 8)}-${Date.now().toString(36)}`;
  const text = [task.title, task.description ?? '', params.message ?? ''].join('\n');
  if (needsMacTools(text, launch.cwd, task.tags ?? [])) return { host: launch.host ?? '', from: sourceHost, moved: false, reason: 'it needs this Mac\'s tools' };
  const { namedPaths, namesTooManyPaths, isUnder, pathsOnHost, dirEntries } = await import('../hosts/named-paths.js');
  let ownDirEntries: Promise<string[] | null> | undefined;
  const { isFallbackFolder } = await import('./task-dir-place.js');
  // The task's own directory (no project folder): a host that has the task's files takes
  // it with a new one of its own there, nothing carried.
  let ownDirAsked: Promise<boolean> | undefined;
  const isOwnDir = () => (ownDirAsked ??= isFallbackFolder(launch.cwd, sourceHost).catch(() => false));
  let genericFolder = false;
  // The files the task names inside the repository it works in ride with its committed
  // state (as they are now, committed or not); every other file must already be on the
  // host that takes it. A task directory carries nothing, so all of its are checked.
  // More than placement checks: what it did not check could be anywhere, so the start stays.
  if (namesTooManyPaths(text, launch.cwd)) {
    log.session.info('placement: the task names more files than placement checks; it stays', { taskId: task.id });
    return null;
  }
  let inside = namedPaths(text, (p) => isUnder(p, launch.cwd), { cwd: launch.cwd });
  if (inside.length && await isOwnDir()) inside = [];
  const paths = namedPaths(text, (p) => !inside.includes(p), { cwd: launch.cwd });
  let left: Promise<string[]> | undefined;
  const probeSource = async (): Promise<PackReply | null> => {
    if (probe !== undefined) return probe;
    try {
      const client = await import('../transfer/daemon-transfer-client.js');
      const { transfersDir } = await import('../transfer/workspace.js');
      const pack = (paths: string[]) => within(client.packWorkspace(sourceHost, { cwd: launch.cwd, outDir: `${transfersDir(sourceHost)}/${moveId}/0/pack`, paths, noFullBundle: true }), deadline, 'reading the folder');
      probe = await pack([]);
      const root = probe.meta.root.replace(/\/+$/, '');
      const rel = inside.map((p) => repoRel(p, root, launch.cwd, probe!.meta.relCwd ?? '')).filter((r): r is string => !!r);
      if (probe.meta.kind === 'git' && rel.length) probe = await pack(rel);
    } catch (err) {
      log.session.info('placement: the folder could not be read for a move', { taskId: task.id, cwd: launch.cwd, error: err instanceof Error ? err.message : String(err) });
      probe = null;
    }
    return probe;
  };
  // Every check shares the placement budget: past it the start stays where it was.
  const decision = await within(choosePlacement({
    defaultHost: launch.host ?? '', cwd: launch.cwd, tags: task.tags ?? [], text, paths, toolsOnly: true,
    eligible: async (host, { forFiles }) => {
      const { switchHostBlocker } = await import('./engine-switch.js');
      const blocked = await switchHostBlocker(host, engine ?? 'claude');
      if (blocked) return blocked;
      // Walnut picks only a host it has seen able to start Claude Code (installed, signed in,
      // new enough); a person may still pick any host, and Start says what is wrong there.
      if ((engine ?? 'claude') === 'claude') {
        const { claudeSessionBlocker } = await import('../hosts/host-readiness.js');
        const unready = claudeSessionBlocker(host);
        if (unready) return unready;
      }
      // A new task directory of its own there; the files it names were checked already (keeps).
      // Moved for load only while its own directory here holds nothing: a brief written there
      // and read by a relative path would stay behind (review round 3, Sol).
      // For its files too: what its own directory holds would stay behind (review round 4, Sol).
      if (await isOwnDir()) {
        const names = await (ownDirEntries ??= dirEntries(sourceHost, launch.cwd));
        if (names === null) return `${launch.cwd} could not be read to see whether it holds files`;
        return names.length ? `${launch.cwd} already holds files (${names.slice(0, 3).join(', ')}) a new task directory there would not have` : null;
      }
      const p = await probeSource();
      if (!p) return 'its folder could not be read on its host';
      if (p.meta.kind !== 'git') {
        // An inherited folder is not a requirement for research or mail reading. A task's own
        // folder, or any named file, still binds the work to what is there.
        if (!forFiles && !task.cwd && inside.length === 0 && paths.length === 0
          && /\b(research|read (?:the )?mail|reading mail|read release mail|mail triage)\b/i.test(text)) { genericFolder = true; return null; }
        return `${launch.cwd} is not a git repository another host can set up`;
      }
      const { cloneUrlOf } = await import('../transfer/task-work.js');
      if (!cloneUrlOf(p.meta)) return `${launch.cwd} has no remote another host can clone`;
      const lost = await (left ??= within(notCarried(p, inside, sourceHost, launch.cwd), deadline, 'checking the files it names'));
      if (lost.length) return `${lost.slice(0, 3).join(', ')}, which the task names, would not move with its repository (ignored by git, or a folder)`;
      // Moved for load, the work goes only where a checkout of its repository already is
      // (a seconds-long --shared clone); moved for its files, the session may clone it.
      if (!forFiles && !(await within(checkoutOn(host, p), deadline, 'finding a checkout there'))) return `it has no checkout of ${p.meta.root} to set the work up from`;
      return null;
    },
    checkPaths: pathsOnHost,
  }), deadline, 'choosing a host').catch((err: unknown) => {
    log.session.warn('placement: skipped', { taskId: task.id, error: err instanceof Error ? err.message : String(err) });
    return null;
  });
  // The source's probe pack is copied (or not needed) by the time this returns.
  const dropProbe = () => { if (probe) void dropDir(sourceHost, `${probe.outDir.replace(/\/0\/pack$/, '')}`); };
  if (!decision) { dropProbe(); return null; }
  if (!decision.moved) { dropProbe(); return { host: decision.host, from: decision.from, moved: false, reason: decision.reason }; }

  const target = decision.host || '__local__';
  let slot: (holdMs?: number) => void = () => {};
  try {
    if (opts.admit) slot = await opts.admit(target);
  } catch (err) {
    dropProbe();
    // Moved for load and the target filled up first: the start stays where it was, which is
    // over a cap but has room (review round 4). Moved for its files, it waits for the target.
    const { HostsFullError } = await import('./host-admission.js');
    if (err instanceof HostsFullError && !decision.forFiles) {
      return { host: launch.host ?? '', from: decision.from, moved: false, reason: `${decision.reason}, but ${target === '__local__' ? 'this Mac' : target} filled up first; it stays` };
    }
    throw err;
  }
  const { hostDisplayName } = await import('../hosts/host-display-name.js');
  const name = (h: string) => (h === '__local__' ? 'this Mac' : hostDisplayName(h));
  if (genericFolder || await isOwnDir()) {
    dropProbe();
    const { ensureTaskDirOnHost } = await import('./task-dir-place.js');
    const made = await within(ensureTaskDirOnHost(task.id, target), deadline, 'making the task directory').catch((err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }));
    if ('error' in made) {
      slot();
      log.session.warn('placement: the task directory could not be made there; the start stays', { taskId: task.id, target, error: made.error });
      return { host: launch.host ?? '', from: decision.from, moved: false, reason: `${decision.reason}, but its task directory could not be made there; it stays` };
    }
    launch.host = decision.host;
    launch.cwd = made.path;
    launch.message = [`Walnut placed this task on ${name(target)}: ${decision.reason}.`, '', launch.message].join('\n');
    return { host: decision.host, from: decision.from, moved: true, reason: decision.reason, cwd: made.path, setUp: true };
  }
  const p = (await probeSource())!;
  const setupBy = decision.forFiles ? Math.max(deadline, Date.now() + filesSetupBudgetMs()) : deadline;
  const setup = await within(setUpOn(task, p, sourceHost, target, moveId), setupBy, 'setting the repository up').catch((err: unknown) => {
    log.session.warn('placement: the repository could not be prepared in time; the start stays', { taskId: task.id, target, error: err instanceof Error ? err.message : String(err) });
    return null;
  });
  dropProbe();
  if (!setup) slot();
  if (!setup) return { host: launch.host ?? '', from: decision.from, moved: false, reason: `${decision.reason}, but the work could not be prepared there in time; it stays` };
  // The folder it works in must be in the copy: one only untracked files make is not (review
  // round 4, Sol), and the session could not start in it.
  if (setup.setUp && setup.cwd !== setup.dest) {
    const there = await within(pathsOnHost(target, [setup.cwd]), decision.forFiles ? Math.max(setupBy, Date.now() + 5_000) : deadline, 'checking its folder there').catch(() => null);
    if (!there || there.missing.length) {
      slot();
      log.session.warn('placement: its folder is not in the committed state; the start stays', { taskId: task.id, target, cwd: setup.cwd });
      return { host: launch.host ?? '', from: decision.from, moved: false, reason: `${decision.reason}, but ${launch.cwd} is not in its repository's committed state; it stays` };
    }
  }
  launch.host = decision.host;
  const sourceCwd = launch.cwd;
  launch.cwd = setup.cwd;
  const label = name(target);
  launch.message = [
    `Walnut placed this task on ${label}: ${decision.reason}.`,
    setup.setUp
      ? `Your working copy of ${p.meta.root} is ${setup.dest} (branch ${p.meta.branch ?? '(detached)'} at ${(p.meta.head ?? '').slice(0, 12)}); work there, never in another checkout.`
      : `Set the repository up first:\n${setup.steps}`,
    `It holds the committed state only${p.meta.limited ? ', and the files this task names in it as they are now' : ''}: other files left uncommitted in ${p.meta.root} on ${name(sourceHost)} (another session's work there) are not in it.`,
    ...movedPaths(inside, p, sourceCwd, setup.dest),
    '',
    launch.message,
  ].join('\n');
  return { host: decision.host, from: decision.from, moved: true, reason: decision.reason, cwd: setup.cwd, setUp: setup.setUp };
}

/**
 * The named files inside the repository that a move would not carry: carried are the
 * ones that rode in the pack (changed or untracked, as they are now), the ones git
 * tracks unchanged (in the committed state), the folder the start works in and those
 * above it; a path that does not exist loses nothing. An ignored file is left behind.
 * A folder counts as carried when git tracks anything in it (untracked files inside a
 * named folder are not looked for: the pack carries only the files named).
 */
async function notCarried(p: PackReply, inside: string[], sourceHost: string, cwd: string): Promise<string[]> {
  if (inside.length === 0) return [];
  const root = p.meta.root.replace(/\/+$/, '');
  const rode = new Set((p.meta.limited?.files ?? []).map((f) => f.path));
  const { isUnder, pathsOnHost } = await import('../hosts/named-paths.js');
  const { DaemonFileReader } = await import('../daemon-file-reader.js');
  const reader = new DaemonFileReader(sourceHost);
  const head = p.meta.head ?? '';
  const lost = await Promise.all(inside.map(async (abs) => {
    if (isUnder(cwd, abs)) return null;
    const rel = repoRel(abs, root, cwd, p.meta.relCwd ?? '');
    // A path the repository's own spelling cannot name is never assumed carried.
    if (rel === null) return abs;
    if (rode.has(rel)) return null;
    const there = await pathsOnHost(sourceHost, [abs]);
    if (there && there.missing.length) return null;
    // In HEAD (a file's history is not enough: deleted and ignored since is left behind).
    const inHead = /^[0-9a-f]{7,40}$/.test(head) && await reader.gitFileShow(root, `${root}/${rel}`, head).then(() => true, (e: unknown) => /larger than/.test(String(e)));
    return inHead ? null : abs;
  }));
  return lost.filter((x): x is string => !!x);
}

/**
 * `abs` relative to the repository root git reports, or null. The start's folder may be
 * spelled another way than git's root (a symlink, `/tmp` against `/private/tmp`), so a
 * path under the folder is mapped through the folder's own place in the repository.
 */
function repoRel(abs: string, root: string, cwd: string, relCwd: string): string | null {
  const c = cwd.replace(/\/+$/, '');
  const viaCwd = abs.startsWith(`${c}/`) ? path.posix.join(relCwd, abs.slice(c.length + 1)) : null;
  const rel = abs.startsWith(`${root}/`) ? abs.slice(root.length + 1) : viaCwd;
  return rel && !rel.startsWith('..') ? rel : null;
}

/** Where the files the task names in its repository are in the new working copy. */
function movedPaths(inside: string[], p: PackReply, cwd: string, dest: string): string[] {
  const r = p.meta.root.replace(/\/+$/, '');
  const moved = inside.map((abs) => [abs, repoRel(abs, r, cwd, p.meta.relCwd ?? '')] as const)
    .filter((x): x is readonly [string, string] => !!x[1]).map(([abs, rel]) => `${abs} is ${dest}/${rel}`);
  return moved.length ? [`The files this task names there are in it: ${moved.join('; ')}.`] : [];
}

/** The checkout of `p`'s repository `host` has (recorded, and still there), or null. */
async function checkoutOn(host: string, p: PackReply): Promise<string | null> {
  const { readHostProfile, repoKey } = await import('../hosts/host-profile.js');
  const { cloneUrlOf } = await import('../transfer/task-work.js');
  const known = (await readHostProfile(host).catch(() => null))?.observed.repoPaths[repoKey(cloneUrlOf(p.meta), path.posix.basename(p.meta.root))]?.path;
  if (!known) return null;
  const { pathsOnHost } = await import('../hosts/named-paths.js');
  // A checkout, not a folder left where one was (its `.git`, a folder or a worktree's file).
  return (await pathsOnHost(host, [`${known.replace(/\/+$/, '')}/.git`]))?.present.length ? known : null;
}

async function setUpOn(task: Task, p: PackReply, sourceHost: string, target: string, moveId: string): Promise<{ cwd: string; dest: string; setUp: boolean; steps?: string }> {
  const { ensureTaskDirOnHost } = await import('./task-dir-place.js');
  const made = await ensureTaskDirOnHost(task.id, target);
  if ('error' in made) throw new Error(made.error);
  const { DaemonFileReader } = await import('../daemon-file-reader.js');
  const reader = new DaemonFileReader(target);
  const { targetNamer } = await import('../transfer/task-work.js');
  const name = targetNamer(await reader.listDirStrict(made.path))(path.posix.basename(p.meta.root) || 'workspace');
  const dest = `${made.path}/${name}`;
  const relCwd = p.meta.relCwd ?? '';
  const { copyPack, transfersDir, workspaceInstructions } = await import('../transfer/workspace.js');
  const moved = await copyPack(p, { sourceHost, targetHost: target, bundleDir: `${transfersDir(target)}/${moveId}/0/pack` });
  const { readHostProfile, repoKey, recordRepoPath } = await import('../hosts/host-profile.js');
  const { cloneUrlOf } = await import('../transfer/task-work.js');
  const url = cloneUrlOf(p.meta);
  const known = (await readHostProfile(target).catch(() => null))?.observed.repoPaths[repoKey(url, path.posix.basename(p.meta.root))]?.path;
  const client = await import('../transfer/daemon-transfer-client.js');
  // A checkout this host already has makes it a seconds-long `--shared` clone; a full clone waits for the session.
  if (known && await client.hostCanMove(target)) {
    try {
      await client.applyPack(target, { dest, bundleDir: moved.bundleDir, cloneFrom: known, ...(url ? { url } : {}), timeoutMs: 3 * 60_000 });
      void recordRepoPath(target, repoKey(url, path.posix.basename(p.meta.root)), dest).catch(() => {});
      void dropDir(target, moved.bundleDir.replace(/\/0\/pack$/, ''));
      return { cwd: relCwd ? `${dest}/${relCwd}` : dest, dest, setUp: true };
    } catch (err) {
      // The target's daemon removed what its own apply made.
      log.session.info('placement: the --shared clone failed; the session clones', { taskId: task.id, target, error: err instanceof Error ? err.message : String(err) });
    }
  }
  const { ensureCwd } = await import('./ensure-cwd.js');
  await ensureCwd(dest, target === '__local__' ? undefined : target);
  return { cwd: dest, dest, setUp: false, steps: workspaceInstructions(moved, { repoRoot: dest, known: false }) };
}

/** Best effort: a transfer folder nothing reads any more (the weekly sweep catches a miss). */
async function dropDir(host: string, dir: string): Promise<void> {
  if (!/-transfers\/xf-place-[^/]+$/.test(dir)) return;
  try {
    const { DaemonFileReader } = await import('../daemon-file-reader.js');
    await new DaemonFileReader(host).removePath(dir, true);
  } catch { /* swept later */ }
}
