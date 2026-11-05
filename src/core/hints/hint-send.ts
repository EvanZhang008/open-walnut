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

import { REFERENCE_CARDS_OPEN } from '../sessions/reference-cards.js';
import type { Config, MessageHintRole, MessageHintTrigger, SessionHintState, SessionRecord, Task } from '../types.js';
import { log } from '../../logging/index.js';
import { composeHinted, parseHinted, renderHintBlock, splitHinted, type CarriedHint } from './hint-format.js';
import { effectiveHints, hintApplies, needsTaskForAudience, type EffectiveHint, type HintTarget } from './hint-registry.js';
import { dueReasons } from './hint-schedule.js';
import { hookStatementVoid } from '../sessions/hook-statement.js';
import { withAskSent } from '../sessions/ask-unanswered.js';
import type { AwayState } from '../org/user-away.js';
import type { BriefHintState } from '../sessions/brief-hint.js';
import type { ThreadCapture, ThreadHintState, ThreadsTidyState } from '../org/thread-capture.js';
import type { UserAskCapture } from '../sessions/user-asks.js';

type HintRecord = Pick<SessionRecord, 'output_mode' | 'output_mode_injected' | 'hintState' | 'lastCompactUuid' | 'lastCompactAt'>
  & Partial<Pick<SessionRecord, 'claudeSessionId' | 'taskId' | 'threadMeta' | 'asksSent'>>;
type HintConfig = Pick<Config, 'session'> | null;

/** Hints a send asks for by kind (`on_request`), with an argument (a question's number). */
export type RequestedHints = Record<string, { arg?: string }>;

export interface HintPlan {
  before: string[];
  after: string[];
  carried: CarriedHint[];
  /** Kind → identity, for each hint this message tells. */
  told: Record<string, string>;
  /** Kind → the triggers that sent it: always some of that hint's own (tests/core/hints/hint-triggers-only.test.ts). */
  reasons: Record<string, MessageHintTrigger[]>;
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

/**
 * A hint the post-compaction hook stated on the current boundary that no boundary of this
 * session's own came near was told to a fork (a side question that compacted), not to this
 * conversation (sessions/hook-statement.ts). What this conversation was told is then unknown:
 * a hint that starts with the session reads it as never told, any other as told something
 * else, before any boundary (so `on_change`, `after_compaction` and `every_n_turns` all see it
 * owed). Pure.
 */
type ToldEntry = SessionHintState['told'][string];
function toldHere(hint: EffectiveHint, t: ToldEntry | undefined, record: HintRecord | null | undefined): ToldEntry | undefined {
  if (!t?.byHookAt || (t.compact ?? '') !== (record?.lastCompactUuid ?? '') || !hookStatementVoid(t.byHookAt, record ?? {})) return t;
  if (hint.triggers.includes('session_start')) return undefined;
  const { byHookAt: _fork, compact: _boundary, ...rest } = t;
  return { ...rest, send: 0, hash: '' };
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
  /** Who wrote this message; absent = not a person (a host's peer note). Never changes which hints are due. */
  sentBy?: 'person' | 'agent';
  /** The message's own words (a question's name is read from them); absent on a host's tail. */
  message?: string;
  /** Main's or a lead's chat: the user's presence there (org/user-away.ts). */
  away?: { away: boolean; lastSeenAt: number | null } | null;
  /** Main's or a lead's Brief (sessions/brief-hint.ts). */
  brief?: BriefHintState | null;
  /** A person typed this message into the chat (not a letter's answer): he is in it. */
  inChat?: boolean;
  /** Main's or a lead's: the user's message was filed as this thread (org/thread-capture.ts). */
  thread?: ThreadHintState | null;
  /** Main's or a lead's Threads that need its decision (org/thread-capture.ts threadsTidyOf). */
  threadsTidy?: ThreadsTidyState | null;
}): HintPlan {
  const state = seededState(input.record);
  const send = state.sends + 1;
  const plan: HintPlan = { before: [], after: [], carried: [], told: {}, reasons: {} };
  for (const hint of input.hints) {
    if (!hint.enabled || input.skip?.has(hint.kind) || !hintApplies(hint, input.target)) continue;
    const request = input.requested?.[hint.kind];
    const told = input.afterCompaction ? undefined : toldHere(hint, state.told[hint.kind], input.record);
    // A message he typed into this chat is the user in it, whatever the clock says.
    const away = input.inChat && input.away ? { away: false, lastSeenAt: Date.now() } : input.away;
    const content = {
      config: input.config, record: input.record ?? null, ...(request ? { request } : {}), ...(told ? { toldHash: told.hash } : {}),
      // The message's own words, never the cards Walnut adds to them.
      ...(input.message !== undefined ? { message: input.message.split(REFERENCE_CARDS_OPEN)[0] } : {}),
      ...(away ? { away } : {}), ...(input.brief ? { brief: input.brief } : {}),
      ...(input.thread ? { thread: input.thread } : {}),
      ...(input.threadsTidy ? { threadsTidy: input.threadsTidy } : {}),
      ...(input.target.role ? { role: input.target.role } : {}),
    };
    const identity = hint.identity(content);
    if (identity === null) continue;
    // Only the hint's own triggers send it, whoever wrote the message and whatever the session's
    // role (2026-11-05: rules here added every_turn for every role and every person's message, so
    // the reply language rode every message though its triggers did not say so).
    let reasons = input.afterCompaction
      ? (hint.triggers.includes('after_compaction') ? ['after_compaction' as const] : [])
      : dueReasons({
        triggers: hint.triggers, everyTurns: hint.everyTurns, told, send, identity,
        compactUuid: input.record?.lastCompactUuid, driftAt: state.drift?.[hint.kind], requested: !!request,
      });
    if (input.only) reasons = reasons.filter((r) => input.only!.has(r));
    if (!reasons.length) continue;
    const rendered = hint.render(content, new Set(reasons));
    if (!rendered) continue;
    const block = renderHintBlock(hint.kind, rendered.text, rendered.arg);
    (hint.placement === 'before' ? plan.before : plan.after).push(block);
    plan.carried.push({ kind: hint.kind, ...(rendered.arg ? { arg: rendered.arg } : {}), text: rendered.text });
    plan.told[hint.kind] = identity;
    plan.reasons[hint.kind] = reasons;
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

async function targetFor(sessionId: string, record: HintRecord | null | undefined, hints: readonly EffectiveHint[]): Promise<{ target: HintTarget; away: AwayState | null; brief?: BriefHintState | null; threadsTidy?: ThreadsTidyState | null; task?: Task }> {
  if (!record?.taskId || !needsTaskForAudience(hints)) return { target: { sessionId }, away: null };
  try {
    const { listTasksByIds } = await import('../task-manager.js');
    const task = (await listTasksByIds([record.taskId]))[0];
    const target = hintTargetOf(sessionId, task);
    // The org is off (org/org-enabled.ts): Main and the VPs get none of the org's own hints (away,
    // Brief, threads tidy); a person's message is still filed under its thread.
    if (target.role === 'main' || target.role === 'lead') {
      const { isOrgEnabled } = await import('../org/org-enabled.js');
      if (!(await isOrgEnabled())) return { target, away: null, brief: null, threadsTidy: null, ...(task ? { task } : {}) };
    }
    // Only Main and the leads hear whether the user is in their chat (hint user-away).
    const wantsAway = (target.role === 'main' || target.role === 'lead') && hints.some((h) => h.kind === 'user-away' && h.enabled);
    const away = wantsAway ? await import('../org/user-away.js').then((m) => m.userAwayFrom(task)).catch(() => null) : null;
    const brief = await briefFor(task, target, hints);
    const threadsTidy = await threadsTidyFor(task, target, hints);
    return { target, away, brief, threadsTidy, ...(task ? { task } : {}) };
  } catch {
    return { target: { sessionId }, away: null };
  }
}

/** The thread this person's message files under, when the session is an Org node's. Never throws. */
async function captureThread(record: HintRecord | null | undefined, task: Task | undefined, message: string, opts: HintSendOptions): Promise<ThreadCapture | null> {
  if (!record?.taskId) return null;
  try {
    let node: Task | undefined = task;
    if (!node) {
      const { listTasksByIds } = await import('../task-manager.js');
      node = (await listTasksByIds([record.taskId]))[0];
    }
    const { prepareThreadCapture } = await import('../org/thread-capture.js');
    return await prepareThreadCapture({
      task: node, message, inChat: opts.inChat ?? opts.sentBy === 'person',
      ...(opts.threadId ? { threadId: opts.threadId } : {}), ...(opts.threadKey ? { key: opts.threadKey } : {}),
      ...(record.claudeSessionId ? { sid: record.claudeSessionId } : {}),
      ...(opts.now ? { now: opts.now() } : {}),
    });
  } catch (err) {
    log.session.warn('org threads: message not planned', { sessionId: record.claudeSessionId, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/** The user's message to a task that is no Org node, filed as an ask it owes an answer (sessions/user-asks.ts). Never throws. */
async function captureUserAsk(record: HintRecord | null | undefined, task: Task | undefined, message: string, opts: HintSendOptions): Promise<UserAskCapture | null> {
  if (!record?.taskId) return null;
  try {
    let node: Task | undefined = task;
    if (!node) {
      const { listTasksByIds } = await import('../task-manager.js');
      node = (await listTasksByIds([record.taskId]))[0];
    }
    const { prepareUserAskCapture } = await import('../sessions/user-asks.js');
    return await prepareUserAskCapture({
      task: node, message, inChat: opts.inChat ?? opts.sentBy === 'person',
      ...(opts.threadKey ? { key: opts.threadKey } : {}),
      ...(record.claudeSessionId ? { sid: record.claudeSessionId } : {}),
      ...(opts.now ? { now: opts.now() } : {}),
    });
  } catch (err) {
    log.session.warn('user asks: message not planned', { sessionId: record.claudeSessionId, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/** Main's or a lead's Brief state, for the `brief` hint (sessions/brief-hint.ts); null elsewhere. */
async function briefFor(task: Task | undefined | null, target: HintTarget, hints: readonly EffectiveHint[]): Promise<BriefHintState | null> {
  if (!task || (target.role !== 'main' && target.role !== 'lead') || !hints.some((h) => h.kind === 'brief' && h.enabled)) return null;
  try {
    const { listTasks } = await import('../task-manager.js');
    const { briefHintStateOf } = await import('../sessions/brief-hint.js');
    return briefHintStateOf(task, await listTasks());
  } catch {
    return null;
  }
}

/** Main's or a lead's Threads that need its decision, for the `threads-tidy` hint; null elsewhere. */
async function threadsTidyFor(task: Task | undefined | null, target: HintTarget, hints: readonly EffectiveHint[]): Promise<ThreadsTidyState | null> {
  if (!task || (target.role !== 'main' && target.role !== 'lead') || !hints.some((h) => h.kind === 'threads-tidy' && h.enabled)) return null;
  try {
    const { readThreads } = await import('../org/threads-store.js');
    const { threadsTidyOf } = await import('../org/thread-capture.js');
    return threadsTidyOf(await readThreads(task.id));
  } catch {
    return null;
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
  /** Typed into the chat itself; default: sentBy is a person. False for a letter's answer. */
  inChat?: boolean;
  /**
   * The exact blocks an upstream sender may already have composed into `message`
   * (the companion adds the voice block before it relays a phone send). Those are
   * kept where they are; any other block in the text is the sender's own words and
   * is escaped like the rest. Default: none, so a person's text is never trusted.
   */
  upstreamBlocks?: readonly string[];
  /** The plain line a message with no words of its own carries in front of its hints. */
  emptyBodyLine?: string;
  /** The user sent it from this thread's Follow up (an Org node's Threads, org/thread-capture.ts). */
  threadId?: string;
  /** False: not one of the user's requests to file (a side question asked beside the chat, a
   *  Retry of a message filed when it was first sent). */
  threads?: boolean;
  /** The send's own id when it has one before it is queued (the phone's qm- id): a retry of it is filed once. */
  threadKey?: string;
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
    const { target, away, brief, threadsTidy, task } = await targetFor(sessionId, record, hints);
    // A message composed upstream (the companion's voice hint) keeps those blocks.
    const upstream = opts.upstreamBlocks?.length ? splitHinted(message, opts.upstreamBlocks) : null;
    const words = upstream ? upstream.text : message;
    // The user's words to an Org node become one of its Threads, whether or not its hint is on.
    const thread = opts.sentBy === 'person' && opts.threads !== false ? await captureThread(record, task, words, opts) : null;
    // Any other task's chat: the user's words are kept until its turn-end status says they are answered.
    const userAsk = opts.sentBy === 'person' && opts.threads !== false && !thread ? await captureUserAsk(record, task, words, opts) : null;
    const plan = planHints({
      hints, target, record, config, away, brief, threadsTidy, inChat: opts.inChat ?? opts.sentBy === 'person', message: words,
      ...(opts.requested ? { requested: opts.requested } : {}),
      ...(upstream ? { skip: new Set(upstream.kinds) } : {}),
      ...(opts.sentBy ? { sentBy: opts.sentBy } : {}),
      ...(thread ? { thread: thread.hint } : {}),
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
        if (thread) await thread.commit({ told: !!plan.told.threads });
        // Not awaited: the send's own bookkeeping goes first; the ask's write is locked and deduped.
        if (userAsk) void userAsk.commit();
        // An Ask here question is kept for the Stop hook (sessions/ask-unanswered.ts) under the
        // name its hint gave it, which a follow-up in its thread repeats.
        const ask = plan.carried.find((h) => h.kind === 'question' && h.arg);
        const askName = ask ? /<walnut-ask thread="[^"]*"(?: name="([^"]*)")?>/.exec(ask.text)?.[1] ?? '' : '';
        await writeHintState(sid, (cur) => ({
          hintState: advanceHintState(cur.hintState, cur, plan.told, { now: at, ...(opts.sentBy ? { sentBy: opts.sentBy } : {}) }),
          ...(ask?.arg ? { asksSent: withAskSent(cur.asksSent, { thread: ask.arg, name: askName, words: body, at }) } : {}),
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
 * A first message that has no session yet (a quick start): only the hints it asked for
 * (`on_request`), rendered by the registry and composed the way every send composes them.
 * Never throws: a failure leaves the message as it is.
 */
export async function requestedHintBlocks(message: string, requested: RequestedHints, opts: { config?: HintConfig } = {}): Promise<string> {
  try {
    const config = opts.config !== undefined ? opts.config : await import('../config-manager.js').then((m) => m.getConfig()).catch(() => null);
    const plan = planHints({ hints: effectiveHints(config), target: { sessionId: '' }, record: null, config, requested, only: new Set(['on_request']) });
    if (!plan.before.length && !plan.after.length) return message;
    return composeHinted(message, { before: plan.before, after: plan.after });
  } catch (err) {
    log.session.warn('message hints: first message carries no requested hint', { error: err instanceof Error ? err.message : String(err) });
    return message;
  }
}

/** A start that opens a NEW conversation (not a fork, a rewind or a transfer's resume). */
export interface StartHintData {
  taskId?: string;
  message: string;
  preassignedSessionId?: string;
  forkedFromSessionId?: string;
  resumeFile?: string;
  resumeSessionAtMessageUuid?: string;
  attributed?: true;
}

/**
 * The first message of a new conversation, from any launcher (task_start, a quick start, a
 * routine, a restart into a fresh conversation): the hints its triggers make due at the start
 * (`session_start` above all), placed around what the launcher composed, and recorded as told
 * once the session has its id. Without it a session's start hints went out on its SECOND message
 * (2026-11-05 review: a worker that finished in one turn never got the reply language). The
 * launcher's own text is left exactly as it built it (no second escape), and a kind it already
 * carries (a requested voice or question block) is not added twice. A fork, a rewind and a
 * transfer resume an old conversation and keep its state. Never throws.
 */
export async function prepareStartHints<T extends StartHintData>(data: T, opts: { config?: HintConfig; now?: () => number } = {}): Promise<{ data: T; commit(sessionId: string): Promise<void> }> {
  const none = { data, commit: async () => {} };
  if (!data.message || data.message.startsWith('/') || data.forkedFromSessionId || data.resumeFile || data.resumeSessionAtMessageUuid) return none;
  try {
    const config = opts.config !== undefined ? opts.config : await import('../config-manager.js').then((m) => m.getConfig()).catch(() => null);
    const hints = effectiveHints(config);
    const carried = new Set(parseHinted(data.message).hints.map((h) => h.kind));
    // A new conversation was told nothing, whatever a pre-seeded record holds.
    const record: HintRecord = { ...(data.taskId ? { taskId: data.taskId } : {}) } as HintRecord;
    const sid = data.preassignedSessionId ?? '';
    const { target, away, brief, threadsTidy } = await targetFor(sid, record, hints);
    const plan = planHints({
      hints, target, record, config, away, brief, threadsTidy, skip: carried,
      ...(data.attributed ? { sentBy: 'person' as const, inChat: true } : { sentBy: 'agent' as const }),
      message: parseHinted(data.message).text,
    });
    if (!plan.carried.length) return none;
    const message = [...(plan.before.length ? [plan.before.join('\n')] : []), data.message, ...(plan.after.length ? [plan.after.join('\n')] : [])].join('\n\n');
    const now = opts.now ?? Date.now;
    return {
      data: { ...data, message },
      async commit(sessionId: string): Promise<void> {
        await writeHintState(sessionId, (cur) => ({
          hintState: advanceHintState(cur.hintState, cur, plan.told, { now: now(), sentBy: data.attributed ? 'person' : 'agent' }),
          ...(plan.told['rich-output'] ? { output_mode_injected: plan.told['rich-output'] === 'rich' ? 'rich' : 'markdown' } : {}),
        }));
      },
    };
  } catch (err) {
    log.session.warn('message hints: first message carries no start hint', { taskId: data.taskId, error: err instanceof Error ? err.message : String(err) });
    return none;
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
  'human-inbox', 'auto-continue', 'auto-recover', 'app-state', 'cli', 'brief-refresh', 'choice-recheck',
  'context-recovery',
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
    const { isChatSendSource } = await import('../phase.js');
    return await prepareHintedSend(sessionId, record, message, {
      sentBy: queueSentBy(source) ?? 'agent',
      inChat: isChatSendSource(source),
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
    const target = hintTargetOf(record.claudeSessionId, task);
    // An away note a compaction may have dropped is restated while he is still away.
    const away = record.taskId && (target.role === 'main' || target.role === 'lead') && hints.some((h) => h.kind === 'user-away' && h.enabled)
      ? await import('../org/user-away.js').then((m) => m.userAwayFrom({ id: record.taskId!, org_role: task?.org_role }, now)).catch(() => null)
      : null;
    const owner = record.taskId ? await import('../task-manager.js').then((m) => m.getTask(record.taskId!)).catch(() => null) : null;
    const brief = owner ? await briefFor(owner, target, hints) : null;
    const threadsTidy = owner ? await threadsTidyFor(owner, target, hints) : null;
    const plan = planHints({
      hints, target, record, config: cfg, afterCompaction: true, away, brief, threadsTidy,
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
 * hint that is owed right now (one whose triggers say every_turn, a reply that
 * drifted, a change not yet told). The host cannot count messages or record what it told, so
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
