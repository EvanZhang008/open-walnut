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
  // Default instructions or the reply language changed (instruction-notice.ts).
  'task-routing-policy',
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
  // A topic's lines that did not wake the member (topics/topic-text.ts): it reads them next time.
  'topic-news',
  // A write made while the server was away applied, or had nothing to do (offline-handover.ts).
  'applied', 'noop',
  // An engine switch or a move picked earlier expired without running (engine-switch-watch.ts).
  'switch-expired', 'move-expired',
  // The task was adopted by a leader or released from one (adopt-notice.ts).
  'adopted', 'released',
  // The machine has failed the session's own trigger's checks for hours (trigger-health.ts): nothing in
  // the script to fix, so it waits for the next turn and wakes nobody (2026-11-16, a full disk woke nine).
  'check_machine_fault',
  // The task's removed workspace was made again (workspaces/remake.ts): told once, in front of the
  // messages that waited on the folder, never on its own.
  'workspace-remade',
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
  'host-exec-granted': 'the user allowed the command on another host the session waits on: it runs it now',
  'task-dir-size': 'the host\'s disk is low and this task\'s directory is large: only its owner knows what to delete',
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

/**
 * Cache-aware delivery (2026-11-16, the user: "如果这个东西是在 cache 在 warm 的时候，OK，你可以去
 * reply，但是如果这个东西已经是啊 cold 了。那我觉得我们是不是应该 buffer 一下？"). A message to a
 * session whose prompt cache is still warm goes at once: its turn reads the context at a tenth of the
 * price. One to a session gone cold (idle past its cache lifetime) pays the whole context again, so
 * a message that can wait is held (sessions/cold-hold.ts) and every held message goes in ONE wake:
 * with the next message that cannot wait, when the session wakes anyway, or when the oldest held one
 * reaches COLD_HOLD_MAX_MS.
 *
 * Only an FYI waits: news nobody waits on and no clock set (2026-11-18, the Walnut VP: "凡是按时间来的
 * 消息……都是「到点」本身，一律不压；只有没人等、不催时间的 FYI 才能压"). A message that came because a
 * time came is the moment itself, and nothing else is due to wake the session sooner, so a hold only
 * moves the same cold wake an hour later (11-18: a task's 20:00 daily timer fired at 04:02:48Z and
 * reached its session at 05:03:08Z; two re-checks of an ask to the user reached theirs 60 min late).
 * Two gates, both by what sent the message, never by its words:
 *  - its send source is in COLD_HOLD_SOURCES: another task's note or Walnut's status notice. Every
 *    clock sends under its own source (wait-until, needs-recheck, promise-alarm, thread-recheck,
 *    routine-*, trigger-*), as do the watches of what a task waits on (pr-watch, change-watch);
 *  - its envelopes are FYIs: a task's note that asks nothing, a notice in NOTICE_WAITS_COLD or one
 *    that rides. A `trigger` envelope never waits: each is a clock (a fire, a wait clock, a re-check,
 *    a follow-up, a status check) or news the task waits on (a pull request or change watch).
 * Everything else goes at once: the user's words, an ask or its reply, a script's note (a land's
 * revert alert), an unknown source or shape. tests/core/sessions/cold-hold.test.ts fails when a clock
 * in src/ sends what these gates would hold.
 */

/** Send sources whose messages may wait for a cold session: an FYI only comes under these. */
export const COLD_HOLD_SOURCES: ReadonlySet<string> = new Set([
  'peer',          // another task's task_send (one with a request never waits)
  'walnut-notify', // Walnut's status notices (only NOTICE_WAITS_COLD and riding ones wait)
]);

/**
 * Notices that start a turn (NOTICE_WAKES) but can wait for a cold session's next wake: news with
 * no clock in it and nobody waiting on it.
 */
export const NOTICE_WAITS_COLD: readonly string[] = [
  // The session's own trigger or routine is in trouble: its owner fixes the script when it next works.
  'check_failed', 'check_failing', 'check_repaired', 'trigger_disabled', 'routine_trouble',
  // Its task directory is large on a host low on disk: cleaned up with its next turn.
  'task-dir-size',
];

const WAITS_COLD = new Set(NOTICE_WAITS_COLD);

/**
 * Can this message, sent under `source`, wait while its session is cold? Only an FYI (see above):
 * a source in COLD_HOLD_SOURCES, and a message made of nothing but envelopes (and Walnut's hint
 * blocks), each a task's note that asks nothing (a peer-note with no `request`, not a script's) or a
 * notice that rides or is in NOTICE_WAITS_COLD. Everything else goes at once: an unknown shape or
 * source is never held by mistake.
 */
export function waitsWhenCold(text: string, source: string | undefined): boolean {
  if (!source || !COLD_HOLD_SOURCES.has(source)) return false;
  let rest = text;
  for (const block of hintBlocksIn(text)) rest = rest.replace(block, '');
  const envs = envelopesOnly(rest);
  if (!envs) return false;
  return envs.every((a) => {
    if (a.request) return false;
    if (a.kind === 'peer-note') return a.anonymous !== 'true' && !!(a['from-task'] || a['from-session']);
    if (a.kind === 'notification') return !!a.outcome && (RIDES.has(a.outcome) || WAITS_COLD.has(a.outcome));
    return false;
  });
}
