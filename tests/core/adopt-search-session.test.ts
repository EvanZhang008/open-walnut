/**
 * "Open as session" on the ✦ AI search card = ADOPT the session the search ran
 * in (core/sessions/adopt-search-session.ts).
 *
 * The behaviour under test is a promise to the user: pressing that button hands
 * them the conversation that already has the answer, not a second agent redoing
 * the search. That makes three things load-bearing, and each has a test here:
 * the record must be resumable (right cwd, transcript present), it must wake up
 * as the Personal AI (profile on the RECORD — a resume builds its argv from
 * there), and pressing twice must reopen ONE conversation.
 *
 * Real task store, real session DB, real transcript file on disk. Only the model
 * side is absent — the search run is seeded, exactly as a finished search would
 * have recorded it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createMockConstants } from '../helpers/mock-constants.js';

const { aiDisabledRef } = vi.hoisted(() => ({ aiDisabledRef: { value: true } }));

vi.mock('../../src/constants.js', () => createMockConstants('walnut-adopt-search'));
// backgroundAiDisabled() is unconditionally true under vitest; the tests that
// exercise "start the search myself" need a controllable gate (same importOriginal
// pattern as tests/core/task-search-agent.test.ts).
vi.mock('../../src/core/cheap-model.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/cheap-model.js')>()),
  backgroundAiDisabled: () => aiDisabledRef.value,
}));

import {
  adoptAgentSearchSession,
  searchAskTitle,
  AdoptSearchSessionError,
} from '../../src/core/sessions/adopt-search-session.js';
import {
  runTaskSearchAgent,
  _seedAgentSearchRunForTesting,
  _setAgentSearchEngineForTesting,
  _resetAgentSearchStateForTesting,
  type AgentSearchEngine,
} from '../../src/core/task-search-agent.js';
import {
  getSessionByClaudeId,
  updateSessionRecord,
  _resetSessionTrackerForTesting,
} from '../../src/core/session-tracker.js';
import {
  getTask,
  queryTasks,
  updateTask,
  deleteTasksByIds,
  _resetForTesting as _resetTaskManager,
} from '../../src/core/task-manager.js';
import { existsSync } from 'node:fs';
import { closeDb as closeSessionDb } from '../../src/core/session-db.js';
import { closeDb as closeTaskDb } from '../../src/core/task-db.js';
import { canonicalJsonlPath } from '../../src/core/session-file-reader.js';
import { bus, EventNames } from '../../src/core/event-bus.js';
import { WALNUT_HOME } from '../../src/constants.js';

const QUERY = 'quokka rollout rollback plan';

/** Transcript dirs live under the REAL ~/.claude (CLAUDE_HOME is homedir-based,
 *  and canonicalJsonlPath has no seam), so every test invents its own cwd — the
 *  encoded directory is then unique to this run and removed afterwards. */
const created: string[] = [];

function freshCwd(): string {
  return `/tmp/walnut-adopt-test-${randomUUID()}`;
}

/** Write a transcript where the CLI would have written it. */
async function writeTranscript(sessionId: string, cwd: string, body?: string): Promise<string> {
  const file = canonicalJsonlPath(sessionId, cwd);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  created.push(path.dirname(file));
  await fsp.writeFile(file, body ?? [
    JSON.stringify({ type: 'user', message: { role: 'user', content: `Find the Walnut task matching this search:\n"""${QUERY}"""` }, sessionId, cwd }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '{"results":[]}' }] }, sessionId, cwd }),
  ].join('\n') + '\n', 'utf-8');
  return file;
}

async function rmWalnutHome(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    try { await fsp.rm(WALNUT_HOME, { recursive: true, force: true }); return; }
    catch { await new Promise((r) => setTimeout(r, 50)); }
  }
}

async function resetAll(): Promise<void> {
  closeSessionDb();
  closeTaskDb();
  _resetSessionTrackerForTesting();
  _resetTaskManager();
  _resetAgentSearchStateForTesting();
  await rmWalnutHome();
}

beforeEach(async () => {
  aiDisabledRef.value = true;
  await resetAll();
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  bus.clear();
  await resetAll();
  // Both ends of the migration: the scratch dirs each test invented, and the
  // project dir the adopted transcript is MOVED into (encoded from this run's
  // temp WALNUT_HOME, so unique to it — but it lives under the real ~/.claude).
  created.push(path.dirname(canonicalJsonlPath('probe', WALNUT_HOME)));
  for (const dir of created.splice(0)) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

describe('adoptAgentSearchSession', () => {
  it('adopts the search\'s own session as an Ask Walnut task, resumable and Personal-AI-capable', async () => {
    const sessionId = randomUUID();
    const cwd = freshCwd();
    await writeTranscript(sessionId, cwd);
    _seedAgentSearchRunForTesting(QUERY, { sessionId, cwd, model: 'sonnet' });

    // Subscribed under 'web-ui', the destination the browser listens on: an emit
    // that reached only a global subscriber would not seat the board row (the
    // external importer's coarse nudge routes nowhere and is invisible).
    const emitted: Array<Record<string, unknown>> = [];
    bus.subscribe('web-ui', (event) => {
      if (event.name === EventNames.TASK_CREATED) emitted.push(event.data as Record<string, unknown>);
    });

    const adopted = await adoptAgentSearchSession(QUERY);
    expect(adopted).toMatchObject({ sessionId, reused: false });

    // The ask, as the board and the drawer expect it.
    const task = await getTask(adopted.taskId);
    expect(task.project).toBe('Ask Walnut');
    expect(task.walnut_agent).toBe(true);
    expect(task.pinned).toBe(true);
    expect(task.focus_tier).toBe('focus');
    // LABELLED, not bare: a row reading just "quokka rollout rollback plan" is
    // indistinguishable from a todo the user typed (user report, 2026-09-17).
    expect(task.title).toBe(`Search query: ${QUERY}`);
    // 1-session-per-task: the adopted session is in the SLOT, not just history.
    expect(task.session_id).toBe(sessionId);

    const record = await getSessionByClaudeId(sessionId);
    // RESUMABILITY, the whole point: the record's cwd and the transcript's
    // directory must agree, because `--resume` is strictly cwd-scoped. The
    // transcript is moved out of the micro-Claude scratch cwd into WALNUT_HOME
    // (where every other ask lives, and out of reach of Claude Code's retention
    // sweep of temp dirs), so the record must name the destination.
    expect(record?.cwd).toBe(WALNUT_HOME);
    expect(existsSync(canonicalJsonlPath(sessionId, WALNUT_HOME))).toBe(true);
    expect(existsSync(canonicalJsonlPath(sessionId, cwd))).toBe(false);
    expect(record?.taskId).toBe(adopted.taskId);
    expect(record?.engine).toBe('claude');
    expect(record?.provider).toBe('cli');
    expect(record?.process_status).toBe('stopped');
    // A stopped record with no reason reads as "unknown" and stays a rescuable
    // record for a day, burning the health monitor's probe budget on a session no
    // daemon ever knew. This conversation ENDED.
    expect(record?.status_reason).toBe('normal_completion');
    // Local sessions store NO host (the sentinel is in-memory only).
    expect(record?.host).toBeUndefined();
    // The session header wears the same label as the board row…
    expect(record?.title).toBe(`Search query: ${QUERY}`);
    // …while the note is a sentence, so it quotes the search words alone.
    expect(record?.human_note).toBe(`Adopted from the ✦ AI search for "${QUERY}".`);
    // The profile has to be on the RECORD: a cold resume builds its argv from
    // the record, so without this the follow-up wakes up as a bare coding agent
    // in a temp directory, unable to search anything.
    expect(record?.profile?.systemPrompt).toBeTruthy();
    expect(record?.effort).toBeTruthy();
    // …and so does the permission mode, for the same argv reason but with the
    // opposite default: a fresh spawn with no mode starts in bypass, a RESUME
    // with no mode on the record falls back to 'default' and asks Allow/Deny for
    // every tool — including the search tool this very session had just used
    // unattended (user report, 2026-09-17).
    expect(record?.mode).toBe('bypass');

    // The board hears about it — nothing else on this path emits for the UI.
    // The task in the event must ALREADY carry the slot, or the row lands
    // sessionless and the user sees a plain todo where their conversation is.
    expect(emitted).toHaveLength(1);
    expect((emitted[0]?.task as { session_id?: string })?.session_id).toBe(sessionId);
  });

  it('a second press reopens the SAME conversation instead of forking it', async () => {
    const sessionId = randomUUID();
    const cwd = freshCwd();
    await writeTranscript(sessionId, cwd);
    _seedAgentSearchRunForTesting(QUERY, { sessionId, cwd, model: 'sonnet' });

    const first = await adoptAgentSearchSession(QUERY);
    const second = await adoptAgentSearchSession(QUERY);
    expect(second).toEqual({ sessionId, taskId: first.taskId, reused: true });
    expect(await queryTasks({ projects: ['Ask Walnut'] })).toHaveLength(1);
  });

  it('two presses at once still leave ONE task (the loser adopts the winner\'s session)', async () => {
    const sessionId = randomUUID();
    const cwd = freshCwd();
    await writeTranscript(sessionId, cwd);
    _seedAgentSearchRunForTesting(QUERY, { sessionId, cwd, model: 'sonnet' });

    const [a, b] = await Promise.all([
      adoptAgentSearchSession(QUERY),
      adoptAgentSearchSession(QUERY),
    ]);
    expect(a.sessionId).toBe(sessionId);
    expect(b.taskId).toBe(a.taskId);
    // The rollback matters: a lost race must not leave an empty orphan task.
    expect(await queryTasks({ projects: ['Ask Walnut'] })).toHaveLength(1);
  });

  it('says there is nothing to reopen when no search ran for this query', async () => {
    await expect(adoptAgentSearchSession('nothing ever searched this')).rejects.toMatchObject({
      code: 'no_session', statusCode: 404,
    });
  });

  it('with no run at all it tries to search, and a disabled lane answers PROMPTLY', async () => {
    // Pressing the button before the card's ~1s debounce has fired means nothing
    // has run yet; adoption starts the search itself rather than sending the user
    // into a fresh agent (that hole is what made the feature look broken).
    //
    // Here the lane is disabled (every test process is), which is the branch that
    // must not turn "start it myself" into an 85-second wait on a search that can
    // never happen: it has to fall through to no_session fast, so the caller can
    // launch a session while the click still feels like a click.
    const t0 = Date.now();
    await expect(adoptAgentSearchSession('another query nobody has searched')).rejects.toMatchObject({
      code: 'no_session',
    });
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it('refuses a run whose transcript is gone, rather than minting a dead session', async () => {
    // The failure this guards: `--resume` on a transcript the CLI cannot find
    // answers "No conversation found", and Walnut ARCHIVES the session for it.
    // Better to report "nothing to reopen" and let the caller start a real one.
    _seedAgentSearchRunForTesting(QUERY, { sessionId: randomUUID(), cwd: freshCwd(), model: 'sonnet' });
    await expect(adoptAgentSearchSession(QUERY)).rejects.toMatchObject({ code: 'no_transcript' });
    expect(await queryTasks({ projects: ['Ask Walnut'] })).toHaveLength(0);
  });

  it('rejects a query too short to have been searched', async () => {
    await expect(adoptAgentSearchSession('ab')).rejects.toBeInstanceOf(AdoptSearchSessionError);
    await expect(adoptAgentSearchSession('ab')).rejects.toMatchObject({ code: 'bad_query', statusCode: 400 });
  });

  it('matches the query the way the search cache does (case and spacing)', async () => {
    const sessionId = randomUUID();
    const cwd = freshCwd();
    await writeTranscript(sessionId, cwd);
    _seedAgentSearchRunForTesting(QUERY, { sessionId, cwd, model: 'sonnet' });
    // The user retypes with different spacing/case; it is the same search, so it
    // must reopen the same session rather than start a fresh one.
    const adopted = await adoptAgentSearchSession(`  Quokka   Rollout Rollback Plan `);
    expect(adopted.sessionId).toBe(sessionId);
  });

  it('with nothing searched yet it RUNS the search and adopts that run\'s session', async () => {
    // The window that made the feature look broken: the card's lane debounces
    // ~1s, so a fast click arrives before any search exists. Answering "nothing
    // to reopen" there sent the user into a fresh agent redoing the work.
    aiDisabledRef.value = false;
    const sessionId = randomUUID();
    const cwd = freshCwd();
    await writeTranscript(sessionId, cwd);
    let engineCalls = 0;
    const engine: AgentSearchEngine = async () => {
      engineCalls++;
      return { response: JSON.stringify({ results: [] }), sessionId, cwd, model: 'sonnet' };
    };
    _setAgentSearchEngineForTesting(engine);

    const adopted = await adoptAgentSearchSession(QUERY, { startIfMissing: true });
    expect(engineCalls).toBe(1);
    expect(adopted).toMatchObject({ sessionId, reused: false });
    expect((await getSessionByClaudeId(sessionId))?.taskId).toBe(adopted.taskId);
  });

  it('JOINS a search already in flight instead of running a second one', async () => {
    aiDisabledRef.value = false;
    const sessionId = randomUUID();
    const cwd = freshCwd();
    await writeTranscript(sessionId, cwd);
    let engineCalls = 0;
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const engine: AgentSearchEngine = async () => {
      engineCalls++;
      await held;
      return { response: JSON.stringify({ results: [] }), sessionId, cwd, model: 'sonnet' };
    };
    _setAgentSearchEngineForTesting(engine);

    // The lane's own request, still running when the button is pressed.
    const lane = runTaskSearchAgent(QUERY, { engine });
    await new Promise((r) => setTimeout(r, 20));
    const adopting = adoptAgentSearchSession(QUERY, { startIfMissing: true });
    await new Promise((r) => setTimeout(r, 20));
    release!();
    const adopted = await adopting;
    await lane;
    // ONE child for both, and the adopted session is the one the lane ran in —
    // a second search would have cost a second model run and a second session.
    expect(engineCalls).toBe(1);
    expect(adopted.sessionId).toBe(sessionId);
  });

  it('never starts a search when the caller says not to (the AI lane is switched off)', async () => {
    aiDisabledRef.value = false;
    let engineCalls = 0;
    _setAgentSearchEngineForTesting(async () => {
      engineCalls++;
      return { response: '{"results":[]}' };
    });
    // The lane being off is the user's own token/privacy choice; a click must
    // degrade to launching a session, never spend a model run behind that choice.
    await expect(adoptAgentSearchSession(QUERY)).rejects.toMatchObject({ code: 'no_session' });
    expect(engineCalls).toBe(0);
  });

  it('re-links a session whose ask the user deleted, instead of failing', async () => {
    // deleteTask clears the session row's task_id and leaves the row. The second
    // press used to read "already tracked" from importSessionRecord, find no
    // owner to hand back, and answer 500 — with no way back to the conversation.
    const sessionId = randomUUID();
    const cwd = freshCwd();
    await writeTranscript(sessionId, cwd);
    _seedAgentSearchRunForTesting(QUERY, { sessionId, cwd, model: 'sonnet' });
    const first = await adoptAgentSearchSession(QUERY);
    // force, because a task holding a session refuses a plain delete — this is
    // the real gesture (DELETE /api/tasks/:id?force=true, and the multi-select
    // delete), which stops the session, clears the slot and leaves the row.
    const removed = await deleteTasksByIds([first.taskId], { force: true });
    expect(removed.failed, JSON.stringify(removed.failed)).toHaveLength(0);
    expect((await getSessionByClaudeId(sessionId))?.taskId).toBeFalsy();

    const second = await adoptAgentSearchSession(QUERY);
    expect(second.taskId).not.toBe(first.taskId);
    expect(second.sessionId).toBe(sessionId);
    const record = await getSessionByClaudeId(sessionId);
    expect(record?.taskId).toBe(second.taskId);
    expect((await getTask(second.taskId)).session_id).toBe(sessionId);
    // The re-link writes the same argv fields the import does — a conversation
    // recovered this way must not start asking permission either.
    expect(record?.mode).toBe('bypass');
    expect(record?.profile?.systemPrompt).toBeTruthy();
  });

  it('heals an ask adopted before the mode was recorded, so it stops asking Allow/Deny', async () => {
    // Every ask adopted before 2026-09-18 carries mode 'default' (what
    // importSessionRecord wrote unconditionally), and a resume reads exactly
    // that: the user's existing search asks would keep prompting forever. The
    // conversations a reuse path hands back get the mode on the way out.
    const sessionId = randomUUID();
    const cwd = freshCwd();
    await writeTranscript(sessionId, cwd);
    _seedAgentSearchRunForTesting(QUERY, { sessionId, cwd, model: 'sonnet' });
    const first = await adoptAgentSearchSession(QUERY);
    // Exactly what a pre-fix row looks like.
    await updateSessionRecord(sessionId, { mode: 'default' });

    const second = await adoptAgentSearchSession(QUERY);
    expect(second).toEqual({ sessionId, taskId: first.taskId, reused: true });
    expect((await getSessionByClaudeId(sessionId))?.mode).toBe('bypass');

    // And the OTHER reuse path — the run has aged out, so the ask is found by
    // title rather than by the live run.
    await updateSessionRecord(sessionId, { mode: 'default' });
    _seedAgentSearchRunForTesting(QUERY, { sessionId, cwd, model: 'sonnet', at: Date.now() - 3 * 60 * 60_000 });
    const third = await adoptAgentSearchSession(QUERY);
    expect(third).toEqual({ sessionId, taskId: first.taskId, reused: true });
    expect((await getSessionByClaudeId(sessionId))?.mode).toBe('bypass');
  });

  it('refuses to hand back an ARCHIVED conversation', async () => {
    // A resume that cannot find the transcript archives the session. Reopening
    // that is handing the user a dead panel; report nothing-to-reopen instead.
    const sessionId = randomUUID();
    const cwd = freshCwd();
    await writeTranscript(sessionId, cwd);
    _seedAgentSearchRunForTesting(QUERY, { sessionId, cwd, model: 'sonnet' });
    await adoptAgentSearchSession(QUERY);
    await updateSessionRecord(sessionId, { archived: true });

    await expect(adoptAgentSearchSession(QUERY)).rejects.toMatchObject({ code: 'no_session' });
  });

  it('finds the ask it already created once the search run has aged out', async () => {
    // Three hours later the run is gone from memory (2h TTL). Without this the
    // same question searches again and forks a second, identically titled ask —
    // the user's complaint, just delayed.
    const sessionId = randomUUID();
    const cwd = freshCwd();
    await writeTranscript(sessionId, cwd);
    _seedAgentSearchRunForTesting(QUERY, { sessionId, cwd, model: 'sonnet' });
    const first = await adoptAgentSearchSession(QUERY);

    _seedAgentSearchRunForTesting(QUERY, { sessionId, cwd, model: 'sonnet', at: Date.now() - 3 * 60 * 60_000 });
    aiDisabledRef.value = false;
    let engineCalls = 0;
    _setAgentSearchEngineForTesting(async () => {
      engineCalls++;
      return { response: '{"results":[]}' };
    });
    const again = await adoptAgentSearchSession(QUERY, { startIfMissing: true });
    expect(again).toEqual({ sessionId, taskId: first.taskId, reused: true });
    expect(engineCalls, 'the earlier ask makes a fresh search unnecessary').toBe(0);
    expect(await queryTasks({ projects: ['Ask Walnut'] })).toHaveLength(1);
  });

  it('titles a long search with an ellipsis instead of a wall of text', async () => {
    const long = `${'zebra '.repeat(30)}end`;
    const sessionId = randomUUID();
    const cwd = freshCwd();
    await writeTranscript(sessionId, cwd);
    _seedAgentSearchRunForTesting(long, { sessionId, cwd, model: 'sonnet' });
    const adopted = await adoptAgentSearchSession(long);
    const task = await getTask(adopted.taskId);
    expect(task.title.length).toBeLessThanOrEqual(80);
    expect(task.title.endsWith('…')).toBe(true);
    // The QUERY is what gets clipped. A clipped label ("Search que…") would stop
    // saying what the row is, which is the whole reason the label exists.
    expect(task.title.startsWith('Search query: ')).toBe(true);
  });

  it('finds an ask created BEFORE the label existed, instead of forking a second one', async () => {
    // Asks minted before 2026-09-17 wear the bare query as their title, and the
    // dedup lookup matches by title. Without the legacy candidate, the first
    // press after the label landed searches again and forks a duplicate ask for a
    // conversation the user already has.
    const sessionId = randomUUID();
    const cwd = freshCwd();
    await writeTranscript(sessionId, cwd);
    _seedAgentSearchRunForTesting(QUERY, { sessionId, cwd, model: 'sonnet' });
    const first = await adoptAgentSearchSession(QUERY);
    // Exactly what an old row looks like: same tag, same project, bare title.
    await updateTask(first.taskId, { title: QUERY });

    // Three hours on, the run has left the in-memory map, so the lookup is the
    // only thing that can find this conversation.
    _seedAgentSearchRunForTesting(QUERY, { sessionId, cwd, model: 'sonnet', at: Date.now() - 3 * 60 * 60_000 });
    aiDisabledRef.value = false;
    let engineCalls = 0;
    _setAgentSearchEngineForTesting(async () => {
      engineCalls++;
      return { response: '{"results":[]}' };
    });
    const again = await adoptAgentSearchSession(QUERY, { startIfMissing: true });
    expect(again).toEqual({ sessionId, taskId: first.taskId, reused: true });
    expect(engineCalls, 'the legacy ask makes a fresh search unnecessary').toBe(0);
    expect(await queryTasks({ projects: ['Ask Walnut'] })).toHaveLength(1);
    // Found, not renamed: the row is the user's now, and a title they may have
    // edited themselves is not ours to rewrite.
    expect((await getTask(first.taskId)).title).toBe(QUERY);
  });
});

describe('searchAskTitle', () => {
  it('labels the query and keeps it verbatim', () => {
    expect(searchAskTitle('aihub cos')).toBe('Search query: aihub cos');
  });

  it('flattens what the user typed onto one line', () => {
    expect(searchAskTitle('  aihub \n\t cos  ')).toBe('Search query: aihub cos');
  });

  it('spends the 80-char budget on the query, never on the label', () => {
    const title = searchAskTitle('zebra '.repeat(40));
    expect(title.length).toBeLessThanOrEqual(80);
    expect(title.startsWith('Search query: ')).toBe(true);
    expect(title.endsWith('…')).toBe(true);
  });

  it('never cuts an emoji in half at the boundary', () => {
    // A lone surrogate goes through JSON.stringify into tasks.json and then
    // breaks whoever decodes the file — one bad title, a whole store unreadable.
    for (let pad = 60; pad <= 70; pad++) {
      const title = searchAskTitle('a'.repeat(pad) + '\u{1F600}b');
      expect(title).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
      expect(title).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
      expect(title.length).toBeLessThanOrEqual(80);
    }
  });
});
