import { describe, expect, it } from 'vitest';
import { createCleanupLedger, within } from '../e2e/fixtures/acp-cleanup-ledger.js';
import type { Identity } from '../e2e/fixtures/process-identity.js';

const T = 'Fri Oct 24 01:23:45 2026';
const EXPECTED = { adapter: 'mock-acp-agent.mjs', worker: 'acp-worker.js' };
function world(rows: Record<number, Identity>) {
  const alive = new Map(Object.entries(rows).map(([k, v]) => [Number(k), v]));
  return {
    alive,
    identity: (pid: number): Identity => alive.get(pid) ?? { state: 'absent' },
    gone: (p: { pid: number; lstart: string }) => { const s = alive.get(p.pid); if (s && s.state === 'present' && s.command === 'ps-broken') throw new Error('ps could not tell'); return !s || s.state === 'absent' || s.lstart !== p.lstart; },
  };
}
const present = (command: string, lstart = T): Identity => ({ state: 'present', lstart, command });

describe('ACP E2E cleanup ledger', () => {
  it('a start with no witness line never cleans up, even when the daemon says no_worker', () => {
    const w = world({ 50: present('node mock-acp-agent.mjs'), 49: present('node acp-worker.js') });
    const ledger = createCleanupLedger(w);
    ledger.created('rt-1');
    ledger.spawned('rt-1', [], EXPECTED);
    // The daemon has forgotten the worker; the adapter may still run: nothing proves it gone.
    expect(ledger.allGone('rt-1')).toBe(false);
    expect(ledger.verdict()).toEqual(['rt-1: no witness line for a start that spawned a worker']);
  });

  it('a start whose call failed is unproven; one that was refused before spawning has nothing to prove', () => {
    const ledger = createCleanupLedger(world({}));
    ledger.created('rt-2');
    ledger.unknown('rt-2', 'acpStart timed out');
    ledger.created('rt-3');
    expect(ledger.allGone('rt-3')).toBe(true);
    expect(ledger.verdict()).toEqual(['rt-2: acpStart timed out']);
  });

  it('proves adapter and worker gone by ps, and reports one still running or unknown', () => {
    const w = world({ 50: present('node /x/mock-acp-agent.mjs'), 49: present('node /x/acp-worker.js') });
    const ledger = createCleanupLedger(w);
    ledger.created('rt-1');
    ledger.spawned('rt-1', [{ pid: 50, ppid: 49 }], EXPECTED);
    expect(ledger.allGone('rt-1')).toBe(false);
    w.alive.delete(50);
    expect(ledger.verdict()).toEqual(['rt-1: worker 49 still runs (node /x/acp-worker.js)']);
    w.alive.set(49, present('node /x/acp-worker.js', 'Fri Oct 24 09:00:00 2026'));
    expect(ledger.allGone('rt-1')).toBe(true);
    w.alive.set(49, present('ps-broken'));
    expect(ledger.verdict()[0]).toMatch(/could not tell/);
  });

  it('refuses a witness pid that is not the process the test started', () => {
    const ledger = createCleanupLedger(world({ 50: present('/usr/bin/vim'), 49: present('node acp-worker.js') }));
    ledger.created('rt-1');
    expect(() => ledger.spawned('rt-1', [{ pid: 50, ppid: 49 }], EXPECTED)).toThrow(/not the adapter/);
    expect(ledger.allGone('rt-1')).toBe(false);
  });

  it('signals a daemon only while ps shows the very process it spawned', () => {
    const w = world({ 70: present('node /r/twin/daemon.cjs --start') });
    const ledger = createCleanupLedger(w);
    const d = ledger.daemonSpawned(70, 'daemon.cjs');
    expect(ledger.stillOurs(d)).toBe(true);
    w.alive.set(70, present('node /r/twin/daemon.cjs --start', 'Fri Oct 24 09:00:00 2026'));
    expect(ledger.stillOurs(d)).toBe(false);
    expect(ledger.verdict()).toEqual([]);
    expect(() => ledger.daemonSpawned(71, 'daemon.cjs')).toThrow(/not the daemon/);
  });

  it('a child seen only through its witness: already gone, reused, still running, or unknown', () => {
    const w = world({ 80: present('node /f/session-budget-cli.mjs --session-id s1'), 81: present('/usr/bin/vim'), 83: present('ps-broken') });
    const ledger = createCleanupLedger({ ...w, identity: (pid: number) => { if (pid === 83) throw new Error('ps could not tell'); return w.identity(pid); } });
    ledger.observed(80, 'session-budget-cli.mjs --session-id s1', 'cli');
    ledger.observed(81, 'session-budget-cli.mjs --session-id s1', 'cli');
    ledger.observed(82, 'session-budget-cli.mjs --session-id s1', 'cli');
    ledger.observed(83, 'session-budget-cli.mjs --session-id s1', 'cli');
    // Seen twice, pinned once.
    ledger.observed(80, 'session-budget-cli.mjs --session-id s1', 'cli');
    expect(ledger.verdict()).toEqual(['cli 80 still runs (node /f/session-budget-cli.mjs --session-id s1)', 'cli 83: ps could not tell']);
    w.alive.delete(80);
    expect(ledger.verdict()).toEqual(['cli 83: ps could not tell']);
  });

  it('pins a process the code under test started for itself, and refuses one that is not it', () => {
    const w = world({ 90: present('/r/dist/daemon-binaries/daemon-darwin-arm64 --start') });
    const ledger = createCleanupLedger(w);
    const local = ledger.owned(90, '--start', 'local-daemon');
    expect(ledger.stillOurs(local)).toBe(true);
    expect(ledger.verdict()).toEqual(['local-daemon 90 still runs (/r/dist/daemon-binaries/daemon-darwin-arm64 --start)']);
    w.alive.delete(90);
    expect(ledger.stillOurs(local)).toBe(false);
    expect(ledger.verdict()).toEqual([]);
    expect(() => ledger.owned(91, '--start', 'session-host')).toThrow(/not the session-host/);
  });

  it('a cleanup that runs out of time fails', async () => {
    await expect(within(20, 'cleanup', () => new Promise(() => {}))).rejects.toThrow(/did not finish in 20 ms/);
    await expect(within(1_000, 'cleanup', async () => 'ok')).resolves.toBe('ok');
  });
});
