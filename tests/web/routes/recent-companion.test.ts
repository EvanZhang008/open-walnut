/** A native phone using the companion reads and writes the primary's verified list. */
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../../helpers/mock-constants.js';
const copy = vi.hoisted(() => ({ prefs: null as Record<string, { v: string; ts: number }> | null, writes: [] as unknown[] }));
vi.mock('../../../src/constants.js', () => createMockConstants('walnut-recent-companion'));
vi.mock('../../../src/core/server-role.js', () => ({ isCompanion: () => true, isHostReplicaProgram: () => false }));
vi.mock('../../../src/core/replication/kinds/prefs.js', () => ({ readUiPrefsCopy: async () => copy.prefs }));
vi.mock('../../../src/core/replication/kinds/gate.js', () => ({ assertCopyKept: async () => {}, copyKindAsOf: async () => 1, COPY_AS_OF_HEADER: 'x-copy-as-of', KIND_NOT_COPIED: 'not_copied' }));
vi.mock('../../../src/web/routes/v1-control-relay.js', () => ({ callPrimaryControl: async (_op: string, _sid: string, body: unknown) => { copy.writes.push(body); return { ok: true, result: { ok: true } }; } }));
import { WALNUT_HOME } from '../../../src/constants.js';
import { uiPrefsRouter, _resetUiPrefsMigrationForTest } from '../../../src/web/routes/ui-prefs.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';
const key = 'walnut-todo-recent-opened';
const marker = 'walnut-todo-recent-human-since';
const since = Date.parse('2026-11-09T20:00:00Z');
function app() {
  const a = express(); a.use(express.json());
  a.use((req, _res, next) => { (req as typeof req & { deviceName: string }).deviceName = 'paired-device'; next(); });
  a.use('/api/ui-prefs', uiPrefsRouter); a.use(errorHandler); return a;
}
beforeEach(() => { copy.prefs = null; copy.writes = []; _resetUiPrefsMigrationForTest(); });
afterEach(async () => { await fs.rm(WALNUT_HOME, { recursive: true, force: true }); });
it('uses the copied cutover marker and forwards only fresh native phone opens', async () => {
  copy.prefs = { [marker]: { v: String(since), ts: since } };
  const res = await request(app()).put('/api/ui-prefs').set('User-Agent', 'Walnut/1.0 CFNetwork/1 Darwin/1').send({ prefs: { [key]: {
    v: JSON.stringify([{ id: 'old', at: '2026-11-09T19:59:59Z' }, { id: 'new', at: '2026-11-09T20:00:01Z' }]), ts: since + 1000,
  } } });
  expect(res.status).toBe(200);
  expect(copy.writes).toEqual([{ prefs: { [key]: { v: JSON.stringify([{ id: 'new', at: '2026-11-09T20:00:01Z', human: true }]), ts: since + 1000 } } }]);
});
it('requires a primary cutover for old phone opens, while verified web opens still forward', async () => {
  for (const prefs of [null, {}]) {
    copy.prefs = prefs;
    const res = await request(app()).put('/api/ui-prefs').set('User-Agent', 'Walnut/1.0 CFNetwork/1 Darwin/1').send({ prefs: { [key]: {
      v: JSON.stringify([{ id: 'old', at: '2026-11-09T20:00:01Z' }]), ts: since + 1000,
    } } });
    expect(res.status).toBe(503); expect(copy.writes).toEqual([]);
  }
  const res = await request(app()).put('/api/ui-prefs').set('User-Agent', 'Mozilla/5.0').send({ prefs: { [key]: {
    v: JSON.stringify([{ id: 'verified', at: '2026-11-09T20:00:02Z', human: true }, { id: 'automatic', at: '2026-11-09T20:00:03Z' }]), ts: since + 2000,
  } } });
  expect(res.status).toBe(200);
  expect(copy.writes).toEqual([{ prefs: { [key]: { v: JSON.stringify([{ id: 'verified', at: '2026-11-09T20:00:02Z', human: true }]), ts: since + 2000 } } }]);
});

it('a copied unverified Recent row is hidden before the primary migrates', async () => {
  copy.prefs = { [key]: { v: JSON.stringify([{ id: 'automatic', at: '2026-11-09T20:00:00Z' }]), ts: since } };
  const res = await request(app()).get('/api/ui-prefs').query({ key });
  expect(res.status).toBe(200); expect(JSON.parse(res.body.prefs[key].v)).toEqual([]);
});
