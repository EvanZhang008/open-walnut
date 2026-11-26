/**
 * What a host copy build costs the event loop (src/core/host-slice.ts). A build runs every few
 * seconds for every connected host while tasks change (2026-11-25: about 1,500 pushes in seven
 * hours, ten hosts), and in the live server's stall profiles buildHostSlice was 22 s of 395 s of
 * loop CPU. A second build over unchanged rows must not:
 *  - hash an active session's spawn prompt again (sha256 of a 15 to 60 KB text, about six times
 *    per session per build: 39% of a build in a production-sized home);
 *  - read an active session's whole row from SQLite again (withPromptFields);
 * and the push sends the JSON text the hash already wrote, never a second JSON.stringify.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createMockConstants } from '../helpers/mock-constants.js';

const counts = vi.hoisted(() => ({ longSha: 0, heavy: 0 }));
vi.mock('../../src/constants.js', () => createMockConstants('walnut-host-slice-cost'));
vi.mock('node:crypto', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:crypto')>();
  const createHash = ((alg: string, ...rest: unknown[]) => {
    const h = (real.createHash as (...a: unknown[]) => ReturnType<typeof real.createHash>)(alg, ...rest);
    if (alg !== 'sha256') return h;
    const update = h.update.bind(h) as (...a: unknown[]) => typeof h;
    (h as unknown as { update: unknown }).update = (data: unknown, ...more: unknown[]) => {
      if (typeof data === 'string' && data.length >= 2_048) counts.longSha++;
      return update(data, ...more);
    };
    return h;
  }) as typeof real.createHash;
  return { ...real, createHash, default: { ...real, createHash } };
});
vi.mock('../../src/core/session-tracker.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/core/session-tracker.js')>();
  return { ...real, withPromptFields: (r: Parameters<typeof real.withPromptFields>[0]) => { counts.heavy++; return real.withPromptFields(r); } };
});

import { WALNUT_HOME } from '../../src/constants.js';
import { addTask } from '../../src/core/task-manager.js';
import { createSessionRecord, updateSessionRecord } from '../../src/core/session-tracker.js';
import { buildHostSlice, hostSliceJson } from '../../src/core/host-slice.js';
import { buildSessionContext } from '../../src/core/sessions/session-context.js';

beforeEach(async () => { await fs.rm(WALNUT_HOME, { recursive: true, force: true }); });

describe('a host copy build over unchanged rows', () => {
  it('neither hashes a spawn prompt again nor reads a session row again', async () => {
    const sids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const { task } = await addTask({ title: `Worker ${i}`, project: 'Mobile' });
      const prompt = (await buildSessionContext(task.id)).systemPrompt;
      expect(prompt.length).toBeGreaterThan(2_048);
      const sid = randomUUID();
      // A live pid: a dead one gets its row repaired (fixStaleRecords) between the two builds.
      await createSessionRecord(sid, task.id, task.project, WALNUT_HOME, { pid: process.pid });
      // One line short of the current instructions: a notice is due, so the build diffs the prompt.
      await updateSessionRecord(sid, { appliedAppendSystemPrompt: prompt.split('\n').slice(0, -3).join('\n') });
      sids.push(sid);
    }
    const first = await buildHostSlice('__local__');
    expect(first.sessions.filter((s) => sids.includes(s.sid) && s.taskRoutingPolicy)).toHaveLength(4);
    counts.longSha = 0;
    counts.heavy = 0;
    const second = await buildHostSlice('__local__');
    expect(second.sessions.filter((s) => sids.includes(s.sid) && s.taskRoutingPolicy)).toHaveLength(4);
    expect(second.hash).toBe(first.hash);
    expect(counts.longSha).toBe(0);
    expect(counts.heavy).toBe(0);
  });

  it('a session row written since is read again', async () => {
    const { task } = await addTask({ title: 'Lead', project: 'Mobile' });
    const prompt = (await buildSessionContext(task.id)).systemPrompt;
    const sid = randomUUID();
    await createSessionRecord(sid, task.id, task.project, WALNUT_HOME);
    await updateSessionRecord(sid, { appliedAppendSystemPrompt: prompt.split('\n').slice(0, -3).join('\n') });
    expect((await buildHostSlice('__local__')).sessions.find((s) => s.sid === sid)?.taskRoutingPolicy).toBeTruthy();
    // Its prompt is current now: nothing is due.
    await updateSessionRecord(sid, { appliedAppendSystemPrompt: prompt });
    counts.heavy = 0;
    expect((await buildHostSlice('__local__')).sessions.find((s) => s.sid === sid)).not.toHaveProperty('taskRoutingPolicy');
    expect(counts.heavy).toBeGreaterThan(0);
  });

  it('the JSON the push sends is the slice as JSON.stringify writes it', async () => {
    const { task } = await addTask({ title: 'Solo', project: 'Mobile', description: 'a "quoted" é line' });
    await createSessionRecord(randomUUID(), task.id, task.project, WALNUT_HOME);
    const slice = await buildHostSlice('__local__');
    expect(hostSliceJson(slice)).toBe(JSON.stringify(slice));
    // A copy that is not a build's own (a test's, a changed one) is written out as it is.
    const edited = { ...slice, asOf: 1 };
    expect(hostSliceJson(edited)).toBe(JSON.stringify(edited));
  });
});
