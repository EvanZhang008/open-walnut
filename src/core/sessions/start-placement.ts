/**
 * A first start that names no host goes where there is room (core/hosts/placement.ts).
 * Called by startSessionForTask once the launch is resolved: when the host it would use
 * is overloaded and another has room, the start moves there, into the task's directory,
 * with the project's repository set up from a checkout that host already has (`--shared`,
 * so it costs seconds; never the shared checkout's other files: only its committed state)
 * or, when it has none, with the steps to clone it as the session's first job.
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

/** Starts that continue, replace or recover a session keep their place. */
const KEEP_SOURCES = new Set(['engine-switch', 'transfer', 'auto-recover', 'recovery', 'restart', 'folder-gone', 'workspace']);

export interface PlaceableLaunch { host?: string; cwd: string; message: string }

export async function placeStartByLoad(
  task: Task,
  params: { host?: string; cwd?: string; workspace?: unknown; startAttemptId?: string; source?: string; message?: string },
  launch: PlaceableLaunch,
  engine: SessionEngine | undefined,
): Promise<StartPlacement | null> {
  if (params.host !== undefined || params.cwd !== undefined || params.workspace || params.startAttemptId) return null;
  if (params.source && KEEP_SOURCES.has(params.source)) return null;
  const { WALNUT_HOME } = await import('../../constants.js');
  if (!launch.cwd || launch.cwd === WALNUT_HOME || launch.cwd.startsWith(`${WALNUT_HOME.replace(/\/+$/, '')}/`)) return null;
  const sourceHost = launch.host || '__local__';
  const { choosePlacement } = await import('../hosts/placement.js');
  let probe: PackReply | null | undefined;
  const moveId = `xf-place-${task.id.slice(0, 8)}-${Date.now().toString(36)}`;
  const probeSource = async (): Promise<PackReply | null> => {
    if (probe !== undefined) return probe;
    try {
      const client = await import('../transfer/daemon-transfer-client.js');
      const { transfersDir } = await import('../transfer/workspace.js');
      probe = await client.packWorkspace(sourceHost, { cwd: launch.cwd, outDir: `${transfersDir(sourceHost)}/${moveId}/0/pack`, paths: [] });
    } catch (err) {
      log.session.info('placement: the folder could not be read for a move', { taskId: task.id, cwd: launch.cwd, error: err instanceof Error ? err.message : String(err) });
      probe = null;
    }
    return probe;
  };
  const decision = await choosePlacement({
    defaultHost: launch.host ?? '', cwd: launch.cwd, tags: task.tags ?? [],
    text: [task.title, task.description ?? '', params.message ?? ''].join('\n'),
    eligible: async (host) => {
      const { switchHostBlocker } = await import('./engine-switch.js');
      const blocked = await switchHostBlocker(host, engine ?? 'claude');
      if (blocked) return blocked;
      const p = await probeSource();
      if (!p) return 'its folder could not be read on its host';
      if (p.meta.kind !== 'git') return `${launch.cwd} is not a git repository another host can set up`;
      const { cloneUrlOf } = await import('../transfer/task-work.js');
      if (!cloneUrlOf(p.meta)) return `${launch.cwd} has no remote another host can clone`;
      return null;
    },
  }).catch((err: unknown) => {
    log.session.warn('placement: skipped', { taskId: task.id, error: err instanceof Error ? err.message : String(err) });
    return null;
  });
  if (!decision) return null;
  if (!decision.moved) return { host: decision.host, from: decision.from, moved: false, reason: decision.reason };

  const target = decision.host || '__local__';
  const p = (await probeSource())!;
  const setup = await setUpOn(task, p, sourceHost, target, moveId).catch((err: unknown) => {
    log.session.warn('placement: the repository could not be prepared; the session sets it up', { taskId: task.id, target, error: err instanceof Error ? err.message : String(err) });
    return null;
  });
  if (!setup) return { host: launch.host ?? '', from: decision.from, moved: false, reason: `${decision.reason}, but the work could not be prepared there; it stays` };
  launch.host = decision.host;
  launch.cwd = setup.cwd;
  const label = target === '__local__' ? 'this Mac' : target;
  launch.message = [
    `Walnut placed this task on ${label}: ${decision.reason}.`,
    setup.setUp
      ? `Your working copy of ${p.meta.root} is ${setup.dest} (branch ${p.meta.branch ?? '(detached)'} at ${(p.meta.head ?? '').slice(0, 12)}); work there, never in another checkout.`
      : `Set the repository up first:\n${setup.steps}`,
    '',
    launch.message,
  ].join('\n');
  return { host: decision.host, from: decision.from, moved: true, reason: decision.reason, cwd: setup.cwd, setUp: setup.setUp };
}

async function setUpOn(task: Task, p: PackReply, sourceHost: string, target: string, moveId: string): Promise<{ cwd: string; dest: string; setUp: boolean; steps?: string }> {
  const { ensureTaskDirOnHost } = await import('./task-dir-place.js');
  const made = await ensureTaskDirOnHost(task.id, target);
  if ('error' in made) throw new Error(made.error);
  const { DaemonFileReader } = await import('../daemon-file-reader.js');
  const reader = new DaemonFileReader(target);
  const taken = new Set(await reader.listDir(made.path).catch(() => [] as string[]));
  const want = path.posix.basename(p.meta.root) || 'workspace';
  let name = want;
  for (let i = 2; taken.has(name); i++) name = `${want}-${i}`;
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
      return { cwd: relCwd ? `${dest}/${relCwd}` : dest, dest, setUp: true };
    } catch (err) {
      log.session.info('placement: the --shared clone failed; the session clones', { taskId: task.id, target, error: err instanceof Error ? err.message : String(err) });
      // The folder was free before (above), so what is there now is the half-made clone.
      await reader.removePath(dest, true).catch(() => {});
    }
  }
  const { ensureCwd } = await import('./ensure-cwd.js');
  await ensureCwd(dest, target === '__local__' ? undefined : target);
  return { cwd: dest, dest, setUp: false, steps: workspaceInstructions(moved, { repoRoot: dest, known: false }) };
}
