import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { createMockConstants } from '../helpers/mock-constants.js';
vi.mock('../../src/constants.js', () => createMockConstants('item-origin'));
import { actionsV1Router } from '../../src/web/routes/actions-v1.js';
import { executeOp } from '../../src/ops/index.js';

describe('Human actions do not borrow session identity', () => {
  it('ignores forged Host ports and environment session ids on registry self-calls; a session\'s call runs as that session', async () => {
    const app = express(); app.use(express.json());
    let sid: unknown = 'not-called';
    app.post('/api/v1/messages', (req, res) => { sid = req.headers['x-walnut-caller-sid']; res.status(202).json({ delivery: 'queued', targetTaskId: 'task-id', targetSessionId: 'session-id' }); });
    app.use('/api/v1', actionsV1Router);
    const server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const root = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    vi.stubEnv('WALNUT_SESSION_ID', 'ambient-session');
    try {
      // A person's click: no caller header, and the server's own environment lends none.
      const response = await fetch(`${root}/api/v1/actions/invoke`, { method: 'POST', headers: { 'Content-Type': 'application/json', Host: 'example.invalid:3456' }, body: JSON.stringify({ tool: 'task_send', args: { to: 'task-id', text: 'Human work', expect_reply: false }, confirmed: true }) });
      expect(response.status).toBe(200); expect((await response.json()).ok).toBe(true); expect(sid).toBeUndefined();
      // A session's call (2026-10-27): it runs as that session, under the rules a session meets, never as the user.
      sid = 'not-called';
      const bySession = await fetch(`${root}/api/v1/actions/invoke`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-walnut-caller-sid': 'calling-session' }, body: JSON.stringify({ tool: 'task_send', args: { to: 'task-id', text: 'Session work', expect_reply: false }, confirmed: true }) });
      expect(bySession.status).toBe(200); expect(sid).toBe('calling-session');
      const outcome = await executeOp('task_send', { to: 'task-id', text: 'Another human work', expect_reply: false }, { apiBase: root, callerMode: 'human', callerSid: 'explicit-session', origin: '__local__' });
      expect(outcome.ok).toBe(true); expect(sid).toBeUndefined();
    } finally { vi.unstubAllEnvs(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
