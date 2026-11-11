import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import express from 'express';
import request from 'supertest';
import { createMockConstants } from '../../helpers/mock-constants.js';
vi.mock('../../../src/constants.js', () => createMockConstants());
import { CONFIG_FILE, WALNUT_HOME } from '../../../src/constants.js';
import { configRouter } from '../../../src/web/routes/config.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';
import { _resetWriteLockForTest } from '../../../src/core/config-manager.js';
import { withTestRun } from '../../../src/core/test-run.js';
import { _resetTestRunPrefsForTest } from '../../../src/core/test-run-prefs.js';
import { bus } from '../../../src/core/event-bus.js';

function app(label?: string) {
  const a = express(); a.use(express.json());
  a.use((req, res, next) => withTestRun(label, next));
  a.use('/api/config', configRouter); a.use(errorHandler); return a;
}
beforeEach(async () => { _resetWriteLockForTest(); _resetTestRunPrefsForTest(); await fs.mkdir(WALNUT_HOME, { recursive: true }); });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(WALNUT_HOME, { recursive: true, force: true }); });

describe('experimental config writes', () => {
  it('persists explicit choices and unknown boolean flags, leaving unrelated config intact', async () => {
    await request(app()).put('/api/config').send({ user: { name: 'Ada' } }).expect(200);
    await request(app()).put('/api/config').send({ experimental: { leader_status_follows_workers: true, future_flag: false } }).expect(200);
    const c = (await request(app()).get('/api/config')).body.config;
    expect(c.experimental).toEqual({ leader_status_follows_workers: true, future_flag: false });
    expect(c.user.name).toBe('Ada');
    await request(app()).put('/api/config').send({ experimental: { leader_status_follows_workers: false } }).expect(200);
    expect((await request(app()).get('/api/config')).body.config.experimental.leader_status_follows_workers).toBe(false);
  });
  it.each([null, [], 'true', { leader_status_follows_workers: 1 }])('refuses malformed flags %j without saving', async (experimental) => {
    await request(app()).put('/api/config').send({ experimental }).expect(400);
    await expect(fs.stat(CONFIG_FILE)).rejects.toThrow();
  });
  it('test preferences read their override but never write disk or announce a global change', async () => {
    await request(app()).put('/api/config').send({ experimental: { leader_status_follows_workers: false, future_flag: true } }).expect(200);
    const before = await fs.readFile(CONFIG_FILE, 'utf8');
    const spy = vi.spyOn(bus, 'emit');
    await request(app('test-a')).put('/api/config').send({ experimental: { leader_status_follows_workers: true } }).expect(200);
    expect((await request(app('test-a')).get('/api/config')).body.config.experimental).toEqual({ leader_status_follows_workers: true, future_flag: true });
    expect((await request(app('test-b')).get('/api/config')).body.config.experimental.leader_status_follows_workers).toBe(false);
    expect((await request(app()).get('/api/config')).body.config.experimental.leader_status_follows_workers).toBe(false);
    expect(await fs.readFile(CONFIG_FILE, 'utf8')).toBe(before);
    expect(spy.mock.calls.filter(([event]) => event.name === 'config:changed')).toHaveLength(0);
  });
});
