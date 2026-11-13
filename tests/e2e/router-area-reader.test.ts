// router-area-reader.ts on a real server (port 0, temp home); no model, daemon or network.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';
import { patchLegacyTask, seedLegacySession } from '../helpers/router-history-fixtures.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-router-area-reader'));
// The status check's own pass needs settled live sessions; its rows are fixed here so the route's filter is what is tested.
const statusRows = vi.hoisted(() => ({
  rows: [] as Array<{ kind: 'drift'; taskId: string; title: string; detail: string }>,
  during: undefined as undefined | (() => Promise<void>),
}));
vi.mock('../../src/core/status-consistency.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/status-consistency.js')>()),
  checkStatuses: async () => { await statusRows.during?.(); return statusRows.rows; },
}));

import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { addTask, getTask, updateTaskRaw } from '../../src/core/task-manager.js';
import { createSessionRecord, updateSessionRecord } from '../../src/core/session-tracker.js';
import { routerAreasPath, updateRouterAreas, type RouterAreaItem } from '../../src/core/router/areas.js';
import { registerRouterSource } from '../../src/core/router/source-registry.js';
import { registerMentionSource } from '../../src/core/mention-sources/registry.js';
import { mailDeliveryVersion, mailRouterKey } from '../../src/integrations/mail/router-source.js';
import { routerAreaProfile } from '../../src/core/router/session-policy.js';
import { disposeRouterStores } from '../../src/core/router/runtime.js';
import {
  AreaBadInput, areaCallerOf, areaTargetOf, judgeAreaRead, rowDenied, recheckAreaPayload, isMentionSearchPath, isAreaAggregatePath, buildAreaDenials, filterAreaPayload, isAreaListPath, scopeAllows, taskScopes, type AreaDenials,
} from '../../src/web/middleware/router-area-reader.js';
import { snapshotTask } from '../../src/web/routes/org-v1.js';
import { executeOp } from '../../src/ops/index.js';
import { routerRuleRevision } from '../../src/core/router/rules.js';
import { routingRulesPath, setRoutingRule } from '../../src/core/triage/routing-rules.js';
import type { Task } from '../../src/core/types.js';

const PRIVATE = 'PRIVATE_NOTE_CANARY';
const DROPPED = 'DROPPED_MARK_CANARY';
let base = '';
let personalId = '';
let workId = '';
let droppedId = '';
let ordinaryId = '';
const personalSid = randomUUID();
const droppedSid = randomUUID();
const ordinarySid = randomUUID();
const account = 'desk@marina.example.invalid';
const RFC = '<rota-1@marina.example.invalid>';
// The same RFC message under another message id, never written to the ledger.
const COPY = 'Archive:2:30';
const otherAccount = 'shelf@marina.example.invalid';
const PERSONAL_MESSAGE = 'INBOX:1:10';
/** The fixture cache's RFC id per message: the personal item and its copy share one. */
const rfcOf = (message: string) => (message === PERSONAL_MESSAGE || message === COPY ? RFC : '');
/** A cached delivery's version through the real helper; `generation` stands for a later delivery of one handle. */
const versionOf = (acc: string, message: string, generation = 1) =>
  mailDeliveryVersion(1_760_000_000_000, null, `bodies/fixture/${acc}/${message}/${generation}`, rfcOf(message));
/** The delivery the fixture cache holds now, per account and message (generation 1 unless a test moves it). */
const cacheGeneration = new Map<string, number>();
const cacheKeyOf = (acc: string, message: string) => `${acc}\u0000${message}`;
const currentVersion = (acc: string, message: string) => versionOf(acc, message, cacheGeneration.get(cacheKeyOf(acc, message)) ?? 1);
const PERSONAL_VERSION = versionOf(account, PERSONAL_MESSAGE);
const WORK_VERSION = versionOf(account, 'INBOX:1:20');
// Confirmed exact sources: each names the cached delivery it was confirmed at.
const personalMail = { kind: 'mail' as const, account, message: PERSONAL_MESSAGE, version: PERSONAL_VERSION };
const workMail = { kind: 'mail' as const, account, message: 'INBOX:1:20', version: WORK_VERSION };
const PERSONAL_KEY = mailRouterKey(account, personalMail.message, RFC);
const AUTOMATION = { automation: true } as const;
const mailPath = (acc: string, message: string) => `/api/plugins/mail/messages/${encodeURIComponent(acc)}/${encodeURIComponent(message)}`;

// Cache metadata only, as the mail adapter answers it: the current delivery's version, the exact key under
// it, and the RFC scope key (the copy shares the classified item's); read() must never run.
const resolve = vi.fn(async (source: { kind: 'mail'; account: string; message: string; version?: string }) => {
  const version = currentVersion(source.account, source.message);
  const rfc = rfcOf(source.message);
  return {
    source: { kind: source.kind, account: source.account, message: source.message, version },
    sender: 'pat@marina.example.invalid', subject: 'META_ONLY',
    key: mailRouterKey(source.account, source.message, '', version),
    scopeKey: rfc ? mailRouterKey(source.account, source.message, rfc) : mailRouterKey(source.account, source.message),
  };
});
const read = vi.fn(async () => { throw new Error('the guard must not read a body'); });
let stopSource = () => {};
const MENTION = 'MENTION_ROW_CANARY';
let mentionCalls = 0;
let mentionDuring: undefined | (() => Promise<void>);
let stopMention: { dispose(): void } = { dispose() {} };
const AGGREGATES = ['/api/v1/org', '/api/v1/org/reports', '/api/time/report'];
const mentionSearch = (id: string, q: string) => `/api/mention-sources/${encodeURIComponent(id)}/search?q=${encodeURIComponent(q)}`;

async function call(method: string, p: string, who?: string | typeof AUTOMATION, body?: unknown): Promise<Response> {
  const caller = typeof who === 'string' ? { 'x-walnut-caller-sid': who } : who ? { 'x-walnut-caller-kind': 'automation' } : {};
  return fetch(`${base}${p}`, {
    method,
    headers: { ...caller, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

async function mark(taskId: string, patch: Record<string, unknown>) {
  await updateTaskRaw(taskId, patch as Partial<Task>, { source: 'router-areas', emitEvent: false });
}

beforeAll(async () => {
  const server = await startServer({ port: 0, dev: true });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  personalId = (await addTask({ title: 'Personal desk', project: 'Garden' })).task.id;
  workId = (await addTask({ title: 'Work desk', project: 'Workshop' })).task.id;
  droppedId = (await addTask({ title: 'Lost mark', project: 'Garden' })).task.id;
  ordinaryId = (await addTask({ title: 'Ordinary chores', project: 'Pantry' })).task.id;
  await createSessionRecord(ordinarySid, ordinaryId, '', WALNUT_HOME, { mode: 'dontAsk' });
  await updateSessionRecord(ordinarySid, { process_status: 'stopped' });
  stopMention = registerMentionSource('test-canary', {
    id: 'canary-src', label: 'Canary', keyword: 'canarysrc', minChars: 0,
    search: async () => { mentionCalls += 1; await mentionDuring?.(); return [{ ref: 'r1', title: MENTION }]; },
    resolve: async () => null,
  });
});

/** Areas exist only from here on, so the first suite sees a stock home with ordinary tasks. */
let areasReady = false;
async function ensureAreas() {
  if (areasReady) return;
  areasReady = true;
  await updateRouterAreas(WALNUT_HOME, () => ({
    version: 1,
    areas: [
      { id: 'personal', name: 'Personal', host: '__local__', taskIds: [personalId], sources: [{ kind: 'mail', account }] },
      { id: 'work', name: 'Work', host: '__local__', taskIds: [workId], sources: [{ kind: 'mail', account }] },
    ],
    routers: [{ taskId: personalId, areaId: 'personal', paused: false }, { taskId: workId, areaId: 'work', paused: false }],
    // canonicalKey: the adapter key saved at classification (the field lands with the areas change).
    items: [{ source: personalMail, areaId: 'personal', canonicalKey: PERSONAL_KEY } as RouterAreaItem, { source: workMail, areaId: 'work' }],
  }));
  stopSource = registerRouterSource('mail', { resolve, read });
  await mark(personalId, { org_role: 'router', router_area_id: 'personal', router_paused: false, description: PRIVATE, note: PRIVATE });
  await mark(workId, { org_role: 'router', router_area_id: 'work', router_paused: false });
  // A task whose own mark is gone and that the registry no longer lists: only its session's profile says.
  await mark(droppedId, { description: DROPPED });
  await createSessionRecord(personalSid, personalId, '', WALNUT_HOME, { profile: routerAreaProfile('personal'), mode: 'dontAsk' });
  // Fault injection: a historical area profile remains after the task's mark was lost.
  await seedLegacySession(droppedSid, droppedId, '', WALNUT_HOME, { profile: routerAreaProfile('personal', 'work'), mode: 'dontAsk', initialProcessStatus: 'stopped' });
  await updateSessionRecord(personalSid, { process_status: 'stopped' });
}

afterAll(async () => {
  stopSource();
  stopMention.dispose();
  await disposeRouterStores();
  await stopServer();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('mention search on a stock home with no areas', () => {
  it('serves every caller as before', async () => {
    mentionCalls = 0;
    for (const [who, q] of [[ordinarySid, 'stock-sid'], [AUTOMATION, 'stock-automation'], [undefined, 'stock-person']] as const) {
      const response = await call('GET', mentionSearch('canary-src', q), who);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain(MENTION);
    }
    expect(mentionCalls).toBe(3);
    expect((await call('GET', `/api/v1/tasks/${ordinaryId}`, ordinarySid)).status).toBe(200);
    for (const p of [...AGGREGATES, '/api/v1/org/status-check']) {
      for (const who of [ordinarySid, AUTOMATION, undefined] as const) {
        expect({ p, status: (await call('GET', p, who)).status }).toEqual({ p, status: 200 });
      }
    }
  });
});

describe('a classification made while the request runs (stock home)', () => {
  it('refuses the mention answer whose search ran while a task was classified', async () => {
    for (const who of [ordinarySid, AUTOMATION] as const) {
      mentionCalls = 0;
      mentionDuring = () => mark(personalId, { router_area_id: 'personal' });
      try {
        const response = await call('GET', mentionSearch('canary-src', `race-${typeof who}`), who);
        expect(response.status).toBe(403);
        expect(await response.text()).not.toContain(MENTION);
        expect(mentionCalls).toBe(1);
      } finally {
        mentionDuring = undefined;
        patchLegacyTask(personalId, { router_area_id: null } as unknown as Partial<Task>);
      }
    }
    expect((await call('GET', mentionSearch('canary-src', 'race-after'), ordinarySid)).status).toBe(200);
  });
});

describe('org and time aggregates once areas are classified', () => {
  beforeAll(ensureAreas);

  it('builds a session\'s or automated caller\'s org without area tasks, counts included', async () => {
    const person = (await (await call('GET', '/api/v1/org')).json()).tree;
    for (const who of [ordinarySid, AUTOMATION] as const) {
      for (const p of ['/api/v1/org', '/api/v1/org/']) {
        const response = await call('GET', p, who);
        expect({ p, status: response.status }).toEqual({ p, status: 200 });
        const text = await response.text();
        for (const hidden of ['Personal desk', 'Work desk', 'Lost mark', PRIVATE, DROPPED, personalId, workId, droppedId]) expect(text).not.toContain(hidden);
        expect(text).toContain('Ordinary chores');
        const tree = JSON.parse(text).tree;
        expect(tree.routers).toBeUndefined();
        expect(tree.counts.open).toBeLessThan(person.counts.open);
      }
      const reports = await call('GET', '/api/v1/org/reports', who);
      expect(reports.status).toBe(200);
      const text = await reports.text();
      for (const hidden of ['Personal desk', 'Work desk', 'Lost mark', personalId, workId, droppedId]) expect(text).not.toContain(hidden);
    }
  });

  it('refuses reports of an area task by id before any title, and serves an ordinary one', async () => {
    for (const id of [personalId, droppedId, personalId.slice(0, 13)]) {
      for (const who of [ordinarySid, AUTOMATION] as const) {
        const response = await call('GET', `/api/v1/org/reports?of=${encodeURIComponent(id)}`, who);
        const text = await response.text();
        expect({ id, status: response.status }).toEqual({ id, status: 403 });
        expect(text).not.toContain('Personal desk');
        expect(text).not.toContain('Lost mark');
      }
    }
    expect((await call('GET', `/api/v1/org/reports?of=${ordinaryId}`, ordinarySid)).status).toBe(200);
    expect((await call('GET', `/api/v1/org/reports?of=${personalId}`)).status).toBe(200);
  });

  it('filters status-check mismatches of area tasks for a session, and keeps them for a person', async () => {
    const strayId = randomUUID();
    statusRows.rows = [
      { kind: 'drift', taskId: personalId, title: 'Personal desk', detail: PRIVATE },
      { kind: 'drift', taskId: droppedId, title: 'Lost mark', detail: DROPPED },
      { kind: 'drift', taskId: ordinaryId, title: 'Ordinary chores', detail: 'stored needs, the facts say waiting' },
      // A task the caller's snapshot never judged (made or marked after it): not shown.
      { kind: 'drift', taskId: strayId, title: 'Stray after snapshot', detail: 'x' },
    ];
    try {
      for (const who of [ordinarySid, AUTOMATION] as const) {
        const response = await call('GET', '/api/v1/org/status-check', who);
        expect(response.status).toBe(200);
        const text = await response.text();
        expect(JSON.parse(text).mismatches.map((m: { taskId: string }) => m.taskId)).toEqual([ordinaryId]);
        for (const hidden of ['Personal desk', 'Lost mark', PRIVATE, DROPPED, 'Stray after snapshot']) expect(text).not.toContain(hidden);
      }
      const person = await (await call('GET', '/api/v1/org/status-check')).json();
      expect(person.mismatches.map((m: { taskId: string }) => m.taskId)).toEqual([personalId, droppedId, ordinaryId, strayId]);
    } finally {
      statusRows.rows = [];
    }
  });

  it('judges status-check rows again when a task is classified while the check runs', async () => {
    const late = (await addTask({ title: 'Classified mid-check', project: 'Pantry' })).task.id;
    statusRows.rows = [
      { kind: 'drift', taskId: late, title: 'Classified mid-check', detail: 'x' },
      { kind: 'drift', taskId: ordinaryId, title: 'Ordinary chores', detail: 'y' },
    ];
    statusRows.during = () => mark(late, { router_area_id: 'work' });
    try {
      const response = await call('GET', '/api/v1/org/status-check', ordinarySid);
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(JSON.parse(text).mismatches.map((m: { taskId: string }) => m.taskId)).toEqual([ordinaryId]);
      expect(text).not.toContain('Classified mid-check');
    } finally {
      statusRows.rows = [];
      statusRows.during = undefined;
      patchLegacyTask(late, { router_area_id: null } as unknown as Partial<Task>);
    }
  });

  it('resolves a session\'s reports `of` only inside its snapshot', async () => {
    expect((await call('GET', `/api/v1/org/reports?of=${randomUUID()}`, ordinarySid)).status).toBe(404);
    expect((await call('GET', `/api/v1/org/reports?of=${ordinaryId.slice(0, 13)}`, ordinarySid)).status).toBe(200);
  });

  it('refuses a session or an automated caller the whole time report', async () => {
    for (const p of ['/api/time/report', '/api/time/report/']) {
      for (const who of [ordinarySid, AUTOMATION] as const) {
        const response = await call('GET', p, who);
        const text = await response.text();
        expect({ p, status: response.status }).toEqual({ p, status: 403 });
        expect(text).not.toContain('Personal desk');
        expect(text).not.toContain(PRIVATE);
      }
    }
  });

  it('serves a person as before, router titles included', async () => {
    const org = await call('GET', '/api/v1/org');
    expect(org.status).toBe(200);
    expect(await org.text()).toContain('Personal desk');
    expect((await call('GET', '/api/v1/org/reports')).status).toBe(200);
    expect((await call('GET', '/api/time/report')).status).not.toBe(403);
  });
});

describe('mention search once areas are classified', () => {
  beforeAll(ensureAreas);

  it('refuses a session or an automated caller on every source path before the source runs', async () => {
    mentionCalls = 0;
    const listed = (await (await call('GET', '/api/mention-sources')).json()).sources.map((s: { id: string }) => s.id) as string[];
    expect(listed).toContain('canary-src');
    for (const id of [...listed, 'mail', 'not-registered-yet']) {
      for (const who of [ordinarySid, AUTOMATION] as const) {
        const response = await call('GET', mentionSearch(id, `q-${id}`), who);
        const text = await response.text();
        expect({ id, status: response.status }).toEqual({ id, status: 403 });
        expect(text).not.toContain(MENTION);
      }
    }
    expect(mentionCalls).toBe(0);
  });

  it('still answers a person', async () => {
    mentionCalls = 0;
    const response = await call('GET', mentionSearch('canary-src', 'classified-person'));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(MENTION);
    expect(mentionCalls).toBe(1);
  });
});

describe('an ordinary session reading one area object', () => {
  beforeAll(ensureAreas);

  const denied = (): Array<[string, string, unknown?]> => [
    ['GET', `/api/v1/tasks/${personalId}`],
    ['GET', `/api/tasks/${personalId}`],
    ['GET', `/api/tasks/${personalId.slice(0, 13)}`],
    ['GET', `/api/v1/tasks/${personalId}/sessions`],
    ['GET', `/api/v1/tasks/${personalId}/agent-memory`],
    ['GET', `/api/v1/tasks/${personalId}/board`],
    ['GET', `/api/sessions/task/${personalId}`],
    ['GET', `/api/sessions/${personalSid}`],
    ['GET', `/api/sessions/${personalSid}/history`],
    ['GET', `/api/v1/sessions/${personalSid}/transcript`],
    ['GET', `/api/v1/sessions/${personalSid}/history`],
    ['GET', `/api/v1/tasks/${droppedId}`],
    ['GET', `/api/v1/sessions/${droppedSid}/transcript`],
    ['GET', `/api/plugins/mail/messages/${encodeURIComponent(account)}/${encodeURIComponent(personalMail.message)}`],
    ['POST', '/api/plugin-runtime/mail/ops/mail_read', { account, message: personalMail.message }],
    ['POST', '/api/plugin-runtime/mail/ops/mail_mark_read', { account, messages: [workMail.message], read: true }],
  ];

  it('is refused with area_forbidden before any payload is read', async () => {
    for (const [method, p, body] of denied()) {
      const response = await call(method, p, ordinarySid, body);
      const text = await response.text();
      expect({ p, status: response.status }).toEqual({ p, status: 403 });
      expect(JSON.parse(text).code).toBe('area_forbidden');
      expect(text).not.toContain(PRIVATE);
      expect(text).not.toContain(DROPPED);
    }
  });

  it('cannot write an area task either, and the task is unchanged', async () => {
    const response = await call('PATCH', `/api/tasks/${personalId}`, ordinarySid, { title: 'Renamed by a peer' });
    expect(response.status).toBe(403);
    expect((await getTask(personalId)).title).toBe('Personal desk');
  });

  it('lets a person read the same area task and transcript routes', async () => {
    const task = await call('GET', `/api/v1/tasks/${personalId}`);
    expect(task.status).toBe(200);
    expect(await task.text()).toContain(PRIVATE);
    for (const p of [`/api/v1/sessions/${personalSid}/transcript`, `/api/sessions/${personalSid}/history`]) {
      expect((await call('GET', p)).status).not.toBe(403);
    }
  });

  it('still reads ordinary work, unknown ids keep their 404, and literal paths are not ids', async () => {
    const own = await call('GET', `/api/v1/tasks/${ordinaryId}`, ordinarySid);
    expect(own.status).toBe(200);
    expect((await own.json()).task.id).toBe(ordinaryId);
    expect((await call('GET', `/api/v1/tasks/${randomUUID()}`, ordinarySid)).status).toBe(404);
    expect((await call('GET', `/api/v1/sessions/${randomUUID()}/transcript`, ordinarySid)).status).not.toBe(403);
    for (const p of ['/api/tasks/groups', '/api/tasks/meta/tags', '/api/tasks/board-counts']) {
      expect({ p, status: (await call('GET', p, ordinarySid)).status }).toEqual({ p, status: 200 });
    }
    const unassigned = `/api/plugins/mail/messages/${encodeURIComponent(account)}/${encodeURIComponent('INBOX:1:99')}`;
    expect([403, 503]).not.toContain((await call('GET', unassigned, ordinarySid)).status);
    expect([403, 503]).not.toContain((await call('POST', '/api/plugin-runtime/mail/ops/mail_read', ordinarySid, { account, message: 'INBOX:1:99' })).status);
    expect((await call('GET', '/api/v1/approvals/ap-none', ordinarySid)).status).not.toBe(403);
  });

  it('answers unverifiable for an assigned message id whose account the middleware cannot resolve', async () => {
    for (const body of [{ message: personalMail.message }, { account: 'Desk', message: personalMail.message }, { message: 'INBOX:1:99' }]) {
      const response = await call('POST', '/api/plugin-runtime/mail/ops/mail_read', ordinarySid, body);
      expect(response.status).toBe(503);
      expect(await response.text()).toContain('area_unverifiable');
    }
  });

  it('fails closed while the registry cannot be read, marks and profiles still deny, a person is untouched', async () => {
    const file = routerAreasPath(WALNUT_HOME);
    const saved = await fs.readFile(file, 'utf8');
    await fs.writeFile(file, '{ not json');
    try {
      for (const p of [`/api/v1/tasks/${personalId}`, `/api/v1/sessions/${droppedSid}/transcript`, `/api/v1/tasks/${droppedId}`]) {
        const response = await call('GET', p, ordinarySid);
        expect({ p, status: response.status }).toEqual({ p, status: 403 });
      }
      for (const p of [`/api/v1/tasks/${ordinaryId}`, '/api/tasks', '/api/sessions',
        `/api/plugins/mail/messages/${encodeURIComponent(account)}/${encodeURIComponent(personalMail.message)}`]) {
        const response = await call('GET', p, ordinarySid);
        expect({ p, status: response.status }).toEqual({ p, status: 403 });
        expect(await response.text()).toContain('area_forbidden');
      }
      // The tool belt refuses first; these assertions exercise the reader underneath it.
      expect(await judgeAreaRead({ sid: ordinarySid }, { kind: 'task', id: ordinaryId })).toBe('unverifiable');
      expect(await judgeAreaRead({ sid: ordinarySid }, { kind: 'task', id: personalId })).toBe('deny');
      expect(await judgeAreaRead({ sid: ordinarySid }, { kind: 'session', id: droppedSid })).toBe('deny');
      expect(await judgeAreaRead({ sid: ordinarySid }, { kind: 'mail', account, message: personalMail.message })).toBe('unverifiable');
      expect(await buildAreaDenials({ sid: ordinarySid })).toBeUndefined();
      expect((await call('GET', `/api/v1/tasks/${ordinaryId}`, AUTOMATION)).status).toBe(503);
      mentionCalls = 0;
      for (const who of [ordinarySid, AUTOMATION] as const) {
        expect((await call('GET', mentionSearch('canary-src', 'bad-registry'), who)).status).toBe(typeof who === 'string' ? 403 : 503);
      }
      expect(mentionCalls).toBe(0);
      expect((await call('GET', mentionSearch('canary-src', 'bad-registry-person'))).status).toBe(200);
      for (const p of [...AGGREGATES, '/api/v1/org/status-check']) {
        for (const who of [ordinarySid, AUTOMATION] as const) {
          expect({ p, status: (await call('GET', p, who)).status }).toEqual({ p, status: typeof who === 'string' ? 403 : 503 });
        }
      }
      expect((await call('GET', `/api/v1/tasks/${personalId}`, AUTOMATION)).status).toBe(403);
      expect((await call('GET', `/api/v1/tasks/${personalId}`)).status).toBe(200);
      expect((await call('GET', '/api/tasks')).status).toBe(200);
    } finally {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, saved);
    }
  });
});

describe('mail copies, automated callers and missing metadata', () => {
  beforeAll(ensureAreas);

  it('refuses an unledgered RFC copy of a classified message, from metadata only', async () => {
    resolve.mockClear();
    read.mockClear();
    expect((await call('GET', mailPath(account, COPY), ordinarySid)).status).toBe(403);
    expect((await call('POST', '/api/plugin-runtime/mail/ops/mail_read', ordinarySid, { account, message: COPY })).status).toBe(403);
    expect(resolve).toHaveBeenCalledWith({ kind: 'mail', account, message: COPY });
    expect(read).not.toHaveBeenCalled();
  });

  it('allows a different account or a different key, and a person reads the copy', async () => {
    resolve.mockClear();
    expect([403, 503]).not.toContain((await call('GET', mailPath(otherAccount, COPY), ordinarySid)).status);
    // No classified mail in that account: nothing to look up.
    expect(resolve).not.toHaveBeenCalled();
    expect([403, 503]).not.toContain((await call('GET', mailPath(account, 'INBOX:1:99'), ordinarySid)).status);
    expect([403, 503]).not.toContain((await call('GET', mailPath(account, COPY))).status);
    expect(read).not.toHaveBeenCalled();
  });

  it('answers unverifiable when the adapter cannot give metadata in a classified account', async () => {
    stopSource();
    try {
      const response = await call('GET', mailPath(account, 'INBOX:1:99'), ordinarySid);
      expect(response.status).toBe(503);
      expect(await response.text()).toContain('area_unverifiable');
      expect([403, 503]).not.toContain((await call('GET', mailPath(otherAccount, 'INBOX:1:99'), ordinarySid)).status);
    } finally {
      stopSource = registerRouterSource('mail', { resolve, read });
    }
  });

  it('judges exactly the task snapshot it is handed', async () => {
    const ghost = { id: 'ghost-area-task', router_area_id: 'personal' };
    expect((await buildAreaDenials({ sid: ordinarySid }, { tasks: [ghost] }))!.denials.tasks.has(ghost.id)).toBe(true);
    expect((await buildAreaDenials({ sid: ordinarySid }))!.denials.tasks.has(ghost.id)).toBe(false);
    const tasks = [{ id: 'abc-1' }, { id: 'abd-2' }, { id: 'xyz' }];
    expect(snapshotTask(tasks, 'xyz')).toEqual({ id: 'xyz' });
    expect(snapshotTask(tasks, 'abc')).toEqual({ id: 'abc-1' });
    expect(snapshotTask(tasks, 'ab')).toBeUndefined();
    expect(snapshotTask(tasks, 'nope')).toBeUndefined();
  });

  it('filters list rows by exact id and by adapter key, per account', async () => {
    const built = await buildAreaDenials({ sid: ordinarySid });
    expect(built).toBeDefined();
    const mail = built!.denials.mail;
    const key99 = mailRouterKey(account, 'INBOX:1:99', '<other@marina.example.invalid>');
    expect(mail(account, COPY, mailRouterKey(account, COPY, RFC), currentVersion(account, COPY))).toBe(true);
    expect(mail(account, workMail.message, undefined, WORK_VERSION)).toBe(true);
    // A row that lost its version is no proof of another delivery: a handle confirmed at any version
    // restricts an ordinary caller, and a missing version only ever restricts, never grants.
    expect(mail(account, workMail.message)).toBe(true);
    expect(mail(otherAccount, COPY, mailRouterKey(otherAccount, COPY, RFC), currentVersion(otherAccount, COPY))).toBe(false);
    expect(mail(account, 'INBOX:1:99', key99, currentVersion(account, 'INBOX:1:99'))).toBe(false);
    const own = await buildAreaDenials({ sid: personalSid });
    // The copy shares only the RFC key: its own area does not get its row (snippet) either.
    expect(own!.denials.mail(account, COPY, mailRouterKey(account, COPY, RFC), currentVersion(account, COPY))).toBe(true);
    expect(own!.denials.mail(account, personalMail.message, PERSONAL_KEY, PERSONAL_VERSION)).toBe(false);
    // Only the confirmed delivery grants: a row with no version, or another one, is denied.
    expect(own!.denials.mail(account, personalMail.message, PERSONAL_KEY)).toBe(true);
    expect(own!.denials.mail(account, personalMail.message, PERSONAL_KEY, WORK_VERSION)).toBe(true);
    expect(own!.denials.mail(account, workMail.message, undefined, WORK_VERSION)).toBe(true);
    expect(own!.denials.mail(account, workMail.message)).toBe(true);
    // An area caller's lists carry no unassigned mail either.
    expect(own!.denials.mail(account, 'INBOX:1:99', key99, currentVersion(account, 'INBOX:1:99'))).toBe(true);
    expect(own!.denials.mail(otherAccount, COPY, mailRouterKey(otherAccount, COPY, RFC), currentVersion(otherAccount, COPY))).toBe(true);
    const rows = filterAreaPayload({ messages: [
      { accountId: account, messageId: COPY, rfcMessageId: RFC, deliveryVersion: currentVersion(account, COPY) },
      { accountId: otherAccount, messageId: COPY, rfcMessageId: RFC, deliveryVersion: currentVersion(otherAccount, COPY) },
      { accountId: account, messageId: 'INBOX:1:99', rfcMessageId: '', deliveryVersion: currentVersion(account, 'INBOX:1:99') },
      // A returned DTO of the classified work handle with its version missing is filtered too.
      { accountId: account, messageId: workMail.message, rfcMessageId: '' },
    ] }, built!.denials, 'mail').body as { messages: Array<{ accountId: string; deliveryVersion?: string }> };
    // Unassigned mail stays visible: the other account's copy and the same account's other handle.
    expect(rows.messages.map((m) => m.accountId)).toEqual([otherAccount, account]);
    expect(rows.messages.some((m) => (m as { messageId?: string }).messageId === workMail.message)).toBe(false);
    expect(rows.messages.every((m) => typeof m.deliveryVersion === 'string')).toBe(true);
  });

  it('treats an automated caller with no session as outside every area; a person stays a person', async () => {
    expect(areaCallerOf({ headers: { 'x-walnut-caller-kind': 'automation' } })).toEqual({ automation: true });
    expect(areaCallerOf({ headers: { 'x-walnut-caller-sid': ' s1 ', 'x-walnut-caller-kind': 'automation' } })).toEqual({ sid: 's1' });
    expect(areaCallerOf({ headers: {} })).toBeUndefined();
    for (const [method, p, body] of [
      ['GET', `/api/v1/tasks/${personalId}`], ['GET', `/api/v1/sessions/${personalSid}/transcript`],
      ['GET', mailPath(account, personalMail.message)], ['GET', mailPath(account, COPY)],
      ['POST', '/api/plugin-runtime/mail/ops/mail_read', { account, message: personalMail.message }],
    ] as Array<[string, string, unknown?]>) {
      const response = await call(method, p, AUTOMATION, body);
      expect({ p, status: response.status }).toEqual({ p, status: 403 });
      expect(await response.text()).not.toContain(PRIVATE);
    }
    expect((await call('GET', `/api/v1/tasks/${ordinaryId}`, AUTOMATION)).status).toBe(200);
    const listed = (await (await call('GET', '/api/tasks', AUTOMATION)).json()).tasks.map((t: { id: string }) => t.id);
    expect(listed).not.toContain(personalId);
    expect((await call('GET', `/api/v1/tasks/${personalId}`)).status).toBe(200);
  });
});

describe('an ordinary session reading lists', () => {
  beforeAll(ensureAreas);

  const areaIds = () => [personalId, workId, droppedId];
  const idsOf = (rows: Array<Record<string, unknown>>, key: string) => rows.map((r) => String(r[key]));

  for (const [p, key, idKey] of [
    ['/api/tasks', 'tasks', 'id'],
    ['/api/v1/tasks', 'tasks', 'id'],
  ] as const) {
    it(`GET ${p} leaves out area tasks and keeps the rest`, async () => {
      const human = idsOf((await (await call('GET', p)).json())[key] ?? [], idKey);
      const response = await call('GET', p, ordinarySid);
      expect(response.status).toBe(200);
      const text = await response.text();
      const peer = idsOf(JSON.parse(text)[key] ?? [], idKey);
      if (p === '/api/tasks') expect(human).toContain(personalId);
      for (const id of areaIds()) expect(peer).not.toContain(id);
      expect(peer).toEqual(human.filter((id) => !areaIds().includes(id)));
      expect(text).not.toContain(PRIVATE);
    });
  }

  it('GET /api/tasks/bulk drops the area row and keeps the ordinary one', async () => {
    const response = await call('GET', `/api/tasks/bulk?ids=${personalId},${ordinaryId}`, ordinarySid);
    expect(response.status).toBe(200);
    const body = await response.json();
    const rows = idsOf(body.tasks, 'id');
    expect(rows).toEqual([ordinaryId]);
    expect(body.count).toBe(rows.length);
    expect(body.errors).toBe(0);
    const hidden = await (await call('GET', `/api/tasks/bulk?ids=${personalId}`, ordinarySid)).json();
    expect(hidden.tasks).toEqual([]);
    expect(hidden.count).toBe(0);
    expect(hidden.errors).toBe(0);
  });

  for (const [p, idKey] of [['/api/sessions', 'claudeSessionId'], ['/api/sessions/mention-index', 'id']] as const) {
    it(`GET ${p} leaves out area sessions, the dropped-mark one included`, async () => {
      const human = idsOf((await (await call('GET', p)).json()).sessions ?? [], idKey);
      const peer = idsOf((await (await call('GET', p, ordinarySid)).json()).sessions ?? [], idKey);
      for (const sid of [personalSid, droppedSid]) expect(peer).not.toContain(sid);
      expect(peer).toEqual(human.filter((sid) => sid !== personalSid && sid !== droppedSid));
    });
  }

  // Last in this server's run: it adds tasks the earlier list baselines do not expect.
  it('leaves out a task made or marked after the judged snapshot, and shows ordinary ones on the next read', async () => {
    const built = await buildAreaDenials({ sid: ordinarySid });
    const lateArea = (await addTask({ title: 'Late area desk', project: 'Workshop' })).task.id;
    await mark(lateArea, { router_area_id: 'work' });
    const lateOrdinary = (await addTask({ title: 'Late chores', project: 'Pantry' })).task.id;
    // The route's own later read, as the person sees it, filtered by the earlier snapshot.
    const raced = filterAreaPayload(await (await call('GET', '/api/tasks')).json(), built!.denials, 'task').body as { tasks: Array<{ id: string }> };
    const racedIds = raced.tasks.map((t) => t.id);
    expect(racedIds).not.toContain(lateArea);
    expect(racedIds).not.toContain(lateOrdinary);
    expect(racedIds).toContain(ordinaryId);
    const next = (await (await call('GET', '/api/tasks', ordinarySid)).json()).tasks.map((t: { id: string }) => t.id);
    expect(next).not.toContain(lateArea);
    expect(next).toContain(lateOrdinary);
    const view = await (await call('GET', '/api/v1/org', ordinarySid)).text();
    expect(view).not.toContain('Late area desk');
    expect(view).toContain('Late chores');
  });

  it('judges again at response time a task the snapshot saw as ordinary and that was classified since', async () => {
    const same = (await addTask({ title: 'Same id, classified later', project: 'Pantry', description: 'SAME_ID_CANARY' })).task.id;
    try {
      const built = await buildAreaDenials({ sid: ordinarySid });
      expect(built!.denials.knownTasks!.has(same)).toBe(true);
      await mark(same, { router_area_id: 'work' });
      const routeRead = await (await call('GET', '/api/tasks')).json();
      // The snapshot alone lets the same id through: a known id proves nothing about its scope now.
      const first = filterAreaPayload(routeRead, built!.denials, 'task').body as { tasks: Array<{ id: string }> };
      expect(first.tasks.map((t) => t.id)).toContain(same);
      const again = await recheckAreaPayload({ sid: ordinarySid }, first, 'task');
      const ids = (again!.body as { tasks: Array<{ id: string }> }).tasks.map((t) => t.id);
      expect(ids).not.toContain(same);
      expect(ids).toContain(ordinaryId);
      const session = await recheckAreaPayload({ sid: ordinarySid }, { sessions: [{ claudeSessionId: droppedSid }, { claudeSessionId: ordinarySid }] }, 'session');
      expect((session!.body as { sessions: unknown[] }).sessions).toEqual([{ claudeSessionId: ordinarySid }]);
      const live = await (await call('GET', '/api/tasks', ordinarySid)).text();
      expect(live).not.toContain('SAME_ID_CANARY');
      expect(live).not.toContain(same);
    } finally {
      // A mark is never cleared through the store; restore the fixture the way it was planted.
      patchLegacyTask(same, { router_area_id: null as never });
    }
  });
});

describe('visible task pages and supervisor reads', () => {
  beforeAll(ensureAreas);

  it('counts exactly the visible match set before every limit and projection', async () => {
    const ids = [personalId, workId, ordinaryId].join(',');
    for (const fields of ['', '&slim=1', '&fields=list']) {
      for (const who of [ordinarySid, AUTOMATION, undefined] as const) {
        for (const limit of [1, 2, 5]) {
          const response = await call('GET', `/api/tasks?ids=${ids}&sort=title_asc&limit=${limit}${fields}`, who);
          expect(response.status).toBe(200);
          const page = await response.json();
          const expected = who ? 1 : 3;
          expect(page.total).toBe(expected);
          expect(page.tasks).toHaveLength(Math.min(expected, limit));
          expect(page.truncated).toBe(expected > limit);
          if (who) expect(page.visibility_note).toContain('area isolation');
        }
      }
    }
    for (const q of ['Personal desk', 'Work desk', 'Ordinary chores', 'missing task']) {
      const outcome = await executeOp('task_list', { q, scope: 'all', limit: 5 }, { apiBase: base, callerSid: ordinarySid });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw new Error(outcome.message);
      const page = outcome.result as { count: number; total: number; truncated: boolean; tasks: Array<{ id: string }>; hint?: string };
      expect(page.total).toBe(q === 'Ordinary chores' ? 1 : 0);
      expect(page.count).toBe(page.total);
      expect(page.tasks).toHaveLength(page.total);
      expect(page.truncated).toBe(false);
      expect(page.hint).toContain('area isolation');
    }
  });

  it('the archive window counts only visible rows before the page, for every caller', async () => {
    const open = (await addTask({ title: 'Window canary visible', project: 'Pantry' })).task;
    const old = (await addTask({ title: 'Window canary old', project: 'Pantry' })).task;
    const denied = (await addTask({ title: 'Window canary area', project: 'Garden' })).task;
    const ancient = '2000-01-01T00:00:00Z';
    await mark(old.id, { phase: 'COMPLETE', status: 'done', completed_at: ancient });
    await mark(denied.id, { phase: 'COMPLETE', status: 'done', completed_at: ancient, router_area_id: 'personal' });
    for (const who of [ordinarySid, AUTOMATION, undefined] as const) {
      const page = await (await call('GET', '/api/tasks?q=Window%20canary&sort=title_asc&limit=1&fields=list&completedWithinDays=7', who)).json();
      expect(page.tasks.map((t: { id: string }) => t.id)).toEqual([open.id]);
      expect(page.total).toBe(1);
      expect(page.truncated).toBe(false);
      expect(page.completedHidden).toBe(who ? 1 : 2);
    }
  });

  it('does not let denied early matches consume the page or leak board counts', async () => {
    const hidden = [];
    for (let i = 0; i < 24; i++) {
      const t = (await addTask({ title: `Page canary A ${i}`, project: 'Garden', pinned: true })).task;
      await mark(t.id, { router_area_id: 'personal' });
      hidden.push(t.id);
    }
    const visible = [];
    for (let i = 0; i < 7; i++) visible.push((await addTask({ title: `Page canary Z ${i}`, project: 'Pantry', pinned: true })).task.id);
    for (const limit of [1, 3, 7, 20]) {
      const page = await (await call('GET', `/api/tasks?q=Page%20canary&sort=title_asc&limit=${limit}&fields=list&working_set=true`, ordinarySid)).json();
      expect(page.total).toBe(7);
      expect(page.tasks.map((t: { id: string }) => t.id)).toEqual(visible.slice(0, limit));
      expect(page.truncated).toBe(limit < 7);
      expect(page.board.pinned_total).toBe(7);
      expect(JSON.stringify(page)).not.toContain(hidden[0]);
    }
    for (const route of ['/api/search', '/api/v1/search']) {
      const hits = await (await call('GET', `${route}?q=Page%20canary&types=task&limit=3`, ordinarySid)).json();
      expect(hits.results).toHaveLength(3);
      expect(hits.results.every((r: { taskId: string }) => visible.includes(r.taskId))).toBe(true);
    }
  });

  it('Main and the current project lead can read and search their work, but peers and retired leads cannot', async () => {
    const main = (await addTask({ title: 'Company owner', org_role: 'main' })).task;
    const lead = (await addTask({ title: 'Garden owner', project: 'Garden', org_role: 'lead' })).task;
    const peer = (await addTask({ title: 'Pantry owner', project: 'Pantry', org_role: 'lead' })).task;
    const retired = (await addTask({ title: 'Former garden owner', project: 'Garden', org_role: 'lead' })).task;
    await mark(retired.id, { phase: 'COMPLETE', status: 'done' });
    const downstream = (await addTask({ title: 'Classified garden work', project: 'Garden' })).task;
    await mark(downstream.id, { router_area_id: 'personal' });
    const workSid = randomUUID();
    await seedLegacySession(workSid, downstream.id, '', WALNUT_HOME, { mode: 'dontAsk', initialProcessStatus: 'stopped' });
    const isolatedWorkSid = randomUUID();
    const isolatedWork = (await addTask({ title: 'Classified isolated garden work', project: 'Garden' })).task;
    await mark(isolatedWork.id, { router_area_id: 'personal' });
    await createSessionRecord(isolatedWorkSid, isolatedWork.id, '', WALNUT_HOME, { profile: routerAreaProfile('personal', 'work'), mode: 'dontAsk' });
    await mark(isolatedWork.id, { session_id: isolatedWorkSid, exec_session_id: isolatedWorkSid, session_ids: [isolatedWorkSid] });
    await updateSessionRecord(isolatedWorkSid, { process_status: 'stopped' });
    const sids = new Map<string, string>();
    for (const node of [main, lead, peer, retired]) {
      const sid = randomUUID();
      sids.set(node.id, sid);
      await createSessionRecord(sid, node.id, '', WALNUT_HOME, { mode: 'dontAsk' });
      await updateSessionRecord(sid, { process_status: 'stopped' });
      const allowed = node.id === main.id || node.id === lead.id;
      const detail = await call('GET', `/api/tasks/${downstream.id}`, sid);
      expect(detail.status).toBe(allowed ? 200 : 403);
      const listed = await (await call('GET', '/api/tasks?q=Classified%20garden%20work&limit=1&fields=list', sid)).json();
      expect(listed.total).toBe(allowed ? 1 : 0);
      expect(listed.tasks.map((t: { id: string }) => t.id)).toEqual(allowed ? [downstream.id] : []);
      const searched = await (await call('GET', `/api/search?q=${downstream.id}&types=task&slim=1`, sid)).json();
      expect(searched.results.map((r: { id: string }) => r.id)).toEqual(allowed ? [downstream.id] : []);
      expect((await call('GET', `/api/sessions/${workSid}/history`, sid)).status).toBe(allowed ? 200 : 403);
      // Router source notes and isolated profiles may carry the original mail.
      expect((await call('GET', `/api/tasks/${personalId}`, sid)).status).toBe(403);
      expect((await call('GET', `/api/sessions/${personalSid}/history`, sid)).status).toBe(403);
      const rawHits = await (await call('GET', `/api/search?q=${personalSid}&types=session`, sid)).json();
      expect(rawHits.results).toEqual([]);
      const isolatedPage = await (await call('GET', `/api/tasks?ids=${isolatedWork.id}&limit=1`, sid)).json();
      expect(isolatedPage.total).toBe(allowed ? 1 : 0);
      expect(isolatedPage.tasks.map((t: { id: string }) => t.id)).toEqual(allowed ? [isolatedWork.id] : []);
      expect(JSON.stringify(isolatedPage)).not.toContain(isolatedWorkSid);
      const isolatedDetail = await call('GET', `/api/tasks/${isolatedWork.id}`, sid);
      expect(isolatedDetail.status).toBe(allowed ? 200 : 403);
      expect(await isolatedDetail.text()).not.toContain(isolatedWorkSid);
      expect((await call('GET', `/api/sessions/${isolatedWorkSid}/history`, sid)).status).toBe(403);
      // Read access never becomes a write grant or raw mail access.
      expect((await call('PATCH', `/api/tasks/${personalId}`, sid, { title: 'Changed by supervisor' })).status).toBe(403);
      expect((await call('GET', mailPath(account, personalMail.message), sid)).status).toBe(403);
    }
    // Transferring this project also transfers the read grant, even if an old parent remains.
    await mark(downstream.id, { parent_task_id: lead.id });
    await mark(peer.id, { org_leads: ['Garden'] });
    const oldSid = sids.get(lead.id)!;
    const newSid = sids.get(peer.id)!;
    expect(await judgeAreaRead({ sid: oldSid }, { kind: 'task', id: downstream.id }, undefined, true)).toBe('deny');
    expect(await judgeAreaRead({ sid: newSid }, { kind: 'task', id: downstream.id }, undefined, true)).toBe('pass');
    expect(await judgeAreaRead({ sid: newSid }, { kind: 'task', id: downstream.id })).toBe('deny');
    await mark(peer.id, { org_leads: [] });
    // Lost org_role never turns a registered source router into downstream work.
    patchLegacyTask(personalId, { org_role: null as never });
    try {
      expect((await call('GET', `/api/tasks/${personalId}`, sids.get(main.id)!)).status).toBe(403);
    } finally {
      patchLegacyTask(personalId, { org_role: 'router' });
    }
  });
});

describe('the pure helpers', () => {
  const d: AreaDenials = {
    tasks: new Set(['t-area']),
    sessions: new Set(['s-area']),
    mail: (a, m) => a === account && m === personalMail.message,
  };

  it('allows only the same single area, or a target outside every area', () => {
    const personal = new Set(['personal']);
    expect(scopeAllows(new Set(), new Set())).toBe(true);
    expect(scopeAllows(personal, new Set())).toBe(true);
    expect(scopeAllows(personal, personal)).toBe(true);
    expect(scopeAllows(new Set(), personal)).toBe(false);
    expect(scopeAllows(new Set(['work']), personal)).toBe(false);
    expect(scopeAllows(personal, new Set(['personal', 'work']))).toBe(false);
    expect(scopeAllows(new Set(['personal', 'work']), personal)).toBe(false);
    // A router task with no area anywhere matches nobody, itself included.
    const unscopedRouter = taskScopes({ id: 'r', org_role: 'router' }, undefined);
    expect(unscopedRouter.size).toBe(1);
    expect(scopeAllows(unscopedRouter, unscopedRouter)).toBe(false);
    expect(taskScopes({ id: 'plain' }, undefined).size).toBe(0);
  });

  it('names the object a path addresses, and never a literal segment', () => {
    expect(areaTargetOf('GET', '/v1/tasks/abc/board')).toEqual({ kind: 'task', id: 'abc' });
    expect(areaTargetOf('GET', '/tasks/abc')).toEqual({ kind: 'task', id: 'abc' });
    expect(areaTargetOf('GET', '/sessions/task/abc')).toEqual({ kind: 'task', id: 'abc' });
    expect(areaTargetOf('GET', '/v1/sessions/s1/transcript')).toEqual({ kind: 'session', id: 's1' });
    expect(areaTargetOf('POST', '/v1/human-inbox/lt-1/answer')).toEqual({ kind: 'letter', id: 'lt-1' });
    expect(areaTargetOf('GET', '/plugins/mail/messages/a%40b/INBOX%3A1%3A2/invite')).toEqual({ kind: 'mail', account: 'a@b', message: 'INBOX:1:2' });
    expect(areaTargetOf('POST', '/plugin-runtime/mail/ops/mail_thread')).toEqual({ kind: 'mail-op' });
    expect(areaTargetOf('POST', '/plugin-runtime/mail/ops/mail_list')).toBeUndefined();
    for (const p of ['/tasks/bulk', '/tasks/meta/tags', '/v1/tasks/groups', '/tasks/board-counts', '/sessions/recent',
      '/v1/sessions/summaries', '/sessions/mention-index', '/v1/human-inbox/body', '/config', '/v1/router/context']) {
      expect({ p, t: areaTargetOf('GET', p) }).toEqual({ p, t: undefined });
    }
    for (const p of ['/mention-sources/mail/search', '/mention-sources/notes/search/', '/mention-sources/any.plugin-x/search']) {
      expect({ p, hit: isMentionSearchPath('get', p) }).toEqual({ p, hit: true });
      expect({ p, post: isMentionSearchPath('POST', p) }).toEqual({ p, post: false });
    }
    for (const p of ['/mention-sources', '/mention-sources/mail', '/mention-sources/mail/search/more', '/v1/mention-sources/mail/search']) {
      expect({ p, hit: isMentionSearchPath('GET', p) }).toEqual({ p, hit: false });
    }
    for (const p of ['/time/report', '/time/report/']) {
      expect({ p, hit: isAreaAggregatePath('get', p) }).toEqual({ p, hit: true });
      expect({ p, post: isAreaAggregatePath('POST', p) }).toEqual({ p, post: false });
    }
    // The org routes narrow their own tree, so the middleware leaves them alone.
    for (const p of ['/v1/org', '/v1/org/', '/v1/org/reports', '/v1/org/reports/', '/v1/org/status-check', '/v1/org/nodes/x/start', '/org', '/time/summary', '/time/reports', '/v1/time/report', '/v1/orgs']) {
      expect({ p, hit: isAreaAggregatePath('GET', p) }).toEqual({ p, hit: false });
    }
    expect(isAreaListPath('GET', '/v1/search')).toBe(true);
    expect(areaTargetOf('GET', '/v1/approvals/ap-1')).toEqual({ kind: 'approval', id: 'ap-1' });
    expect(areaTargetOf('POST', '/v1/approvals/ap-1/wait')).toEqual({ kind: 'approval', id: 'ap-1' });
    expect(areaTargetOf('POST', '/v1/approvals/ap-1/cancel')).toEqual({ kind: 'approval', id: 'ap-1' });
    expect(areaTargetOf('GET', '/v1/approvals/keys')).toBeUndefined();
    expect(isAreaListPath('GET', '/v1/approvals')).toBe(true);
    expect(isAreaListPath('GET', '/v1/approvals/keys')).toBe(false);
    expect(isAreaListPath('POST', '/tasks')).toBe(false);
  });

  it('filters every listed shape by its real row keys, without mutating the answer', () => {
    const body = {
      tasks: [{ id: 't-area', title: PRIVATE }, { id: 't-ok' }, { id: 't-ok2', session_id: 's-area' }],
      sessions: [{ claudeSessionId: 's-area', taskId: 't-ok' }, { id: 's-ok', task_id: 't-area' }, { claudeSessionId: 's-ok', taskId: 't-ok' }],
      results: [
        { type: 'task', id: 't-area', ref: '[t-area]' }, { type: 'session', id: 's-area' },
        { type: 'memory', path: '/m.md', taskId: 't-area' }, { type: 'task', taskId: 't-area', snippet: PRIVATE },
        { type: 'session', sessionId: 's-ok' }, { type: 'memory', path: '/other.md' },
      ],
      hits: [{ taskId: 't-area' }, { taskId: 't-ok' }],
      // A summary's id is its file slug, never a session id.
      summaries: [{ id: '2026-11-07-garden-slug', task_ids: [] }, { id: 'x', task_ids: ['t-ok', 't-area'] }, { id: 'y', task_ids: ['t-ok'] }],
      letters: [{ id: 'lt-1', sender: { sessionId: 's-1', taskId: 't-area' } }, { id: 'lt-2', sender: { sessionId: 's-area' } }, { id: 'lt-3', sender: { sessionId: 's-ok', taskId: 't-ok' } }],
      approvals: [{ id: 'ap-1', requester: { host: 'h', taskId: 't-area' } }, { id: 'ap-2', requester: { host: 'h' } }],
      messages: [{ accountId: account, messageId: personalMail.message, deliveryVersion: PERSONAL_VERSION },
        { accountId: account, messageId: 'INBOX:1:99', deliveryVersion: versionOf(account, 'INBOX:1:99') }],
      byTask: { 't-area': { since: 1 }, 't-ok': { since: 2 } },
      statuses: { 's-area': {}, 's-ok': {} },
      recent_tasks: [{ id: 't-area' }], recent_sessions: [{ id: 's-ok', task_ids: ['t-area'] }],
      total: 3,
      items: [{ taskId: 't-area' }],
    };
    const snapshot = structuredClone(body);
    const out = filterAreaPayload(body, d).body as typeof body;
    expect(body).toEqual(snapshot);
    expect(out.tasks.map((t) => t.id)).toEqual(['t-ok']);
    expect(out.sessions).toEqual([{ claudeSessionId: 's-ok', taskId: 't-ok' }]);
    expect(out.results).toEqual([{ type: 'session', sessionId: 's-ok' }, { type: 'memory', path: '/other.md' }]);
    expect(out.hits).toEqual([{ taskId: 't-ok' }]);
    expect(out.summaries.map((s) => s.id)).toEqual(['2026-11-07-garden-slug', 'y']);
    expect(out.letters.map((l) => l.id)).toEqual(['lt-3']);
    expect(out.approvals.map((a) => a.id)).toEqual(['ap-2']);
    expect(out.messages).toEqual([{ accountId: account, messageId: 'INBOX:1:99', deliveryVersion: versionOf(account, 'INBOX:1:99') }]);
    expect(Object.keys(out.byTask)).toEqual(['t-ok']);
    expect(Object.keys(out.statuses)).toEqual(['s-ok']);
    expect(out.recent_tasks).toEqual([]);
    expect(out.recent_sessions).toEqual([]);
    // Shapes the filter does not know pass as they are (reported as uncovered, never guessed at).
    expect(out.total).toBe(3);
    expect(out.items).toEqual([{ taskId: 't-area' }]);
    expect(JSON.stringify(out)).not.toContain(PRIVATE);
  });

  it('leaves out rows outside a known snapshot, keeping error rows and denials without one unchanged', () => {
    const snap: AreaDenials = { ...d, knownTasks: new Set(['t-ok']), knownSessions: new Set(['s-ok']) };
    const body = {
      tasks: [{ id: 't-ok' }, { id: 't-new' }, { id: 't-missing', error: 'not found' }],
      sessions: [{ claudeSessionId: 's-ok' }, { claudeSessionId: 's-new' }, { id: 's-new' }],
      results: [{ type: 'task', id: 't-new' }, { type: 'session', sessionId: 's-new' }, { type: 'task', taskId: 't-ok' }, { type: 'memory', path: '/m.md' }],
      byTask: { 't-ok': {}, 't-new': {} },
      letters: [{ id: 'lt', sender: { sessionId: 's-new', taskId: 't-new' } }],
    };
    const out = filterAreaPayload(body, snap).body as typeof body;
    expect(out.tasks).toEqual([{ id: 't-ok' }, { id: 't-missing', error: 'not found' }]);
    expect(out.sessions).toEqual([{ claudeSessionId: 's-ok' }]);
    expect(out.results).toEqual([{ type: 'task', taskId: 't-ok' }, { type: 'memory', path: '/m.md' }]);
    expect(Object.keys(out.byTask)).toEqual(['t-ok']);
    // Letters and mail are judged by denials only (their owners may be long gone).
    expect(out.letters).toHaveLength(1);
    expect(filterAreaPayload(body, d).body).toBe(body);
  });

  it('turns a single denied object into a refusal and leaves ordinary ones alone', () => {
    expect(filterAreaPayload({ letter: { id: 'lt-1', sender: { sessionId: 's-area' } } }, d).denied).toBe(true);
    expect(filterAreaPayload({ approval: { id: 'ap', requester: { host: 'h', taskId: 't-area' } } }, d).denied).toBe(true);
    expect(filterAreaPayload({ message: { accountId: account, messageId: personalMail.message }, body: { text: PRIVATE } }, d).denied).toBe(true);
    const fine = { approval: { id: 'ap', requester: { host: 'h', taskId: 't-ok' } } };
    expect(filterAreaPayload(fine, d)).toEqual({ body: fine });
    expect(filterAreaPayload([{ taskId: 't-area' }], d).body).toEqual([{ taskId: 't-area' }]);
  });

  it('reads a top-level array answer by its route kind', () => {
    expect(filterAreaPayload([{ id: 't-area' }, { id: 't-ok' }], d, 'task').body).toEqual([{ id: 't-ok' }]);
    expect(filterAreaPayload([{ id: 's-area' }, { claudeSessionId: 's-ok' }], d, 'session').body).toEqual([{ claudeSessionId: 's-ok' }]);
    expect(filterAreaPayload([
      { type: 'session', id: 's-area' }, { type: 'task', id: 't-area' }, { type: 'task', taskId: 't-ok', sessionId: 's-area' },
      { type: 'task', id: 't-ok' }, { type: 'memory', id: '/notes/a.md' },
    ], d, 'result').body).toEqual([{ type: 'task', id: 't-ok' }, { type: 'memory', id: '/notes/a.md' }]);
  });

  it('protects a router assignment even when the task lost its mark and its registry row', () => {
    const file = { version: 1 as const, areas: [], routers: [{ taskId: 'r1', areaId: 'personal', paused: true }], items: [] };
    expect([...taskScopes({ id: 'r1' }, file)]).toEqual(['personal']);
    expect(scopeAllows(new Set(), taskScopes({ id: 'r1' }, file))).toBe(false);
    expect(filterAreaPayload('text', d).body).toBe('text');
  });
});

// Last in the file: it adds marked tasks and sessions the list baselines above do not expect.
describe('mail copies read by a marked ordinary session', () => {
  beforeAll(ensureAreas);

  // The HTTP tool belt blocks generic routes; these checks exercise the shared reader rule directly.
  async function markedPersonalSid(): Promise<string> {
    const id = (await addTask({ title: 'Marked desk reader', project: 'Garden' })).task.id;
    await mark(id, { router_area_id: 'personal' });
    const sid = randomUUID();
    await createSessionRecord(sid, id, '', WALNUT_HOME, { profile: routerAreaProfile('personal', 'work'), mode: 'dontAsk' });
    await updateSessionRecord(sid, { process_status: 'stopped' });
    return sid;
  }
  const mailTarget = (message: string, acc = account) => ({ kind: 'mail' as const, account: acc, message });
  /**
   * Runs `body` against the registry with its items rewritten, then puts the file back byte for byte.
   * Written to the file directly: the registry's own update path never removes or replaces an item.
   */
  async function withItems(change: (items: RouterAreaItem[]) => RouterAreaItem[], body: () => Promise<void>): Promise<void> {
    const file = routerAreasPath(WALNUT_HOME);
    const saved = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(saved) as { items: RouterAreaItem[] };
    await fs.writeFile(file, JSON.stringify({ ...parsed, items: change(parsed.items) }, null, 2));
    try { await body(); } finally { await fs.writeFile(file, saved); }
  }

  it('the belt answers first over HTTP: a marked session reaches no ordinary mail route at all', async () => {
    const sid = await markedPersonalSid();
    expect((await call('GET', mailPath(account, personalMail.message), sid)).status).toBe(403);
  });

  it('an area caller reads only its own exact item: no copy, no other area, no unassigned mail', async () => {
    const sid = await markedPersonalSid();
    read.mockClear();
    expect(await judgeAreaRead({ sid }, mailTarget(personalMail.message))).toBe('pass');
    expect(await judgeAreaRead({ sid }, mailTarget(COPY))).toBe('deny');
    expect(await judgeAreaRead({ sid }, mailTarget(workMail.message))).toBe('deny');
    expect(await judgeAreaRead({ sid }, mailTarget('INBOX:1:99'))).toBe('deny');
    expect(await judgeAreaRead({ sid }, mailTarget(COPY, otherAccount))).toBe('deny');
    expect(await judgeAreaRead({ sid }, { kind: 'mail-op' }, { account, message: 'INBOX:1:99' })).toBe('deny');
    expect(await judgeAreaRead({ sid }, { kind: 'mail-op' }, { account, message: personalMail.message })).toBe('pass');
    // Ordinary positive control: no area, unassigned mail is readable, a copy and an area item are not.
    expect(await judgeAreaRead({ sid: ordinarySid }, mailTarget('INBOX:1:99'))).toBe('pass');
    expect(await judgeAreaRead({ sid: ordinarySid }, mailTarget(COPY, otherAccount))).toBe('pass');
    expect(await judgeAreaRead({ sid: ordinarySid }, mailTarget(COPY))).toBe('deny');
    expect(await judgeAreaRead({ sid: ordinarySid }, mailTarget(personalMail.message))).toBe('deny');
    const lists = (await buildAreaDenials({ sid }))!.denials.mail;
    expect(lists(account, personalMail.message, PERSONAL_KEY, PERSONAL_VERSION)).toBe(false);
    expect(lists(account, personalMail.message, PERSONAL_KEY)).toBe(true);
    expect(lists(account, COPY, mailRouterKey(account, COPY, RFC), currentVersion(account, COPY))).toBe(true);
    expect(lists(account, 'INBOX:1:99', mailRouterKey(account, 'INBOX:1:99', '<other@marina.example.invalid>'), currentVersion(account, 'INBOX:1:99'))).toBe(true);
    expect(read).not.toHaveBeenCalled();
  });

  it('a mail-op batch is judged message by message: one unconfirmed message refuses the whole batch', async () => {
    const sid = await markedPersonalSid();
    const batch = (...messages: string[]) => ({ account, messages });
    read.mockClear();
    expect(await judgeAreaRead({ sid }, { kind: 'mail-op' }, batch(personalMail.message))).toBe('pass');
    expect(await judgeAreaRead({ sid }, { kind: 'mail-op' }, { ...batch(personalMail.message), message: personalMail.message })).toBe('pass');
    for (const other of ['INBOX:1:99', COPY, workMail.message]) {
      expect(await judgeAreaRead({ sid }, { kind: 'mail-op' }, batch(personalMail.message, other))).toBe('deny');
      expect(await judgeAreaRead({ sid }, { kind: 'mail-op' }, { account, message: other, messages: [personalMail.message] })).toBe('deny');
    }
    // Ordinary control: a batch of unassigned mail passes; one assigned message in it refuses the batch.
    expect(await judgeAreaRead({ sid: ordinarySid }, { kind: 'mail-op' }, batch('INBOX:1:99', 'INBOX:1:98'))).toBe('pass');
    expect(await judgeAreaRead({ sid: ordinarySid }, { kind: 'mail-op' }, batch('INBOX:1:99', personalMail.message))).toBe('deny');
    expect(await judgeAreaRead({ sid: ordinarySid }, { kind: 'mail-op' }, batch('INBOX:1:99', COPY))).toBe('deny');
    expect(read).not.toHaveBeenCalled();
  });

  it('an exact item is not cleared on its own when the adapter cannot give its key in a keyed account', async () => {
    const sid = await markedPersonalSid();
    stopSource();
    try {
      expect(await judgeAreaRead({ sid }, mailTarget(personalMail.message))).toBe('unverifiable');
      expect(await judgeAreaRead({ sid }, { kind: 'mail-op' }, { account, messages: [personalMail.message] })).toBe('unverifiable');
    } finally {
      stopSource = registerRouterSource('mail', { resolve, read });
    }
  });

  it('a legacy registry row with no delivery version restricts its message and grants no area', async () => {
    const LEGACY = 'INBOX:1:40';
    const legacyItem = { source: { kind: 'mail' as const, account, message: LEGACY }, areaId: 'personal' } as RouterAreaItem;
    const sid = await markedPersonalSid();
    await withItems((items) => [...items, legacyItem], async () => {
      read.mockClear();
      for (const who of [sid, personalSid, ordinarySid]) {
        expect(await judgeAreaRead({ sid: who }, mailTarget(LEGACY))).toBe('deny');
        expect(await judgeAreaRead({ sid: who }, { kind: 'mail-op' }, { account, message: LEGACY })).toBe('deny');
        const lists = (await buildAreaDenials({ sid: who }))!.denials.mail;
        expect(lists(account, LEGACY, mailRouterKey(account, LEGACY), currentVersion(account, LEGACY))).toBe(true);
        expect(lists(account, LEGACY, mailRouterKey(account, LEGACY))).toBe(true);
      }
      // The versioned items beside it keep their grant.
      expect(await judgeAreaRead({ sid }, mailTarget(personalMail.message))).toBe('pass');
      expect(read).not.toHaveBeenCalled();
    });
  });

  it('a later delivery of a confirmed message is denied to every caller until it is confirmed itself', async () => {
    const sid = await markedPersonalSid();
    const handle = cacheKeyOf(account, personalMail.message);
    cacheGeneration.set(handle, 2);
    try {
      const next = currentVersion(account, personalMail.message);
      expect(next).not.toBe(PERSONAL_VERSION);
      for (const who of [sid, personalSid, ordinarySid]) {
        expect(await judgeAreaRead({ sid: who }, mailTarget(personalMail.message))).toBe('deny');
        expect(await judgeAreaRead({ sid: who }, { kind: 'mail-op' }, { account, message: personalMail.message })).toBe('deny');
        expect((await buildAreaDenials({ sid: who }))!.denials.mail(account, personalMail.message, PERSONAL_KEY, next)).toBe(true);
      }
    } finally {
      cacheGeneration.delete(handle);
    }
    expect(await judgeAreaRead({ sid }, mailTarget(personalMail.message))).toBe('pass');
  });

  it('a returned message of another delivery than the confirmed one is filtered out of the answer', async () => {
    const sid = await markedPersonalSid();
    const { denials } = (await buildAreaDenials({ sid }))!;
    const row = (version?: string) => ({ accountId: account, messageId: personalMail.message, rfcMessageId: RFC, ...(version ? { deliveryVersion: version } : {}) });
    const next = versionOf(account, personalMail.message, 2);
    // The single-message answer: the judged delivery passes, a newer one or none is refused whole.
    const confirmed = { message: row(PERSONAL_VERSION), body: { text: 'own body' } };
    expect(filterAreaPayload(confirmed, denials, 'mail')).toEqual({ body: confirmed });
    for (const version of [next, undefined]) {
      expect(filterAreaPayload({ message: row(version), body: { text: PRIVATE } }, denials, 'mail').denied).toBe(true);
    }
    // A list answer keeps only the confirmed delivery's row.
    const listed = filterAreaPayload({ messages: [row(PERSONAL_VERSION), row(next), row()] }, denials, 'mail').body as { messages: unknown[] };
    expect(listed.messages).toEqual([row(PERSONAL_VERSION)]);
    // Confirmed at the later delivery instead: the old one coming back is filtered the same way.
    const later = { source: { kind: 'mail' as const, account, message: personalMail.message, version: next }, areaId: 'personal', canonicalKey: PERSONAL_KEY } as RouterAreaItem;
    await withItems((items) => items.map((i) => (i.source.message === personalMail.message ? later : i)), async () => {
      const fresh = (await buildAreaDenials({ sid }))!.denials;
      expect(filterAreaPayload({ message: row(PERSONAL_VERSION), body: { text: PRIVATE } }, fresh, 'mail').denied).toBe(true);
      expect(filterAreaPayload({ message: row(next) }, fresh, 'mail').denied).toBeUndefined();
    });
    // The file is back: the original confirmation grants again.
    expect(filterAreaPayload({ message: row(PERSONAL_VERSION) }, (await buildAreaDenials({ sid }))!.denials, 'mail').denied).toBeUndefined();
  });

  it('bad mail-op input is refused before any lookup: 400 over HTTP, AreaBadInput to a direct caller', async () => {
    const sid = await markedPersonalSid();
    const many = Array.from({ length: 26 }, (_, i) => `INBOX:7:${i}`);
    const bad = [{ account, messages: many }, { account, message: 'INBOX:7:99', messages: many.slice(0, 25) }, { account, message: 'x'.repeat(1001) }, { account, messages: ['y'.repeat(1001)] }, { account: 'a'.repeat(321), message: personalMail.message }];
    resolve.mockClear();
    read.mockClear();
    for (const body of bad) {
      for (const who of [sid, ordinarySid]) await expect(judgeAreaRead({ sid: who }, { kind: 'mail-op' }, body)).rejects.toBeInstanceOf(AreaBadInput);
      const response = await call('POST', '/api/plugin-runtime/mail/ops/mail_mark_read', ordinarySid, body);
      expect(response.status).toBe(400);
      expect(await response.text()).toContain('area_bad_request');
    }
    expect(resolve).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it('25 ids are allowed and each judged on its own; ids are trimmed as the mail surface trims them', async () => {
    const sid = await markedPersonalSid();
    const own = Array.from({ length: 25 }, () => personalMail.message);
    expect(await judgeAreaRead({ sid }, { kind: 'mail-op' }, { account, messages: own })).toBe('pass');
    expect(await judgeAreaRead({ sid }, { kind: 'mail-op' }, { account, message: personalMail.message, messages: own })).toBe('pass');
    expect(await judgeAreaRead({ sid }, { kind: 'mail-op' }, { account, messages: [...own.slice(1), 'INBOX:1:99'] })).toBe('deny');
    expect(await judgeAreaRead({ sid: ordinarySid }, { kind: 'mail-op' }, { account, messages: [...Array(24).fill('INBOX:1:99'), ` ${personalMail.message} `] })).toBe('deny');
    expect(await judgeAreaRead({ sid: ordinarySid }, { kind: 'mail-op' }, { account: ` ${account} `, message: personalMail.message })).toBe('deny');
    expect(read).not.toHaveBeenCalled();
  });
});

describe('a live inbound rule whose confirm has not landed', () => {
  // The fixture cache names every sender pat@marina.example.invalid; the rule targets an open task.
  let targetId = '';
  const fresh = { kind: 'mail' as const, account, message: 'INBOX:1:77' };
  const row = (from: unknown, subject = 'META_ONLY') => ({
    accountId: account, messageId: fresh.message, rfcMessageId: '', deliveryVersion: currentVersion(account, fresh.message), from, subject,
  });
  beforeAll(async () => {
    await ensureAreas();
    targetId = (await addTask({ title: 'Rota inbox', project: 'Garden' })).task.id;
    const rule = await setRoutingRule(WALNUT_HOME, { from: 'pat@marina.example.invalid', taskId: targetId }, { by: 'human' });
    await updateRouterAreas(WALNUT_HOME, (file) => ({
      ...file, ruleBindings: [{ ruleId: rule.id, revision: routerRuleRevision(rule), areaId: 'personal', confirmedAt: 1 }],
    }));
  });
  afterAll(async () => {
    await updateRouterAreas(WALNUT_HOME, ({ ruleBindings: _drop, ...file }) => file);
    await fs.rm(routingRulesPath(WALNUT_HOME), { force: true });
  });

  it('denies an ordinary session and the own area alike, an unlisted account included, with no body read', async () => {
    read.mockClear();
    expect(await judgeAreaRead({ sid: ordinarySid }, { kind: 'mail', ...fresh })).toBe('deny');
    expect(await judgeAreaRead({ sid: personalSid }, { kind: 'mail', ...fresh })).toBe('deny');
    expect(await judgeAreaRead(AUTOMATION, { kind: 'mail', account: otherAccount, message: 'INBOX:1:77' })).toBe('deny');
    expect(await judgeAreaRead({ sid: ordinarySid }, { kind: 'mail-op' }, { account: otherAccount, message: 'INBOX:1:77' })).toBe('deny');
    expect(await judgeAreaRead({ sid: ordinarySid }, { kind: 'mail-op' }, { message: 'INBOX:1:77' })).toBe('unverifiable');
    expect(await judgeAreaRead({ sid: personalSid }, { kind: 'mail', account, message: PERSONAL_MESSAGE })).toBe('pass');
    expect(read).not.toHaveBeenCalled();
  });

  it('list rows are judged by their own sender and subject: a match is denied, a true miss stays readable', async () => {
    const built = (await buildAreaDenials({ sid: ordinarySid }))!;
    expect(built.none).toBe(false);
    expect(rowDenied(row({ name: 'Pat', address: 'pat@marina.example.invalid' }), 'mail', built.denials)).toBe(true);
    expect(rowDenied(row('pat@marina.example.invalid'), 'mail', built.denials)).toBe(true);
    expect(rowDenied(row({ address: 'news@paper.example.invalid' }, 'Morning edition'), 'mail', built.denials)).toBe(false);
    expect(rowDenied(row(undefined), 'mail', built.denials)).toBe(true);
    const own = (await buildAreaDenials({ sid: personalSid }))!;
    expect(rowDenied(row({ address: 'pat@marina.example.invalid' }), 'mail', own.denials)).toBe(true);
  });

  it('a complete target is no rule, and an unreadable rule file fails closed', async () => {
    await mark(targetId, { phase: 'COMPLETE' });
    try {
      expect(await judgeAreaRead({ sid: ordinarySid }, { kind: 'mail', ...fresh })).toBe('pass');
    } finally {
      await mark(targetId, { phase: 'TODO' });
    }
    const saved = await fs.readFile(routingRulesPath(WALNUT_HOME), 'utf-8');
    await fs.writeFile(routingRulesPath(WALNUT_HOME), '{ not json', 'utf-8');
    try {
      expect(await judgeAreaRead({ sid: ordinarySid }, { kind: 'mail', ...fresh })).toBe('unverifiable');
      expect(await buildAreaDenials({ sid: ordinarySid })).toBeUndefined();
      expect(await judgeAreaRead({ sid: ordinarySid }, { kind: 'task', id: ordinaryId })).toBe('pass');
    } finally {
      await fs.writeFile(routingRulesPath(WALNUT_HOME), saved, 'utf-8');
    }
  });
});
