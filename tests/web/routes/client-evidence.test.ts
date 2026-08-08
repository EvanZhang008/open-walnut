/**
 * Tests for POST /api/client-evidence — the untruncated browser-divergence
 * upload (inc-1786165723472's forensics gap: the console-log forwarder caps
 * args at 1000 chars, so flight traces arrived ~94% truncated).
 *
 * Contract under test:
 *   - payload persists VERBATIM (a 200-entry trace survives end-to-end);
 *   - a durable incident opens (trigger 'client', label = kind), deduped;
 *   - captureBundle picks the evidence up as client-evidence.json;
 *   - per-session file cap prunes old uploads;
 *   - invalid payloads → 400, never a crash.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-client-evidence'));

import express from 'express';
import request from 'supertest';
import { LOG_DIR, WALNUT_HOME } from '../../../src/constants.js';
import { clientEvidenceRouter, CLIENT_EVIDENCE_DIR, latestClientEvidence } from '../../../src/web/routes/client-evidence.js';

function createApp() {
  const app = express();
  app.use(express.json({ limit: '15mb' }));
  app.use('/api/client-evidence', clientEvidenceRouter);
  return app;
}

beforeEach(() => {
  fs.rmSync(LOG_DIR, { recursive: true, force: true });
  fs.rmSync(WALNUT_HOME, { recursive: true, force: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.mkdirSync(WALNUT_HOME, { recursive: true });
});

describe('POST /api/client-evidence', () => {
  it('persists the full payload verbatim — a 200-entry flight trace survives untruncated', async () => {
    const trace = Array.from({ length: 200 }, (_, i) => ({
      t: i, ev: 'session:text-delta', d: { msgId: `msg_bdrk_${'x'.repeat(50)}_${i}`, len: i },
    }));
    const unmatched = Array.from({ length: 78 }, (_, i) => ({
      index: i, kind: 'tool_call', reason: 'no toolUseId twin in delta',
    }));

    const res = await request(createApp()).post('/api/client-evidence').send({
      sessionId: 'sid-full-trace',
      kind: 'render-filter-no-twin',
      flightTrace: trace,
      unmatched,
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const stored = JSON.parse(latestClientEvidence('sid-full-trace')!);
    expect(stored.flightTrace).toHaveLength(200);
    expect(stored.unmatched).toHaveLength(78);
    // Verbatim: the deepest field round-trips exactly.
    expect(stored.flightTrace[199].d.msgId).toBe(trace[199].d.msgId);
  });

  it('opens a durable client-trigger incident, deduped within the window', async () => {
    const app = createApp();
    const send = () => request(app).post('/api/client-evidence').send({
      sessionId: 'sid-incident', kind: 'render-filter-no-twin', unmatched: [{ index: 0 }],
    });
    const first = await send();
    expect(first.status).toBe(200);
    expect(typeof first.body.incidentId).toBe('string');

    // Second fire inside the dedup window → evidence file still written, no new incident.
    const second = await send();
    expect(second.status).toBe(200);
    expect(second.body.incidentId).toBeUndefined();

    const { listIncidents } = await import('../../../src/core/observability/incidents.js');
    const incidents = (await listIncidents()).filter(i => i.sessionId === 'sid-incident');
    expect(incidents).toHaveLength(1);
    expect(incidents[0].trigger).toBe('client');
    expect(incidents[0].label).toBe('render-filter-no-twin');
  });

  it('captureBundle includes the evidence as client-evidence.json', async () => {
    await request(createApp()).post('/api/client-evidence').send({
      sessionId: 'sid-bundle', kind: 'render-filter-no-twin',
      flightTrace: [{ t: 1, ev: 'session:result' }],
    });

    const { captureBundle } = await import('../../../src/core/observability/bundle.js');
    const dir = await captureBundle('sid-bundle');
    const evidencePath = path.join(dir, 'client-evidence.json');
    expect(fs.existsSync(evidencePath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(evidencePath, 'utf-8'));
    expect(parsed.kind).toBe('render-filter-no-twin');
    expect(parsed.flightTrace).toHaveLength(1);
  });

  it('caps stored files per session (prunes oldest)', async () => {
    const app = createApp();
    for (let i = 0; i < 8; i++) {
      await request(app).post('/api/client-evidence').send({
        sessionId: 'sid-prune', kind: 'render-filter-no-twin', unmatched: [{ seq: i }],
      });
      // Filename timestamps are Date.now() — space them out one tick.
      await new Promise(r => setTimeout(r, 2));
    }
    const files = fs.readdirSync(CLIENT_EVIDENCE_DIR).filter(f => f.startsWith('sid-prune-'));
    expect(files.length).toBeLessThanOrEqual(5);
    // The newest survives.
    const newest = JSON.parse(latestClientEvidence('sid-prune')!);
    expect(newest.unmatched[0].seq).toBe(7);
  });

  it('rejects payloads missing sessionId or kind with 400', async () => {
    const app = createApp();
    expect((await request(app).post('/api/client-evidence').send({ kind: 'x' })).status).toBe(400);
    expect((await request(app).post('/api/client-evidence').send({ sessionId: 's' })).status).toBe(400);
    expect((await request(app).post('/api/client-evidence').send({})).status).toBe(400);
  });
});
