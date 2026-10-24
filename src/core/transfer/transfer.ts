/**
 * Transfer a task's work to another engine and/or host (planner.ts says what
 * each mode does). The steps, in order, each one reversible until the start:
 *   1. plan: validate the engine × host pair, pick the history method
 *   2. learn the target host if its probe is stale (host-profile.ts)
 *   3. host change: pack the workspace, move it, choose the target directory
 *   4. history: a transcript file plus a seed, or a handoff brief; Claude to
 *      Claude forks the source's own conversation instead (below)
 *   5. a new task beside the source (one session per task) and its first
 *      message: history, workspace steps, host summary, the first instruction
 *   6. start it; then the source task completes (unless kept) and both point
 *      at each other
 *
 * Claude to Claude (native-copy) in another place, once planner.ts allows a CLI
 * version for it (none yet: such a transfer replays): the source transcript is
 * relayed into a private stage the target daemon owns ('transfer-private-v1'),
 * the CLI forks from that file, and the transfer is done only once that very
 * spawn's init has run its whole record chain (TRANSFER_FORK_INIT) and its new
 * transcript holds the source's active leaf. Every refusal before the stage
 * leaves nothing behind; every failure after it keeps the new task and the
 * stage (NEED_ACTION) and leaves the source open.
 */
import os from 'node:os';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { log } from '../../logging/index.js';
import type { SessionRecord, Task } from '../types.js';
import { engineCaps } from '../agents/engine-registry.js';
import { bus, EventNames, eventData } from '../event-bus.js';
import { computeCliLoadedChain, type TranscriptChainLine } from '../transcript-chain.js';
import { getResumeFileGate, LOCAL_HOST, planTransfer, TransferError, type HistoryMethod, type TransferPlan, type TransferRequest } from './planner.js';
import { renderTranscriptMarkdownChunked, renderTranscriptSeed } from './transcript.js';
import { hostDisplayName } from '../hosts/host-display-name.js';
import { chooseTargetCwd, moveWorkspace, pruneLocalTransfers, transfersDir, workspaceInstructions, type MovedWorkspace } from './workspace.js';
import {
  probeIsStale, readHostProfile, recordProbedFacts, recordRepoPath, repoKey, type HostProfile,
} from '../hosts/host-profile.js';

const SEED_CHARS = 40_000;
const TITLE_MAX = 60;
/** How long a fork has to show its init and the source's leaf. */
const FORK_CONFIRM_MS = 180_000;
const LEAF_POLL_MS = 5_000;

/** One read of a fork's transcript while looking for the source's leaf. */
const SCAN_CHUNK_BYTES = 1024 * 1024;

export { __setResumeFileGateForTesting } from './planner.js';

export interface TransferResult {
  taskId: string;
  title: string;
  sessionId?: string;
  requestId?: string;
  sourceTaskId: string;
  sourceCompleted: boolean;
  history: HistoryMethod;
  target: { engine: string; host: string; cwd: string; model?: string; effort?: string; permissionMode?: string };
  workspace?: { route: 'direct' | 'relay'; bytes: number; bundleDir: string; files: string[] };
  transcriptPath?: string;
}

function hostLabel(host: string): string {
  return host === LOCAL_HOST ? 'this Mac' : hostDisplayName(host);
}

/** The target's profile, probed first when the last probe is old or missing. Never fails the transfer. */
async function freshProfile(host: string): Promise<HostProfile | null> {
  const profile = await readHostProfile(host).catch(() => null);
  if (profile && !probeIsStale(profile)) return profile;
  try {
    const { probeHostFacts } = await import('./daemon-transfer-client.js');
    return await recordProbedFacts(host, await probeHostFacts(host));
  } catch (err) {
    log.session.info('transfer: target host probe unavailable', { host, error: err instanceof Error ? err.message : String(err) });
    return profile;
  }
}

function expandHome(p: string, host: string, profile: HostProfile | null): string {
  if (!p.startsWith('~')) return p;
  const home = host === LOCAL_HOST ? os.homedir() : profile?.probed?.home;
  if (!home) throw new TransferError(`Walnut does not know the home directory on ${host} yet; pass an absolute cwd`, 409, 'unknown_home');
  return p.replace(/^~/, home);
}

async function writeTargetFile(host: string, filePath: string, content: string): Promise<void> {
  const bytes = Buffer.from(content, 'utf8');
  if (bytes.length <= 4 * 1024 * 1024) {
    const { DaemonFileReader } = await import('../daemon-file-reader.js');
    await new DaemonFileReader(host).writeFile(filePath, content);
    return;
  }
  const { writePart } = await import('./daemon-transfer-client.js');
  const { createHash } = await import('node:crypto');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const step = 1024 * 1024;
  for (let offset = 0; offset < bytes.length; offset += step) {
    const final = offset + step >= bytes.length;
    await writePart(host, {
      path: filePath, offset, data: bytes.subarray(offset, offset + step),
      ...(final ? { final: true, size: bytes.length, sha256 } : {}),
    });
  }
}

/** A daemon refusal as the HTTP answer it is (an old daemon, an absent host). */
async function hostFailure(err: unknown): Promise<unknown> {
  const { DaemonNeedsUpgradeError } = await import('../daemon-file-reader.js');
  const { TransferHostOfflineError } = await import('./daemon-transfer-client.js');
  if (err instanceof DaemonNeedsUpgradeError) return new TransferError(err.message, 409, 'daemon_upgrade_required');
  if (err instanceof TransferHostOfflineError) return new TransferError(err.message, 502, 'host_offline');
  return err;
}

/** Parse a transcript in slices, yielding between them: a long one is tens of MB and the event loop serves every route. */
async function chainLines(text: string): Promise<TranscriptChainLine[]> {
  const lines: TranscriptChainLine[] = [];
  let n = 0;
  for (const raw of text.split('\n')) {
    if (++n % 2000 === 0) await new Promise((r) => setImmediate(r));
    if (!raw.trim()) continue;
    try { lines.push(JSON.parse(raw) as TranscriptChainLine); } catch { /* a torn line: the CLI skips it too */ }
  }
  return lines;
}

interface NativeFork {
  /** The source transcript on the source host. */
  from: string;
  /** Where the private stage goes on the target, and the attempt's token. */
  stage?: { path: string; attempt: string };
}

/**
 * Everything a Claude to Claude fork can refuse before anything is written:
 * the CLI allowlist and the target's private-stage capability (only when the
 * conversation must be staged), then the source transcript, told apart honestly.
 * A fork in place reads nothing more: the CLI finds its own transcript by id.
 */
async function prepareNativeFork(session: SessionRecord, plan: TransferPlan, inPlace: boolean): Promise<NativeFork> {
  const client = await import('./daemon-transfer-client.js');
  if (!inPlace) {
    const gate = getResumeFileGate();
    const version = await gate.versionOn(plan.target.host).catch(() => null);
    if (!version || !gate.versions.includes(version)) {
      throw new TransferError(
        `Claude Code on ${hostLabel(plan.target.host)} is not a version checked to continue a conversation from a copied file`,
        409, 'cli_resume_file_unsupported');
    }
    try { await client.assertPrivateStage(plan.target.host); } catch (err) { throw await hostFailure(err); }
  }
  const sid = session.claudeSessionId;
  const found = await client.findTranscript(plan.source.host, sid);
  if (found.kind === 'unreachable') throw new TransferError(`The source host did not answer: ${found.error}`, 502, 'source_unreachable');
  if (found.kind === 'none') throw new TransferError('The source transcript was not found on its host', 409, 'transcript_missing');
  if (found.kind === 'many') throw new TransferError(`The source host has ${found.paths.length} transcripts for this session`, 409, 'transcript_ambiguous');
  if (inPlace) return { from: found.path };
  // The stage has a dir of its own: the workspace pack goes under the transfer's
  // id first, and the private write only accepts an attempt dir it made itself.
  return {
    from: found.path,
    stage: { path: `${transfersDir(plan.target.host)}/xf-${randomUUID()}/transcript/${sid}.jsonl`, attempt: randomBytes(16).toString('hex') },
  };
}

/** Relay the source transcript into the private stage; returns the staged file and the source's active leaf. */
async function stageTranscript(plan: TransferPlan, fork: NativeFork & { stage: NonNullable<NativeFork['stage']> }): Promise<{ path: string; leafUuid: string }> {
  const { relayFile } = await import('./daemon-transfer-client.js');
  const parts: Buffer[] = [];
  let relayed: Awaited<ReturnType<typeof relayFile>>;
  try {
    relayed = await relayFile(plan.source.host, fork.from, plan.target.host, fork.stage.path, {
      privateAttempt: fork.stage.attempt, onBytes: (b) => { parts.push(Buffer.from(b)); },
    });
  } catch (err) { throw await hostFailure(err); }
  const bytes = Buffer.concat(parts);
  if (!relayed.path || createHash('sha256').update(bytes).digest('hex') !== relayed.sha256) {
    throw new TransferError('The staged transcript is not the one that was read', 502, 'stage_unverified');
  }
  const leafUuid = computeCliLoadedChain(await chainLines(bytes.toString('utf8'))).leafUuid;
  if (!leafUuid) throw new TransferError('The source transcript holds no conversation', 409, 'transcript_empty');
  return { path: relayed.path, leafUuid };
}

/**
 * Wait for THIS attempt's fork to finish its first init (TRANSFER_FORK_INIT, sent
 * after the record, rename and queue move), or for the new task's session to
 * fail first. Subscribed before the start is requested, so nothing is missed.
 */
function waitForForkInit(attemptId: string, taskId: string, ms: number): { done: Promise<string>; cancel(): void } {
  const name = `transfer-attempt:${attemptId}`;
  let finish: (r: string | Error) => void = () => {};
  const done = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => finish(new TransferError('The new session did not confirm its start in time', 504, 'fork_unconfirmed')), ms);
    timer.unref?.();
    finish = (r) => {
      clearTimeout(timer);
      bus.unsubscribe(name);
      if (r instanceof Error) reject(r); else resolve(r);
    };
    bus.subscribe(name, (event) => {
      if (event.name === EventNames.TRANSFER_FORK_INIT) {
        const d = eventData<'transfer:fork-init'>(event);
        if (d.attemptId !== attemptId) return;
        finish(d.refused ? new TransferError(`The new session was not started: ${d.refused}`, 409, 'fork_refused') : d.actualId);
        return;
      }
      const d = event.data as { taskId?: string; error?: string } | undefined;
      if (d?.taskId !== taskId) return;
      if (event.name === EventNames.SESSION_ERROR) finish(new TransferError(`The new session failed: ${d.error ?? 'unknown error'}`, 502, 'fork_failed'));
      else if (event.name === EventNames.SESSION_ENDED) finish(new TransferError('The new session ended before it confirmed its start', 502, 'fork_failed'));
    }, { global: true, interest: [EventNames.TRANSFER_FORK_INIT, EventNames.SESSION_ERROR, EventNames.SESSION_ENDED] });
  });
  return { done, cancel: () => { done.catch(() => {}); finish(new Error('cancelled')); } };
}

/**
 * Whether a fork's transcript holds the record `uuid`: scanned forward from
 * where the last look stopped, one chunk at a time, never parsed and never held
 * whole (a long conversation is tens of MB, and the server's loop serves every route).
 */
async function transcriptHolds(host: string, filePath: string, uuid: string, scan: { offset: number }): Promise<boolean> {
  const { DaemonFileReader } = await import('../daemon-file-reader.js');
  const reader = new DaemonFileReader(host);
  const needle = Buffer.from(`"uuid":"${uuid}"`);
  // A needle split across two chunks is found by keeping its length minus one byte of overlap;
  // the next look (or a retry after a failed read) starts where that overlap does.
  let pos = scan.offset;
  let carry = Buffer.alloc(0);
  for (;;) {
    const part = await reader.readRangeBytes(filePath, pos, SCAN_CHUNK_BYTES);
    if (!part || part.buf.length === 0) return false;
    const window = Buffer.concat([carry, part.buf]);
    if (window.includes(needle)) return true;
    pos += part.buf.length;
    carry = window.subarray(Math.max(0, window.length - (needle.length - 1)));
    scan.offset = pos - carry.length;
    if (part.eof) return false;
    await new Promise((r) => setImmediate(r));
  }
}

/**
 * The init's id is the new task's conversation, and (for a fork from a staged
 * file) its transcript carries the source's leaf. A fork in place resumed the
 * source by id from the CLI's own store, so its init is the proof.
 */
async function confirmFork(taskId: string, actualId: string, host: string, leafUuid: string | undefined, deadline: number): Promise<void> {
  const { taskConversation } = await import('../sessions/task-session-claim.js');
  const linked = await taskConversation(taskId);
  if (linked?.claudeSessionId !== actualId) {
    throw new TransferError(`The new task is not linked to the session that started (${actualId})`, 409, 'fork_link_mismatch');
  }
  if (!leafUuid) return;
  const { findTranscript } = await import('./daemon-transfer-client.js');
  const scan = { offset: 0, path: '' };
  for (;;) {
    const found = await findTranscript(host, actualId);
    if (found.kind === 'many') throw new TransferError('The target host has several transcripts for the new session', 409, 'transcript_ambiguous');
    // The CLI copies the resumed conversation in with its uuids kept, at the first turn.
    if (found.kind === 'one') {
      if (found.path !== scan.path) Object.assign(scan, { offset: 0, path: found.path });
      if (await transcriptHolds(host, found.path, leafUuid, scan).catch(() => false)) return;
    }
    if (Date.now() + LEAF_POLL_MS > deadline) {
      throw new TransferError('The new session\'s transcript does not hold the conversation yet', 504, 'fork_unconfirmed');
    }
    await new Promise((r) => setTimeout(r, LEAF_POLL_MS));
  }
}

function transferTitle(task: Task, plan: TransferPlan): string {
  // A task that came from a transfer wears the last place as its last layer; the
  // next transfer replaces that layer instead of stacking another.
  const base = (task.transferred_from ? task.title.replace(/\s+·\s+[^·]+$/, '').trim() : task.title) || task.title;
  const where = plan.changesHost && plan.changesEngine
    ? `${engineCaps(plan.target.engine).displayName} @ ${hostLabel(plan.target.host)}`
    : plan.changesEngine ? engineCaps(plan.target.engine).displayName
      : plan.changesHost ? hostLabel(plan.target.host)
        // Only the model changed: name it.
        : plan.target.cwd === plan.source.cwd && plan.target.model ? plan.target.model
          // Only the directory changed: name the new one.
          : (plan.target.cwd.replace(/\/+$/, '').split('/').pop() || plan.target.cwd);
  const suffix = ` · ${where}`;
  return base.length + suffix.length > TITLE_MAX ? `${base.slice(0, TITLE_MAX - suffix.length - 1)}…${suffix}` : `${base}${suffix}`;
}

function composeMessage(p: {
  task: Task; plan: TransferPlan; cwd: string; history: string; transcriptPath?: string;
  workspace?: string; first?: string;
}): string {
  const { task, plan } = p;
  const from = `${engineCaps(plan.source.engine).displayName} on ${hostLabel(plan.source.host)} in ${plan.source.cwd || 'an unknown directory'}`;
  const to = `${engineCaps(plan.target.engine).displayName} on ${hostLabel(plan.target.host)} in ${p.cwd}`;
  const parts: string[] = [];
  parts.push(`# Work transferred to you\n\nThis task takes over "${task.title}" (task ${task.id}), which ran ${from}. You run ${to}.`
    + (plan.history === 'native-copy'
      ? ' The conversation above is that task\'s own conversation, carried over as it was.'
        + (plan.changesHost || p.cwd !== plan.source.cwd ? ' Paths and results in it refer to the old place; check them here before relying on them.' : '')
      : ''));
  if (p.history) parts.push(p.history);
  if (p.transcriptPath) parts.push(`The full earlier conversation is at ${p.transcriptPath} on this host; read it when you need a detail the summary above leaves out.`);
  if (p.workspace) parts.push(`## Workspace\n\n${p.workspace}`);
  parts.push(`## First\n\n${p.first?.trim() || (plan.moveWorkspace
    ? 'Set the workspace up as described, install what is missing, check that it builds, then continue the work where it stood.'
    : 'Continue the work where it stood.')}`);
  return parts.join('\n\n');
}

/** Nothing started and nothing was staged: the new task holds nothing, and the source keeps the work. */
async function removeUnstartedTask(targetId: string, sourceTaskId: string, transferId: string, err: unknown): Promise<void> {
  const tm = await import('../task-manager.js');
  await tm.deleteTask(targetId).catch(() => { /* reported below */ });
  log.session.warn('transfer: the new session did not start; its task was removed', {
    transferId, sourceTaskId, taskId: targetId, error: err instanceof Error ? err.message : String(err),
  });
}

/**
 * A failure once the stage may exist or the start was asked for: nothing is
 * deleted. The new task keeps its stage and says what happened (NEED_ACTION);
 * the source stays open and is not marked transferred.
 */
async function keepForUser(targetId: string, transferId: string, err: unknown): Promise<never> {
  const tm = await import('../task-manager.js');
  const message = err instanceof Error ? err.message : String(err);
  await tm.updateTaskRaw(targetId, (cur) => ({ transfer: { ...(cur.transfer ?? { id: transferId }), error: message } }), { source: 'transfer' })
    .catch((e) => log.session.warn('transfer: recording the failure on the new task failed', { taskId: targetId, error: String(e) }));
  await tm.updateTask(targetId, { phase: 'NEED_ACTION' }, { source: 'transfer' })
    .catch((e) => log.session.warn('transfer: handing the new task back failed', { taskId: targetId, error: String(e) }));
  log.session.warn('transfer: not confirmed; the new task and its stage are kept', { transferId, taskId: targetId, error: message });
  const e = err as { status?: unknown; code?: unknown };
  throw new TransferError(
    `${message.replace(/\.$/, '')}. The new task is kept as it is for you to look at, and the source task stays open.`,
    typeof e.status === 'number' ? e.status : 502, typeof e.code === 'string' ? e.code : 'transfer_unconfirmed');
}

/** Stage (when needed), fork, and confirm. Returns the id the new session really runs under. */
async function runNativeFork(p: {
  target: Task; sourceTaskId: string; session: SessionRecord; plan: TransferPlan; fork: NativeFork; cwd: string; message: string; transferId: string;
}): Promise<string> {
  const { target, plan, fork, transferId } = p;
  let resumeFile: string | undefined;
  let leafUuid: string | undefined;
  if (fork.stage) {
    try {
      const staged = await stageTranscript(plan, { ...fork, stage: fork.stage });
      resumeFile = staged.path;
      leafUuid = staged.leafUuid;
    } catch (err) { return keepForUser(target.id, transferId, err); }
  }
  const deadline = Date.now() + FORK_CONFIRM_MS;
  const waiter = waitForForkInit(transferId, target.id, FORK_CONFIRM_MS);
  try {
    const { forkSessionToTask } = await import('../sessions/session-controls.js');
    await forkSessionToTask(p.session.claudeSessionId, {
      // 'default' = no --model (the CLI's own default); a fork would otherwise keep the source's.
      task_id: target.id, message: p.message, model: plan.target.model === 'default' ? '' : plan.target.model, rawMessage: true,
      ...(plan.target.effort ? { effort: plan.target.effort } : {}),
      ...(plan.target.permissionMode ? { permissionMode: plan.target.permissionMode } : {}),
      placeOverride: { cwd: p.cwd, ...(plan.target.host === LOCAL_HOST ? {} : { host: plan.target.host }) },
      ...(resumeFile ? { resumeFile } : {}),
      transferAttemptId: transferId,
    }, 'transfer');
  } catch (err) {
    waiter.cancel();
    if (!fork.stage) { await removeUnstartedTask(target.id, p.sourceTaskId, transferId, err); throw err; }
    return keepForUser(target.id, transferId, err);
  }
  let actualId: string;
  try {
    actualId = await waiter.done;
  } catch (err) {
    // Refused before anything ran: in place nothing was staged, so the new task holds nothing.
    if ((err as { code?: string }).code === 'fork_refused' && !fork.stage) {
      await removeUnstartedTask(target.id, p.sourceTaskId, transferId, err);
      throw err;
    }
    return keepForUser(target.id, transferId, err);
  }
  try {
    await confirmFork(target.id, actualId, plan.target.host, leafUuid, deadline);
    const tm = await import('../task-manager.js');
    await tm.updateTaskRaw(target.id, { transfer_state: 'done' }, { source: 'transfer' });
    if (resumeFile) void removeStage(target.id, plan.target.host, resumeFile, transferId);
    return actualId;
  } catch (err) { return keepForUser(target.id, transferId, err); }
}

/** The fork holds the conversation in its own transcript now: the staged copy goes (best effort, never fails the transfer). */
async function removeStage(taskId: string, host: string, stagedFile: string, transferId: string): Promise<void> {
  const parts = stagedFile.split('/');
  const attemptDir = parts.slice(0, -2).join('/');
  if (parts.at(-2) !== 'transcript' || !/^xf-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(parts.at(-3) ?? '')) return;
  try {
    const { DaemonFileReader } = await import('../daemon-file-reader.js');
    await new DaemonFileReader(host).removePath(attemptDir, true);
    const tm = await import('../task-manager.js');
    await tm.updateTaskRaw(taskId, (cur) => ({ transfer: { ...(cur.transfer ?? { id: transferId }), stage: undefined } }), { source: 'transfer' });
  } catch (err) {
    log.session.info('transfer: the staged transcript could not be removed', { transferId, host, attemptDir, error: err instanceof Error ? err.message : String(err) });
  }
}

export async function transferTask(req: TransferRequest, transferId = `xf-${randomUUID()}`): Promise<TransferResult> {
  const tm = await import('../task-manager.js');
  let task: Task;
  try {
    task = await tm.getTask(req.taskId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new TransferError(msg, msg.includes('No task found') ? 404 : 400, 'task_not_found');
  }
  const { taskConversation } = await import('../sessions/task-session-claim.js');
  const session = await taskConversation(task.id);
  if (!session) throw new TransferError('This task has no conversation to transfer; start it instead', 409, 'no_conversation');
  const { getConfig } = await import('../config-manager.js');
  const config = await getConfig();
  const hosts = config.hosts ?? {};
  const known = new Set(Object.entries(hosts).filter(([, h]) => (h as { enabled?: boolean }).enabled !== false).map(([k]) => k));
  const plan = planTransfer(task, session, req, known);
  // The SDK session server starts fresh sessions and cannot fork one: the
  // conversation is replayed instead (a fork there would never confirm).
  if (plan.history === 'native-copy' && config.session_server?.enabled) plan.history = 'replay';
  if (session.process_status === 'running') {
    throw new TransferError('The task\'s session is in the middle of a turn. Wait for it to finish (or stop it), then transfer, so nothing it does is left behind.', 409, 'source_busy');
  }
  void pruneLocalTransfers().catch(() => {});
  log.session.info('transfer: planned', {
    transferId, taskId: task.id, sessionId: session.claudeSessionId, history: plan.history,
    from: { engine: plan.source.engine, host: plan.source.host }, to: { engine: plan.target.engine, host: plan.target.host, cwd: plan.target.cwd },
  });

  // A conversation that must be staged is gated before the target is probed or any workspace byte moves.
  let fork: NativeFork | undefined;
  if (plan.history === 'native-copy' && plan.changesHost) fork = await prepareNativeFork(session, plan, false);

  const profile = plan.changesHost ? await freshProfile(plan.target.host) : await readHostProfile(plan.target.host).catch(() => null);

  let moved: MovedWorkspace | undefined;
  let place: ReturnType<typeof chooseTargetCwd> | undefined;
  if (plan.moveWorkspace) {
    moved = await moveWorkspace({ transferId, sourceHost: plan.source.host, sourceCwd: plan.source.cwd, targetHost: plan.target.host });
    place = chooseTargetCwd(moved.meta, plan.source.cwd, profile);
  }
  const chosen = plan.target.cwd === 'auto' ? (place?.cwd ?? plan.source.cwd) : plan.target.cwd;
  const cwd = expandHome(chosen, plan.target.host, profile);
  // A directory the user named is where the workspace goes, even when the host
  // knows the repository elsewhere (2026-10-21: a transfer back to this Mac into
  // a new folder set itself up in the original checkout instead).
  // A named absolute cwd needs no home: an unknown one only loses the "known" hint.
  const knownRoot = !place ? cwd : plan.target.cwd === 'auto'
    ? expandHome(place.repoRoot, plan.target.host, profile)
    : (() => { try { return expandHome(place.repoRoot, plan.target.host, profile); } catch { return undefined; } })();
  const repoRoot = plan.target.cwd === 'auto' ? (knownRoot ?? cwd) : cwd;
  const repoKnown = !!place?.known && repoRoot === knownRoot;
  // Same host, same directory (a model change): the CLI forks the source by id.
  // Gated before the target directory is made, like every other refusal.
  if (plan.history === 'native-copy') fork ??= await prepareNativeFork(session, plan, plan.inPlace);
  const { ensureCwd } = await import('../sessions/ensure-cwd.js');
  await ensureCwd(cwd, plan.target.host === LOCAL_HOST ? undefined : plan.target.host);

  // History.
  let historyText = '';
  let transcriptPath: string | undefined;
  if (plan.history !== 'native-copy') {
    const { readProviderSessionHistory } = await import('../sessions/session-lifecycle.js');
    const { messages } = await readProviderSessionHistory(session.claudeSessionId, session, session.host, true);
    transcriptPath = `${transfersDir(plan.target.host)}/${transferId}/transcript.md`;
    await writeTargetFile(plan.target.host, transcriptPath, await renderTranscriptMarkdownChunked(messages, {
      title: task.title, engine: engineCaps(plan.source.engine).displayName, host: hostLabel(plan.source.host), cwd: plan.source.cwd,
    }));
    if (plan.history === 'brief') {
      const { writeHandoffBrief } = await import('./brief.js');
      const brief = await writeHandoffBrief(messages, {
        title: task.title, sourceEngine: engineCaps(plan.source.engine).displayName, sourceHost: hostLabel(plan.source.host),
      });
      historyText = `## Handoff brief\n\n${brief.text}`;
    } else {
      const seed = renderTranscriptSeed(messages, SEED_CHARS);
      historyText = `## The conversation so far\n\n${seed.text || '_It was empty._'}`;
    }
  }

  // The new task, beside the source.
  const { createForkSiblingTask } = await import('../sessions/session-controls.js');
  const { task: target } = await createForkSiblingTask(task.id, { childTitle: transferTitle(task, plan), source: 'transfer' });
  // The new task takes the source's place in its team too (a worker stays its leader's worker).
  await tm.updateTaskRaw(target.id, {
    transferred_from: task.id, cwd, ...(task.parent_task_id ? { parent_task_id: task.parent_task_id } : {}),
    ...(fork ? {
      transfer_state: 'pending' as const,
      transfer: { id: transferId, ...(fork.stage ? { stage: { host: plan.target.host, path: fork.stage.path } } : {}) },
    } : {}),
  }, { source: 'transfer' });

  const message = composeMessage({
    task, plan, cwd, history: historyText, transcriptPath,
    workspace: moved && place ? workspaceInstructions(moved, { repoRoot, known: repoKnown }) : undefined,
    first: req.message,
  });

  let sessionId: string | undefined;
  let requestId: string | undefined;
  if (fork) {
    sessionId = await runNativeFork({ target, sourceTaskId: task.id, session, plan, fork, cwd, message, transferId });
  } else {
    try {
      const { startSessionForTask } = await import('../sessions/task-start.js');
      const started = await startSessionForTask({
        taskIdPrefix: target.id, message, cwd, host: plan.target.host === LOCAL_HOST ? '__local__' : plan.target.host,
        engine: plan.target.engine, model: plan.target.model, callerSid: req.callerSid, expectReply: false, source: 'transfer',
        ...(plan.target.effort ? { effort: plan.target.effort } : {}),
        ...(plan.target.permissionMode ? { mode: plan.target.permissionMode } : {}),
      });
      sessionId = started.sessionId;
      requestId = started.requestId;
    } catch (err) {
      await removeUnstartedTask(target.id, task.id, transferId, err);
      throw err;
    }
  }

  // Learn: where the repository is on both hosts.
  if (moved) {
    const key = repoKey(moved.meta.remotes?.[0]?.url, moved.meta.root.split('/').pop() || 'workspace');
    await recordRepoPath(plan.source.host, key, moved.meta.root).catch(() => {});
    await recordRepoPath(plan.target.host, key, repoRoot).catch(() => {});
  }

  await tm.updateTaskRaw(task.id, { transferred_to: target.id }, { source: 'transfer' });
  let sourceCompleted = false;
  if (!req.keepSource && task.phase !== 'COMPLETE') {
    try {
      await tm.updateTask(task.id, { phase: 'COMPLETE' }, { source: 'transfer', ...(req.callerSid ? { actorSid: req.callerSid } : {}) });
      sourceCompleted = true;
    } catch (err) {
      log.session.warn('transfer: completing the source task failed', { taskId: task.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  log.session.info('transfer: started', { transferId, sourceTaskId: task.id, taskId: target.id, sessionId, route: moved?.route });
  return {
    taskId: target.id, title: target.title, ...(sessionId ? { sessionId } : {}), ...(requestId ? { requestId } : {}),
    sourceTaskId: task.id, sourceCompleted, history: plan.history,
    target: {
      engine: plan.target.engine, host: plan.target.host, cwd,
      ...(plan.target.model ? { model: plan.target.model } : {}),
      ...(plan.target.effort ? { effort: plan.target.effort } : {}),
      ...(plan.target.permissionMode ? { permissionMode: plan.target.permissionMode } : {}),
    },
    ...(moved ? { workspace: { route: moved.route, bytes: moved.bytes, bundleDir: moved.bundleDir, files: moved.files } } : {}),
    ...(transcriptPath ? { transcriptPath } : {}),
  };
}
