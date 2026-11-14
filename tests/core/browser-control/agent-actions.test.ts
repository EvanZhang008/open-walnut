import fs from 'node:fs/promises';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createMockConstants } from '../../helpers/mock-constants.js';
vi.mock('../../../src/constants.js', () => createMockConstants('walnut-agent-attribution'));
import { WALNUT_HOME } from '../../../src/constants.js';
import { checkAgentActions, noteAgentAction, noteHostAction } from '../../../src/core/browser-control/agent-actions.js';
import { checkSecurityAlert } from '../../../src/core/browser-control/security-alert.js';

afterAll(() => fs.rm(WALNUT_HOME, { recursive: true, force: true }));
describe('sanitized recent agent actions', () => {
  it('marks a unique successful form fill ours and attributes the task', async () => {
    const at = Date.now();
    await noteAgentAction('task-login', 'https://secure.login.example.test/login?secret=SECRET_CANARY', 'fill_login', at, 'agent@example.test');
    const result = await checkSecurityAlert({ domain: 'example.test', occurred_at: new Date(at).toISOString(), account: 'agent@example.test' });
    expect(result).toMatchObject({ status: 'ours', actions: [{ taskId: 'task-login', domain: 'example.test', kind: 'fill_login' }] });
    expect(JSON.stringify(result)).not.toContain('SECRET_CANARY');
    const disk = await fs.readFile(`${WALNUT_HOME}/cache/agent-actions.json`, 'utf8');
    expect(disk).not.toContain('SECRET_CANARY');
    expect(disk).not.toContain('/login');
  });
  it('does not confuse a wrong domain, old event or browser navigation with a sign-in', async () => {
    const at = Date.now();
    expect((await checkAgentActions('other.test', at, 'agent@example.test')).status).toBe('unknown');
    expect((await checkAgentActions('example.test', at - 11 * 60_000, 'agent@example.test')).status).toBe('unknown');
    await noteAgentAction('task-browse', 'https://browse.test', 'browser', at);
    expect((await checkAgentActions('browse.test', at, 'agent@example.test')).status).toBe('unknown');
  });
  it('host commands keep only relevant domain attribution, never command text or credentials', async () => {
    const at = Date.now();
    await noteHostAction('task-host', 'curl https://remote.test/login?token=SECRET_HOST_CANARY');
    const result = await checkAgentActions('remote.test', Date.now(), 'agent@example.test');
    expect(result).toMatchObject({ status: 'unknown', actions: [{ taskId: 'task-host', kind: 'host_exec' }] });
    expect(await fs.readFile(`${WALNUT_HOME}/cache/agent-actions.json`, 'utf8')).not.toContain('SECRET_HOST_CANARY');
  });
  it('never attributes an earlier alert or another account to a later fill', async () => {
    const at = Date.now();
    await noteAgentAction('task-later', 'https://ordered.test', 'fill_login', at, 'agent@example.test');
    expect((await checkAgentActions('ordered.test', at - 1, 'agent@example.test')).status).toBe('unknown');
    expect((await checkAgentActions('ordered.test', at, 'other@example.test')).status).toBe('unknown');
    expect((await checkAgentActions('ordered.test', at)).status).toBe('unknown');
    expect((await checkAgentActions('ordered.test', at + 60_000, 'agent@example.test')).status).toBe('ours');
    const disk = await fs.readFile(`${WALNUT_HOME}/cache/agent-actions.json`, 'utf8');
    expect(disk).not.toContain('agent@example.test');
  });
  it('ambiguous task matches require supervisor checking', async () => {
    const at = Date.now();
    await noteAgentAction('task-one', 'https://ambiguous.test', 'fill_login', at, 'agent@example.test');
    await noteAgentAction('task-two', 'https://ambiguous.test', 'fill_code', at, 'agent@example.test');
    expect((await checkAgentActions('ambiguous.test', at, 'agent@example.test')).status).toBe('unknown');
  });
  it('keeps the matching fill when later navigation candidates fill the response limit', async () => {
    const at = Date.now();
    await noteAgentAction('task-filled', 'https://busy.test', 'fill_login', at, 'agent@example.test');
    for (let i = 0; i < 12; i++) await noteAgentAction(`task-browser-${i}`, 'https://busy.test', 'browser', at);
    const result = await checkAgentActions('busy.test', at, 'agent@example.test');
    expect(result.status).toBe('ours');
    expect(result.actions[0]?.taskId).toBe('task-filled');
  });
  it('keeps concurrent metadata writes and handles repeated checks', async () => {
    const at = Date.now();
    await Promise.all(Array.from({ length: 10 }, (_, i) => noteAgentAction(`task-${i}`, `https://parallel-${i}.test`, 'fill_login', at, 'agent@example.test')));
    for (let i = 0; i < 10; i++) for (let n = 0; n < 2; n++) {
      expect((await checkAgentActions(`parallel-${i}.test`, at, 'agent@example.test')).actions[0]?.taskId).toBe(`task-${i}`);
    }
  });
  it('rejects unknown event time and invalid domains rather than guessing', async () => {
    for (const raw of [null, {}, { domain: 'example.test', occurred_at: 'recently' }, { domain: 'example.test', occurred_at: '2026-11-14' }, { domain: 'example.test', occurred_at: '2026-11-14T06:20:00' }, { domain: 'example.test/a', occurred_at: new Date().toISOString() }]) {
      await expect(checkSecurityAlert(raw)).rejects.toMatchObject({ code: 'bad_security_alert' });
    }
  });
  it('unreadable records are unavailable, never ours, and recover after a valid write', async () => {
    const file = `${WALNUT_HOME}/cache/agent-actions.json`;
    await fs.writeFile(file, '{broken');
    expect((await checkAgentActions('example.test', Date.now(), 'agent@example.test')).status).toBe('unavailable');
    await fs.writeFile(file, '[]');
    await noteAgentAction('task-recovered', 'https://recovered.test', 'fill_login', Date.now(), 'agent@example.test');
    expect((await checkAgentActions('recovered.test', Date.now(), 'agent@example.test')).status).toBe('ours');
  });
});
