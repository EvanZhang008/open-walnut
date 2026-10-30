/**
 * What a transfer will do, decided before anything is touched.
 *
 * A transfer moves a task's conversation to another engine and/or host. It
 * always makes a NEW task (one session per task, sessions/one-session-per-task.ts):
 *   carry: the conversation comes along. Claude to Claude in the same place
 *          forks the CLI's own transcript by id (lossless); elsewhere it does
 *          so from a private copy once the target's CLI is a version checked
 *          to resume a copied file (resumeFileGate), and until then replays it
 *          like any other pair: a transcript file plus a seed in the first message.
 *   brief: the new task starts from a handoff brief written from the
 *          conversation, not from the conversation itself.
 * When the host changes, the workspace (branch, uncommitted changes, untracked
 * files) is packed on the source host and moved to the target.
 */
import { VALID_SESSION_EFFORT_IDS, VALID_SESSION_MODE_IDS, type SessionEffort, type SessionEngine, type SessionMode, type SessionRecord, type Task } from '../types.js';
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
  /** 'default' = the engine's default, not the source session's model. */
  model?: string;
  /** Reasoning effort for the new session (Claude Code; an ACP engine's effort rides its model id). */
  effort?: SessionEffort;
  /** Permission mode the new session starts in. */
  permissionMode?: SessionMode;
  /** What the new task should do first, after taking the work over. */
  message?: string;
  /** Leave the source task open (a copy). Default: the source task completes, except from a
   *  session when the source is still in use (source-in-use.ts), where it stays open. */
  keepSource?: boolean;
  callerSid?: string;
}

export interface TransferPlan {
  source: { task: Task; session: SessionRecord; engine: SessionEngine; host: string; cwd: string };
  target: {
    engine: SessionEngine; host: string; cwd: string | 'auto';
    /** Unset = the engine's default. On the same engine it defaults to the source session's. */
    model?: string; effort?: SessionEffort; permissionMode?: SessionMode;
  };
  mode: TransferMode;
  history: HistoryMethod;
  changesHost: boolean;
  changesEngine: boolean;
  /** The workspace must be packed and moved (the host changes). */
  moveWorkspace: boolean;
  /** Same host and directory: a Claude to Claude fork resumes the source by id, nothing is staged. */
  inPlace: boolean;
}

/**
 * Claude Code versions checked to resume a transcript FILE with --fork-session
 * and --session-id. None yet, and Walnut records no host's CLI version, so a
 * Claude to Claude carry to another place replays the conversation instead.
 * Before a version goes in, the private stage's owner stamp must also answer
 * for every target it would serve: a daemon shared by several Walnuts on one
 * host, and a local daemon a service manager restarted (no fresh stamp).
 */
const CLI_RESUME_FILE_VERSIONS: readonly string[] = [];
export interface ResumeFileGate { versions: readonly string[]; versionOn: (host: string) => Promise<string | null> }
const CLOSED_GATE: ResumeFileGate = { versions: CLI_RESUME_FILE_VERSIONS, versionOn: async () => null };
let resumeFileGate: ResumeFileGate = CLOSED_GATE;
export function getResumeFileGate(): ResumeFileGate { return resumeFileGate; }
/** Test-only: the allowlist and the target's CLI version. */
export function __setResumeFileGateForTesting(gate: ResumeFileGate | null): void { resumeFileGate = gate ?? CLOSED_GATE; }

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
  // Every ACP engine runs on another host through that host's daemon, which finds the
  // engine's CLI there (providers/acp-host-artifacts.ts). Not the custom engine: its
  // adapter command is this machine's config. Whether the host HAS the CLI is the
  // host's answer (agents/host-engines.ts), not this rule's.
  if (isAcpEngine(engine) && engineCaps(engine).acpAdapter?.source === 'config' && normalizeHost(host) !== LOCAL_HOST) {
    return `${engineCaps(engine).displayName} runs on this machine only: its adapter command is this machine's config`;
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

  if (req.effort !== undefined && !VALID_SESSION_EFFORT_IDS.has(req.effort)) {
    throw new TransferError('effort is one of low, medium, high, xhigh, max', 400, 'bad_effort');
  }
  if (req.permissionMode !== undefined && !VALID_SESSION_MODE_IDS.has(req.permissionMode)) {
    throw new TransferError(`Unknown permission mode: ${req.permissionMode}`, 400, 'bad_permission_mode');
  }
  // What the new session runs with: the request's pick, else the source's own
  // settings when they still mean something (the same engine). An ACP engine
  // has no separate effort: its model id carries it.
  const launch = targetLaunch(session, sourceEngine, engine, req);

  const mode: TransferMode = req.mode ?? 'carry';
  // 'auto' without a host change keeps the source's directory (transfer.ts: no move, no place).
  const inPlace = !changesHost && (cwd === 'auto' || cwd === sourceCwd);
  const sourceNative = engineCaps(sourceEngine).historySource === 'provider-jsonl';
  const targetNative = engineCaps(engine).historySource === 'provider-jsonl';
  const history: HistoryMethod = mode === 'brief'
    ? 'brief'
    : sourceNative && targetNative && sourceEngine === engine
      && (inPlace || resumeFileGate.versions.length > 0) ? 'native-copy' : 'replay';
  return {
    source: { task, session, engine: sourceEngine, host: sourceHost, cwd: sourceCwd },
    target: { engine, host, cwd, ...launch },
    mode,
    history,
    changesHost,
    changesEngine,
    moveWorkspace: changesHost,
    inPlace,
  };
}

/** The model, effort and permission mode the target session launches with. */
export function targetLaunch(
  session: SessionRecord, sourceEngine: SessionEngine, engine: SessionEngine,
  req: Pick<TransferRequest, 'model' | 'effort' | 'permissionMode'>,
): { model?: string; effort?: SessionEffort; permissionMode?: SessionMode } {
  const sameEngine = engine === sourceEngine;
  const model = req.model ?? (sameEngine ? (session.cliModel || session.model || undefined) : undefined);
  const effort = isAcpEngine(engine) ? undefined : req.effort ?? (sameEngine ? session.effort : undefined);
  const sourceMode = session.mode && VALID_SESSION_MODE_IDS.has(session.mode) ? session.mode : undefined;
  const permissionMode = req.permissionMode ?? sourceMode;
  return {
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(permissionMode ? { permissionMode } : {}),
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
