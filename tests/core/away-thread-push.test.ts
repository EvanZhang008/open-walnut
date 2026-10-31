/**
 * One buzz per absence (human-inbox/away-thread.ts): a letter or a thread turn sent `quiet` never
 * reaches the phone, through the real bus and the real letter push subscriber; anything else still does.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('away-thread-push'));

const getConfig = vi.hoisted(() => vi.fn());
const updatePushTokens = vi.hoisted(() => vi.fn(async () => []));
const sendApns = vi.hoisted(() => vi.fn(async () => ({ attempted: true, sent: 1, failed: 0, deadTokens: [] as string[] })));
vi.mock('../../src/core/config-manager.js', () => ({ getConfig, updatePushTokens }));
vi.mock('../../src/core/push/apns.js', () => ({
  sendApns,
  apnsStatus: vi.fn(async () => ({ configured: true, environment: 'production', topic: 'test' })),
}));
vi.mock('../../src/web/ws/handler.js', () => ({ clientCount: () => 0 }));
vi.mock('../../src/core/notifications/letter-bridge.js', () => ({ ensureLetterBridge: () => {}, mirrorLetterReadState: vi.fn(async () => {}) }));

import { initLetterPush, resetLetterPushForTests } from '../../src/core/push/letter-push.js';
import { agentReply, humanInboxPaths, sendLetter } from '../../src/core/human-inbox/store.js';

const sender = { sessionId: 's-lead', taskId: 't-lead', host: 'local' };

beforeEach(() => {
  fs.rmSync(humanInboxPaths.dir, { recursive: true, force: true });
  sendApns.mockClear();
  getConfig.mockResolvedValue({ push_tokens: [{ token: 'd'.repeat(64), key_name: 'phone', platform: 'ios' }] });
  resetLetterPushForTests();
  initLetterPush();
});

describe('quiet letters and turns never buzz', () => {
  it('the first letter buzzes, a quiet turn does not, a loud turn does', async () => {
    const l = await sendLetter({ subject: 'Deploy is live', type: 'info', markdown: 'x', sender }, { awayThread: { taskId: 't-lead', since: 1 } });
    await vi.waitFor(() => expect(sendApns).toHaveBeenCalledTimes(1), { timeout: 5_000, interval: 25 });
    await agentReply(l.id, { text: 'Review the plan' }, { quiet: true });
    await sendLetter({ subject: 'Start?', type: 'action_required', markdown: 'y', actions: [{ id: 'go', label: 'Go' }], sender }, { quiet: true });
    await new Promise((r) => setTimeout(r, 300));
    expect(sendApns).toHaveBeenCalledTimes(1);
    await agentReply(l.id, { text: 'Tests green' });
    await vi.waitFor(() => expect(sendApns).toHaveBeenCalledTimes(2), { timeout: 5_000, interval: 25 });
  });
});
