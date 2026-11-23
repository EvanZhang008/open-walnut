/**
 * A message an engine's CLI refused for want of a sign-in on its host (EngineSignInRequiredError)
 * waits, and goes out by itself once that host signs in (sessions/agent-wait-resend.ts, rule
 * 'engine-signed-in'): a finished sign-in or a saved API key sends it, a status read sends it only
 * on a turn to signed in, and only the rows of sessions on that engine and host; a person's Retry
 * still sends it at once and Discard drops it (the queue's own rules, agent-wait-resend-guard.test.ts).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-engine-sign-in-resend'));

const records = new Map<string, { claudeSessionId: string; host?: string; engine?: string; taskId?: string; archived?: boolean }>();
vi.mock('../../../src/core/session-tracker.js', () => ({ getSessionByClaudeId: async (id: string) => records.get(id) ?? null }));

import { WALNUT_HOME } from '../../../src/constants.js';
import { AGENT_WAIT_RESEND, noteEngineSignedIn, resetAgentWaitResendForTests } from '../../../src/core/sessions/agent-wait-resend.js';
import { ENGINE_SIGN_IN_WAIT, EngineSignInRequiredError, classifyDeliveryFailure } from '../../../src/providers/delivery-failure.js';
import { enqueueMessage, getQueue, markProcessing, parkMessages, resetCache, unparkMessage } from '../../../src/core/session-message-queue.js';
import { bus, EventNames, type BusEvent } from '../../../src/core/event-bus.js';

const verdict = classifyDeliveryFailure(new EngineSignInRequiredError(
  'Antigravity is not signed in on devbox. Open Settings to sign in.', 'antigravity', 'devbox', 'devbox'));

async function parkedRow(sid: string, record: { host?: string; engine?: string }) {
  records.set(sid, { claudeSessionId: sid, taskId: `task-${sid}`, ...record });
  const row = await enqueueMessage(sid, `hello from ${sid}`);
  await parkMessages(await markProcessing(sid), verdict);
  return row;
}

const status = async (sid: string) => (await getQueue(sid)).map((m) => m.status);

describe('a message waiting for its host to sign the engine in', () => {
  let sends: string[] = [];
  let off: () => void = () => {};

  beforeEach(async () => {
    await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
    await fsp.mkdir(WALNUT_HOME, { recursive: true });
    resetCache();
    resetAgentWaitResendForTests();
    records.clear();
    sends = [];
    bus.subscribe('engine-sign-in-resend-test', (e: BusEvent) => {
      if (e.name === EventNames.SESSION_SEND) sends.push(String((e.data as { sessionId?: string }).sessionId));
    }, { global: true });
    off = () => bus.unsubscribe('engine-sign-in-resend-test');
  });
  afterEach(async () => {
    off();
    resetCache();
    await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {});
  });

  it('is parked with the sign-in wait, which has a rule that sends it', async () => {
    expect(verdict).toMatchObject({ kind: 'permanent', code: 'sign_in_required', waitsFor: ENGINE_SIGN_IN_WAIT });
    expect(AGENT_WAIT_RESEND[ENGINE_SIGN_IN_WAIT]).toBe('engine-signed-in');
    const row = await parkedRow('s-devbox', { host: 'devbox', engine: 'antigravity' });
    expect((await getQueue('s-devbox'))[0]).toMatchObject({ id: row.id, status: 'parked', waitsFor: ENGINE_SIGN_IN_WAIT });
  });

  it('goes out once that host signs in, and only on that host and engine', async () => {
    await parkedRow('s-devbox', { host: 'devbox', engine: 'antigravity' })
    await parkedRow('s-other-host', { host: 'buildbox', engine: 'antigravity' })
    await parkedRow('s-other-engine', { host: 'devbox', engine: 'codex' })
    const sent = await noteEngineSignedIn('antigravity', 'devbox', true, { confirmed: true })
    expect(sent).toHaveLength(1)
    expect(await status('s-devbox')).toEqual(['pending'])
    expect(await status('s-other-host')).toEqual(['parked'])
    expect(await status('s-other-engine')).toEqual(['parked'])
    await new Promise((r) => setTimeout(r, 20))
    expect(sends).toEqual(['s-devbox'])
  });

  it('a saved API key (every host) sends every host\'s waiting rows of the engine', async () => {
    await parkedRow('s-devbox', { host: 'devbox', engine: 'antigravity' })
    await parkedRow('s-local', { engine: 'antigravity' })
    await parkedRow('s-claude', { host: 'devbox' })
    expect(await noteEngineSignedIn('antigravity', null, true, { confirmed: true })).toHaveLength(2)
    expect(await status('s-devbox')).toEqual(['pending'])
    expect(await status('s-local')).toEqual(['pending'])
    expect(await status('s-claude')).toEqual(['parked'])
  });

  it('a status read sends them only on a turn to signed in, so a host that keeps refusing never loops', async () => {
    await parkedRow('s-devbox', { host: 'devbox', engine: 'antigravity' })
    expect(noteEngineSignedIn('antigravity', 'devbox', false)).toBeUndefined()
    expect(await noteEngineSignedIn('antigravity', 'devbox', true)).toHaveLength(1)
    // Refused again and parked again: the next read that still says signed in sends nothing.
    await parkMessages(await markProcessing('s-devbox'), verdict)
    expect(noteEngineSignedIn('antigravity', 'devbox', true)).toBeUndefined()
    expect(await status('s-devbox')).toEqual(['parked'])
  });

  it('a person\'s Retry still sends it at once (the wait mark goes)', async () => {
    const row = await parkedRow('s-devbox', { host: 'devbox', engine: 'antigravity' })
    expect(await unparkMessage('s-devbox', row.id)).toBe(true)
    expect((await getQueue('s-devbox'))[0].waitsFor).toBeUndefined()
  });
});
