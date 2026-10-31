/**
 * What a task works in on its host, and moving exactly that to another host
 * (2026-10-31, the user: "can u move transfer all non ios to clouddev?"). A task's
 * session often runs in a SHARED checkout full of other agents' uncommitted files,
 * while the task's own work is a clone under its task directory; packing the
 * session's folder carried the wrong workspace and none of the task's commits.
 *
 * The work of a task on a host is:
 *   - every git repository inside its task directory that holds something no remote
 *     has (commits, uncommitted or untracked files), whole: the task made it;
 *   - the task directory's loose files (drafts, plans, notes), without its repositories;
 *   - the session's folder when it lies outside the task directory: only the files the
 *     session itself changed there ride (Changed tab's list, session-changes.ts), never
 *     another writer's; when that list cannot be read, only the committed state.
 * Each piece is packed on the source host (transfer-pack-core.ts), copied (workspace.ts
 * copyPack) and set up under the task directory on the target host by the target's own
 * daemon (`transfer.apply`). A piece the target could not set up becomes steps for the
 * new session (workspaceInstructions). A target daemon without 'task-move-v1' gets the
 * session folder's plain pack and those steps, as task_transfer did.
 */
import path from 'node:path';
import { log } from '../../logging/index.js';
import type { SessionRecord, Task } from '../types.js';
import { LOCAL_HOST } from './planner.js';
import { copyPack, transfersDir, workspaceInstructions, type MovedWorkspace } from './workspace.js';
import type { PackedFile, PackMeta, PackReply, ScanReply } from './daemon-transfer-client.js';
import { readHostProfile, repoKey } from '../hosts/host-profile.js';

export interface WorkPiece {
  kind: 'repo' | 'files' | 'checkout';
  /** On the source host. */
  source: string;
  /** Under the task directory on the target ('' = the task directory itself). */
  rel: string;
}

export interface MovedPiece {
  kind: WorkPiece['kind'];
  source: string;
  dest: string;
  /** Set up on the target by its daemon; false = the new session follows `steps`. */
  applied: boolean;
  branch?: string | null;
  head?: string | null;
  /** Commits that rode in the bundle. */
  commits?: number;
  /** Uncommitted tracked changes rode (a patch). */
  changes?: boolean;
  untracked?: number;
  /** Files of a shared checkout that are not this task's and stayed. */
  leftOut?: { count: number; sample: string[] };
  /** The session's own files there could not be read: only the committed state rode. */
  ownUnknown?: boolean;
  bytes: number;
  error?: string;
  /** The new session's steps when the target did not set it up. */
  steps?: string;
}

export interface MovedWork {
  /** The session's folder on the target. */
  cwd: string;
  targetTaskDir: string;
  pieces: MovedPiece[];
  /** Repositories left behind because they hold nothing a remote lacks. */
  cleanRepos: Array<{ source: string; url?: string }>;
  /** Plain words for the outcome and the new session: what moved and what did not. */
  summary: string[];
  /** A shared checkout's own files that rode: cleared from it once the move is done (clearMovedCopies). */
  clearable: Array<{ root: string; files: PackedFile[]; backupFrom: string; leftUntracked?: number }>;
}

export class TaskWorkError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
    this.name = 'TaskWorkError';
  }
}

const MAX_LOOSE_BYTES = 200 * 1024 * 1024;
const CHANGES_DEADLINE_MS = 60_000;

/** Two remote URLs of one repository (ssh and https spellings, `.git`, credentials). */
export function sameRepoUrl(a: string | undefined, b: string | undefined): boolean {
  const norm = (u: string | undefined): string => {
    if (!u) return '';
    let s = u.trim().toLowerCase().replace(/^[a-z+]+:\/\//, '').replace(/^[^@/]+@/, '').replace(/\.git$/, '').replace(/\/+$/, '');
    // scp-like `host:owner/repo`
    s = s.replace(/^([^/:]+):(?!\d)/, '$1/');
    return s;
  };
  const x = norm(a);
  return !!x && x === norm(b);
}

/** The URL another host clones this repository from: the deep upstream, else the first remote that is not a local folder. */
export function cloneUrlOf(meta: PackMeta): string | undefined {
  if (meta.upstreamUrl) return meta.upstreamUrl;
  return meta.remotes?.find((r) => !/^(\/|~\/|file:\/\/)/.test(r.url))?.url;
}

/** A folder never copied whole: the root, a home folder, a system folder, Walnut's own data. */
export function unmovableFolder(dir: string): boolean {
  const d = dir.replace(/\/+$/, '') || '/';
  if (/^\/(?:[^/]+)?$/.test(d)) return true;
  if (/^\/(?:home|Users)\/[^/]+$/.test(d) || /^\/local\/home\/[^/]+$/.test(d)) return true;
  return /(^|\/)\.open-walnut(\/|$)/.test(d);
}

function inside(child: string, parent: string): boolean {
  const rel = path.posix.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.posix.isAbsolute(rel));
}

/**
 * Files the session changed under `repoRoot`, repo-relative, and for each one whose whole
 * history the session's record holds, the sha256 of the file when the session first touched
 * it (`before`): the clear after a move takes a file back only when that equals HEAD, so no
 * other writer's edit sits under the session's. null when the list is unknown.
 */
async function ownFiles(session: SessionRecord, repoRoot: string, host: string): Promise<{ paths: string[]; before: Record<string, string> } | null> {
  try {
    const { computeSessionChanges } = await import('../session-changes.js');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const res = await Promise.race([
      computeSessionChanges(session.claudeSessionId, session.cwd ?? undefined, host === LOCAL_HOST ? undefined : host, session.outputFile ?? undefined),
      new Promise<null>((r) => { timer = setTimeout(() => r(null), CHANGES_DEADLINE_MS); timer.unref?.(); }),
    ]);
    if (timer) clearTimeout(timer);
    if (!res) return null;
    const out = new Set<string>();
    const before: Record<string, string> = {};
    const { createHash } = await import('node:crypto');
    const sha = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');
    const until = Date.now() + CHANGES_DEADLINE_MS;
    for (const g of res.groups) {
      if (g.repoRoot.replace(/\/+$/, '') !== repoRoot.replace(/\/+$/, '')) continue;
      for (const f of g.files) {
        if (f.relPath) out.add(f.relPath);
        if (f.oldRelPath) out.add(f.oldRelPath);
        // A rename, or a record that could not be rebuilt whole, never clears.
        if (!f.relPath || f.oldRelPath || f.status === 'renamed') continue;
        let full: { before: string; partial: boolean } | null = res.light ? null : f;
        if (!full && f.filePath && Date.now() < until && Object.keys(before).length < 200) {
          const { fetchSessionFileChangeViaDaemon } = await import('../session-changes.js');
          full = (await fetchSessionFileChangeViaDaemon(session.claudeSessionId, session.cwd ?? undefined, host === LOCAL_HOST ? undefined : host, f.filePath).catch(() => null))?.file ?? null;
        }
        if (full && !full.partial && typeof full.before === 'string') before[f.relPath] = sha(full.before);
      }
    }
    return { paths: [...out], before };
  } catch (err) {
    log.session.info('task move: the session\'s own changes could not be read', { sessionId: session.claudeSessionId, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/**
 * Names under the target task dir. A piece's top folder never reuses a name the target
 * already holds (a move back finds its old copies there) or another piece took; the
 * repositories of one source task dir keep their layout (`repos/a`, `repos/b` share
 * one top folder, renamed together).
 */
export function targetNamer(existing: Iterable<string>): (want: string, layout?: boolean) => string {
  const used = new Set(existing);
  const tops = new Map<string, string>();
  return (want, layout = false) => {
    const [top, ...rest] = (want || 'workspace').split('/');
    let mapped = layout ? tops.get(top) : undefined;
    if (!mapped) {
      mapped = top;
      for (let i = 2; used.has(mapped); i++) mapped = `${top}-${i}`;
      used.add(mapped);
      if (layout) tops.set(top, mapped);
    }
    return [mapped, ...rest].join('/');
  };
}

interface Packed { piece: WorkPiece; pack: PackReply }

/**
 * Pack, copy and set up a task's own work from `sourceHost` onto `targetHost`, under
 * the task directory there. `moveId` names the transfer files on both hosts.
 */
export async function moveTaskWork(opts: {
  task: Pick<Task, 'id' | 'title'>; session: SessionRecord; sourceHost: string; targetHost: string; moveId: string;
}): Promise<MovedWork> {
  const { task, session, sourceHost, targetHost, moveId } = opts;
  const client = await import('./daemon-transfer-client.js');
  const { taskDirForHost, ensureTaskDirOnHost } = await import('../sessions/task-dir-place.js');
  if (!(await client.hostCanMove(sourceHost))) {
    throw new TaskWorkError(`The daemon on ${sourceHost === LOCAL_HOST ? 'this Mac' : sourceHost} is too old to move a task's own work; it upgrades on its next session start`, 409, 'daemon_upgrade_required');
  }
  const made = await ensureTaskDirOnHost(task.id, targetHost);
  if ('error' in made) throw new TaskWorkError(`The task directory could not be made on ${targetHost}: ${made.error}`, made.status, 'target_task_dir');
  const targetTaskDir = made.path;
  const targetMoves = await client.hostCanMove(targetHost);
  const sourceTaskDir = await taskDirForHost(task.id, sourceHost);
  const cwd = (session.cwd ?? '').replace(/\/+$/, '');
  if (!cwd && !sourceTaskDir) throw new TaskWorkError('The task has no folder and no task directory to move', 400, 'no_source_cwd');

  const scan: ScanReply | null = sourceTaskDir ? await client.scanWorkDir(sourceHost, sourceTaskDir) : null;
  // A name the target's task directory already holds (a move back finds its old copies there) is never reused.
  const { DaemonFileReader } = await import('../daemon-file-reader.js');
  // A listing that fails is no answer: a name thought free could hold an older copy.
  const existing = await new DaemonFileReader(targetHost).listDirStrict(targetTaskDir).catch((err: unknown) => {
    throw new TaskWorkError(`The task directory on ${targetHost} could not be read: ${err instanceof Error ? err.message : String(err)}`, 502, 'target_task_dir');
  });
  const nameFor = targetNamer(existing);
  const packed: Packed[] = [];
  const cleanRepos: MovedWork['cleanRepos'] = [];
  const outDir = (n: number) => `${transfersDir(sourceHost)}/${moveId}/${n}/pack`;
  let n = 0;
  for (const repo of scan?.repos ?? []) {
    const pack = await client.packWorkspace(sourceHost, { cwd: repo.root, outDir: outDir(n++) });
    const m = pack.meta;
    const own = !!m.dirty || (!!m.head && !m.headOnRemote) || !!m.noCommits || !cloneUrlOf(m);
    // The session's own folder always goes: it is where the work continues.
    if (!own && !(cwd && inside(cwd, repo.root))) {
      cleanRepos.push({ source: repo.root, ...(cloneUrlOf(m) ? { url: cloneUrlOf(m) } : {}) });
      continue;
    }
    packed.push({ piece: { kind: 'repo', source: repo.root, rel: nameFor(repo.rel || path.posix.basename(repo.root), true) }, pack });
  }

  // The session's folder outside the task directory: a checkout others may share.
  let cwdPiece: Packed | undefined = packed.find((p) => cwd && inside(cwd, p.piece.source));
  // Where in its repository the session ran, kept when it continues in another copy of it.
  let relCwd = cwdPiece && cwd ? path.posix.relative(cwdPiece.piece.source, cwd) : '';
  const ownUnknown = new Set<Packed>();
  const notes: string[] = [];
  const clearable: MovedWork['clearable'] = [];
  if (!cwdPiece && cwd && !(sourceTaskDir && inside(cwd, sourceTaskDir))) {
    const probe = await client.packWorkspace(sourceHost, { cwd, outDir: outDir(n++), paths: [] });
    relCwd = probe.meta.relCwd ?? '';
    if (probe.meta.kind === 'git') {
      const same = packed.find((p) => p.pack.meta.kind === 'git' && (sameRepoUrl(cloneUrlOf(p.pack.meta), cloneUrlOf(probe.meta))
        || p.pack.meta.remotes?.some((r) => r.url.replace(/\/+$/, '') === probe.meta.root)));
      const mine = await ownFiles(session, probe.meta.root, sourceHost);
      if (same && (!mine || mine.paths.length === 0)) {
        // The work is the task directory's clone of this repository: the session continues there.
        cwdPiece = same;
      } else {
        const pack = mine && mine.paths.length > 0
          ? await client.packWorkspace(sourceHost, { cwd, outDir: outDir(n++), paths: mine.paths, ownBefore: mine.before })
          : probe;
        cwdPiece = { piece: { kind: 'checkout', source: probe.meta.root, rel: nameFor(path.posix.basename(probe.meta.root)) }, pack };
        if (!mine) ownUnknown.add(cwdPiece);
        else if (pack.meta.limited?.files?.length) clearable.push({ root: probe.meta.root, files: pack.meta.limited.files, backupFrom: pack.outDir, leftUntracked: pack.meta.untracked?.skippedCount ?? 0 });
        packed.push(cwdPiece);
      }
    } else if (unmovableFolder(probe.meta.root)) {
      // A home folder, the root or Walnut's data never ride (dotfiles, credentials): the session continues in the task directory.
      notes.push(`${probe.meta.root}: not copied (a home, system or Walnut data folder); the session continues in the task directory.`);
    } else {
      // A plain folder outside the task directory (notes, a scratch dir): it moves whole, up to the size cap.
      const pack = await client.packWorkspace(sourceHost, { cwd, outDir: outDir(n++), asDir: true, maxTarBytes: MAX_LOOSE_BYTES });
      if (pack.meta.tooLarge) {
        notes.push(`${probe.meta.root}: not copied, over ${MAX_LOOSE_BYTES / 1024 ** 2} MB; the session continues in the task directory.`);
      } else {
        cwdPiece = { piece: { kind: 'files', source: probe.meta.root, rel: nameFor(path.posix.basename(probe.meta.root)) }, pack };
        packed.push(cwdPiece);
      }
    }
  }

  // The task directory's own files, without its repositories (they rode above).
  if (sourceTaskDir && scan && scan.loose.count > 0) {
    if (scan.loose.bytes > MAX_LOOSE_BYTES) {
      log.session.info('task move: the task directory\'s loose files are too large to move', { taskId: task.id, bytes: scan.loose.bytes });
      notes.push(`${sourceTaskDir}: its loose files (${Math.round(scan.loose.bytes / 1024 ** 2)} MB) are over ${MAX_LOOSE_BYTES / 1024 ** 2} MB and stayed on the old host.`);
    } else {
      const pack = await client.packWorkspace(sourceHost, {
        cwd: sourceTaskDir, outDir: outDir(n++), asDir: true, exclude: scan.repos.map((r) => r.rel).filter(Boolean), maxTarBytes: MAX_LOOSE_BYTES,
      });
      packed.push({ piece: { kind: 'files', source: sourceTaskDir, rel: '' }, pack });
    }
  }

  const profile = await readHostProfile(targetHost).catch(() => null);
  const pieces: MovedPiece[] = [];
  for (const [i, p] of packed.entries()) {
    const dest = p.piece.rel ? `${targetTaskDir}/${p.piece.rel}` : targetTaskDir;
    const bundleDir = `${transfersDir(targetHost)}/${moveId}/${i}/pack`;
    const moved: MovedWorkspace = await copyPack(p.pack, { sourceHost, targetHost, bundleDir });
    const m = p.pack.meta;
    const url = m.kind === 'git' ? cloneUrlOf(m) : undefined;
    const knownPath = m.kind === 'git' ? profile?.observed.repoPaths[repoKey(url, path.posix.basename(m.root))]?.path : undefined;
    const base: MovedPiece = {
      kind: p.piece.kind, source: p.piece.source, dest, applied: false, bytes: moved.bytes,
      ...(m.kind === 'git' ? { branch: m.branch ?? null, head: m.head ?? null, changes: moved.files.includes('changes.patch'), untracked: moved.files.includes('untracked.tgz') ? m.untracked?.count ?? 0 : 0 } : {}),
      ...(m.ahead ? { commits: m.ahead } : {}),
      ...(m.limited && (m.limited.leftOutTracked + m.limited.leftOutUntracked) > 0
        ? { leftOut: { count: m.limited.leftOutTracked + m.limited.leftOutUntracked, sample: m.limited.leftOut } } : {}),
      ...(ownUnknown.has(p) ? { ownUnknown: true } : {}),
    };
    if (targetMoves) {
      try {
        const done = await client.applyPack(targetHost, {
          dest, bundleDir, ...(knownPath && knownPath !== dest ? { cloneFrom: knownPath } : {}), ...(url ? { url } : {}),
        });
        pieces.push({ ...base, applied: true, head: done.head ?? base.head });
        continue;
      } catch (err) {
        base.error = err instanceof Error ? err.message.replace(/^transfer\.apply failed: /, '') : String(err);
        // The target's daemon removed what its own apply made; nothing else is touched here.
        log.session.warn('task move: the target could not set a piece up; the new session will', { taskId: task.id, dest, error: base.error });
      }
    }
    base.steps = workspaceInstructions(moved, { repoRoot: knownPath && !targetMoves ? knownPath : dest, known: !!knownPath && !targetMoves });
    pieces.push(base);
  }

  const cwdOnTarget = (() => {
    if (!cwdPiece) return targetTaskDir;
    const piece = pieces[packed.indexOf(cwdPiece)];
    if (!piece) return targetTaskDir;
    // An unset-up clone starts in its (empty) root, so the session can clone into it.
    return piece.applied && relCwd && !relCwd.startsWith('..') ? `${piece.dest}/${relCwd}` : piece.dest;
  })();
  return {
    cwd: cwdOnTarget, targetTaskDir, pieces, cleanRepos, summary: [...describeMovedWork(pieces, cleanRepos), ...notes],
    // Only a whole move clears anything: every piece set up on the target.
    clearable: pieces.every((p) => p.applied) ? clearable : [],
  };
}

/**
 * After a move is done (its new session started), the files it carried away from a shared
 * checkout on the old host are backed up under the task's directory there and cleared, so
 * a later landing in that checkout does not meet them as another writer's edits (2026-10-31:
 * three such sets were cleared by hand in one day). Each file is cleared only while it still
 * holds what was packed; one a writer changed since stays and is named. One line per checkout.
 */
export async function clearMovedCopies(work: Pick<MovedWork, 'clearable'>, opts: { taskId: string; sourceHost: string; targetHost: string }): Promise<string[]> {
  if (work.clearable.length === 0) return [];
  const client = await import('./daemon-transfer-client.js');
  const lines: string[] = [];
  const { taskDirForHost } = await import('../sessions/task-dir-place.js');
  const taskDir = await taskDirForHost(opts.taskId, opts.sourceHost).catch(() => null);
  const can = await client.hostCanClear(opts.sourceHost).catch(() => false);
  const day = new Date().toISOString().slice(0, 10);
  const to = opts.targetHost === LOCAL_HOST ? 'this-mac' : opts.targetHost.replace(/[^\w.-]+/g, '_');
  for (const c of work.clearable) {
    const names = c.files.map((f) => f.path);
    const list = `${names.slice(0, 5).join(', ')}${names.length > 5 ? ', …' : ''}`;
    if (!can || !taskDir) {
      lines.push(`Still in ${c.root} on the old host: ${names.length} file${names.length === 1 ? '' : 's'} this task changed (${list}); ${!taskDir ? 'its task directory there is unknown' : 'that host\'s daemon cannot clear them yet'}, so they were left as they are.`);
      continue;
    }
    try {
      let backupTo = '';
      let res: Awaited<ReturnType<typeof client.clearMovedFiles>> | null = null;
      for (let i = 1; i <= 5 && !res; i++) {
        backupTo = `${taskDir}/moved-out/${day}-${path.posix.basename(c.root)}-to-${to}${i > 1 ? `-${i}` : ''}`;
        res = await client.clearMovedFiles(opts.sourceHost, { root: c.root, files: c.files, backupFrom: c.backupFrom, backupTo }).catch((err: unknown) => {
          if ((err as { code?: string }).code === 'dest_not_empty') return null;
          throw err;
        });
      }
      if (!res) throw new Error('no free backup folder');
      if (res.cleared.length) lines.push(`Cleared from ${c.root} on the old host: ${res.cleared.length} file${res.cleared.length === 1 ? '' : 's'} this task changed, backed up in ${res.backup} (README.txt says how to put them back).`);
      if (c.leftUntracked) lines.push(`  Left in ${c.root}: ${c.leftUntracked} new file${c.leftUntracked === 1 ? '' : 's'} over the copy's size cap (they did not move).`);
      if (res.kept.length) {
        lines.push(`  Left in ${c.root}: ${res.kept.map((k) => `${k.path} (${k.reason})`).slice(0, 5).join(', ')}${res.kept.length > 5 ? ', …' : ''}.`);
      }
    } catch (err) {
      log.session.warn('task move: the moved files could not be cleared from the shared checkout', { taskId: opts.taskId, root: c.root, error: err instanceof Error ? err.message : String(err) });
      lines.push(`Still in ${c.root} on the old host: ${names.length} file${names.length === 1 ? '' : 's'} this task changed (${list}); clearing them failed (${err instanceof Error ? err.message : String(err)}).`);
    }
  }
  return lines;
}

/** One line per piece, plain words, for the outcome and the new session's first message. */
export function describeMovedWork(pieces: readonly MovedPiece[], cleanRepos: MovedWork['cleanRepos']): string[] {
  const lines: string[] = [];
  for (const p of pieces) {
    const what: string[] = [];
    if (p.kind === 'files') what.push('its files');
    else {
      what.push(`branch ${p.branch ?? '(detached)'}${p.head ? ` at ${p.head.slice(0, 12)}` : ''}`);
      if (p.commits) what.push(`${p.commits} commit${p.commits === 1 ? '' : 's'} no remote has`);
      if (p.changes) what.push('uncommitted changes');
      if (p.untracked) what.push(`${p.untracked} untracked file${p.untracked === 1 ? '' : 's'}`);
    }
    const from = p.kind === 'checkout' ? `${p.source} (a shared checkout: only this task's own files)` : p.source;
    lines.push(`${from} -> ${p.dest}: ${what.join(', ')}${p.applied ? '' : `; NOT set up yet (${p.error ?? 'the target daemon cannot'}), the new session does it`}.`);
    if (p.leftOut) {
      const sample = `${p.leftOut.sample.slice(0, 5).join(', ')}${p.leftOut.count > 5 ? ', …' : ''}`;
      lines.push(p.ownUnknown
        ? `  Left on the old host: ${p.leftOut.count} uncommitted file${p.leftOut.count === 1 ? '' : 's'} in ${p.source}; Walnut could not read which of them this task changed, so only the committed state moved (${sample}).`
        : `  Left on the old host: ${p.leftOut.count} changed file${p.leftOut.count === 1 ? '' : 's'} in ${p.source} that this task did not change (${sample}).`);
    }
  }
  for (const r of cleanRepos) lines.push(`${r.source}: not copied, nothing in it a remote lacks${r.url ? ` (clone ${r.url} when needed)` : ''}.`);
  return lines;
}
