/**
 * What a transfer will do, decided before anything is touched.
 *
 * A transfer moves a task's conversation to another engine and/or host. It
 * always makes a NEW task (one session per task, sessions/one-session-per-task.ts):
 *   carry: the conversation comes along. Claude to Claude copies the CLI's own
 *          transcript and forks it (lossless); any other pair replays it as a
 *          transcript file plus a seed in the first message.
 *   brief: the new task starts from a handoff brief written from the
 *          conversation, not from the conversation itself.
 * When the host changes, the workspace (branch, uncommitted changes, untracked
 * files) is packed on the source host and moved to the target.
 */
import type { SessionEngine, SessionRecord, Task } from '../types.js';
import { engineCaps, isAcpEngine, resolveEngine } from '../agents/engine-registry.js';

export const LOCAL_HOST = '__local__';
export type TransferMode = 'carry' | 'brief';
export type HistoryMethod = 'native-copy' | 'replay' | 'brief';

export interface TransferRequest {
  taskId: string;
  engine?: SessionEngine;
  host?: string;
  /** Absolute path on the target host, or 'auto' to let Walnut choose one. */
  cwd?: string;
  mode?: TransferMode;
  model?: string;
  /** What the new task should do first, after taking the work over. */
  message?: string;
  /** Leave the source task open (a copy). Default: the source task completes. */
  keepSource?: boolean;
  callerSid?: string;
}

export interface TransferPlan {
  source: { task: Task; session: SessionRecord; engine: SessionEngine; host: string; cwd: string };
  target: { engine: SessionEngine; host: string; cwd: string | 'auto'; model?: string };
  mode: TransferMode;
  history: HistoryMethod;
  changesHost: boolean;
  changesEngine: boolean;
  /** The workspace must be packed and moved (the host changes). */
  moveWorkspace: boolean;
}

export class TransferError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
    this.name = 'TransferError';
  }
}

export function normalizeHost(host: string | undefined | null): string {
  return !host || host === 'local' || host === LOCAL_HOST ? LOCAL_HOST : host;
}

/**
 * Why `engine` cannot run on `host`, or null when it can. ACP engines run
 * through the local worker only (web/routes/engines.ts localOnly).
 */
export function engineHostBlocker(engine: SessionEngine, host: string): string | null {
  if (isAcpEngine(engine) && normalizeHost(host) !== LOCAL_HOST) {
    return `${engineCaps(engine).displayName} runs on this machine only for now`;
  }
  return null;
}

export function planTransfer(
  task: Task,
  session: SessionRecord,
  req: TransferRequest,
  knownHosts: ReadonlySet<string>,
): TransferPlan {
  const sourceEngine = resolveEngine(session.engine);
  const sourceHost = normalizeHost(session.host);
  const sourceCwd = session.cwd ?? task.cwd ?? '';
  const engine = req.engine ? resolveEngine(req.engine) : sourceEngine;
  const host = req.host !== undefined ? normalizeHost(req.host) : sourceHost;
  if (host !== LOCAL_HOST && !knownHosts.has(host)) {
    throw new TransferError(`Unknown host: ${host}`, 400, 'unknown_host');
  }
  const blocker = engineHostBlocker(engine, host);
  if (blocker) throw new TransferError(blocker, 409, 'engine_host_unsupported');

  const changesHost = host !== sourceHost;
  const changesEngine = engine !== sourceEngine;
  let cwd: string | 'auto';
  if (req.cwd === 'auto') cwd = 'auto';
  else if (req.cwd) {
    if (!req.cwd.startsWith('/') && !req.cwd.startsWith('~/')) {
      throw new TransferError('cwd must be an absolute path (or "auto")', 400, 'bad_cwd');
    }
    cwd = sameDir(req.cwd, sourceCwd) ? sourceCwd : req.cwd.replace(/(.)\/+$/, '$1');
  } else cwd = changesHost ? 'auto' : sourceCwd;
  if (!changesHost && !changesEngine && cwd === sourceCwd && !req.model) {
    throw new TransferError('Nothing would change: pick another engine, host or directory (or fork the session)', 400, 'nothing_to_transfer');
  }
  if (!sourceCwd && changesHost) {
    throw new TransferError('The source session has no working directory to move', 400, 'no_source_cwd');
  }

  const mode: TransferMode = req.mode ?? 'carry';
  const sourceNative = engineCaps(sourceEngine).historySource === 'provider-jsonl';
  const targetNative = engineCaps(engine).historySource === 'provider-jsonl';
  const history: HistoryMethod = mode === 'brief'
    ? 'brief'
    : sourceNative && targetNative && sourceEngine === engine ? 'native-copy' : 'replay';
  return {
    source: { task, session, engine: sourceEngine, host: sourceHost, cwd: sourceCwd },
    target: { engine, host, cwd, ...(req.model ? { model: req.model } : {}) },
    mode,
    history,
    changesHost,
    changesEngine,
    moveWorkspace: changesHost,
  };
}

export interface TransferOption {
  engine: SessionEngine;
  host: string;
  /** Present when this pair cannot be picked. */
  blockedReason?: string;
}

/** Every engine × host pair, with a reason on the ones that cannot run. */
export function transferOptions(engines: readonly SessionEngine[], hosts: readonly string[]): TransferOption[] {
  const out: TransferOption[] = [];
  for (const engine of engines) {
    for (const host of [LOCAL_HOST, ...hosts.filter((h) => normalizeHost(h) !== LOCAL_HOST)]) {
      const blockedReason = engineHostBlocker(engine, host);
      out.push({ engine, host, ...(blockedReason ? { blockedReason } : {}) });
    }
  }
  return out;
}

/** Two spellings of one directory: trailing slashes do not make another place. */
function sameDir(a: string, b: string): boolean {
  const trim = (p: string): string => p.replace(/(.)\/+$/, '$1');
  return trim(a) === trim(b);
}
