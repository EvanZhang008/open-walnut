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
import type { PackMeta, PackReply, ScanReply } from './daemon-transfer-client.js';
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

function inside(child: string, parent: string): boolean {
  const rel = path.posix.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.posix.isAbsolute(rel));
}

/** Files the session changed under `repoRoot`, repo-relative; null when unknown. */
async function ownFiles(session: SessionRecord, repoRoot: string, host: string): Promise<string[] | null> {
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
    for (const g of res.groups) {
      if (g.repoRoot.replace(/\/+$/, '') !== repoRoot.replace(/\/+$/, '')) continue;
      for (const f of g.files) {
        if (f.relPath) out.add(f.relPath);
        if (f.oldRelPath) out.add(f.oldRelPath);
      }
    }
    return [...out];
  } catch (err) {
    log.session.info('task move: the session\'s own changes could not be read', { sessionId: session.claudeSessionId, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/** A name under the target task dir that no other piece took. */
function freeRel(want: string, taken: Set<string>): string {
  let rel = want || 'workspace';
  for (let i = 2; taken.has(rel); i++) rel = `${want}-${i}`;
  taken.add(rel);
  return rel;
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
  const existing = await new DaemonFileReader(targetHost).listDir(targetTaskDir).catch(() => [] as string[]);
  const taken = new Set<string>(existing);
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
    packed.push({ piece: { kind: 'repo', source: repo.root, rel: freeRel(repo.rel || path.posix.basename(repo.root), taken) }, pack });
  }

  // The session's folder outside the task directory: a checkout others may share.
  let cwdPiece: Packed | undefined = packed.find((p) => cwd && inside(cwd, p.piece.source));
  // Where in its repository the session ran, kept when it continues in another copy of it.
  let relCwd = cwdPiece && cwd ? path.posix.relative(cwdPiece.piece.source, cwd) : '';
  const ownUnknown = new Set<Packed>();
  if (!cwdPiece && cwd && !(sourceTaskDir && inside(cwd, sourceTaskDir))) {
    const probe = await client.packWorkspace(sourceHost, { cwd, outDir: outDir(n++), paths: [] });
    relCwd = probe.meta.relCwd ?? '';
    if (probe.meta.kind === 'git') {
      const same = packed.find((p) => p.pack.meta.kind === 'git' && (sameRepoUrl(cloneUrlOf(p.pack.meta), cloneUrlOf(probe.meta))
        || p.pack.meta.remotes?.some((r) => r.url.replace(/\/+$/, '') === probe.meta.root)));
      const mine = await ownFiles(session, probe.meta.root, sourceHost);
      if (same && (!mine || mine.length === 0)) {
        // The work is the task directory's clone of this repository: the session continues there.
        cwdPiece = same;
      } else {
        const pack = mine && mine.length > 0
          ? await client.packWorkspace(sourceHost, { cwd, outDir: outDir(n++), paths: mine })
          : probe;
        cwdPiece = { piece: { kind: 'checkout', source: probe.meta.root, rel: freeRel(path.posix.basename(probe.meta.root), taken) }, pack };
        if (!mine) ownUnknown.add(cwdPiece);
        packed.push(cwdPiece);
      }
    } else {
      // A plain folder outside the task directory (notes, a scratch dir): it moves whole.
      const pack = await client.packWorkspace(sourceHost, { cwd, outDir: outDir(n++), asDir: true });
      cwdPiece = { piece: { kind: 'files', source: probe.meta.root, rel: freeRel(path.posix.basename(probe.meta.root), taken) }, pack };
      packed.push(cwdPiece);
    }
  }

  // The task directory's own files, without its repositories (they rode above).
  if (sourceTaskDir && scan && scan.loose.count > 0) {
    if (scan.loose.bytes > MAX_LOOSE_BYTES) {
      log.session.info('task move: the task directory\'s loose files are too large to move', { taskId: task.id, bytes: scan.loose.bytes });
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
        log.session.warn('task move: the target could not set a piece up; the new session will', { taskId: task.id, dest, error: base.error });
        // A repository's folder was free before this apply (freeRel), so what is there now is its half-made clone.
        if (m.kind === 'git' && p.piece.rel && dest.startsWith(`${targetTaskDir}/`)) {
          await new DaemonFileReader(targetHost).removePath(dest, true).catch(() => {});
        }
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
  return { cwd: cwdOnTarget, targetTaskDir, pieces, cleanRepos, summary: describeMovedWork(pieces, cleanRepos) };
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
