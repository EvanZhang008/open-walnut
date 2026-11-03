/**
 * The outline's sections end to end (src/core/sessions/turn-titles.ts): a long
 * session's main-conversation messages get one short AI title each, written on
 * the session record and served by GET /api/sessions/:id, from the client's ask
 * and from a turn end; a question's row, an injected row and a short session get
 * none; a session the AI cannot serve is answered `unavailable`.
 *
 * Real: Express server, routes, session store, transcript parse, the titler and
 * its queue, the thread AI stub channel (the same deterministic stand-in the
 * browser suite uses). Mocked: constants (temp dirs) and the local daemon reader
 * (serves the mocked CLAUDE_HOME from the real fs).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Server as HttpServer } from 'node:http';
import { createMockConstants } from '../helpers/mock-constants.js';
import { mockLocalDaemonReader } from '../helpers/mock-local-daemon-reader.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-e2e-turn-titles'));
vi.mock('../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader());

import { WALNUT_HOME, CLAUDE_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { encodeProjectPath } from '../../src/core/session-history.js';
import { createSessionRecord, updateSessionRecord } from '../../src/core/session-tracker.js';
import { bus, EventNames } from '../../src/core/event-bus.js';
import { threadAiCallCounts, THREAD_AI_STUB_ENV } from '../../src/core/sessions/thread-ai-stub.js';
import { __turnTitlesIdleForTesting } from '../../src/core/sessions/turn-titles.js';
import { TURN_TITLE_MIN_MESSAGES } from '../../src/core/sessions/turn-titles-text.js';

const CWD = '/Users/test/turn-titles-project';
const PREFIX = 'e2e-sections-';
const LONG = `${PREFIX}long-0001`;
const SHORT = `${PREFIX}short-0002`;
const OFF = 'plain-sections-0003';
const prevStub = process.env[THREAD_AI_STUB_ENV];

let server: HttpServer;
let port: number;
let seq = 0;

const TOPICS = [
  'Explain the cache eviction policy', 'Write tests for the parser', 'Rename the config loader',
  'Profile the slow history route', 'Fix the login redirect loop', 'Document the retry budget',
  'Split the session store file', 'Review the deploy script guard', 'Measure the startup time',
  'Remove the unused flag',
];

const user = (text: string, extra: Record<string, unknown> = {}) => ({
  type: 'user', uuid: `u-${++seq}`, timestamp: new Date(Date.UTC(2026, 10, 3, 9, seq)).toISOString(),
  message: { role: 'user', content: text }, ...extra,
});
const asst = (text: string) => ({
  type: 'assistant', uuid: `a-${++seq}`, timestamp: new Date(Date.UTC(2026, 10, 3, 9, seq, 30)).toISOString(),
  message: { role: 'assistant', id: `msg_${seq}`, content: [{ type: 'text', text }] },
});

async function writeJsonl(sessionId: string, lines: Array<Record<string, unknown>>): Promise<void> {
  const dir = path.join(CLAUDE_HOME, 'projects', encodeProjectPath(CWD));
  await fs.mkdir(dir, { recursive: true });
  const withParents = lines.map((l, i) => ({ ...l, sessionId, parentUuid: i === 0 ? null : lines[i - 1].uuid }));
  await fs.writeFile(path.join(dir, `${sessionId}.jsonl`), `${withParents.map((l) => JSON.stringify(l)).join('\n')}\n`);
}

function conversation(topics: readonly string[]): Array<Record<string, unknown>> {
  return topics.flatMap((t) => [user(t), asst(`Done: ${t.toLowerCase()}.`)]);
}

async function api(method: string, p: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`http://localhost:${port}${p}`, { method, headers: { 'content-type': 'application/json' }, body: method === 'GET' ? undefined : '{}' });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) { await new Promise((r) => setTimeout(r, 50)); await __turnTitlesIdleForTesting(); }
}

/** The stub's title for a message: its first three words, title-cased. */
const stubTitle = (text: string) => text.split(/\s+/).slice(0, 3).map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(' ');

let longLines: Array<Record<string, unknown>> = [];
let questionUuid = '';
let injectedUuid = '';

beforeAll(async () => {
  process.env[THREAD_AI_STUB_ENV] = PREFIX;
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  server = await startServer({ port: 0, dev: true });
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;

  longLines = conversation(TOPICS);
  // A question about a reply (a thread anchor's head) and a CLI-injected line:
  // neither is a section.
  const question = user('What does point two mean for the reader?');
  const injected = user('Base directory for this skill: /tmp/skill', { isMeta: true });
  questionUuid = question.uuid;
  injectedUuid = injected.uuid;
  longLines.splice(4, 0, question, asst('Point two means the reader waits.'), injected);
  await writeJsonl(LONG, longLines);
  await createSessionRecord(LONG, 'task-long', 'proj', CWD);
  await updateSessionRecord(LONG, {
    threadAnchors: [{ msgId: questionUuid, parent: String(longLines[1].uuid), source: 'selection', at: '2026-11-03T09:00:00.000Z' }],
  });

  await writeJsonl(SHORT, conversation(TOPICS.slice(0, TURN_TITLE_MIN_MESSAGES - 1)));
  await createSessionRecord(SHORT, 'task-short', 'proj', CWD);
  await writeJsonl(OFF, conversation(TOPICS));
  await createSessionRecord(OFF, 'task-off', 'proj', CWD);
}, 60_000);

afterAll(async () => {
  if (prevStub === undefined) delete process.env[THREAD_AI_STUB_ENV]; else process.env[THREAD_AI_STUB_ENV] = prevStub;
  await stopServer();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
});

describe('outline sections of a long session', () => {
  it('the client ask titles every main-conversation message in one model call, served on the record', async () => {
    const statusEvents: Array<{ sessionId?: string; turnTitles?: unknown[] }> = [];
    bus.subscribe('test-turn-titles', (e) => {
      if (e.name === EventNames.SESSION_STATUS_CHANGED) statusEvents.push(e.data as never);
    }, { global: true, interest: [EventNames.SESSION_STATUS_CHANGED] });

    const ask = await api('POST', `/api/sessions/${LONG}/turn-titles`);
    expect(ask.status).toBe(202);
    expect(ask.json).toEqual({ queued: true });
    await settle();

    const { json } = await api('GET', `/api/sessions/${LONG}`);
    const titles = (json.session ?? json).turnTitles as Array<{ msgId: string; title: string }>;
    expect(titles.map((t) => t.title)).toEqual(TOPICS.map(stubTitle));
    const ids = titles.map((t) => t.msgId);
    expect(ids).not.toContain(questionUuid);
    expect(ids).not.toContain(injectedUuid);
    // Keyed by the user row's msgId as /history serves it (what the client jumps to).
    const history = await api('GET', `/api/sessions/${LONG}/history`);
    const userIds = (history.json.messages as Array<{ role: string; msgId?: string; text: string }>)
      .filter((m) => m.role === 'user' && TOPICS.includes(m.text)).map((m) => m.msgId);
    expect(ids).toEqual(userIds);
    expect(threadAiCallCounts(LONG)).toEqual({ sections: 1 });
    // The open panel adopts the list from the status event.
    expect(statusEvents.some((e) => e.sessionId === LONG && Array.isArray(e.turnTitles) && e.turnTitles.length === TOPICS.length)).toBe(true);
    bus.unsubscribe('test-turn-titles');

    // Asked again with nothing new: no model call, nothing rewritten.
    await api('POST', `/api/sessions/${LONG}/turn-titles`);
    await settle();
    expect(threadAiCallCounts(LONG)).toEqual({ sections: 1 });
  });

  it('a turn end titles only the new messages, and never rewrites an old title', async () => {
    const before = ((await api('GET', `/api/sessions/${LONG}`)).json.session).turnTitles as Array<{ msgId: string; title: string; at: string }>;
    const more = conversation(['Tune the backoff curve', 'Ship the final patch']);
    longLines = [...longLines, ...more];
    await writeJsonl(LONG, longLines);
    // The panel reading history is what makes the server hold it parsed.
    await api('GET', `/api/sessions/${LONG}/history`);
    bus.emit(EventNames.SESSION_RESULT, { sessionId: LONG, result: 'ok' }, ['*']);
    await settle();
    const after = ((await api('GET', `/api/sessions/${LONG}`)).json.session).turnTitles as Array<{ msgId: string; title: string; at: string }>;
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.slice(before.length).map((t) => t.title)).toEqual(['Tune The Backoff', 'Ship The Final']);
    expect(threadAiCallCounts(LONG)).toEqual({ sections: 2 });
  });

  it('a short session gets no sections and costs no model call', async () => {
    const ask = await api('POST', `/api/sessions/${SHORT}/turn-titles`);
    expect(ask.json).toEqual({ queued: true });
    await settle();
    expect(((await api('GET', `/api/sessions/${SHORT}`)).json.session).turnTitles).toBeUndefined();
    expect(threadAiCallCounts(SHORT)).toEqual({});
  });

  it('a session the AI cannot serve is answered unavailable, and a missing one 404', async () => {
    const off = await api('POST', `/api/sessions/${OFF}/turn-titles`);
    expect(off.status).toBe(202);
    expect(off.json).toEqual({ queued: false, reason: 'unavailable' });
    bus.emit(EventNames.SESSION_RESULT, { sessionId: OFF, result: 'ok' }, ['*']);
    await settle();
    expect(((await api('GET', `/api/sessions/${OFF}`)).json.session).turnTitles).toBeUndefined();
    const missing = await api('POST', `/api/sessions/${PREFIX}missing/turn-titles`);
    expect(missing.status).toBe(404);
  });
});
