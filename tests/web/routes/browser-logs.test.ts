/**
 * POST /api/browser-logs: the REST path the browser logger uses as its
 * page-unload fallback, and the path the Mac app shell uses for its
 * page-process footprint samples (desktop/WebContentWatchdog.swift).
 *
 * The subsystem tag is what makes those entries findable
 * (`walnut-logs.sh desktop`), so this pins: `desktop` is honoured, everything
 * else (absent, unknown, an attempt to impersonate the server's own
 * subsystems) lands as `browser`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const written: Array<Record<string, unknown>> = [];
vi.mock('../../../src/logging/logger.js', () => ({
  writeLogEntry: (entry: Record<string, unknown>) => { written.push(entry); },
}));

import { browserLogsRouter } from '../../../src/web/routes/browser-logs.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/browser-logs', browserLogsRouter);
  return app;
}

beforeEach(() => { written.length = 0; });

describe('POST /api/browser-logs', () => {
  it('writes browser entries under subsystem=browser by default', async () => {
    const res = await request(createApp()).post('/api/browser-logs').send({
      entries: [{ time: '2026-09-02T18:00:00.000Z', level: 'warn', message: 'chunk failed', url: '/x' }],
    });
    expect(res.status).toBe(204);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ subsystem: 'browser', level: 'warn', message: 'chunk failed', url: '/x' });
  });

  it('tags the Mac app shell entries as subsystem=desktop, args preserved', async () => {
    const args = JSON.stringify({ footprintMB: '2310', level: 'critical', pid: '4242' });
    const res = await request(createApp()).post('/api/browser-logs').send({
      entries: [{
        time: '2026-09-02T18:00:00.000Z', level: 'error', subsystem: 'desktop',
        message: '[webcontent] page process footprint 2310MB (critical)', args,
      }],
    });
    expect(res.status).toBe(204);
    expect(written[0]).toMatchObject({ subsystem: 'desktop', level: 'error', args });
  });

  it('refuses to file an entry under an arbitrary subsystem (falls back to browser)', async () => {
    await request(createApp()).post('/api/browser-logs').send({
      entries: [
        { time: 't', level: 'info', message: 'a', subsystem: 'session' },
        { time: 't', level: 'info', message: 'b', subsystem: '' },
      ],
    });
    expect(written.map((e) => e.subsystem)).toEqual(['browser', 'browser']);
  });

  it('rejects a body without an entries array', async () => {
    const res = await request(createApp()).post('/api/browser-logs').send({ entries: 'nope' });
    expect(res.status).toBe(400);
    expect(written).toHaveLength(0);
  });
});
