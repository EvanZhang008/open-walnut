/**
 * Transfer a task's work to another engine and/or host (planner.ts says what
 * each mode does). The steps, in order, each one reversible until the start:
 *   1. plan: validate the engine × host pair, pick the history method
 *   2. learn the target host if its probe is stale (host-profile.ts)
 *   3. host change: pack the workspace, move it, choose the target directory
 *   4. history: copy the CLI transcript (Claude to Claude), or write a
 *      transcript file plus a seed, or write a handoff brief
 *   5. a new task beside the source (one session per task) and its first
 *      message: history, workspace steps, host summary, the first instruction
 *   6. start it; then the source task completes (unless kept) and both point
 *      at each other
 */
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { log } from '../../logging/index.js';
import type { SessionRecord, Task } from '../types.js';
import { engineCaps } from '../agents/engine-registry.js';
import { encodeProjectPath } from '../session-file-reader.js';
import { LOCAL_HOST, planTransfer, TransferError, type HistoryMethod, type TransferPlan, type TransferRequest } from './planner.js';
import { renderTranscriptMarkdownChunked, renderTranscriptSeed } from './transcript.js';
import { chooseTargetCwd, moveWorkspace, pruneLocalTransfers, transfersDir, workspaceInstructions, type MovedWorkspace } from './workspace.js';
import {
  hostProfileSummary, probeIsStale, readHostProfile, recordProbedFacts, recordRepoPath, repoKey, type HostProfile,
} from '../hosts/host-profile.js';

const SEED_CHARS = 40_000;
const TITLE_MAX = 60;

export interface TransferResult {
  taskId: string;
  title: string;
  sessionId?: string;
  requestId?: string;
  sourceTaskId: string;
  sourceCompleted: boolean;
  history: HistoryMethod;
  target: { engine: string; host: string; cwd: string };
  workspace?: { route: 'direct' | 'relay'; bytes: number; bundleDir: string; files: string[] };
  transcriptPath?: string;
}

function hostLabel(host: string): string {
  return host === LOCAL_HOST ? 'this Mac' : host;
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

/** Put the source's Claude transcript where the CLI on the target looks for it. */
async function copyNativeTranscript(session: SessionRecord, plan: TransferPlan, targetCwd: string, transferId: string): Promise<string | null> {
  // Same host, same directory (a model change): the CLI already finds it there.
  if (!plan.changesHost && targetCwd === plan.source.cwd) return null;
  const { DaemonFileReader } = await import('../daemon-file-reader.js');
  const source = new DaemonFileReader(plan.source.host);
  const sid = session.claudeSessionId;
  const from = await source.findSessionPath(sid);
  if (!from) throw new TransferError('The source transcript was not found on its host', 409, 'transcript_missing');
  // The CLI keys its transcripts by the cwd the kernel reports (symlinks resolved:
  // /tmp is /private/tmp on macOS, a home is often a link on a managed Linux box).
  const { realpathOn } = await import('./daemon-transfer-client.js');
  const realCwd = await realpathOn(plan.target.host, targetCwd).catch(() => targetCwd);
  const to = `~/.claude/projects/${encodeProjectPath(realCwd)}/${sid}.jsonl`;
  // The same file under another spelling of the directory: nothing to copy, and
  // never anything to remove later (that would be the source's own transcript).
  if (!plan.changesHost && from.endsWith(`/projects/${encodeProjectPath(realCwd)}/${sid}.jsonl`)) return null;
  if (!plan.changesHost) {
    await source.copyPath(from, to);
    return to;
  }
  // A live session keeps appending: move a snapshot, not the growing file.
  const snapshot = `${transfersDir(plan.source.host)}/${transferId}/${sid}.jsonl`;
  await source.copyPath(from, snapshot);
  const { relayFile } = await import('./daemon-transfer-client.js');
  await relayFile(plan.source.host, snapshot, plan.target.host, to, {});
  return to;
}

/**
 * The copy carries the SOURCE session's id, so on its host two files now answer
 * to that id. Once the fork has its own transcript the copy is not needed:
 * remove it, so nothing reading by session id lands on the stale one.
 */
function removeCopyOnceForked(host: string, copyPath: string, forkSid: string): void {
  let tries = 0;
  const tick = async (): Promise<void> => {
    try {
      const { DaemonFileReader } = await import('../daemon-file-reader.js');
      const reader = new DaemonFileReader(host);
      if (await reader.findSessionPath(forkSid)) {
        await reader.removePath(copyPath, false);
        log.session.info('transfer: removed the transcript copy the fork started from', { host, copyPath, forkSid });
        return;
      }
    } catch { /* try again */ }
    if (++tries < 40) setTimeout(() => { void tick(); }, 30_000).unref?.();
  };
  setTimeout(() => { void tick(); }, 30_000).unref?.();
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
  workspace?: string; host?: string; first?: string;
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
  if (p.host) parts.push(`## This host\n\n${p.host}`);
  parts.push('## Learn this host\n\nWhen you find something worth knowing the next time work comes here (a tool you installed and how, where a repository lives, a proxy, registry or credential setup that differs, a command that behaves differently), record it in one line: '
    + '`walnut tools call host_note_add \'{"key":"<short key>","fact":"<what is true here>"}\'`.');
  parts.push(`## First\n\n${p.first?.trim() || (plan.moveWorkspace
    ? 'Set the workspace up as described, install what is missing, check that it builds, then continue the work where it stood.'
    : 'Continue the work where it stood.')}`);
  return parts.join('\n\n');
}

export async function transferTask(req: TransferRequest, transferId = `xf-${randomUUID().slice(0, 12)}`): Promise<TransferResult> {
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
  const hosts = (await getConfig()).hosts ?? {};
  const known = new Set(Object.entries(hosts).filter(([, h]) => (h as { enabled?: boolean }).enabled !== false).map(([k]) => k));
  const plan = planTransfer(task, session, req, known);
  if (session.process_status === 'running') {
    throw new TransferError('The task\'s session is in the middle of a turn. Wait for it to finish (or stop it), then transfer, so nothing it does is left behind.', 409, 'source_busy');
  }
  void pruneLocalTransfers().catch(() => {});
  log.session.info('transfer: planned', {
    transferId, taskId: task.id, sessionId: session.claudeSessionId, history: plan.history,
    from: { engine: plan.source.engine, host: plan.source.host }, to: { engine: plan.target.engine, host: plan.target.host, cwd: plan.target.cwd },
  });

  const profile = plan.changesHost ? await freshProfile(plan.target.host) : await readHostProfile(plan.target.host).catch(() => null);

  let moved: MovedWorkspace | undefined;
  let place: ReturnType<typeof chooseTargetCwd> | undefined;
  if (plan.moveWorkspace) {
    moved = await moveWorkspace({ transferId, sourceHost: plan.source.host, sourceCwd: plan.source.cwd, targetHost: plan.target.host });
    place = chooseTargetCwd(moved.meta, plan.source.cwd, profile);
  }
  const chosen = plan.target.cwd === 'auto' ? (place?.cwd ?? plan.source.cwd) : plan.target.cwd;
  const cwd = expandHome(chosen, plan.target.host, profile);
  const repoRoot = place ? expandHome(place.repoRoot, plan.target.host, profile) : cwd;
  const { ensureCwd } = await import('../sessions/ensure-cwd.js');
  await ensureCwd(cwd, plan.target.host === LOCAL_HOST ? undefined : plan.target.host);

  // History.
  let historyText = '';
  let transcriptPath: string | undefined;
  let transcriptCopy: string | null = null;
  if (plan.history === 'native-copy') {
    transcriptCopy = await copyNativeTranscript(session, plan, cwd, transferId);
  } else {
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
  }, { source: 'transfer' });

  const message = composeMessage({
    task, plan, cwd, history: historyText, transcriptPath,
    workspace: moved && place ? workspaceInstructions(moved, { repoRoot, known: place.known }) : undefined,
    // A summary that knows nothing says nothing a session on the same machine needs.
    host: profile && (plan.changesHost || profile.probed || profile.notes.length > 0)
      ? hostProfileSummary(profile, hostLabel(plan.target.host)) : undefined,
    first: req.message,
  });

  let sessionId: string | undefined;
  let requestId: string | undefined;
  try {
  if (plan.history === 'native-copy') {
    const { forkSessionToTask } = await import('../sessions/session-controls.js');
    const forked = await forkSessionToTask(session.claudeSessionId, {
      task_id: target.id, message, model: plan.target.model, rawMessage: true,
      placeOverride: { cwd, ...(plan.target.host === LOCAL_HOST ? {} : { host: plan.target.host }) },
    }, 'transfer');
    sessionId = forked.sessionId;
  } else {
    const { startSessionForTask } = await import('../sessions/task-start.js');
    const started = await startSessionForTask({
      taskIdPrefix: target.id, message, cwd, host: plan.target.host === LOCAL_HOST ? '__local__' : plan.target.host,
      engine: plan.target.engine, model: plan.target.model, callerSid: req.callerSid, expectReply: false, source: 'transfer',
    });
    sessionId = started.sessionId;
    requestId = started.requestId;
  }
  } catch (err) {
    // Nothing started: the new task holds nothing, and the source keeps the work.
    await tm.deleteTask(target.id).catch(() => { /* reported below */ });
    log.session.warn('transfer: the new session did not start; its task was removed', {
      transferId, sourceTaskId: task.id, taskId: target.id, error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
  if (transcriptCopy && sessionId) removeCopyOnceForked(plan.target.host, transcriptCopy, sessionId);

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
    target: { engine: plan.target.engine, host: plan.target.host, cwd },
    ...(moved ? { workspace: { route: moved.route, bytes: moved.bytes, bundleDir: moved.bundleDir, files: moved.files } } : {}),
    ...(transcriptPath ? { transcriptPath } : {}),
  };
}
