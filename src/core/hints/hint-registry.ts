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
import { detectLanguageDrift } from './hint-drift-detect.js';

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
  record: { output_mode?: SessionOutputMode } | null;
  /** The send asked for this hint (`on_request`), with its argument. */
  request?: { arg?: string };
  /** The identity this session was last told, if any. */
  toldHash?: string;
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
  /** Did this reply break the hint's rule? (`on_drift`) */
  drifted?(config: Pick<Config, 'session'> | null, reply: string): boolean;
  /**
   * Roles that get it on every message a person did not write, while its triggers are the
   * default: the user reads their chat whoever started the turn.
   */
  agentTurnRoles?: readonly MessageHintRole[];
}

const SCHEDULED: readonly MessageHintTrigger[] = HINT_TRIGGERS.filter((t) => t !== 'on_request');
const periodicOnly = (reasons: ReadonlySet<MessageHintTrigger>) =>
  [...reasons].every((r) => r === 'every_turn' || r === 'every_n_turns' || r === 'on_drift');

const BUILT_IN: readonly HintSpec[] = [
  {
    kind: 'question',
    label: 'Question number',
    description: 'Asks the reply to a question in the conversation tree to begin with its number, so the answer is filed under that question.',
    allowed: ['on_request'],
    defaults: { enabled: true, triggers: ['on_request'], placement: 'before' },
    identity: (i) => (i.request?.arg ? `question ${i.request.arg}` : null),
    render: (i) => {
      const seq = i.request?.arg;
      if (!seq || !/^\d{1,5}$/.test(seq)) return null;
      return {
        arg: seq,
        text: `this message is question ${seq} of this conversation. Begin your reply with the line "[Q${seq}]" (nothing else on that line) so the reply is filed under question ${seq}.`,
      };
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
    description: 'The language to answer the user in (Settings, Reply language). Main and the leads get it on every message a person did not write (a notice, a worker\'s reply, a trigger), because the user reads their chat whoever started the turn.',
    allowed: SCHEDULED,
    defaults: { enabled: true, triggers: ['session_start', 'after_compaction', 'on_change', 'on_drift'], placement: 'after' },
    // 2026-10-29: leads answered Walnut notices in English in the chats the user reads on the Org page.
    agentTurnRoles: ['main', 'lead'],
    identity: (i) => replyLanguageText(i.config),
    // 2026-10-29: after the user wrote Chinese, a worker's progress lines between its tool calls
    // stayed English; the rule covers every line the user reads, not only the final reply.
    render: (i) => {
      const text = replyLanguageText(i.config);
      return text ? { text: `${text} ${REPLY_LANGUAGE_SCOPE}` } : null;
    },
    drifted: (config, reply) => {
      const rule = replyLanguageText(config);
      return !!rule && detectLanguageDrift(rule, reply);
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
];

/** Walnut's own clause after the user's reply-language sentence. */
export const REPLY_LANGUAGE_SCOPE = 'This covers every line the user reads, the short progress lines between your tool calls included.';

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
  drifted?(config: Pick<Config, 'session'> | null, reply: string): boolean;
  /** Roles that get it on every message a person did not write (empty once its triggers are overridden). */
  agentTurnRoles: MessageHintRole[];
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
    if (BUILT_IN_BY_KIND.has(kind) || !HINT_KIND_RE.test(kind)) continue;
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
      agentTurnRoles: o?.triggers === undefined && spec.allowed.includes('every_turn') ? [...(spec.agentTurnRoles ?? [])] : [],
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
  return hints.some((h) => h.enabled && (h.audience.roles.length > 0 || h.audience.agents.length > 0 || h.agentTurnRoles.length > 0));
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
export function describeHint(h: EffectiveHint) {
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
  };
}
