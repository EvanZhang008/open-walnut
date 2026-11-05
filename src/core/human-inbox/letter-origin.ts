/**
 * Who a letter is FROM, in one value every inbox surface reads (2026-11-04: a Walnut task's
 * decision letter named an outside company in its subject, and the user took it for a new mail
 * from that company; it took three messages to learn it came from his own task).
 *
 * Every letter in the inbox is Walnut's own: a task's, an Inbox Triage run's, Walnut's own
 * notice, a plugin's, or a script calling Walnut's API. None is outside mail, so each surface
 * leads a letter with this origin (its kind and name), styled as Walnut's, before the subject.
 * The origin is derived from the stamped sender, never written by the sender, and it is derived
 * on every read of the store (store.ts), so a letter written before this field reads the same.
 *
 * Kinds, in the order they are decided:
 *   task    — a Walnut task's session (Main and the VPs are tasks too): its name
 *   triage  — an Inbox Triage run: the letter summarizes outside mail, the run is Walnut's
 *   session — a session with no task (rare: a hand-started agent)
 *   walnut  — a letter Walnut writes itself (walnut-letters/registry.ts)
 *   plugin  — a plugin's letter (walnut.letters.send)
 *   script  — a caller of the letter route with no session (a script or tool calling Walnut's API)
 *
 * The web (`web/src/api/human-inbox.ts`) and iOS (`ModelsInbox.swift`) read `origin` as given;
 * `tests/core/human-inbox/letter-origin-surfaces.test.ts` fails when a letter kind or an inbox
 * surface shows no origin.
 */
import { askProjectFor } from '../sessions/ask-list.js';
import { TRIAGE_AGENT_ID, TRIAGE_AGENT_NAME } from '../triage/types.js';
import type { LetterRecord, LetterSender } from './types.js';

export const LETTER_ORIGIN_KINDS = ['task', 'triage', 'session', 'walnut', 'plugin', 'script'] as const;
export type LetterOriginKind = (typeof LETTER_ORIGIN_KINDS)[number];

export interface LetterOrigin {
  kind: LetterOriginKind;
  /** What the user reads first: the task's or the run's name, "Walnut", the plugin's name. */
  name: string;
  /** The sending task, when one sent it (the surfaces link to it and show its live name). */
  taskId?: string;
}

/** The project an Inbox Triage run is filed under (bootstrap.ts TRIAGE_PROJECT). */
const TRIAGE_PROJECT = askProjectFor({ id: TRIAGE_AGENT_ID, name: TRIAGE_AGENT_NAME });

const NAME_MAX = 200;

function clean(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
}

/** An Inbox Triage run's letter: stamped `agentId`, or (letters before the stamp) its project. */
export function isTriageLetterSender(sender: LetterSender): boolean {
  if (!sender.taskId) return false;
  return sender.agentId === TRIAGE_AGENT_ID || sender.project === TRIAGE_PROJECT;
}

/**
 * The origin of a letter. `walnutKind` says whether Walnut wrote it itself (the registry's
 * `kindOfLetter`, passed in so this file stays free of the letter templates).
 */
export function letterOriginOf(
  letter: Pick<LetterRecord, 'sender'>,
  walnutKind: boolean,
): LetterOrigin {
  const s = letter.sender ?? { sessionId: 'external', host: 'local' };
  const sid = (s.sessionId ?? '').trim();
  const hasSession = !!sid && sid !== 'external';
  if (s.taskId && isTriageLetterSender(s)) {
    return { kind: 'triage', name: TRIAGE_AGENT_NAME, taskId: s.taskId };
  }
  if (s.taskId) {
    return { kind: 'task', name: clean(s.taskTitle) || clean(s.sessionTitle) || 'Walnut task', taskId: s.taskId };
  }
  if (hasSession) return { kind: 'session', name: clean(s.sessionTitle) || 'Walnut session' };
  if (walnutKind) return { kind: 'walnut', name: 'Walnut' };
  if (s.pluginId) return { kind: 'plugin', name: clean(s.pluginName) || clean(s.pluginId) };
  // The letter route stamps `via: 'api'` on a caller it could not tie to a session; every other
  // sender-less letter is one Walnut wrote itself, a kind of tomorrow included.
  if (s.via === 'api') return { kind: 'script', name: 'A script' };
  return { kind: 'walnut', name: 'Walnut' };
}

/**
 * The origin as one short line, for a surface with no room for a badge (a phone push title, the
 * bell's card, a desktop notification): `Task “Ship the mail digest”`, `Inbox Triage`, `Walnut`.
 */
export function letterOriginLine(origin: Pick<LetterOrigin, 'kind' | 'name'>, maxName = 0): string {
  // A cap shortens the name itself, so a long task title never loses its closing quote.
  const full = clean(origin.name);
  const name = maxName > 1 && full.length > maxName ? `${full.slice(0, maxName - 1).trimEnd()}…` : full;
  switch (origin.kind) {
    case 'task': return `Task “${name || 'Walnut task'}”`;
    case 'session': return `Session “${name || 'Walnut session'}”`;
    case 'plugin': return `${name || 'A plugin'} (plugin)`;
    case 'triage': return name || TRIAGE_AGENT_NAME;
    case 'walnut': return 'Walnut';
    default: return name || 'A script';
  }
}
