/**
 * The day's line about tasks kept out of a service (src/core/private-tasks/kept-digest.ts): no
 * letter asks the user (2026-11-02: three decision letters in four hours, all unread, though the
 * safe choice was applied), Main hears one line, the first burst once it is quiet (at most 10
 * minutes after it began), later ones at most once a day, a restart keeps the notes and their hour,
 * a line Main could not take waits and is tried again, and a task already decided is not news.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../../helpers/mock-constants.js';
vi.mock('../../../src/constants.js', () => createMockConstants('kept-digest'));

type T = { id: string; title: string; source: string; org_role?: string; phase?: string; sync_hold?: Record<string, unknown> };
const tasks = new Map<string, T>();
vi.mock('../../../src/core/task-manager.js', () => ({
  listTasks: async () => [...tasks.values()],
  getTask: async (id: string) => { const t = tasks.get(id); if (!t) throw new Error('none'); return t; },
}));
vi.mock('../../../src/core/private-tasks/sync-gate.js', () => ({ serviceName: async (id: string) => (id === 'svc' ? 'Team Tracker' : id) }));

import { WALNUT_HOME } from '../../../src/constants.js';
import {
  noteKeptLocal, pendingKeptForTest, resetKeptDigestForTest, resumeKeptDigest, settleKeptDigest,
} from '../../../src/core/private-tasks/kept-digest.js';

const kept = (id: string, extra: Partial<T> = {}): T => {
  const t: T = { id, title: `Task ${id}`, source: 'local', sync_hold: { target: 'svc', state: 'private', by: 'model', at: new Date().toISOString() }, ...extra };
  tasks.set(id, t);
  return t;
};

let told: string[];
let mainTakes: boolean;
const tell = async (line: string) => { if (!mainTakes) return false; told.push(line); return true; };
/** Let timers due by now run, then the chain they start. */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await settleKeptDigest();
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(new Date('2026-11-02T04:00:00Z'));
  tasks.clear();
  told = [];
  mainTakes = true;
  resetKeptDigestForTest(tell);
});

afterEach(async () => {
  resetKeptDigestForTest(null);
  vi.useRealTimers();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('the day\'s line about kept tasks', () => {
  it('a burst is one line once it is quiet; the next one waits a day', async () => {
    kept('a'); kept('b');
    await noteKeptLocal('a', 'created');
    await advance(60_000);
    await noteKeptLocal('b', 'edited');
    await advance(60_000);
    expect(told).toEqual([]); // still not quiet for 90 s
    await advance(31_000);
    expect(told).toHaveLength(1);
    expect(told[0]).toContain('2 out of Team Tracker');
    expect(told[0]).toContain('"Task b" (b), its copy there keeps the text from before the edit');
    expect(told[0]).toContain('Nothing waits on the user');
    expect(await pendingKeptForTest()).toEqual([]);

    kept('c');
    await noteKeptLocal('c', 'created');
    await advance(3600_000);
    expect(told).toHaveLength(1);
    await advance(23 * 3600_000);
    expect(told).toHaveLength(2);
    expect(told[1]).toContain('"Task c" (c)');
  });

  it('a slow stream of notes is told at most 10 minutes after it began', async () => {
    for (let i = 0; i < 12; i++) {
      kept(`s${i}`);
      await noteKeptLocal(`s${i}`, 'created');
      await advance(60_000);
    }
    expect(told).toHaveLength(1);
    expect(Number(/(\d+) out of Team Tracker/.exec(told[0])![1])).toBeGreaterThanOrEqual(10);
  });

  it('a task decided meanwhile, or Main itself, is not news; with nothing left the day is not used up', async () => {
    kept('main', { org_role: 'main' });
    kept('d');
    await noteKeptLocal('main', 'created');
    await noteKeptLocal('d', 'created');
    tasks.set('d', { ...tasks.get('d')!, source: 'svc', sync_hold: undefined }); // released
    await advance(91_000);
    expect(told).toEqual([]);
    expect(await pendingKeptForTest()).toEqual([]);
    // The day was not used: a new kept task is told after its quiet, not a day later.
    kept('e');
    await noteKeptLocal('e', 'created');
    await advance(91_000);
    expect(told).toHaveLength(1);
    expect(told[0]).toContain('"Task e" (e)');
    expect(told[0]).not.toContain('Task main');
  });

  it('a line Main cannot take waits and is tried again an hour later, notes kept', async () => {
    mainTakes = false;
    kept('f');
    await noteKeptLocal('f', 'created');
    await advance(91_000);
    expect(told).toEqual([]);
    expect(await pendingKeptForTest()).toEqual(['f']);
    mainTakes = true;
    await advance(3600_000);
    expect(told).toHaveLength(1);
    expect(await pendingKeptForTest()).toEqual([]);
  });

  it('a restart keeps the notes and their hour', async () => {
    kept('g');
    await noteKeptLocal('g', 'created');
    await advance(91_000);
    expect(told).toHaveLength(1);
    kept('h');
    await noteKeptLocal('h', 'created');
    // The server stops: memory and timer are gone, the file stays.
    resetKeptDigestForTest(tell);
    await resumeKeptDigest();
    await advance(3600_000);
    expect(told).toHaveLength(1);
    await advance(23 * 3600_000);
    expect(told).toHaveLength(2);
    expect(told[1]).toContain('"Task h" (h)');
  });
});
