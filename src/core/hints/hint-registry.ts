/**
 * The message-hint registry: every piece of Walnut text that rides a message to a
 * session's model, defined in ONE place. A hint is an entry here (built in) or in
 * config `session.hints` (custom); the send pipeline (hint-send.ts) asks the
 * registry which hints a message carries, so adding a hint is adding an entry,
 * never a change to a send path.
 *
 * Each entry says:
 *   - its text (`render`; a custom hint's fixed `text`),
 *   - what it currently says (`identity`, compared by the `on_change` trigger),
 *   - when it goes out (`triggers`, any one that holds sends it; hint-schedule.ts),
 *   - who gets it (`audience`: roles, agent ids, session ids; empty = everyone),
 *   - where it goes (`placement`: before or after the message).
 *
 * The user and agents change an entry through the same route (`/api/v1/hints`,
 * ops hint_list / hint_set / hint_reset); a change is a config override on top
 * of the built-in default, so "reset" is deleting the override.
 *
 * Standing rules a session should always hold (core instructions, routing rules)
 * are NOT hints: they live in the system prompt and reach a running session through
 * the instruction notice (sessions/instruction-notice.ts).
 */

import type {
  Config, MessageHintRole, MessageHintSettings, MessageHintTrigger, SessionOutputMode,
} from '../types.js';
import {
  RICH_OUTPUT_MODE_OFF_INSTRUCTION, RICH_OUTPUT_MODE_ON_INSTRUCTION, RICH_OUTPUT_MODE_REMINDER,
  replyLanguageText, resolveEffectiveOutputMode,
} from '../sessions/output-mode.js';
import { VOICE_REPLY_TEXT } from '../sessions/voice-reply.js';
import { ASK_THREAD_RE, askHintText, askNameOf } from '../sessions/ask-thread.js';
import { MESSAGE_MIN_LETTERS, languageDrift, ruleLanguage } from './hint-drift-detect.js';
import { replyLanguageLines } from './reply-language-lines.js';
import { briefHintText, type BriefHintState } from '../sessions/brief-hint.js';
import { threadHintText, threadsTidyText, type ThreadHintState, type ThreadsTidyState } from '../org/thread-capture.js';
import { HINT_USER_SETTINGS, REPLY_LANGUAGE_SCOPE, WALNUT_ONLY_KINDS, replyLanguageCorrection } from './hint-origin.js';

export { REPLY_LANGUAGE_SCOPE, replyLanguageCorrection };

export const HINT_TRIGGERS: readonly MessageHintTrigger[] = [
  'every_turn', 'every_n_turns', 'session_start', 'after_compaction', 'on_change', 'on_drift', 'on_request',
];
export const HINT_ROLES: readonly MessageHintRole[] = ['main', 'lead', 'worker', 'ask', 'other'];
export const HINT_KIND_RE = /^[a-z][a-z0-9-]{1,40}$/;
export const HINT_TEXT_MAX = 2000;
export const HINT_EVERY_MAX = 1000;

/** What a hint's content functions read. */
export interface HintContentInput {
  config: Pick<Config, 'session'> | null;
  record: {
    output_mode?: SessionOutputMode; hintState?: { drift?: Record<string, string> };
    threadMeta?: ReadonlyArray<{ seq?: number; thread?: string; title?: string; question?: string }>;
    asksSent?: ReadonlyArray<{ thread: string; name: string }>;
  } | null;
  /** The send asked for this hint (`on_request`), with its argument. */
  request?: { arg?: string };
  /** The identity this session was last told, if any. */
  toldHash?: string;
  /** The words of the message the hint rides (its language may differ from the asked one). */
  message?: string;
  /** Main's or a lead's chat: is the user away from it (org/user-away.ts)? Absent elsewhere. */
  away?: { away: boolean; lastSeenAt: number | null } | null;
  /** Main's or a lead's Brief: how old, what moved since (sessions/brief-hint.ts). Absent elsewhere. */
  brief?: BriefHintState | null;
  /** Main's or a lead's chat: the user's message was filed as this thread (org/thread-capture.ts). */
  thread?: ThreadHintState | null;
  /** Main's or a lead's Threads that need its decision now (org/thread-capture.ts threadsTidyOf). */
  threadsTidy?: ThreadsTidyState | null;
}

export interface HintRender { text: string; arg?: string }

interface HintSpec {
  kind: string;
  label: string;
  description: string;
  /** Triggers this hint can use at all (a request-only hint has no schedule). */
  allowed: readonly MessageHintTrigger[];
  defaults: Required<Pick<MessageHintSettings, 'enabled' | 'triggers' | 'placement'>> & { every_turns?: number };
  /** What it says now; null = nothing to say to this session. */
  identity(input: HintContentInput): string | null;
  /** Its text for this send, given why it is due; null = say nothing this time. */
  render(input: HintContentInput, reasons: ReadonlySet<MessageHintTrigger>): HintRender | null;
  /** Did this reply break the hint's rule? (`on_drift`; null = it cannot tell) */
  drifted?(config: Pick<Config, 'session'> | null, reply: string): boolean | null;
  /**
   * Roles that get it on every message, while its triggers are the default: the user reads
   * their chat whoever started the turn, and a setting is not guessed from the message
   * (2026-10-30: the user typed English into a lead's chat, the hint stayed off, and the lead
   * answered in English though his reply language is Chinese).
   */
  everyTurnRoles?: readonly MessageHintRole[];
  /**
   * Every message a person sends carries it, in any session, while its triggers are the default:
   * he reads the answer to his own message, whatever language he typed it in (2026-11-01: a
   * worker's chat, the user's English "what the hack?" carried no reminder, and the long turn after
   * it was English throughout).
   */
  everyPersonTurn?: boolean;
}

const SCHEDULED: readonly MessageHintTrigger[] = HINT_TRIGGERS.filter((t) => t !== 'on_request');
const periodicOnly = (reasons: ReadonlySet<MessageHintTrigger>) =>
  [...reasons].every((r) => r === 'every_turn' || r === 'every_n_turns' || r === 'on_drift');

const BUILT_IN: readonly HintSpec[] = [
  {
    kind: 'question',
    label: 'Question number',
    description: 'Names an Ask here question by its thread number and name, and asks the model to put its answer inside a tag with that number, so the answer is filed under that question and nothing else is.',
    allowed: ['on_request'],
    defaults: { enabled: true, triggers: ['on_request'], placement: 'before' },
    identity: (i) => (i.request?.arg ? `question ${i.request.arg}` : null),
    render: (i) => {
      const thread = i.request?.arg;
      if (!thread || !ASK_THREAD_RE.test(thread)) return null;
      // A follow-up in the thread keeps the name its first send gave it: the answer must match both.
      const sent = i.record?.asksSent?.find((a) => a.thread === thread);
      const flat = /^\d+$/.test(thread) ? Number(thread) : null;
      const name = sent?.name ?? askNameOf(i.record?.threadMeta?.find((m) => (m.thread ?? (m.seq !== undefined ? String(m.seq) : '')) === thread || (flat !== null && m.seq === flat && !m.thread)), i.message);
      // The answer is filed ONLY from the tag (2026-11-03, the user: "we must make it strict ...
      // the thread-id and thread name in a html tag format, in the first send"; "each question has
      // a thread id and thread name, and they must match, each ask from us in that thread also
      // remind model about this, the thread can be nested"). The reader is web/src/utils/ask-answer.ts;
      // the Stop hook names a question still without one (src/core/sessions/ask-unanswered.ts).
      return { arg: thread, text: askHintText(thread, name) };
    },
  },
  {
    kind: 'rich-output',
    label: 'Rich output',
    description: 'Tells the model the session is on rich output (markdown first, HTML and SVG where markdown has no shape), and that it is off again after a switch.',
    allowed: SCHEDULED,
    defaults: { enabled: true, triggers: ['session_start', 'after_compaction', 'on_change', 'every_n_turns'], every_turns: 5, placement: 'after' },
    identity: (i) => resolveEffectiveOutputMode(i.record, i.config),
    render: (i, reasons) => {
      const mode = resolveEffectiveOutputMode(i.record, i.config);
      if (mode === 'markdown') {
        // Plain markdown is what a model does untold: only a switch away from rich needs words.
        return reasons.has('on_change') && i.toldHash === 'rich' ? { text: RICH_OUTPUT_MODE_OFF_INSTRUCTION } : null;
      }
      return { text: periodicOnly(reasons) ? RICH_OUTPUT_MODE_REMINDER : RICH_OUTPUT_MODE_ON_INSTRUCTION };
    },
  },
  {
    kind: 'reply-language',
    label: 'Reply language',
    description: 'The language to answer the user in (Settings, Reply language). Every session gets it on every message (the user\'s own in whatever language he types, a notice, another task\'s message or reply, a trigger), because the user reads every chat whoever started the turn.',
    allowed: SCHEDULED,
    defaults: { enabled: true, triggers: ['session_start', 'after_compaction', 'on_change', 'on_drift'], placement: 'after' },
    // 2026-10-29: leads answered Walnut notices in English in the chats the user reads on the Org page.
    // 2026-11-02, the org review: workers did the same after another task's English message, so
    // every session carries it on every message.
    everyTurnRoles: ['main', 'lead', 'worker', 'ask', 'other'],
    everyPersonTurn: true,
    identity: (i) => replyLanguageText(i.config),
    // 2026-10-29: after the user wrote Chinese, a worker's progress lines between its tool calls
    // stayed English; the rule covers every line the user reads, not only the final reply.
    // A reply that broke it is named first (hint-drift.ts): the same reminder on every message
    // did not hold a lead whose context was mostly English agent traffic (2026-10-31).
    // 2026-11-02: a model follows the language of the message it answers, and an English rule
    // about Chinese did not hold after his English message; the lines in the language itself
    // (reply-language-lines.ts) lead the block: under a message in another language (his, or
    // another task's: an English peer note started a worker's English lines), one asking for his
    // language, and a correction written in it. A host's own delivery has no message to read
    // here (hostReplyTail): the line rides it too, those are other tasks' messages.
    render: (i, reasons) => {
      const text = replyLanguageText(i.config);
      if (!text) return null;
      const lines = replyLanguageLines(ruleLanguage(text));
      const driftAt = reasons.has('on_drift') ? i.record?.hintState?.drift?.['reply-language'] : undefined;
      const correction = driftAt ? `${lines ? lines.drifted : replyLanguageCorrection(driftAt)} ` : '';
      const other = !!lines && (i.message === undefined || languageDrift(text, i.message, MESSAGE_MIN_LETTERS) === true);
      return { text: `${other ? `${lines!.reply} ` : ''}${correction}${text} ${REPLY_LANGUAGE_SCOPE}` };
    },
    drifted: (config, reply) => {
      const rule = replyLanguageText(config);
      return rule ? languageDrift(rule, reply) : null;
    },
  },
  {
    kind: 'voice-reply',
    label: 'Voice reply',
    description: 'On a voice send from the phone: answer with a short spoken part first.',
    allowed: ['on_request'],
    defaults: { enabled: true, triggers: ['on_request'], placement: 'after' },
    identity: (i) => (i.request ? 'voice' : null),
    render: (i) => (i.request ? { text: VOICE_REPLY_TEXT } : null),
  },
  {
    kind: 'user-away',
    label: 'User away',
    description: 'Main and the leads: the user has not been in this chat for a while, so an important update goes to his inbox; and that he is back.',
    allowed: SCHEDULED,
    defaults: { enabled: true, triggers: ['session_start', 'on_change', 'after_compaction'], placement: 'after' },
    // 2026-10-31, the user: when he is not in a node's chat, an important update goes to his inbox.
    // No time in it: a restart that forgets a heartbeat must not make the same absence news again.
    identity: (i) => (!i.away ? null : i.away.away ? 'away' : 'present'),
    render: (i) => {
      if (!i.away) return null;
      if (i.away.away) return { text: userAwayText(i.away.lastSeenAt) };
      // Back: said once, after an away note; a chat he never left needs no words.
      return i.toldHash === 'away' ? { text: USER_BACK_TEXT } : null;
    },
  },
  {
    kind: 'brief',
    label: 'Brief reminder',
    description: 'Main and the leads: keep the Brief (the letter above their chat) current, written by the node itself with brief_write. Every 3 messages, and when its team moved since it was written.',
    allowed: SCHEDULED,
    // 2026-10-31, the user: "每三轮提示他一下 ... 你有什么新的 update，你要自己去写 ... 这就是一个 file".
    defaults: { enabled: true, triggers: ['session_start', 'after_compaction', 'on_change', 'every_n_turns'], every_turns: 3, placement: 'after' },
    identity: (i) => (i.brief ? `${i.brief.at ?? 'none'}|${i.brief.key}` : null),
    render: (i, reasons) => {
      if (!i.brief) return null;
      // A rewrite changes what it says; only a Brief that is behind needs words then.
      if (!i.brief.stale && [...reasons].every((r) => r === 'on_change')) return null;
      return { text: briefHintText(i.brief) };
    },
  },
  {
    kind: 'threads',
    label: 'Threads',
    description: 'Main and the leads: which of the user\'s Threads (his own requests, beside the Brief) his message was filed under, his other open threads, and how to keep them current with thread_update. On each message the user sends there.',
    allowed: SCHEDULED,
    // 2026-11-01, the user: every request of his becomes a thread the node keeps; "if my multiple
    // ask is about the same thread, add it below that thread".
    defaults: { enabled: true, triggers: ['every_turn'], placement: 'after' },
    identity: (i) => (i.thread ? `${i.thread.threadId}|${i.thread.created ? 'new' : 'in'}` : null),
    render: (i) => (i.thread ? { text: threadHintText(i.thread) } : null),
  },
  {
    kind: 'threads-tidy',
    label: 'Threads cleanup',
    description: 'Main and the leads: the user\'s Threads that need the node\'s decision (he wrote after an answer: did he react to it? a stand-in title, a stale state), so it folds what he knows and closes what he reacted to as finished. Every 3 messages, when there is one.',
    allowed: SCHEDULED,
    // 2026-11-01, the user: "you should proactively clean the thread ... make sure this is a Walnut
    // feature, not just your memory".
    defaults: { enabled: true, triggers: ['session_start', 'after_compaction', 'every_n_turns'], every_turns: 3, placement: 'after' },
    identity: (i) => (i.threadsTidy ? i.threadsTidy.key : null),
    render: (i) => (i.threadsTidy ? { text: threadsTidyText(i.threadsTidy) } : null),
  },
];

/** What a node hears while the user is away from its chat (org/user-away.ts). */
export function userAwayText(lastSeenAt: number | null): string {
  const when = lastSeenAt ? `since ${new Date(lastSeenAt).toISOString().slice(0, 16)}Z` : 'for as long as Walnut knows';
  return `the user has not been in this chat ${when}, and it is not open anywhere. An update that needs him (a decision only he `
    + 'can make, something to review, a result he asked for) goes to his inbox now with human_inbox_send, a decision as '
    + 'action_required with its options so one tap answers it; Walnut adds your letters of this absence to one thread and his '
    + 'phone buzzes once. Anything else stays in this chat and is never a letter.';
}

export const USER_BACK_TEXT = 'the user is back in this chat: updates go here again, not to his inbox.';

const BUILT_IN_BY_KIND = new Map(BUILT_IN.map((s) => [s.kind, s]));

export function isBuiltInHint(kind: string): boolean {
  return BUILT_IN_BY_KIND.has(kind);
}

/** One hint as it applies now: the built-in default with the config override on top. */
export interface EffectiveHint {
  kind: string;
  label: string;
  description: string;
  builtIn: boolean;
  enabled: boolean;
  triggers: MessageHintTrigger[];
  everyTurns?: number;
  placement: 'before' | 'after';
  audience: { roles: MessageHintRole[]; agents: string[]; sessions: string[] };
  allowedTriggers: MessageHintTrigger[];
  /** A custom hint's text. */
  text?: string;
  /** True when config changes this kind. */
  overridden: boolean;
  /** The settings stored for it, as stored. */
  override?: MessageHintSettings;
  identity(input: HintContentInput): string | null;
  render(input: HintContentInput, reasons: ReadonlySet<MessageHintTrigger>): HintRender | null;
  drifted?(config: Pick<Config, 'session'> | null, reply: string): boolean | null;
  /** Roles that get it on every message, the user's own included (empty once its triggers are overridden). */
  everyTurnRoles: MessageHintRole[];
  everyPersonTurn: boolean;
}

/** The strings of a list from config.yaml, which a person may have hand-edited into any shape. */
function stringsOf(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function audienceOf(s?: MessageHintSettings['audience']): EffectiveHint['audience'] {
  const a = s && typeof s === 'object' ? s : undefined;
  return {
    roles: stringsOf(a?.roles).filter((r): r is MessageHintRole => (HINT_ROLES as readonly string[]).includes(r)),
    agents: stringsOf(a?.agents),
    sessions: stringsOf(a?.sessions),
  };
}

function customSpec(kind: string, o: MessageHintSettings): HintSpec | null {
  const text = typeof o.text === 'string' ? o.text.trim() : '';
  if (!text) return null;
  return {
    kind,
    label: (typeof o.label === 'string' && o.label.trim()) || kind,
    description: 'A custom hint.',
    allowed: SCHEDULED,
    defaults: { enabled: true, triggers: ['session_start', 'after_compaction', 'on_change'], placement: 'after' },
    identity: () => text,
    render: () => ({ text }),
  };
}

/** Every hint, in the order they are composed: built-ins first, then custom ones by kind. */
export function effectiveHints(config: Pick<Config, 'session'> | null | undefined): EffectiveHint[] {
  const raw = config?.session?.hints;
  // A hand-edited config never breaks a send or the host slice: a malformed entry is skipped.
  const overrides: Record<string, MessageHintSettings> = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [kind, o] of Object.entries(raw)) if (o && typeof o === 'object' && !Array.isArray(o)) overrides[kind] = o;
  }
  const specs: Array<{ spec: HintSpec; o?: MessageHintSettings; builtIn: boolean }> = BUILT_IN.map((spec) => ({
    spec, o: overrides[spec.kind], builtIn: true,
  }));
  for (const kind of Object.keys(overrides).sort()) {
    if (BUILT_IN_BY_KIND.has(kind) || !HINT_KIND_RE.test(kind) || (WALNUT_ONLY_KINDS as readonly string[]).includes(kind)) continue;
    const spec = customSpec(kind, overrides[kind]);
    if (spec) specs.push({ spec, o: overrides[kind], builtIn: false });
  }
  return specs.map(({ spec, o, builtIn }) => {
    const triggers = (o?.triggers !== undefined ? stringsOf(o.triggers) as MessageHintTrigger[] : spec.defaults.triggers)
      .filter((t) => spec.allowed.includes(t));
    const every = typeof o?.every_turns === 'number' && o.every_turns >= 1 ? Math.floor(o.every_turns) : spec.defaults.every_turns;
    return {
      kind: spec.kind,
      label: spec.label,
      description: spec.description,
      builtIn,
      enabled: typeof o?.enabled === 'boolean' ? o.enabled : spec.defaults.enabled,
      triggers: [...new Set(triggers)],
      ...(every !== undefined ? { everyTurns: every } : {}),
      placement: o?.placement === 'before' || o?.placement === 'after' ? o.placement : spec.defaults.placement,
      audience: audienceOf(o?.audience),
      allowedTriggers: [...spec.allowed],
      ...(builtIn ? {} : { text: typeof o?.text === 'string' ? o.text.trim() : undefined }),
      overridden: !!o,
      ...(o ? { override: o } : {}),
      identity: spec.identity,
      render: spec.render,
      ...(spec.drifted ? { drifted: spec.drifted } : {}),
      // A person who set the triggers decides when it goes out.
      everyTurnRoles: o?.triggers === undefined && spec.allowed.includes('every_turn') ? [...(spec.everyTurnRoles ?? [])] : [],
      everyPersonTurn: o?.triggers === undefined && spec.allowed.includes('every_turn') && spec.everyPersonTurn === true,
    };
  });
}

export function findHint(config: Pick<Config, 'session'> | null | undefined, kind: string): EffectiveHint | undefined {
  return effectiveHints(config).find((h) => h.kind === kind);
}

/** The session a send goes to, as the audience rules see it. */
export interface HintTarget {
  sessionId: string;
  role?: MessageHintRole;
  agentId?: string;
}

export function hintApplies(hint: EffectiveHint, target: HintTarget): boolean {
  const a = hint.audience;
  if (a.sessions.length && !a.sessions.includes(target.sessionId)) return false;
  if (a.roles.length && !a.roles.includes(target.role ?? 'other')) return false;
  if (a.agents.length && !(target.agentId && a.agents.includes(target.agentId))) return false;
  return true;
}

/** Does any enabled hint restrict by role or agent (so the send must read the task)? */
export function needsTaskForAudience(hints: readonly EffectiveHint[]): boolean {
  // user-away reads the task to know it is Main or a lead (org/user-away.ts).
  return hints.some((h) => h.enabled && (h.audience.roles.length > 0 || h.audience.agents.length > 0 || h.everyTurnRoles.length > 0 || h.kind === 'user-away' || h.kind === 'brief' || h.kind === 'threads' || h.kind === 'threads-tidy'));
}

export class HintSettingsError extends Error {
  constructor(message: string) { super(message); }
}

/**
 * Check one kind's settings as a person or an agent sent them. Returns the
 * settings to store (unknown fields dropped), or throws HintSettingsError.
 */
export function validateHintSettings(kind: string, input: unknown): MessageHintSettings {
  if (!HINT_KIND_RE.test(kind)) throw new HintSettingsError('kind must be 2 to 41 lowercase letters, digits or dashes, starting with a letter');
  // Walnut's own text outside the registry: a custom hint by that name would read as Walnut's.
  if ((WALNUT_ONLY_KINDS as readonly string[]).includes(kind)) throw new HintSettingsError(`"${kind}" is the name of Walnut's own text; pick another name`);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HintSettingsError('settings must be an object');
  const i = input as Record<string, unknown>;
  const spec = BUILT_IN_BY_KIND.get(kind);
  const out: MessageHintSettings = {};
  if (i.enabled !== undefined) {
    if (typeof i.enabled !== 'boolean') throw new HintSettingsError('enabled must be true or false');
    out.enabled = i.enabled;
  }
  if (i.label !== undefined) {
    if (spec) throw new HintSettingsError('a built-in hint keeps its own label');
    if (typeof i.label !== 'string' || i.label.trim().length > 60) throw new HintSettingsError('label must be a string of at most 60 characters');
    if (i.label.trim()) out.label = i.label.trim();
  }
  if (i.text !== undefined) {
    if (spec) throw new HintSettingsError('a built-in hint keeps its own text (reply language and output mode are their own settings)');
    if (typeof i.text !== 'string' || !i.text.trim()) throw new HintSettingsError('text must be a non-empty string');
    if (i.text.length > HINT_TEXT_MAX) throw new HintSettingsError(`text must be at most ${HINT_TEXT_MAX} characters`);
    out.text = i.text.trim();
  }
  if (!spec && !out.text) throw new HintSettingsError(`"${kind}" is not a built-in hint: a new hint needs its text`);
  const allowed = spec?.allowed ?? SCHEDULED;
  if (i.triggers !== undefined) {
    if (!Array.isArray(i.triggers) || i.triggers.some((t) => typeof t !== 'string' || !HINT_TRIGGERS.includes(t as MessageHintTrigger))) {
      throw new HintSettingsError(`triggers must be a list of: ${HINT_TRIGGERS.join(', ')}`);
    }
    const bad = (i.triggers as MessageHintTrigger[]).filter((t) => !allowed.includes(t));
    if (bad.length) throw new HintSettingsError(`${kind} cannot use ${bad.join(', ')} (it can use: ${allowed.join(', ')})`);
    out.triggers = [...new Set(i.triggers as MessageHintTrigger[])];
  }
  if (i.every_turns !== undefined) {
    if (typeof i.every_turns !== 'number' || !Number.isInteger(i.every_turns) || i.every_turns < 1 || i.every_turns > HINT_EVERY_MAX) {
      throw new HintSettingsError(`every_turns must be a whole number from 1 to ${HINT_EVERY_MAX}`);
    }
    out.every_turns = i.every_turns;
  }
  if (i.placement !== undefined) {
    if (i.placement !== 'before' && i.placement !== 'after') throw new HintSettingsError('placement must be "before" or "after"');
    out.placement = i.placement;
  }
  if (i.audience !== undefined) {
    const a = i.audience as Record<string, unknown>;
    if (!a || typeof a !== 'object' || Array.isArray(a)) throw new HintSettingsError('audience must be an object');
    const list = (v: unknown, name: string, ok: (s: string) => boolean): string[] | undefined => {
      if (v === undefined) return undefined;
      if (!Array.isArray(v) || v.some((s) => typeof s !== 'string' || !ok(s))) throw new HintSettingsError(`audience.${name} must be a list of valid ${name}`);
      return [...new Set(v as string[])];
    };
    const roles = list(a.roles, 'roles', (s) => HINT_ROLES.includes(s as MessageHintRole)) as MessageHintRole[] | undefined;
    const agents = list(a.agents, 'agents', (s) => /^[\w.-]{1,64}$/.test(s));
    const sessions = list(a.sessions, 'sessions', (s) => /^[\w-]{1,80}$/.test(s));
    out.audience = { ...(roles?.length ? { roles } : {}), ...(agents?.length ? { agents } : {}), ...(sessions?.length ? { sessions } : {}) };
  }
  return out;
}

/** A hint as the API and the ops show it (no functions). */
export function describeHint(h: EffectiveHint, config?: Pick<Config, 'session'> | null) {
  const setting = h.builtIn ? HINT_USER_SETTINGS[h.kind] : undefined;
  // As it is sent: whitespace collapsed, a long one cut (output-mode.ts).
  const value = setting?.key === 'reply_language' ? replyLanguageText(config) : null;
  return {
    kind: h.kind,
    label: h.label,
    description: h.description,
    built_in: h.builtIn,
    enabled: h.enabled,
    triggers: h.triggers,
    ...(h.everyTurns !== undefined ? { every_turns: h.everyTurns } : {}),
    placement: h.placement,
    audience: h.audience,
    allowed_triggers: h.allowedTriggers,
    ...(h.text !== undefined ? { text: h.text } : {}),
    overridden: h.overridden,
    // Whose words it sends: a built-in's are Walnut's, but for a setting of the user's it fills in.
    ...(setting ? {
      user_setting: {
        label: setting.label, anchor: setting.anchor,
        value,
        walnut_text: setting.walnutText,
      },
    } : {}),
  };
}
