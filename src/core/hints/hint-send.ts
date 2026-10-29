/**
 * The message-hint send pipeline: what ONE outgoing message carries, composed and
 * recorded. Every server path that hands a message to a session's model goes
 * through here (the web `session:send` RPC, the phone's send, the cloud relay, a
 * side thread's first question, and the queue for every other send); none of them
 * knows which hints exist. The registry (hint-registry.ts) says what each hint is,
 * the schedule (hint-schedule.ts) says when it is due, and this file joins them to
 * the session's state (`SessionRecord.hintState`).
 *
 * Three rules every path relies on:
 *   - A slash command reaches the CLI byte-exact: no hint, no escape, not counted
 *     (inc-1788194545341: a prefixed "/compact" stopped being a command).
 *   - The message is escaped even when nothing is due, so every unescaped Walnut
 *     block in a delivered message is one Walnut wrote (hint-format.ts).
 *   - The state advances only in `commit()`, after the text is safely queued: a
 *     throw before that leaves the hint still owed.
 */

import type { Config, MessageHintRole, SessionHintState, SessionRecord, Task } from '../types.js';
import { log } from '../../logging/index.js';
import { composeHinted, parseHinted, renderHintBlock, splitHinted, type CarriedHint } from './hint-format.js';
import { effectiveHints, hintApplies, needsTaskForAudience, type EffectiveHint, type HintTarget } from './hint-registry.js';
import { dueReasons } from './hint-schedule.js';

type HintRecord = Pick<SessionRecord, 'output_mode' | 'output_mode_injected' | 'hintState' | 'lastCompactUuid'>
  & Partial<Pick<SessionRecord, 'claudeSessionId' | 'taskId'>>;
type HintConfig = Pick<Config, 'session'> | null;

/** Hints a send asks for by kind (`on_request`), with an argument (a question's number). */
export type RequestedHints = Record<string, { arg?: string }>;

export interface HintPlan {
  before: string[];
  after: string[];
  carried: CarriedHint[];
  /** Kind → identity, for each hint this message tells. */
  told: Record<string, string>;
}

/** The role and agent the audience rules see, from the session's task. */
export function hintTargetOf(sessionId: string, task: Pick<Task, 'org_role' | 'agent_id' | 'parent_task_id' | 'walnut_agent' | 'project'> | null | undefined): HintTarget {
  if (!task) return { sessionId };
  let role: MessageHintRole = 'other';
  if (task.org_role === 'main') role = 'main';
  else if (task.org_role === 'lead') role = 'lead';
  else if (task.walnut_agent || /^Ask /.test(task.project ?? '')) role = 'ask';
  else if (task.parent_task_id) role = 'worker';
  return { sessionId, role, ...(task.agent_id ? { agentId: task.agent_id } : {}) };
}

/** The state a record had before the registry: the rich instruction it was told. */
function seededState(record: HintRecord | null | undefined): SessionHintState {
  const s = record?.hintState;
  if (s) return s;
  const told: SessionHintState['told'] = {};
  if (record?.output_mode_injected) {
    // output_mode_injected is cleared at a compaction, so a value means "told since the last one".
    told['rich-output'] = {
      send: 0, hash: record.output_mode_injected, at: new Date(0).toISOString(),
      ...(record.lastCompactUuid ? { compact: record.lastCompactUuid } : {}),
    };
  }
  return { sends: 0, told };
}

/**
 * Which hints this send carries. Pure given its inputs. `only` limits the plan to
 * hints due for one of those reasons (the post-compaction hook asks for
 * `after_compaction` alone).
 */
export function planHints(input: {
  hints: readonly EffectiveHint[];
  target: HintTarget;
  record: HintRecord | null | undefined;
  config: HintConfig;
  requested?: RequestedHints;
  only?: ReadonlySet<string>;
  /** Kinds the message already carries (composed upstream). */
  skip?: ReadonlySet<string>;
  /** The post-compaction hook: every hint with `after_compaction` is due, whatever was told. */
  afterCompaction?: boolean;
  /** Who wrote this message; absent = not a person (a host's peer note). */
  sentBy?: 'person' | 'agent';
}): HintPlan {
  const state = seededState(input.record);
  const send = state.sends + 1;
  const plan: HintPlan = { before: [], after: [], carried: [], told: {} };
  for (const hint of input.hints) {
    if (!hint.enabled || input.skip?.has(hint.kind) || !hintApplies(hint, input.target)) continue;
    const request = input.requested?.[hint.kind];
    const told = input.afterCompaction ? undefined : state.told[hint.kind];
    const content = { config: input.config, record: input.record ?? null, ...(request ? { request } : {}), ...(told ? { toldHash: told.hash } : {}) };
    const identity = hint.identity(content);
    if (identity === null) continue;
    let reasons = input.afterCompaction
      ? (hint.triggers.includes('after_compaction') ? ['after_compaction' as const] : [])
      : dueReasons({
        triggers: hint.triggers, everyTurns: hint.everyTurns, told, send, identity,
        compactUuid: input.record?.lastCompactUuid, driftAt: state.drift?.[hint.kind], requested: !!request,
      });
    // A role whose chat the user reads gets it on every turn a person did not start.
    if (!input.afterCompaction && input.sentBy !== 'person' && input.target.role && hint.agentTurnRoles.includes(input.target.role)
      && !reasons.includes('every_turn')) reasons = [...reasons, 'every_turn'];
    if (input.only) reasons = reasons.filter((r) => input.only!.has(r));
    if (!reasons.length) continue;
    const rendered = hint.render(content, new Set(reasons));
    if (!rendered) continue;
    const block = renderHintBlock(hint.kind, rendered.text, rendered.arg);
    (hint.placement === 'before' ? plan.before : plan.after).push(block);
    plan.carried.push({ kind: hint.kind, ...(rendered.arg ? { arg: rendered.arg } : {}), text: rendered.text });
    plan.told[hint.kind] = identity;
  }
  return plan;
}

/** The state after a send that told `told` (pure). */
export function advanceHintState(
  cur: SessionHintState | undefined,
  record: HintRecord | null | undefined,
  told: Record<string, string>,
  opts: { now: number; sentBy?: 'person' | 'agent'; byHook?: boolean; count?: boolean },
): SessionHintState {
  const base = cur ?? seededState(record);
  const sends = base.sends + (opts.count === false ? 0 : 1);
  const at = new Date(opts.now).toISOString();
  const next: SessionHintState = { sends, told: { ...base.told }, ...(base.drift ? { drift: { ...base.drift } } : {}) };
  for (const [kind, hash] of Object.entries(told)) {
    next.told[kind] = {
      send: sends, hash, at,
      ...(record?.lastCompactUuid ? { compact: record.lastCompactUuid } : {}),
      ...(opts.byHook ? { byHookAt: at } : {}),
    };
    if (next.drift) delete next.drift[kind];
  }
  if (next.drift && !Object.keys(next.drift).length) delete next.drift;
  const by = opts.sentBy ?? base.lastSendBy;
  if (by) next.lastSendBy = by;
  return next;
}

/** Write a state change against the record as it is now (compare and set, a few tries). Never throws. */
export async function writeHintState(
  sessionId: string,
  change: (cur: SessionRecord) => Partial<SessionRecord> | null,
): Promise<void> {
  try {
    const { getSessionByClaudeId, updateSessionRecordConditionally } = await import('../session-tracker.js');
    for (let attempt = 0; attempt < 3; attempt++) {
      const cur = await getSessionByClaudeId(sessionId);
      if (!cur) return;
      const patch = change(cur);
      if (!patch) return;
      const seen = JSON.stringify(cur.hintState ?? null);
      const done = await updateSessionRecordConditionally(sessionId, patch,
        (now) => JSON.stringify(now.hintState ?? null) === seen, { preserveLastActiveAt: true });
      if (done) return;
    }
  } catch (err) {
    log.session.warn('message hints: state not recorded', { sessionId, error: err instanceof Error ? err.message : String(err) });
  }
}

async function targetFor(sessionId: string, record: HintRecord | null | undefined, hints: readonly EffectiveHint[]): Promise<HintTarget> {
  if (!record?.taskId || !needsTaskForAudience(hints)) return { sessionId };
  try {
    const { listTasksByIds } = await import('../task-manager.js');
    return hintTargetOf(sessionId, (await listTasksByIds([record.taskId]))[0]);
  } catch {
    return { sessionId };
  }
}

export interface PreparedHintedSend {
  /** Text the CLI must receive. */
  enqueueText: string;
  /** What a history parse will show for it (the input, hints off, escape undone). */
  displayText: string;
  /** Did composition change the text at all? */
  changed: boolean;
  /** The hints this message carries. */
  hints: CarriedHint[];
  /** Record the send. Call ONLY after the text is safely queued. Never throws.
   *  `intoSessionId`: the session the text went to when it had no record yet. */
  commit(intoSessionId?: string): Promise<void>;
}

export interface HintSendOptions {
  requested?: RequestedHints;
  /** Injectable for tests; omitted = the live config. */
  config?: HintConfig;
  /** A person typed it (drift is judged only on replies to a person). */
  sentBy?: 'person' | 'agent';
  /**
   * The exact blocks an upstream sender may already have composed into `message`
   * (the companion adds the voice block before it relays a phone send). Those are
   * kept where they are; any other block in the text is the sender's own words and
   * is escaped like the rest. Default: none, so a person's text is never trusted.
   */
  upstreamBlocks?: readonly string[];
  /** The plain line a message with no words of its own carries in front of its hints. */
  emptyBodyLine?: string;
  now?: () => number;
}

/**
 * A turn must hold something to answer besides Walnut's notes: a message that is
 * only hints leaves the model nothing but the notes to answer. Such a message
 * carries one plain line of its own in front of them.
 */
export const EMPTY_BODY_LINE = 'Walnut started this turn with no message of its own: the notes below are context, not a request.';
export const WAIT_WAKE_EMPTY_LINE = 'The time you were waiting for has passed: check the thing you are waiting on.';

/**
 * The message with no hint and nothing recorded, still escaped so the structural
 * rule holds (a slash command is the one text left byte-exact).
 */
function escapedOnly(message: string): PreparedHintedSend {
  const enqueueText = message.startsWith('/') ? message : composeHinted(message, { before: [], after: [] });
  return { enqueueText, displayText: message, changed: enqueueText !== message, hints: [], commit: async () => {} };
}

/**
 * What this send must carry, ready to hand to `sendMessageToSession`. `message` is
 * the text the CLI would receive without hints (image preamble and reference cards
 * included). Never throws over a hint: a failure sends the message as it is.
 */
export async function prepareHintedSend(
  sessionId: string,
  record: HintRecord | null | undefined,
  message: string,
  opts: HintSendOptions = {},
): Promise<PreparedHintedSend> {
  const now = opts.now ?? Date.now;
  if (message.startsWith('/')) return escapedOnly(message);
  try {
    const config = opts.config !== undefined ? opts.config : await import('../config-manager.js').then((m) => m.getConfig()).catch(() => null);
    const hints = effectiveHints(config);
    const target = await targetFor(sessionId, record, hints);
    // A message composed upstream (the companion's voice hint) keeps those blocks.
    const upstream = opts.upstreamBlocks?.length ? splitHinted(message, opts.upstreamBlocks) : null;
    const words = upstream ? upstream.text : message;
    const plan = planHints({
      hints, target, record, config,
      ...(opts.requested ? { requested: opts.requested } : {}),
      ...(upstream ? { skip: new Set(upstream.kinds) } : {}),
      ...(opts.sentBy ? { sentBy: opts.sentBy } : {}),
    });
    const carriesHints = plan.before.length + plan.after.length + (upstream ? upstream.before.length + upstream.after.length : 0) > 0;
    const body = carriesHints && !words.trim() ? (opts.emptyBodyLine ?? EMPTY_BODY_LINE) : words;
    const enqueueText = composeHinted(body, {
      before: [...(upstream?.before ?? []), ...plan.before],
      after: [...plan.after, ...(upstream?.after ?? [])],
    });
    return {
      enqueueText,
      displayText: body,
      changed: enqueueText !== message,
      hints: [...plan.carried, ...(upstream ? parseHinted(message).hints : [])],
      async commit(intoSessionId?: string): Promise<void> {
        const sid = intoSessionId ?? sessionId;
        const at = now();
        await writeHintState(sid, (cur) => ({
          hintState: advanceHintState(cur.hintState, cur, plan.told, { now: at, ...(opts.sentBy ? { sentBy: opts.sentBy } : {}) }),
          // Kept for a rollback: the release before the registry reads its rich edge here.
          ...(plan.told['rich-output'] ? { output_mode_injected: plan.told['rich-output'] === 'rich' ? 'rich' : 'markdown' } : {}),
        }));
      },
    };
  } catch (err) {
    log.session.warn('message hints: send carries no hint', { sessionId, error: err instanceof Error ? err.message : String(err) });
    return escapedOnly(message);
  }
}

/**
 * Sources the queue composes hints for: turns nobody typed, whose replies the user
 * still reads (a trigger fire, another task's message, the wait_until clock,
 * Walnut's notices, a letter reply, an automatic continue or recovery), and a
 * person's `task_send` from the CLI or the Board. Every other source the queue sees
 * is escaped only. The paths that compose before they enqueue (web, phone, cloud
 * relay, a side thread's question) pass `hinted` and are left alone.
 */
export const QUEUE_HINT_SOURCES: ReadonlySet<string> = new Set([
  'routine-trigger', 'routine-watcher', 'wait-until', 'peer', 'walnut-notify',
  'human-inbox', 'auto-continue', 'auto-recover', 'app-state', 'cli',
]);

/**
 * The pipeline for a message the queue composes itself (session-message-queue.ts).
 * Always returns the text to enqueue, escaped; it carries hints only for
 * QUEUE_HINT_SOURCES on the leader, which keeps the state. The caller commits it
 * when the row it enqueued holds `enqueueText`, which counts the send even when no
 * hint was due. Never throws.
 */
export async function prepareQueuedHintedSend(
  sessionId: string,
  source: string | undefined,
  message: string,
): Promise<PreparedHintedSend> {
  if (!source || !QUEUE_HINT_SOURCES.has(source) || message.startsWith('/')) return escapedOnly(message);
  try {
    // The state lives on the leader's record; a replica's copy may lag.
    const { role } = await import('../server-role.js');
    if (role() !== 'leader') return escapedOnly(message);
    const { getSessionByClaudeId } = await import('../session-tracker.js');
    const record = await getSessionByClaudeId(sessionId);
    if (!record) return escapedOnly(message);
    const { queueSentBy } = await import('../sessions/send-sent-by.js');
    return await prepareHintedSend(sessionId, record, message, {
      sentBy: queueSentBy(source) ?? 'agent',
      ...(source === 'wait-until' ? { emptyBodyLine: WAIT_WAKE_EMPTY_LINE } : {}),
    });
  } catch {
    return escapedOnly(message);
  }
}

/**
 * The hints a compaction may have dropped, for the post-compaction hook to put into
 * context (open-items.ts), recorded as told by the hook. Every enabled hint that
 * has `after_compaction` and applies to this session is stated, whatever it was
 * told before, so the rest of an interrupted turn holds them too. Empty when none.
 * Never throws.
 */
export async function stateHintsAfterCompaction(
  record: SessionRecord,
  task?: Pick<Task, 'org_role' | 'agent_id' | 'parent_task_id' | 'walnut_agent' | 'project'> | null,
  config?: HintConfig,
  now = Date.now(),
): Promise<string> {
  try {
    const cfg = config !== undefined ? config : await import('../config-manager.js').then((m) => m.getConfig()).catch(() => null);
    const hints = effectiveHints(cfg).filter((h) => h.triggers.includes('after_compaction'));
    const plan = planHints({
      hints, target: hintTargetOf(record.claudeSessionId, task), record, config: cfg, afterCompaction: true,
    });
    if (!plan.carried.length) return '';
    await writeHintState(record.claudeSessionId, (cur) => ({
      hintState: advanceHintState(cur.hintState, cur, plan.told, { now, byHook: true, count: false }),
      ...(plan.told['rich-output'] ? { output_mode_injected: plan.told['rich-output'] === 'rich' ? 'rich' : 'markdown', outputModeHookAt: new Date(now).toISOString() } : {}),
    }));
    return [...plan.before, ...plan.after].join('\n');
  } catch {
    return '';
  }
}

/**
 * A compaction boundary the server just read: a hint the post-compaction hook
 * stated after the previous boundary and within `answeredMs` answered THIS one, so
 * it is moved onto the new boundary instead of being sent again (pure; called from
 * place-notice.ts notePlaceCompaction, in the same guarded write).
 */
export function hintStateAtBoundary(
  state: SessionHintState | undefined,
  boundaryUuid: string,
  answered: (atMs: number) => boolean,
): SessionHintState | undefined {
  if (!state) return undefined;
  let changed = false;
  const told: SessionHintState['told'] = {};
  for (const [kind, t] of Object.entries(state.told)) {
    if (t.byHookAt && answered(Date.parse(t.byHookAt))) {
      told[kind] = { ...t, compact: boundaryUuid };
      changed = true;
    } else told[kind] = t;
  }
  return changed ? { ...state, told } : undefined;
}

/** The triggers a host can honour: they need no message count and no request. */
const HOST_TRIGGERS: ReadonlySet<string> = new Set(['every_turn', 'session_start', 'after_compaction', 'on_change', 'on_drift']);

/**
 * The blocks a session's HOST appends to a message it delivers itself (a peer note
 * between two sessions on that host never reaches the server's queue; host-slice.ts
 * ships this as `replyTail`, offline-host-core.ts appends it): every after-placed
 * hint that is owed right now (an every-message hint, a reply that drifted, a
 * change not yet told). The host cannot count messages or record what it told, so
 * `every_n_turns` waits for the server's next send, and an owed hint rides the
 * host's deliveries until the server tells it and the slice moves on. Usually
 * nothing is owed and the field is left out. Null when empty.
 */
export function hostReplyTail(
  record: HintRecord & { claudeSessionId: string },
  config: HintConfig,
  task?: Pick<Task, 'org_role' | 'agent_id' | 'parent_task_id' | 'walnut_agent' | 'project'> | null,
): string | null {
  const hints = effectiveHints(config).filter((h) => h.placement === 'after');
  const plan = planHints({ hints, target: hintTargetOf(record.claudeSessionId, task), record, config, only: HOST_TRIGGERS });
  return plan.after.length ? plan.after.join('\n') : null;
}

/** Display form of a delivered message: what the user typed, and the hints it carried. */
export { parseHinted };
