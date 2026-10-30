/**
 * Switching back to an engine the task used before (2026-10-29, the user: "如果它的
 * prefix 还都一样，那我们可以直接找回原来那个 session append 进去。如果说它已经完全不一样的话，
 * 我们再 create 一个新的 ... 这样的话它能用到它那个 cache").
 *
 * The task's latest earlier session on the target engine is resumed, given only the
 * turns it missed, when its history is still an exact prefix of the task's
 * conversation. That holds when all of these hold, each read from a record, never
 * guessed:
 *   - it ran on the same host, in the same directory, and no other model was picked;
 *   - its engine can load an old session (Claude Code always; an ACP engine only when its
 *     adapter said `loadSession` for that session: Gemini's cannot);
 *   - the context it holds now has the fingerprint recorded when the task left it
 *     (`leftContext`), so nothing in it changed (no compaction, edit or rewind);
 *   - every session after it took over from the one before with the whole context
 *     (a start that left no turn out, or a resume), and none was compacted since;
 *   - its context plus the missed turns fit its window.
 * Otherwise the switch starts a new session with the full current context, as
 * before; the reason is logged either way.
 */
import { createHash } from 'node:crypto';
import type { SessionHistoryMessage } from '../session-history.js';
import type { EngineSwitchState, SessionEngine, SessionRecord } from '../types.js';
import { log } from '../../logging/index.js';
import type { EngineSwitchResult } from './engine-switch.js';
import { putQueuedRows, type HeldRow } from './engine-switch-io.js';
import { engineCaps, isAcpEngine, resolveEngine } from '../agents/engine-registry.js';
import { normalizeHost } from '../transfer/planner.js';
import { isSupersededSession } from './engine-switch-marker.js';
import {
  CARRY_WINDOW_SHARE, ENGINE_SWITCH_HINT, estimateTokens, readActiveContext, renderOwnTurns, type ActiveContext,
} from './engine-switch-context.js';

const tick = () => new Promise<void>((r) => setImmediate(r));

/** The person's and the model's words and tool calls of a context, hashed (system rows and tool results left out). */
export async function contextFingerprint(messages: readonly SessionHistoryMessage[]): Promise<{ fingerprint: string; messages: number }> {
  const h = createHash('sha256');
  let n = 0;
  for (const [i, m] of messages.entries()) {
    if (i % 500 === 499) await tick();
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    n++;
    h.update(`${m.role}\0${m.text ?? ''}\0`);
    for (const hint of m.hints ?? []) h.update(`${hint.kind}\0${hint.text}\0`);
    for (const t of m.tools ?? []) h.update(`${t.name}\0${JSON.stringify(t.input ?? {})}\0`);
    h.update('\n');
  }
  return { fingerprint: h.digest('hex').slice(0, 40), messages: n };
}

export interface ResumePlan {
  prev: SessionRecord;
  /** The hint body: the turns it missed, every later session's own turns in order. */
  text: string;
  missedTurns: number;
  tokens: number;
}

const MAX_LINKS = 64;

function hasSwitchHint(m: SessionHistoryMessage): boolean {
  return m.role === 'user' && !!m.hints?.some((h) => h.kind === ENGINE_SWITCH_HINT);
}

/**
 * A session's own part of the task's conversation since it took over: all of it for a
 * session a switch started; from its latest resume message on for one a switch
 * resumed. Null when that part is not intact (compacted since, or the resume message
 * is gone from its context).
 */
function ownPart(ctx: ActiveContext, resumed: boolean): SessionHistoryMessage[] | null {
  if (!resumed) return ctx.compacted ? null : ctx.messages;
  let at = -1;
  for (let i = ctx.messages.length - 1; i >= 0; i--) if (hasSwitchHint(ctx.messages[i])) { at = i; break; }
  if (at < 0) return null;
  const own = ctx.messages.slice(at);
  return own.some((m) => m.role === 'system' && m.systemVariant === 'compact') ? null : own;
}

async function contextTokens(messages: readonly SessionHistoryMessage[]): Promise<number> {
  let n = 0;
  for (const [i, m] of messages.entries()) {
    if (i % 500 === 499) await tick();
    n += estimateTokens(m.text ?? '');
    for (const h of m.hints ?? []) n += estimateTokens(h.text);
    for (const t of m.tools ?? []) n += estimateTokens(JSON.stringify(t.input ?? {})) + estimateTokens(t.result ?? '');
  }
  return n;
}

export async function planResume(args: {
  active: SessionRecord;
  activeCtx: ActiveContext;
  rows: readonly SessionRecord[];
  engine: SessionEngine;
  host: string;
  cwd: string | undefined;
  model?: string;
  windowTokens: number;
  transcriptPath?: string;
}): Promise<{ plan?: ResumePlan; reason: string }> {
  const { active, activeCtx, rows, engine, host } = args;
  const byId = new Map(rows.map((r) => [r.claudeSessionId, r]));
  const prev = rows
    .filter((r) => r.claudeSessionId !== active.claudeSessionId && isSupersededSession(r) && resolveEngine(r.engine) === engine)
    .sort((a, b) => (b.leftContext?.at ?? b.lastActiveAt ?? '').localeCompare(a.leftContext?.at ?? a.lastActiveAt ?? ''))[0];
  if (!prev) return { reason: 'the task never ran on this engine' };
  if (normalizeHost(prev.host) !== host) return { reason: 'its earlier session ran on another host' };
  if ((prev.cwd ?? '') !== (args.cwd ?? '')) return { reason: 'its earlier session ran in another directory' };
  const prevModel = prev.cliModel || prev.model || prev.acpModel;
  if (args.model && args.model !== 'default' && prevModel && args.model !== prevModel) return { reason: 'another model was picked' };
  if (!prev.leftContext) return { reason: 'no record of the context it was left with' };
  if (isAcpEngine(prev.engine) && prev.acpCapabilities?.loadSession !== true) return { reason: 'its engine cannot load an earlier session' };

  // The sessions after it, each taking over from the one before, up to the active one.
  const links: Array<{ rec: SessionRecord; resumed: boolean }> = [];
  let at = prev;
  for (let i = 0; i < MAX_LINKS && at.claudeSessionId !== active.claudeSessionId; i++) {
    const next = at.supersededBy ? byId.get(at.supersededBy) : undefined;
    if (!next) return { reason: 'the chain of sessions after it is incomplete' };
    const started = next.engineSwitch?.fromSessionId === at.claudeSessionId;
    const resumed = next.resumedBySwitch?.fromSessionId === at.claudeSessionId;
    if (!started && !resumed) return { reason: 'a later session did not take over from it' };
    if (!resumed && (next.engineSwitch?.trimmedTurns ?? 0) > 0) return { reason: 'a later switch left older turns out' };
    links.push({ rec: next, resumed });
    at = next;
  }
  if (at.claudeSessionId !== active.claudeSessionId) return { reason: 'the chain of sessions after it is too long' };

  const prevCtx = await readActiveContext(prev);
  if ((await contextFingerprint(prevCtx.messages)).fingerprint !== prev.leftContext.fingerprint) {
    return { reason: 'its history changed since the task left it' };
  }

  const parts: string[] = [];
  let missedTurns = 0;
  for (const link of links) {
    const ctx = link.rec.claudeSessionId === active.claudeSessionId ? activeCtx : await readActiveContext(link.rec);
    const own = ownPart(ctx, link.resumed);
    if (!own) return { reason: `the own turns of a later session on ${engineCaps(link.rec.engine).displayName} cannot be read whole (compacted since it took over)` };
    const r = await renderOwnTurns(own);
    if (r.text.trim()) parts.push(`## On ${engineCaps(link.rec.engine).displayName}\n\n${r.text}`);
    missedTurns += r.turns;
  }
  const engines = [...new Set(links.map((l) => engineCaps(l.rec.engine).displayName))].join(', ');
  const header = [
    `You are back on this task after it ran on ${engines}. Below are the ${missedTurns} turn${missedTurns === 1 ? '' : 's'} you missed, in order (the newest last); `
      + 'everything before them you already have. Continue from where it stands; do not redo work already done. The user\'s new message follows.',
    ...(args.transcriptPath ? [`The full transcript of the task is at ${args.transcriptPath}; if you find you do not hold the earlier conversation, read it there.`] : []),
    'Paths, branches and results in it are from this same task; check live state before relying on it.',
  ].join(' ');
  const text = `${header}\n\n${parts.join('\n\n') || '[The other engine held no turns.]'}`;
  const tokens = estimateTokens(text);
  const room = Math.floor(args.windowTokens * CARRY_WINDOW_SHARE);
  if ((await contextTokens(prevCtx.messages)) + tokens > room) return { reason: 'its context and the missed turns would not fit its window' };
  return { plan: { prev, text, missedTurns, tokens }, reason: 'its history is still a prefix of the task\'s conversation' };
}

/**
 * Resume the task's earlier session on the target engine with the turns it missed
 * (engine-switch-resume.ts). The old session is already retired; this makes the
 * earlier one the task's session again and sends it the message. Throws before the
 * message is queued to let the caller start a new session instead.
 */
export async function resumeEarlier(
  taskId: string, state: EngineSwitchState, old: SessionRecord, plan: ResumePlan & { message: string },
  transcriptPath: string | undefined, held: HeldRow[],
): Promise<EngineSwitchResult> {
  const tracker = await import('../session-tracker.js');
  const tm = await import('../task-manager.js');
  const prev = plan.prev;
  const at = new Date().toISOString();
  // Noted first, so a restart before the message is queued sends it then (engine-switch-watch.ts).
  await tm.updateTaskRaw(taskId, (cur) => (cur.engine_switch?.id === state.id
    ? { engine_switch: { ...cur.engine_switch, resume_session_id: prev.claudeSessionId, resume_message: plan.message } } : null), { source: 'engine-switch', emitEvent: true });
  const mode = state.to.permission_mode ?? old.mode;
  await tracker.updateSessionRecord(prev.claudeSessionId, {
    archived: false, archive_reason: undefined, supersededBy: undefined,
    resumedBySwitch: { fromSessionId: old.claudeSessionId, ...(old.engine ? { fromEngine: old.engine } : {}), at, carriedTurns: plan.missedTurns },
    ...(state.to.effort ? { effort: state.to.effort } : {}),
  });
  await tm.linkSession(taskId, prev.claudeSessionId);
  await sendResumeMessage(taskId, state, prev.claudeSessionId, plan.message, mode);
  // From here the switch is done: the earlier session holds the task's conversation again.
  // Nothing below may throw (the caller would start a second session for the same message).
  const engine = resolveEngine(state.to.engine);
  let movedRequests = 0;
  try {
    await tracker.updateSessionRecord(old.claudeSessionId, { supersededBy: prev.claudeSessionId }).catch(() => {});
    const { retargetRequestsToSession } = await import('../session-requests.js');
    movedRequests = await retargetRequestsToSession(old.claudeSessionId, prev.claudeSessionId).catch(() => 0);
    await putQueuedRows(prev.claudeSessionId, held);
    await tm.updateTaskRaw(taskId, {
      engine_switch: {
        ...state, state: 'done', resumed: true, message: undefined, display_text: undefined, held_rows: undefined,
        resume_session_id: undefined, resume_message: undefined,
        session_id: prev.claudeSessionId, carried_turns: plan.missedTurns, trimmed_turns: 0, ...(transcriptPath ? { transcript_path: transcriptPath } : {}),
      },
    }, { source: 'engine-switch', emitEvent: true });
  } catch (err) {
    log.session.warn('engine switch: a step after the resume failed (the resumed session carries on)', {
      taskId, sessionId: prev.claudeSessionId, error: err instanceof Error ? err.message : String(err),
    });
  }
  log.session.info('engine switch: done, the earlier session resumed', {
    taskId, switchId: state.id, from: old.claudeSessionId, sessionId: prev.claudeSessionId, engine, missedTurns: plan.missedTurns, tokens: plan.tokens, movedRequests, heldRows: held.length,
  });
  return {
    state: 'done', taskId, switchId: state.id, fromSessionId: old.claudeSessionId, sessionId: prev.claudeSessionId, engine,
    host: normalizeHost(prev.host), carriedTurns: plan.missedTurns, trimmedTurns: 0, resumed: true, ...(transcriptPath ? { transcriptPath } : {}),
  };
}

/** The resumed session's first message. Its id is the switch's, so a resend after a restart collapses onto it. */
export async function sendResumeMessage(taskId: string, state: EngineSwitchState, sessionId: string, message: string, mode?: string): Promise<void> {
  const { sendMessageToSession } = await import('../session-message-queue.js');
  await sendMessageToSession(sessionId, state.display_text ?? state.message ?? '', {
    source: state.by === 'human' ? 'ui' : 'engine-switch', taskId, enqueueMessage: message, hinted: true,
    messageId: `qm-${state.id}`, ...(mode ? { mode } : {}),
  });
}
