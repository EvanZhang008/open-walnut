/**
 * Which messages may start a turn (2026-11-15, the user on the weekly LLM cost letter: "first
 * check if it is right to wake up, second to check is there way to make this more efficient").
 *
 * A turn of a big session costs about $1 (a full re-read of a 220K to 310K context). The week of
 * 11-08 to 11-15, Walnut's own notices started 645 turns of the Walnut VP alone, 343 of them
 * status notices, 145 of those ending with only the agent-ack line. Every notice that asks
 * nothing was already meant to ride the next message (held-notices.ts, status-riding.ts, the
 * subtask notices' "stopped / blocked / waiting ride only a turn already running"), but each
 * path decided that on its own, and a notice written while a turn ran started a turn of its own
 * when that turn ended first.
 *
 * One rule, where every message to a session is queued (session-message-queue.ts): a message that
 * is nothing but Walnut notices that ask nothing (NOTICE_RIDES) never goes to the CLI on its own,
 * not even into a running turn: a line that reaches the CLI as its turn ends starts a turn of its
 * own (2026-11-16: three such notices reached the Walnut VP 1 to 5 s after its last words, while
 * its Stop hooks ran, and each was an agent-ack turn). It is held (holdRidingNotice) and rides in
 * front of the session's next message (a person's words, a reply, a request, a trigger, a notice in
 * NOTICE_WAKES). Every notice
 * kind is classified here, each one that wakes with its reason; tests/core/sessions/
 * wake-policy-guard.test.ts fails when a producer in src/ writes an outcome this file does not
 * list, so a new notice cannot start turns by being forgotten. An outcome missing here at runtime
 * wakes (a notice is never lost or held by mistake) and is logged.
 */
import { log } from '../../logging/index.js';
import { hintBlocksIn } from '../hints/hint-format.js';
import { holdFoldedNotice } from './held-notices.js';

/**
 * Notices that ask nothing of their reader: they ride the next turn, never start one.
 * Each says what moved; the reader acts on it, if at all, with whatever it does next.
 */
export const NOTICE_RIDES: readonly string[] = [
  // A followed task's status changed (status-riding.ts): "not a work request".
  'status',
  // The org changed: Main's digest and a lead's team note (org-store.ts, team-note.ts). A note
  // whose task waits on the lead is sent with a wake reason (org/lead-waits.ts), not by its outcome.
  'org-update',
  // Default instructions or the reply language changed (instruction-notice.ts, reply-language-drift.ts).
  'task-routing-policy', 'reply-language',
  // The task moved, its folder moved, Walnut restarted, a lead handed its project over.
  'moved', 'folder-moved', 'restarted', 'handed-over',
  // A request past its deadline that stays open, and its reminder (no `request` attribute: held-notices.ts).
  'timeout',
  // An answer given for the user was taken back (ask-withdraw.ts).
  'answer-withdrawn',
  // A subtask stopped, parked itself or waits on the user (subtask-notices.ts): its lead's work
  // comes back with its completion, its error, or its reply. The parent's own wait note (task-wait-resume.ts).
  'stopped', 'waiting', 'blocked',
  // Notes that asked for no reply (quiet-notes.ts).
  'quiet-notes',
  // A write made while the server was away applied, or had nothing to do (offline-handover.ts).
  'applied', 'noop',
  // An engine switch or a move picked earlier expired without running (engine-switch-watch.ts).
  'switch-expired', 'move-expired',
  // The task was adopted by a leader or released from one (adopt-notice.ts).
  'adopted', 'released',
];

/** Notices that start a turn, each with why its reader must act now. */
export const NOTICE_WAKES: Readonly<Record<string, string>> = {
  completed: 'a subtask finished: its lead checks the work and decides what comes next',
  error: 'a subtask or a start failed: the work stopped until someone retries or reroutes it',
  awaiting_human: 'a request\'s target waits on the user: its asker decides what to do meanwhile',
  approved: 'the user approved what the session waits on: it goes on',
  denied: 'the user refused what the session waits on: it must take another way',
  expired: 'an approval the session waits on expired: it must ask again or stop',
  check_failed: 'the session\'s own trigger check fails: only its owner can fix the script',
  check_failing: 'the session\'s own trigger check keeps failing: only its owner can fix the script',
  check_repaired: 'the session\'s own trigger check broke its output contract and the daemon repaired it: only its owner can fix the script (told at most once a day, trigger-health.ts)',
  trigger_disabled: 'the session\'s own trigger was switched off: only its owner can repair and resume it',
  routine_trouble: 'a routine of the session is in trouble: only its owner can fix it',
  'threads-overdue': 'threads wait on this node\'s decision past their time',
  vp: 'the session was made a VP: it takes up the role',
  handover: 'a project was handed to this lead: it takes up the work',
  'folder-not-moved': 'the session\'s folder is gone and could not be moved: its work cannot go on',
  refused: 'a write the session made while the server was away was refused: it must redo it',
  'given-up': 'a write the session made while the server was away was given up: it must redo it',
  'test-run': 'the person pressed a test of Talk to CEO and waits to see it answer',
};

const RIDES = new Set(NOTICE_RIDES);
const warned = new Set<string>();

/** Every outcome this file classifies (the guard test reads it). */
export function classifiedOutcomes(): string[] {
  return [...NOTICE_RIDES, ...Object.keys(NOTICE_WAKES)];
}

/**
 * Does a notice of this outcome start a turn? Those in NOTICE_WAKES, a notice with no outcome (a
 * note written to its reader about its own work: its command ended, its ask was answered in a
 * teammate, a tool it called is missing) and an outcome this file does not know. Never throws.
 */
export function noticeWakes(outcome: string | undefined): boolean {
  if (!outcome) return true;
  if (RIDES.has(outcome)) return false;
  if (!(outcome in NOTICE_WAKES) && !warned.has(outcome)) {
    warned.add(outcome);
    log.session.warn('wake policy: a notice outcome it does not classify starts turns (add it to wake-policy.ts)', { outcome });
  }
  return true;
}

const TAG = /^<walnut-message ((?:[a-z][a-z0-9-]*="[^"]*"\s*)*)>\n[\s\S]*?\n<\/walnut-message>/;
const ATTR = /([a-z][a-z0-9-]*)="([^"]*)"/g;

/** The attributes of each envelope `text` is made of, or null when anything else is in it. */
function envelopesOnly(text: string): Array<Record<string, string>> | null {
  const out: Array<Record<string, string>> = [];
  let rest = text.trim();
  while (rest) {
    const m = TAG.exec(rest);
    if (!m) return null;
    const attrs: Record<string, string> = {};
    for (const a of m[1].matchAll(ATTR)) if (!(a[1] in attrs)) attrs[a[1]] = a[2];
    out.push(attrs);
    rest = rest.slice(m[0].length).trim();
  }
  return out.length ? out : null;
}

/**
 * Does this queued row ask nothing, so it rides the next turn instead of starting one? Only a row
 * made of nothing but Walnut notices (and Walnut's hint blocks) whose outcomes are in NOTICE_RIDES. A
 * person's words, a reply, a peer's note, a trigger, a notice with a `request` (its asker waits)
 * one with no outcome or one in NOTICE_WAKES wakes, and so does an outcome this file does not know.
 */
export function rowRides(text: string): boolean {
  // Walnut's own hint blocks (hints/hint-format.ts) go with any message and ask nothing themselves.
  let rest = text;
  for (const block of hintBlocksIn(text)) rest = rest.replace(block, '');
  const envs = envelopesOnly(rest);
  if (!envs) return false;
  return envs.every((a) => {
    if (a.kind !== 'notification' || a.request) return false;
    return !noticeWakes(a.outcome);
  });
}

/**
 * Hold a row of notices that ask nothing for the session's next message (held-notices.ts): every
 * such row waits under one key, so ten status notices read as one block in front of the next
 * message, the newest FOLD_PARTS_MAX kept. In memory, like every held notice: a restart drops what
 * waits, which notices that ask nothing can afford.
 */
export function holdRidingNotice(sessionId: string, text: string, now = Date.now()): void {
  holdFoldedNotice<string>(sessionId, 'riding-notices', text, (parts, dropped) => [
    ...parts,
    ...(dropped > 0 ? [`(${dropped} older notice${dropped === 1 ? '' : 's'} that asked nothing dropped: the newest say where things stand.)`] : []),
  ].join('\n\n'), { now });
}
