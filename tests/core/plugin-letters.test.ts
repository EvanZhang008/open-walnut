/**
 * `walnut.letters`: the host seam a plugin uses to ask the ONE human a question.
 *
 * Graded against the REAL letter store on disk and the real HTTP answer route, because every
 * property below is about how the two halves meet rather than about either one alone:
 *
 * - The envelope is stamped host-side (`sessionId: 'external'` plus the plugin id), so a plugin
 *   cannot claim to be a session and `onAnswered` has an exact filter to key on.
 * - An answer comes back as an EVENT. A plugin letter has no origin session, so
 *   `deliverLetterToOrigin` skips it by design and the bus is the only return path there is.
 * - The filter is exact: another plugin's letter and a session's letter are NOT delivered. An
 *   approval ledger handed a letter id it never issued is a collision waiting to happen.
 * - `withdraw` answers the letter server-side so a stale approval can never be tapped, is
 *   idempotent against a human who tapped a moment earlier, and announces itself as `'plugin'`.
 * - The rate limit is a real ceiling. A letter badges the bell and pushes to the phone, so a
 *   runaway loop is refused with words rather than allowed to bury the human.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('plugin-letters-test'));
vi.mock('../../src/core/config-manager.js', () => ({
  getConfig: vi.fn(async () => ({ plugins: {} })),
  updatePluginConfig: vi.fn(async (_id: string, patch: Record<string, unknown>) => patch),
}));

const mirrorLetterReadState = vi.fn(async () => {});
vi.mock('../../src/core/notifications/letter-bridge.js', () => ({
  ensureLetterBridge: () => {},
  mirrorLetterReadState: (...args: unknown[]) => mirrorLetterReadState(...args),
}));

const getSessionByClaudeId = vi.fn(async () => undefined);
vi.mock('../../src/core/session-tracker.js', () => ({
  getSessionByClaudeId: (...args: unknown[]) => getSessionByClaudeId(...args),
}));

import { WALNUT_HOME } from '../../src/constants.js';
import { bus } from '../../src/core/event-bus.js';
import type { HumanInboxAnsweredEvent } from '../../src/core/event-types.js';
import { IntegrationRegistry } from '../../src/core/integration-registry.js';
import { PluginContext, type PluginLogger } from '../../src/core/plugins/plugin-context.js';
import {
  createServerPluginApi,
  _resetPluginLetterQuotaForTesting,
} from '../../src/core/plugins/server-api.js';
import {
  getLetter,
  humanInboxPaths,
  sendLetter,
  WITHDRAWN_ACTION_ID,
} from '../../src/core/human-inbox/store.js';
import { humanInboxV1Router } from '../../src/web/routes/human-inbox-v1.js';
import { createTestPluginApi } from './plugin-test-utils.js';

const logger: PluginLogger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => logger),
};

const contexts: PluginContext[] = [];
const answered: HumanInboxAnsweredEvent[] = [];

function pluginApi(pluginId: string) {
  const context = new PluginContext({
    id: pluginId,
    dataDir: path.join(WALNUT_HOME, 'plugin-data', pluginId),
    logger,
  });
  contexts.push(context);
  const { api: legacyApi, collected } = createTestPluginApi({ id: pluginId, name: pluginId });
  return createServerPluginApi({
    context,
    pluginName: pluginId,
    legacyApi,
    contributions: collected,
    integrationRegistry: new IntegrationRegistry(),
  });
}

/** The real answer route, so the `source` argument is exercised where it is actually passed. */
function answerApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', humanInboxV1Router);
  return app;
}

/** The bus is asynchronous per subscriber; give the fan-out a turn before asserting. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  fs.rmSync(humanInboxPaths.dir, { recursive: true, force: true });
  _resetPluginLetterQuotaForTesting();
  answered.length = 0;
  mirrorLetterReadState.mockClear();
  bus.subscribe('plugin-letters-observer', (event) => {
    if (event.name === 'human-inbox:answered') answered.push(event.data as HumanInboxAnsweredEvent);
  }, { global: true, interest: ['human-inbox:answered'] });
});

afterEach(async () => {
  bus.unsubscribe('plugin-letters-observer');
  for (const context of contexts.splice(0)) await context.dispose().catch(() => undefined);
});

describe('walnut.letters.send', () => {
  it('stamps the envelope host-side and makes a letter with actions a decision', async () => {
    const walnut = pluginApi('mail');

    const { letterId } = await walnut.letters.send({
      subject: 'Approve this send',
      markdown: 'To: alice@example.invalid\n\n> the draft body',
      actions: [{ id: 'send', label: 'Send' }, { id: 'discard', label: 'Discard' }],
      pin: true,
    });

    const stored = await getLetter(letterId);
    // The plugin never wrote any of this: a caller that could set `sessionId` could aim a
    // letter's answer at somebody else's session.
    expect(stored!.sender).toEqual({ sessionId: 'external', host: 'local', pluginId: 'mail' });
    expect(stored!.type).toBe('action_required');
    expect(stored!.actions!.map((one) => one.id)).toEqual(['send', 'discard']);
    expect(stored!.pinned).toBe(true);
    expect(stored!.body).toContain('the draft body');
  });

  it('makes a letter with no actions a document, not a dead-end decision', async () => {
    const walnut = pluginApi('mail');

    const { letterId } = await walnut.letters.send({ subject: 'Nothing to decide', markdown: 'FYI' });

    // The store REFUSES `action_required` with no buttons, so the type has to follow the
    // actions rather than being assumed: a decision badge with nothing to tap is a bug.
    expect((await getLetter(letterId))!.type).toBe('info');
  });

  it('refuses past 30 letters a minute, with a message the author can act on', async () => {
    const walnut = pluginApi('noisy');

    for (let at = 0; at < 30; at += 1) {
      await walnut.letters.send({ subject: `Item ${at}`, markdown: 'one of many' });
    }

    await expect(walnut.letters.send({ subject: 'Item 31', markdown: 'one too many' }))
      .rejects.toThrow(/30 letters in the last minute/);
    // The refusal is per plugin, not global: another plugin's approval must not be collateral.
    await expect(pluginApi('quiet').letters.send({ subject: 'Unrelated', markdown: 'fine' }))
      .resolves.toMatchObject({ letterId: expect.stringMatching(/^lt-/) });
  }, 30_000);
});

describe('an answer through the route', () => {
  it('reaches the sending plugin as an event, with the source the route knows', async () => {
    const walnut = pluginApi('mail');
    const heard: HumanInboxAnsweredEvent[] = [];
    walnut.letters.onAnswered((event) => { heard.push(event) });
    const { letterId } = await walnut.letters.send({
      subject: 'Approve this send',
      markdown: 'the draft',
      actions: [{ id: 'send', label: 'Send' }],
    });

    const answer = await request(answerApp())
      .post(`/api/v1/human-inbox/${letterId}/answer`)
      .send({ actionId: 'send', freeText: 'go ahead' })
      .expect(200);

    // A plugin letter has NO origin session, so the delivery is skipped by design and the bus
    // event is the whole return path.
    expect(answer.body.delivery).toMatchObject({ status: 'skipped', reason: 'no_origin_session' });
    await settle();
    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatchObject({
      letterId,
      actionId: 'send',
      label: 'Send',
      freeText: 'go ahead',
      source: 'web',
      pluginId: 'mail',
    });
    expect(heard[0]!.answeredAt).toBeGreaterThan(0);
  });

  it('says phone when the request came from a paired device', async () => {
    const walnut = pluginApi('mail');
    const { letterId } = await walnut.letters.send({
      subject: 'Approve from the phone',
      markdown: 'the draft',
      actions: [{ id: 'send', label: 'Send' }],
    });
    // The route's only device signal is the identity the auth middleware attached, so the test
    // attaches the same thing rather than inventing a header the route does not read.
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as express.Request & { deviceName?: string }).deviceName = 'evan-iphone';
      next();
    });
    app.use('/api/v1', humanInboxV1Router);

    await request(app).post(`/api/v1/human-inbox/${letterId}/answer`).send({ actionId: 'send' }).expect(200);

    await settle();
    expect(answered.map((one) => one.source)).toEqual(['phone']);
  });

  it('is refused the second time, so one letter is one decision', async () => {
    const walnut = pluginApi('mail');
    const { letterId } = await walnut.letters.send({
      subject: 'Approve this send',
      markdown: 'the draft',
      actions: [{ id: 'send', label: 'Send' }],
    });
    const app = answerApp();

    await request(app).post(`/api/v1/human-inbox/${letterId}/answer`).send({ actionId: 'send' }).expect(200);
    const second = await request(app)
      .post(`/api/v1/human-inbox/${letterId}/answer`)
      .send({ actionId: 'send' })
      .expect(409);

    expect(second.body.error.code).toBe('conflict');
    await settle();
    // ONE event, whatever the caller does. Two would let a ledger keyed on the letter act twice.
    expect(answered).toHaveLength(1);
  });
});

describe('the onAnswered filter', () => {
  it('delivers only this plugin\'s own letters', async () => {
    const mine = pluginApi('mail');
    const theirs = pluginApi('calendar');
    const heard: string[] = [];
    mine.letters.onAnswered((event) => { heard.push(event.letterId) });

    const own = await mine.letters.send({
      subject: 'Mine', markdown: 'x', actions: [{ id: 'ok', label: 'OK' }],
    });
    const other = await theirs.letters.send({
      subject: 'Theirs', markdown: 'x', actions: [{ id: 'ok', label: 'OK' }],
    });
    // And a letter from a real SESSION, which carries no plugin id at all.
    const session = await sendLetter({
      subject: 'From a session',
      type: 'action_required',
      markdown: 'x',
      actions: [{ id: 'ok', label: 'OK' }],
      sender: { sessionId: 'sess-origin-1', host: 'workstation' },
    });

    const app = answerApp();
    for (const id of [own.letterId, other.letterId, session.id]) {
      await request(app).post(`/api/v1/human-inbox/${id}/answer`).send({ actionId: 'ok' }).expect(200);
    }
    await settle();

    expect(heard).toEqual([own.letterId]);
    // All three really were answered: the filter dropped two, it did not stop them happening.
    expect(answered.map((one) => one.pluginId)).toEqual(['mail', 'calendar', undefined]);
  });

  it('stops delivering once the plugin is disposed', async () => {
    const walnut = pluginApi('mail');
    const heard: string[] = [];
    const handle = walnut.letters.onAnswered((event) => { heard.push(event.letterId) });
    const { letterId } = await walnut.letters.send({
      subject: 'Mine', markdown: 'x', actions: [{ id: 'ok', label: 'OK' }],
    });

    await handle.dispose();
    await request(answerApp()).post(`/api/v1/human-inbox/${letterId}/answer`).send({ actionId: 'ok' }).expect(200);
    await settle();

    expect(heard).toEqual([]);
    expect(answered).toHaveLength(1);
  });
});

describe('withdraw', () => {
  it('answers the letter server-side so a stale approval cannot be tapped', async () => {
    const walnut = pluginApi('mail');
    const { letterId } = await walnut.letters.send({
      subject: 'Approve this send',
      markdown: 'revision 1',
      actions: [{ id: 'send', label: 'Send' }],
    });

    await walnut.letters.withdraw(letterId, { note: 'This draft was edited; a fresh letter follows' });

    const state = await walnut.letters.get(letterId);
    expect(state).toMatchObject({
      letterId,
      subject: 'Approve this send',
      answered: { actionId: WITHDRAWN_ACTION_ID, label: 'Withdrawn' },
    });
    expect(state!.answered!.freeText).toContain('a fresh letter follows');
    // The phone's Send button is no longer live: the inbox itself refuses a second answer.
    await request(answerApp())
      .post(`/api/v1/human-inbox/${letterId}/answer`)
      .send({ actionId: 'send' })
      .expect(409);
    await settle();
    expect(answered).toEqual([expect.objectContaining({
      letterId, actionId: WITHDRAWN_ACTION_ID, source: 'plugin', pluginId: 'mail',
    })]);
  });

  it('is idempotent against a human who answered a moment earlier', async () => {
    const walnut = pluginApi('mail');
    const { letterId } = await walnut.letters.send({
      subject: 'Approve this send',
      markdown: 'revision 1',
      actions: [{ id: 'send', label: 'Send' }],
    });
    await request(answerApp()).post(`/api/v1/human-inbox/${letterId}/answer`).send({ actionId: 'send' }).expect(200);
    await settle();

    // No throw: the caller withdraws because the world moved on, and a race with the human is
    // not an error it should have to special-case.
    await expect(walnut.letters.withdraw(letterId, { note: 'too late' })).resolves.toBeUndefined();

    // The human's record stands, untouched, and no second event was announced.
    expect((await walnut.letters.get(letterId))!.answered).toMatchObject({ actionId: 'send', label: 'Send' });
    expect(answered).toHaveLength(1);
  });

  it('leaves an unread letter unread: nobody looked at it', async () => {
    const walnut = pluginApi('mail');
    const { letterId } = await walnut.letters.send({
      subject: 'Approve this send', markdown: 'x', actions: [{ id: 'send', label: 'Send' }],
    });

    await walnut.letters.withdraw(letterId, { note: 'superseded' });

    expect((await getLetter(letterId))!.read).toBe(false);
  });
});

describe('reply and get', () => {
  it('adds a thread turn and reports the letter state without reading the document', async () => {
    const walnut = pluginApi('mail');
    const { letterId } = await walnut.letters.send({
      subject: 'Approve this send',
      markdown: 'the draft',
      actions: [{ id: 'send', label: 'Send' }],
    });

    await walnut.letters.reply(letterId, { text: 'Sent at 14:02 to 1 recipient' });

    const thread = (await getLetter(letterId))!.thread;
    expect(thread).toHaveLength(1);
    expect(thread[0]).toMatchObject({ from: 'agent', text: 'Sent at 14:02 to 1 recipient' });

    const state = await walnut.letters.get(letterId);
    expect(state).toEqual({
      letterId,
      subject: 'Approve this send',
      actions: [{ id: 'send', label: 'Send' }],
    });
    // A rich reply with no plain text is derived rather than refused: the thread always renders
    // text, and the store would otherwise reject the turn.
    await walnut.letters.reply(letterId, { markdown: '**done**' });
    expect((await getLetter(letterId))!.thread).toHaveLength(2);

    expect(await walnut.letters.get('lt-nope-000001')).toBeNull();
  });
});
