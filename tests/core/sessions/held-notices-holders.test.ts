/**
 * Every in-memory holder of words that wait to ride a later message is kept on disk, or is listed
 * here with why losing it at a restart is fine (2026-11-21: three task_send wake=false notes a lead
 * sent one task were held in server memory only, and deploys restarted the server within minutes:
 * the notes were gone, nobody was told, op_result kept reading "applied, delivery held").
 *
 * The holders are read from the source, not from a list:
 *  - every module sendMessageToSession takes a rider from (`const { pendingX } = await import(…)`,
 *    and waitNoteFor) in src/core/session-message-queue.ts;
 *  - every module in src/ that holds words through a ride or hold call (holdNotice,
 *    holdFoldedNotice, holdQuietNote, holdRidingNotice, rideLine, rideNotice), and the two stores
 *    those write (held-notices-store.ts, status-riding.ts);
 * and in each, every module-scope Map, Set (weak ones too), array or plain object (an UPPER_CASE
 * constant is a lookup table and is left out). Each must be listed below: `durable` with the file it is kept in (its module must
 * name that file), `restart-ok` with why losing it is fine, or `no-text` with why it holds no words
 * that wait. A new holder fails until it is listed; a listed one that is gone fails until its line
 * goes, so the list stays today's truth.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

type How = { durable: string } | { 'restart-ok': string } | { 'no-text': string };

const HOLDERS: Record<string, How> = {
  // The held notices themselves: quiet notes, riding notices, topic folds, deadline notices.
  'src/core/sessions/held-notices-store.ts#held': { durable: 'held-notices.json' },
  'src/core/sessions/held-notices-store.ts#taken': { durable: 'held-notices.json' },
  'src/core/sessions/held-notices-store.ts#fates': { durable: 'held-notices.json' },
  // The tells that a note was dropped: on disk until told, tried again while telling fails (2026-11-23).
  'src/core/sessions/held-notices-store.ts#tells': { durable: 'held-notices.json' },
  'src/core/sessions/held-notices-store.ts#tellsOut': { durable: 'held-notices.json' },
  'src/core/sessions/held-notices-sweep.ts#goneSince': { 'no-text': 'when a sweep lap first found a session gone; a restart only means one more lap before what waits for it is moved or dropped' },
  // Status lines and turn notices of the tasks a node follows.
  'src/core/sessions/status-riding.ts#riding': { durable: 'status-riding.json' },
  'src/core/sessions/status-riding.ts#toldDecisions': { durable: 'status-riding.json' },
  'src/core/sessions/status-riding.ts#toldNotices': { 'no-text': 'when each notice was told, so a later status line does not say it again; at worst one line repeats after a restart' },
  'src/core/org/thread-answered-notes.ts#held': { 'no-text': 'a parsed copy of the answered-threads line, which itself rides in status-riding.json and is read back from there (readBack)' },
  'src/core/sessions/status-push.ts#baseline': { 'no-text': 'each task\'s last seen status; read again from the task store at boot (startStatusPush)' },
  'src/core/sessions/status-push.ts#pending': { 'restart-ok': 'status changes settling for SETTLE_MS before they ride (into status-riding.json); the status itself stays on its task, which the Brief and task_get read' },
  // Riders made from records on disk at the moment of the send: only claims and in-flight work here.
  'src/core/sessions/place-notice.ts#claims': { 'no-text': 'which send is telling the place note now; the note is read from the task and session records' },
  'src/core/sessions/restart-notice.ts#claims': { 'no-text': 'which send is telling the restart note now; the note is read from the session record' },
  'src/core/org/org-store.ts#claims': { 'no-text': 'which send is telling the digest now; the digest is in the org store' },
  'src/core/sessions/folder-gone.ts#noting': { 'no-text': 'a folder check in flight; its result is written on the session record' },
  'src/core/sessions/folder-gone.ts#continuing': { 'no-text': 'a move to a new folder in flight; its result is written on the session record' },
  'src/core/sessions/app-state.ts#published': { 'restart-ok': 'what a running App published; the App runs in this server and publishes again once it runs again' },
  'src/core/sessions/app-state.ts#told': { 'restart-ok': 'what each session was told of an App\'s state; after a restart the App\'s state is told again from the start' },
  'src/core/sessions/app-state.ts#claims': { 'no-text': 'which send is telling an App\'s state now' },
  'src/core/sessions/app-state.ts#proactive': { 'no-text': 'timers of an App\'s own wake, which the App sets again when it runs' },
  'src/core/task-wait-resume.ts#interrupted': { 'no-text': 'a wait a running turn interrupted, to bring back at that turn\'s end; a restart ends the turn, and the wait\'s clock stays on the task' },
  'src/core/task-wait-resume.ts#endsSeen': { 'no-text': 'turn bookkeeping of the turn now running' },
  'src/core/task-wait-resume.ts#restored': { 'no-text': 'turn bookkeeping of the turn now running' },
  'src/core/task-wait-resume.ts#fireTurns': { 'no-text': 'turn bookkeeping of the turn now running' },
  'src/core/task-wait-resume.ts#leftPhase': { 'no-text': 'turn bookkeeping of the turn now running (a minute at most)' },
  'src/core/task-wait-resume.ts#restoredParks': { 'no-text': 'turn bookkeeping of the turn now running' },
  // Writers of held notices: their own maps hold dedupe marks and in-flight work, never the words.
  'src/core/sessions/subtask-notices.ts#completionsTold': { 'no-text': 'which completions were told, so a second turn end is not news; at worst one notice repeats after a restart' },
  'src/core/sessions/subtask-notices.ts#stopsTold': { 'no-text': 'the last stop told per child, so the same stop is not told twice' },
  'src/core/sessions/subtask-notices.ts#completionsSending': { 'no-text': 'completions a flush is sending right now' },
  'src/core/sessions/subtask-notices.ts#siblingsTold': { 'no-text': 'what each parent was last told of its open subtasks, so the next line names only what changed' },
  'src/core/sessions/subtask-notices.ts#pending': { 'restart-ok': 'notices coalescing for COALESCE_MS (3 s) before they go out or into subtask-notices-held.json; the child\'s state stays on its task record' },
  'src/core/sessions/session-send-core.ts#answering': { 'no-text': 'answers in flight, one per request, so two copies never settle it twice' },
  'src/core/sessions/wake-policy.ts#warned': { 'no-text': 'outcomes already logged as unclassified' },
  'src/core/org/thread-reply.ts#wakes': { 'no-text': 'gather timers; the replies wait on the thread record (delivery pending) and the sweep finds them' },
  'src/core/org/thread-reply.ts#flushing': { 'no-text': 'owners being flushed now' },
  'src/core/org/thread-reply.ts#again': { 'no-text': 'owners to flush again after the running flush' },
  'src/core/org/thread-reply.ts#pendingOwners': { 'no-text': 'owners with a pending reply, filled again by the sweep from the thread records' },
  'src/core/org/thread-reply.ts#queuedRows': { 'no-text': 'queue row to owner, for the delivered event; the row is on disk in the session queue' },
  'src/core/org/thread-reply.ts#changedOwners': { 'no-text': 'owners whose Threads changed in the last 250 ms, for one viewers event' },
  'src/core/topics/topic-replies.ts#waiting': { 'no-text': 'which sessions have a topic turn in flight; rebuilt from the topic files at start' },
  'src/core/topics/topic-replies.ts#sessionChains': { 'no-text': 'per-session promise chains of work in flight' },
};

function srcFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...srcFiles(p));
    else if (/\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/** The modules that hold words waiting for a later message (see the header). */
function holderModules(): string[] {
  const mods = new Set<string>(['src/core/sessions/held-notices-store.ts', 'src/core/sessions/status-riding.ts']);
  const queue = read('src/core/session-message-queue.ts');
  // Loaded where the send needs it, or imported at the top.
  for (const m of queue.matchAll(/(?:const \{ ([^}]+) \} = await import\('([^']+)'\)|^import \{ ([^}]+) \} from '([^']+)')/gm)) {
    const [names0, from] = m[1] !== undefined ? [m[1], m[2]] : [m[3], m[4]];
    const names = names0.split(',').map((n) => n.replace(/^type\s+/, '').split(/:| as /)[0].trim());
    if (names.some((n) => /^(pending[A-Z]\w*|waitNoteFor)$/.test(n))) {
      mods.add(path.join('src/core', from).replace(/\.js$/, '.ts'));
    }
  }
  const call = /\b(holdNotice|holdFoldedNotice|holdQuietNote|holdRidingNotice|rideLine|rideNotice)(<[^>()]*>)?\(/;
  for (const p of srcFiles(path.join(ROOT, 'src'))) {
    if (call.test(fs.readFileSync(p, 'utf8'))) mods.add(path.relative(ROOT, p));
  }
  return [...mods].sort();
}

/** Module-scope Maps, Sets (weak ones too), arrays and plain objects of a file (UPPER_CASE constants left out). */
function holdersIn(rel: string): string[] {
  const out: string[] = [];
  const re = /^(?:export )?(?:const|let) ([A-Za-z_$][\w$]*)(?:\s*:[^\n]*?)?\s*=\s*(?:new (?:Weak)?(?:Map|Set)\b|\[\]|\{\})/gm;
  for (const m of read(rel).matchAll(re)) if (!/^[A-Z][A-Z0-9_]*$/.test(m[1])) out.push(`${rel}#${m[1]}`);
  return out;
}

describe('every holder of words that wait for a later message survives a restart, or says why it need not', () => {
  it('finds the riders and the hold writers it is meant to cover', () => {
    const mods = holderModules();
    for (const must of [
      'src/core/sessions/held-notices.ts', 'src/core/sessions/quiet-notes.ts', 'src/core/sessions/wake-policy.ts',
      'src/core/sessions/status-push.ts', 'src/core/topics/topic-delivery.ts', 'src/core/sessions/session-request-notify.ts',
      'src/core/sessions/place-notice.ts', 'src/core/task-wait-resume.ts',
    ]) expect(mods, must).toContain(must);
  });

  it('each one is listed: durable (its module names its file), restart-ok or no-text with why', () => {
    const found = holderModules().flatMap(holdersIn);
    expect(found.length).toBeGreaterThan(20);
    const unlisted = found.filter((h) => !(h in HOLDERS));
    expect(unlisted, 'a new in-memory holder: keep it on disk, or list it in HOLDERS with why a restart may drop it').toEqual([]);
    const stale = Object.keys(HOLDERS).filter((h) => !found.includes(h));
    expect(stale, 'a listed holder is gone: remove its line').toEqual([]);
    for (const [h, how] of Object.entries(HOLDERS)) {
      const [kind, why] = Object.entries(how)[0];
      if (kind === 'durable') expect(read(h.split('#')[0]), `${h} says it is kept in ${why}`).toContain(why);
      else expect(why.length, h).toBeGreaterThan(20);
    }
  });

  it('the held notices are written to their file, which the home manifest lists as the leader\'s data', () => {
    const store = read('src/core/sessions/held-notices-store.ts');
    expect(store).toContain("path.join(WALNUT_HOME, 'cache', 'held-notices.json')");
    expect(store).toMatch(/writeFileAtomic\(/);
    expect(read('src/core/home-manifest/home-nested-entries.ts')).toMatch(/lead\('cache\.held-notices', 'cache\/held-notices\.json', 'file'/);
    // The server opens it at boot, so a restart reads it again; and the quiet note's hold is awaited
    // before its send is answered.
    expect(read('src/web/server.ts')).toContain("import('../core/sessions/held-notices-sweep.js').then((m) => m.startHeldNotices())");
    expect(read('src/core/sessions/session-send-core.ts')).toMatch(/const \{ duplicate, full \} = await holdQuietNote\(/);
  });
});
