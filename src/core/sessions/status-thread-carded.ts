/**
 * The threads a reply's card lines spoke for (org/reply-card.ts; experiment threads_reply_tag): the
 * status question after that turn does not ask about them again, which is the model pass the line
 * saves (2026-11-25, the user: the reply is "both its reply to me and its reply to the thread").
 * Kept per task, in memory, as its last turn's end left it: the next turn's end replaces it, and a
 * thread he wrote in since (a message newer than the one the line saw) is asked again. After a
 * restart nothing is kept and the question asks every thread once more, so nothing is lost.
 */
import { log } from '../../logging/index.js';

const TASKS_MAX = 500;
/** Per task: thread id -> its newest message's id ('' for none) that the line saw. */
const carded = new Map<string, Map<string, string>>();

/** Record what the turn that just ended spoke for (none: the record goes). */
export function noteCarded(taskId: string, threads: ReadonlyArray<{ id: string; upTo: string }>): void {
  carded.delete(taskId);
  if (!threads.length) return;
  carded.set(taskId, new Map(threads.map((t) => [t.id, t.upTo])));
  if (carded.size > TASKS_MAX) carded.delete(carded.keys().next().value!);
}

/** Of these threads, the ones a card line spoke for and that hold nothing of his newer than it. Pure but for the record. */
export function cardedNow(taskId: string, threads: ReadonlyArray<{ id: string; messages: ReadonlyArray<{ id: string }> }>): Set<string> {
  const mine = carded.get(taskId);
  const out = new Set<string>();
  if (!mine) return out;
  for (const t of threads) {
    const upTo = mine.get(t.id);
    if (upTo !== undefined && (t.messages[t.messages.length - 1]?.id ?? '') === upTo) out.add(t.id);
  }
  return out;
}

/**
 * The write of a turn's card lines still on its way, per session. It starts in the step that arms
 * that turn's status question (session-hooks/builtins.ts, org/reply-card.ts turnEndedWith), from the
 * turn's own last words, and the question waits for it before it lists the threads
 * (status-thread-question.ts): a line is noted before its thread can be listed, however slow
 * anything else is (2026-11-25: the write once followed a transcript read, which a real server
 * finished after the question, and an isolated one never started).
 */
const writing = new Map<string, Promise<void>>();
/**
 * The longest a question waits for that write. At the bound it is built as with the switch off
 * (every open thread that needs a line is asked); the write goes on and its lines land when it ends.
 */
export const CARDS_WAIT_MAX_MS = 10_000;

/**
 * The longest one write holds the session's chain: the bound the question waits, so a write the
 * question no longer waits for holds no later write either (review 2026-11-25: one hung write held
 * every later turn's lines of that session). It goes on by itself; its lines land when it ends.
 */
export const CARD_WRITE_HOLD_MS = CARDS_WAIT_MAX_MS;

/** `write`, done for the chain when it ends or at the bound, whichever is first. Never rejects. */
function heldAtMost(sessionId: string, write: () => Promise<unknown>, maxMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ran = Promise.resolve().then(write).then(() => {}, () => {});
  const bound = new Promise<void>((r) => {
    timer = setTimeout(() => {
      log.session.warn('reply card lines: a write ran past its bound, the next one goes on', { sessionId, boundMs: maxMs });
      r();
    }, maxMs);
    timer.unref?.();
  });
  return Promise.race([ran, bound]).finally(() => { if (timer) clearTimeout(timer); });
}

/** Run `write` after the session's write still on its way, if any (each one held at most CARD_WRITE_HOLD_MS); the question waits for both. Never rejects. */
export function queueCardWrite(sessionId: string, write: () => Promise<unknown>, holdMs = CARD_WRITE_HOLD_MS): Promise<void> {
  const run: Promise<void> = (writing.get(sessionId) ?? Promise.resolve()).then(() => heldAtMost(sessionId, write, holdMs));
  writing.delete(sessionId);
  writing.set(sessionId, run);
  if (writing.size > TASKS_MAX) writing.delete(writing.keys().next().value!);
  void run.then(() => { if (writing.get(sessionId) === run) writing.delete(sessionId); });
  return run;
}

/** Wait for the session's card write, at most `maxMs`. False when it still runs at the bound. */
export async function cardsWritten(sessionId: string | undefined, maxMs = CARDS_WAIT_MAX_MS): Promise<boolean> {
  const run = sessionId ? writing.get(sessionId) : undefined;
  if (!run) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const done = await Promise.race([run.then(() => true), new Promise<boolean>((r) => { timer = setTimeout(() => r(false), maxMs); timer.unref?.(); })]);
  if (timer) clearTimeout(timer);
  return done;
}

/** Tests only. */
export function resetCarded(): void {
  carded.clear();
  writing.clear();
}
