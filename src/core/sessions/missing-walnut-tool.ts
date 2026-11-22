/**
 * A session that calls a Walnut tool its CLI does not offer hears, once, what to use instead.
 *
 * Why (2026-11-14): a task the mail router had made under an older build kept calling router_work
 * after that op was retired. The CLI refused each call ("No such tool available") before it ever
 * reached Walnut, and the task, not knowing task_update or task_complete, stayed open and asked the
 * user to close it by hand: a lost tool turned into items on the user's Needs you.
 *
 * Because the CLI refuses such a call itself, Walnut reads the refusal from the session's stream
 * (SESSION_TOOL_RESULT) and answers with one notice delivered into the running turn: what replaces
 * a retired or renamed op, or the CLI form of a real op whose MCP tool this session does not offer,
 * and that a task which cannot write its own state tells its lead, never the user. Once per session
 * and tool name, in memory (a restart may tell it once more). A slim session (a router, an app
 * lane) has no shell and no Walnut instructions to fall back on, so it is left alone.
 */
import { bus, EventNames } from '../event-bus.js';
import { log } from '../../logging/index.js';

/**
 * Ops that no longer exist, with what does their job now. A prompt or a session's own history may
 * still name them. Guard: tests/core/sessions/missing-walnut-tool.test.ts.
 */
export const RETIRED_OPS: Readonly<Record<string, string>> = {
  // Retired 2026-11-14 with router-made work: the router hands each item to an ordinary task.
  router_item: 'the item came whole in the message that handed it to you; read its original with mail_read when that message names one',
  router_work: 'save findings with task_note_write, set your status with task_update (phase) or task_report_set (an ask), and close with task_complete',
};

// The CLI's own refusal, from its start: the same words inside a grep's or a file's output are data.
const REFUSAL = /^\s*(?:\[\{"type":"text","text":")?(?:<tool_use_error>)?\s*(?:Error: )?No such tool available: mcp__walnut__([A-Za-z0-9_]+)\b/;

/** The Walnut op a CLI refusal names, or null when the result is not one. */
export function refusedWalnutTool(result: string): string | null {
  return REFUSAL.exec(result)?.[1] ?? null;
}

type OpLookup = (name: string) => { deprecated?: string } | undefined;

const STATE_LINE = 'If you cannot write your task\'s state either way, tell your lead with task_send '
  + '(or `walnut tools call task_send`); never ask the user to change it for you.';

/** The notice for one refused tool name (pure). */
export function missingToolNotice(name: string, lookup: OpLookup): string {
  const op = lookup(name);
  const instead = RETIRED_OPS[name] ?? op?.deprecated;
  const head = instead
    ? `The Walnut op ${name} no longer exists, so mcp__walnut__${name} is not offered: ${instead}. `
      + 'Load those tools with ToolSearch (select:mcp__walnut__<op>), or run them with the `walnut` CLI (`walnut tools call <op> \'<json>\'`).'
    : op
      ? `The Walnut tool mcp__walnut__${name} is not offered in this session right now; run the same op with the CLI: \`walnut tools call ${name} '<json>'\`.`
      : `There is no Walnut op named ${name}: \`walnut tools list\` names every op.`;
  return `${head} ${STATE_LINE}`;
}

const told = new Map<string, Set<string>>();
const TOLD_MAX = 500;

const wasTold = (sessionId: string, name: string) => told.get(sessionId)?.has(name) === true;

/** Remember that this session was told about this name (bounded memory). */
function markTold(sessionId: string, name: string): void {
  const names = told.get(sessionId) ?? new Set<string>();
  names.add(name);
  told.delete(sessionId);
  told.set(sessionId, names);
  if (told.size > TOLD_MAX) told.delete(told.keys().next().value!);
}

export interface MissingToolDeps {
  lookup?: OpLookup;
  isSlim?: (sessionId: string) => Promise<boolean>;
  send?: (sessionId: string, text: string, taskId: string | undefined) => Promise<void>;
}

/** Handle one tool result event: tell the session once when it names a refused Walnut tool. */
export async function noteToolResult(
  data: { sessionId?: unknown; taskId?: unknown; result?: unknown; isError?: unknown; replayed?: unknown; parentToolUseId?: unknown },
  deps: MissingToolDeps = {},
): Promise<boolean> {
  // Only a failed call of this session itself (not a subagent's, not a replay after a restart).
  if (typeof data.sessionId !== 'string' || typeof data.result !== 'string' || data.isError !== true
    || data.replayed === true || data.parentToolUseId) return false;
  const name = refusedWalnutTool(data.result);
  if (!name) return false;
  const sessionId = data.sessionId;
  const taskId = typeof data.taskId === 'string' ? data.taskId : undefined;
  const isSlim = deps.isSlim ?? (async (sid) => {
    const { getSessionByClaudeId } = await import('../session-tracker.js');
    return (await getSessionByClaudeId(sid))?.profile?.slim === true;
  });
  if (await isSlim(sessionId).catch(() => true)) return false;
  if (wasTold(sessionId, name)) return false;
  const lookup = deps.lookup ?? (await import('../../ops/registry.js')).getOp;
  const text = missingToolNotice(name, lookup);
  // Through deliverToSession, as every Walnut notice: a session held on a permission prompt gets it
  // queued, not written into the held turn.
  const send = deps.send ?? (async (sid, body, tid) => {
    const [{ buildWalnutMessage }, { deliverToSession }, { getSessionByClaudeId }] = await Promise.all([
      import('../peers/walnut-message-tag.js'), import('./session-send-core.js'), import('../session-tracker.js'),
    ]);
    const record = await getSessionByClaudeId(sid);
    if (!record) throw new Error('no session record');
    const message = buildWalnutMessage({
      kind: 'notification', attrs: { from: 'Walnut', note: `the tool mcp__walnut__${name} is not offered here` }, body,
    });
    await deliverToSession(record, { busText: message, enqueueText: message, source: 'walnut-notify', ...(tid ? { taskId: tid } : {}) });
  });
  try {
    await send(sessionId, text, taskId);
    // Marked only once delivered: a failed send is tried again at the next refusal.
    markTold(sessionId, name);
    log.session.info('missing Walnut tool: the session was told what to use instead', { sessionId, taskId, tool: name });
    return true;
  } catch (err) {
    log.session.warn('missing Walnut tool: the notice was not delivered', { sessionId, taskId, tool: name, error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

let started = false;

/** Subscribe to the session tool results on the leader. */
export function startMissingWalnutTool(): () => void {
  if (started) return () => {};
  started = true;
  bus.subscribe('missing-walnut-tool', (event) => {
    // A host's refusal read back long after it happened (a leader that was away): the session went
    // on without the hint, and a hint now would land in a later turn it does not belong to.
    if (event.late) return;
    void noteToolResult((event.data ?? {}) as Parameters<typeof noteToolResult>[0]);
  }, { global: true, interest: [EventNames.SESSION_TOOL_RESULT] });
  return () => {
    bus.unsubscribe('missing-walnut-tool');
    started = false;
  };
}

/** Test seam: forget who was told. */
export function resetMissingWalnutToolForTest(): void {
  told.clear();
}
