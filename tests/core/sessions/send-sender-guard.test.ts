/**
 * Guard for `sentBy: "person"` (2026-11-02, the user's own review: an agent's or a trigger's text
 * passed as his word, because a line with no envelope reads as a person's). It is a ratchet in the
 * sense of the other ones here: it enumerates every way a line reaches a session from the source and
 * fails when a new one lands that this file does not classify, so a new sender cannot become
 * "person" by being forgotten.
 *
 *  1. The sources that count as a person's are pinned. Adding one means reading this file.
 *  2. Every call that puts a line into a session (a send, a raw enqueue, a start) is listed per
 *     file with its sender. A new call site fails until it is listed.
 *  3. Only the files listed as a person's may pass a person source to such a call.
 *  4. A raw `enqueueMessage` outside the queue's own file must frame its text.
 *  5. Through the real queue, every source found in the code lands as the right sender.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());

import { PERSON_SEND_SOURCES, PERSON_START_SOURCES, isPersonSource, queueSentBy } from '../../../src/core/sessions/send-sent-by.js';
import { frameStartText } from '../../../src/core/sessions/send-frame.js';
import { transcriptSentBy } from '../../../src/core/sessions/transcript-sent-by.js';
import { resetCache, sendMessageToSession, getQueue } from '../../../src/core/session-message-queue.js';
import { WALNUT_HOME } from '../../../src/constants.js';

const ROOT = path.resolve(__dirname, '../../..');
const SRC = path.join(ROOT, 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

const CALL = /\b(sendMessageToSession|deliverToSession|enqueueMessage|startSessionForTask|quickStartSession|continueTaskConversation|performSessionSend|performMobileLaunch|getOrCreateLaneSession)\(|sessionRunner\.startSession\(/g;

interface Site { file: string; fn: string; line: number; sources: string[] }

/** Every call that puts a line into a session, with the `source:` literals named in the call. */
function callSites(): Site[] {
  const sites: Site[] = [];
  for (const f of walk(SRC)) {
    const text = fs.readFileSync(f, 'utf8');
    const lines = text.split('\n');
    CALL.lastIndex = 0;
    for (let m = CALL.exec(text); m; m = CALL.exec(text)) {
      if (/function\s+$/.test(text.slice(Math.max(0, m.index - 12), m.index))) continue;
      const line = text.slice(0, m.index).split('\n').length;
      if (/^\s*(\/\/|\*|\/\*)/.test(lines[line - 1])) continue;
      const window = text.slice(m.index, m.index + 900);
      const sources = [...window.matchAll(/source:\s*(?:'([^']+)'|`([^`]+)`|([A-Za-z_][\w.]*))/g)].slice(0, 3)
        .map((x) => x[1] ?? x[2] ?? `<${x[3]}>`);
      sites.push({ file: path.relative(ROOT, f), fn: m[1] ?? 'startSession', line, sources });
    }
  }
  return sites;
}

/**
 * Every file that puts a line into a session, with how many calls it makes. A new file or a new
 * call fails this test: say here who the sender is, and make sure the line is framed for anyone
 * but a person (send-frame.ts), then update the count. The comment names the sender.
 */
const CALL_SITES: Record<string, number> = {
  // A person typed the words (the console, the phone, the terminal, a letter answer, a button)
  'src/commands/direct-commands.ts': 1,            // `walnut start` typed at a terminal
  'src/providers/daemon-connection.ts': 1,         // the phone's message relayed by the companion
  'src/web/routes/quick-input-v1.ts': 3,           // the launcher; a session calling it is `api-agent`
  'src/web/routes/session-chat.ts': 2,             // the console's composer
  'src/web/routes/session-send-v1.ts': 1,          // the phone; a session calling it is `api-agent`
  'src/web/routes/session-launch-v1.ts': 2,        // the phone's launch; a session calling it is `api-agent`
  'src/core/sessions/mobile-launch.ts': 2,         // the launch takes the route's source
  'src/web/routes/sessions.ts': 1,                 // quick-start; a session calling it is `api-agent`
  'src/core/sessions/quick-start.ts': 1,           // continues a conversation with the start's own source
  'src/core/sessions/session-lifecycle.ts': 1,     // "continue" pressed by a person
  'src/core/sessions/session-extras.ts': 1,        // "execute plan" pressed by a person
  'src/core/sessions/side-thread-manager.ts': 2,   // a side-thread question; the digest is Walnut's (framed)
  'src/core/sessions/engine-switch.ts': 3,         // re-sends a held row as stored (an agent's kept its frame)
  'src/core/sessions/engine-switch-resume.ts': 1,
  'src/core/sessions/engine-switch-watch.ts': 1,   // a pending switch whose wait ran out: walnut-notify
  'src/web/routes/chat-turn-relay.ts': 1,          // joins an existing lane; sends no first message
  'src/web/routes/conversations.ts': 1,
  'src/web/routes/personal-ai-v1.ts': 1,
  // Walnut, a task or a script sends: framed unless an envelope already frames the text
  'src/core/boards/board-delivery.ts': 1,          // a due reminder is `board-reminder`; a user's thread message is theirs
  'src/core/sessions/start-queue.ts': 3,           // a queued start run as `start-queue`, framed as the asking session's (the pass's, the user's Start now), and its failure told to the asker
  'src/core/hooks/actions.ts': 1,
  // The answer to a session's own approval request: one Walnut notice (walnut-notify).
  'src/core/approvals/tell-asker.ts': 1,
  'src/core/hosts/exec-grants.ts': 1,
  'src/core/human-inbox/letter-ops.ts': 2,         // the user's letter answer; a task's answer is framed
  'src/core/offline-handover.ts': 2,
  'src/core/org/lead-waits.ts': 1,
  'src/core/org/org-autostart.ts': 2,
  'src/core/org/org-store.ts': 2,
  'src/core/org/thread-recheck.ts': 1,
  'src/core/routines/executors/session.ts': 2,
  'src/core/routines/executors/watcher.ts': 3,
  'src/core/routines/run-start-deps.ts': 1,
  'src/core/routines/trigger-health.ts': 1,
  'src/core/session-auto-continue.ts': 1,
  // Walnut's idle compaction: the bare `/compact` command, passed unframed (send-frame.ts), as a quiet turn.
  'src/core/sessions/idle-compaction.ts': 1,
  // "Prompt is too long" recovery: its bare `/compact` (unframed, a quiet turn) and the resend note, both agents'.
  'src/core/sessions/context-full-recovery.ts': 1,
  'src/core/session-message-queue.ts': 1,          // the queue's own enqueue inside sendMessageToSession
  'src/core/sessions/adopt-notice.ts': 1,
  // A teammate's folded ask answered elsewhere: one Walnut note, source wait-until like needs-recheck.
  'src/core/sessions/ask-answer.ts': 1,
  'src/core/sessions/app-state.ts': 1,
  'src/core/sessions/auto-recover-env.ts': 1,
  'src/core/sessions/brief-refresh.ts': 1,
  'src/core/sessions/endpoint-wait.ts': 1,         // its one continue, as auto-continue
  'src/core/sessions/folder-gone.ts': 1,           // a new conversation's first line: a notice, then the rows that waited as stored
  'src/core/sessions/lane-turn.ts': 2,             // frames the first line for its source
  'src/core/sessions/letter-recheck.ts': 1,
  'src/core/sessions/machine-wake.ts': 1,
  'src/core/sessions/needs-recheck.ts': 1,
  'src/core/sessions/promise-alarm.ts': 1,
  'src/core/sessions/session-request-notify.ts': 4, // and the 10-minute silent-target notice (remindSilent)
  'src/core/sessions/session-send-core.ts': 5,
  'src/core/sessions/status-push.ts': 1,
  'src/core/sessions/subtask-notices.ts': 1,
  'src/core/sessions/task-session-claim.ts': 1,
  'src/core/sessions/task-start.ts': 3,            // frameStartText; a continued conversation (and a move off a lost host) passes the start's source
  // The one wake of a session that owes the user an answer: a Walnut envelope, source wait-until like needs-recheck.
  'src/core/sessions/usage-limit-wait.ts': 1,     // the continue at the usage limit's reset (auto-continue's source)
  'src/core/sessions/user-asks.ts': 1,
  'src/core/sessions/worker-question.ts': 1,       // a worker's question: its own session is the caller
  'src/core/status-consistency.ts': 1,
  // A low disk: one Walnut notice (walnut-notify) asking an open task to clear its own folder.
  'src/core/task-dir-size-notice.ts': 1,
  'src/core/pull-requests/pr-watch.ts': 1,       // pull request news: a Walnut envelope, source pr-watch
  'src/core/task-wait-until.ts': 1,
  'src/core/transfer/transfer.ts': 1,
  'src/core/workspaces/manager.ts': 2,
  // an ACP session's first line (framed by its start); a textless kick for rows a late init put back
  'src/providers/claude-code-session.ts': 2,
  'src/providers/subagent-runner.ts': 2,
  'src/web/routes/messages-v1.ts': 1,              // task_send: the caller session, or an automation, is the sender
  'src/web/routes/notifications.ts': 1,
  'src/web/routes/task-v1.ts': 1,                  // task_start: a caller session makes it a peer note
  'src/web/routes/triage-rules-v1.ts': 2,          // triage_route: an item a routing rule sends (or starts its task with), as `api-agent`
};

/**
 * The bus emits that start a session with a first message. `true`: the emitter says the text is
 * attributed (a person typed it, or its sender framed it). `false`: the runner frames it as Walnut's.
 * A new emitter is framed by default; list it here to say which it is.
 */
const START_EMITTERS: Record<string, boolean[]> = {
  'src/core/ai/ai-agent.ts': [false],              // ai.run: an automation's prompt
  'src/core/sessions/cloud-chat-lane.ts': [true],  // the companion's chat
  'src/core/sessions/lane-fork.ts': [false],       // created idle, no message
  'src/core/sessions/personal-ai-lane.ts': [true, true], // lane-turn.ts framed the first line for its source
  'src/core/sessions/quick-start.ts': [true],      // attributed when the source is a person's
  'src/core/sessions/session-controls.ts': [true], // attributed when the source is a person's
  'src/core/sessions/session-lifecycle.ts': [true], // the first message again, as stored
  'src/core/sessions/session-rewind.ts': [true],   // the earlier message again, as stored
  'src/core/sessions/side-thread-fork.ts': [true], // the person's side question
  'src/web/routes/session-chat.ts': [true],        // the console's composer
  'src/web/routes/sessions.ts': [true],            // the "execute plan" button
};

/** The sources a person passes. Pinned: a new one is a decision, not a side effect. */
const PERSON_SOURCES_PINNED = [
  'api-v1', 'chat', 'cli', 'cloud-fallback', 'cloud-exec-launch', 'human-inbox', 'mobile', 'mobile-launch',
  'mobile-launch-bridge', 'quick-input', 'quick-start', 'side-thread', 'ui', 'web-api',
];

/**
 * What each source found in the code is, written out here and not read from the code under test: a
 * source missing from this table fails until someone says who it is.
 */
const SOURCE_SENDER: Record<string, 'person' | 'agent'> = {
  ...Object.fromEntries(PERSON_SOURCES_PINNED.map((s) => [s, 'person' as const])),
  peer: 'agent', 'walnut-notify': 'agent', transfer: 'agent', 'engine-switch': 'agent',
  'routine-trigger': 'agent', 'routine-watcher': 'agent', 'brief-refresh': 'agent', 'side-thread-digest': 'agent',
  'app-state': 'agent', subagent: 'agent', 'notification-fix': 'agent', 'session-start': 'agent',
  'api-agent': 'agent', 'board-reminder': 'agent', 'auto-continue': 'agent', 'hook:abc': 'agent',
  'brand-new-source': 'agent', 'idle-compact': 'agent', 'context-compact': 'agent', 'context-recovery': 'agent', 'pr-watch': 'agent',
  // Bus tags of emits that are attributed on their own (START_EMITTERS), not send sources a person types into.
  'web-ui': 'agent', 'subagent-runner': 'agent',
};

/** Files allowed to pass a person source to a send or a start. */
const PERSON_SOURCE_FILES = new Set([
  'src/commands/direct-commands.ts', 'src/providers/daemon-connection.ts', 'src/web/routes/quick-input-v1.ts',
  'src/web/routes/session-chat.ts', 'src/web/routes/session-send-v1.ts', 'src/web/routes/sessions.ts',
  'src/core/sessions/session-lifecycle.ts', 'src/core/sessions/session-extras.ts',
  'src/core/sessions/side-thread-manager.ts', 'src/core/sessions/engine-switch.ts',
  'src/core/human-inbox/letter-ops.ts', 'src/web/routes/task-v1.ts', 'src/web/routes/cloud-chat-fallback.ts',
  'src/core/human-inbox/item-plans.ts', 'src/core/human-inbox/item-execution.ts',
]);

describe('who counts as a person', () => {
  it('the person sources are exactly the pinned ones', () => {
    const all = new Set<string>([...PERSON_SEND_SOURCES, ...PERSON_START_SOURCES, 'human-inbox', 'side-thread', 'cloud-fallback']);
    expect([...all].sort()).toEqual([...PERSON_SOURCES_PINNED].sort());
    for (const s of PERSON_SOURCES_PINNED) expect(isPersonSource(s)).toBe(true);
  });

  it('a task, a trigger, a routine, a notice or an unlisted source is never one', () => {
    for (const s of ['peer', 'walnut-notify', 'routine-trigger', 'routine-watcher', 'auto-continue', 'hook:abc', 'api-agent', 'transfer',
      'engine-switch', 'subagent', 'notification-fix', 'app-state', 'something-new', '', undefined]) {
      expect(isPersonSource(s as string | undefined)).toBe(false);
    }
    expect(queueSentBy('peer')).toBe('agent');
  });
});

describe('every way a line reaches a session', () => {
  const sites = callSites();

  it('each file that makes such a call is listed with its number of calls', () => {
    const counts: Record<string, number> = {};
    for (const s of sites) counts[s.file] = (counts[s.file] ?? 0) + 1;
    expect(counts).toEqual(CALL_SITES);
  });

  it('only the files that carry a person\'s words pass a person source', () => {
    const offenders = sites.filter((s) => s.sources.some((x) => PERSON_SOURCES_PINNED.includes(x)) && !PERSON_SOURCE_FILES.has(s.file));
    expect(offenders.map((s) => `${s.file}:${s.line} source ${s.sources.join('|')}`)).toEqual([]);
  });

  it('a raw enqueue outside the queue\'s own send frames its text', () => {
    for (const s of sites.filter((x) => x.fn === 'enqueueMessage' && x.file !== 'src/core/session-message-queue.ts')) {
      const text = fs.readFileSync(path.join(ROOT, s.file), 'utf8');
      // The ACP first line is framed by the start that made it (task-start.ts, quick-start.ts).
      if (s.file === 'src/providers/claude-code-session.ts') continue;
      expect(text, `${s.file} enqueues raw text`).toMatch(/frameForSource\(/);
    }
  });

  it('the paths that start a task frame its first line', () => {
    const read = (f: string) => fs.readFileSync(path.join(SRC, f), 'utf8');
    expect(read('core/sessions/task-start.ts')).toMatch(/frameStartText\(/);
    expect(read('core/session-message-queue.ts')).toMatch(/frameForSource\(rawBody, opts\?\.source\)/);
    // Both ways the runner starts a session pass the net, the bus event and the direct start.
    const runner = read('providers/claude-code-session.ts');
    expect(runner.match(/frameStartData\(/g)).toHaveLength(2);
    expect(read('core/sessions/lane-turn.ts')).toMatch(/frameForSource\(message, opts\.source\)/);
  });

  it('every bus emit that starts a session says whether its first message is attributed', () => {
    const found: Record<string, boolean[]> = {};
    for (const f of walk(SRC)) {
      const text = fs.readFileSync(f, 'utf8');
      for (let i = text.indexOf('EventNames.SESSION_START, {'); i >= 0; i = text.indexOf('EventNames.SESSION_START, {', i + 1)) {
        const block = text.slice(i, text.indexOf('}, [', i));
        (found[path.relative(ROOT, f)] ??= []).push(block.includes('attributed'));
      }
    }
    expect(found).toEqual(START_EMITTERS);
  });

  it('every send made for Walnut itself names its sender', () => {
    // A send with no caller session reads as the human's own CLI (session-send-core.ts), so a caller
    // inside Walnut that is not a person says so with `source`, and a transport passes the caller it stamped.
    for (const s of sites.filter((x) => x.fn === 'performSessionSend')) {
      const text = fs.readFileSync(path.join(ROOT, s.file), 'utf8');
      const at = text.split('\n').slice(s.line - 1, s.line + 32).join('\n');
      expect(at, `${s.file}:${s.line} sends without a sender`).toMatch(/callerSid|source/);
    }
  });

  it('a route a person uses reports `api-agent` when a session made the request', () => {
    for (const f of ['web/routes/session-send-v1.ts', 'web/routes/quick-input-v1.ts', 'web/routes/sessions.ts', 'web/routes/session-launch-v1.ts']) {
      expect(fs.readFileSync(path.join(SRC, f), 'utf8'), f).toMatch(/routeSource\(/);
    }
  });
});

describe('through the real queue', () => {
  beforeEach(async () => {
    await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
    await fsp.mkdir(WALNUT_HOME, { recursive: true });
    resetCache();
  });
  afterEach(async () => {
    await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {});
  });

  // Every `source:` literal the code passes to a send, plus the dynamic ones named by constants.
  const literals = [...new Set(callSites().flatMap((s) => s.sources).filter((x) => !x.startsWith('<') && !x.includes('${')))];

  it('every source found in the code is classified here', () => {
    expect(literals.filter((x) => !(x in SOURCE_SENDER)), 'a source the guard does not know: add it to SOURCE_SENDER').toEqual([]);
    expect(literals).toEqual(expect.arrayContaining(['ui', 'mobile', 'peer', 'walnut-notify', 'routine-trigger', 'transfer']));
  });

  it.each(Object.keys(SOURCE_SENDER))('a line sent as "%s" is stored as the sender the table says', async (source) => {
    const sid = `sess-${source.replace(/[^a-z]/g, '')}`;
    const row = await sendMessageToSession(sid, 'Sam said yes, deploy it now.', { source });
    const stored = (await getQueue(sid)).find((m) => m.id === row.id)!;
    expect(transcriptSentBy({ role: 'user', text: stored.message }), source).toBe(SOURCE_SENDER[source]);
    // The words always survive the frame.
    expect(stored.message).toContain('Sam said yes, deploy it now.');
  });

  it('a start from a session, a script or the console lands as the right sender', () => {
    const caller = { claudeSessionId: 'aaaaaaaa-1111-2222-3333-444444444444', title: 'Lead', taskId: 't1', host: 'local' };
    expect(transcriptSentBy({ role: 'user', text: frameStartText('first', { source: 'ui', callerSid: caller.claudeSessionId, caller }) })).toBe('agent');
    expect(transcriptSentBy({ role: 'user', text: frameStartText('first', { source: 'api-agent' }) })).toBe('agent');
    expect(transcriptSentBy({ role: 'user', text: frameStartText('first', { source: 'ui' }) })).toBe('person');
  });
});
