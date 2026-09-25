/**
 * Quiet mode state (src/core/quiet/quiet-state.ts).
 *
 * Contract under test:
 *   - several sources hold quiet at once; Walnut is quiet while ANY hold is live,
 *     and clearing one source leaves the others alone.
 *   - `allowPermissions` defaults to true and is the AND of the live holds, so a
 *     permission ask still interrupts unless some hold explicitly said otherwise.
 *   - a hold with `until` ends on its own: lazily on read AND via the one timer,
 *     which is what makes `quiet:changed` fire at the moment a focus block ends.
 *   - the state survives a restart (quiet.json), and the process-local `owner`
 *     token is never written.
 *   - `quiet:changed` fires on every change of the public state and never twice
 *     for the same state.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('quiet-state-test'));

import { WALNUT_HOME } from '../../src/constants.js';
import { bus, EventNames } from '../../src/core/event-bus.js';
import {
  clearQuiet, getQuiet, peekQuiet, quietSuppresses, setQuiet, stopQuiet, type QuietState,
} from '../../src/core/quiet/quiet-state.js';

const FILE = path.join(WALNUT_HOME, 'quiet.json');
let events: QuietState[] = [];

beforeEach(() => {
  stopQuiet();
  fs.rmSync(FILE, { force: true });
  events = [];
  bus.subscribe('quiet-test', (e) => { events.push(e.data as QuietState); }, {
    global: true, interest: [EventNames.QUIET_CHANGED],
  });
});

afterEach(() => {
  bus.unsubscribe('quiet-test');
  vi.useRealTimers();
  stopQuiet();
});

describe('holds', () => {
  it('is quiet while any source holds it, and clearing one keeps the others', async () => {
    expect(await getQuiet()).toEqual({ active: false, allowPermissions: true, holds: [] });

    await setQuiet({ source: 'user' });
    await setQuiet({ source: 'plugin:walnut-rhythm', reason: 'Focus block', until: Date.now() + 60_000 });
    let q = await getQuiet();
    expect(q.active).toBe(true);
    expect(q.holds.map(h => h.source)).toEqual(['user', 'plugin:walnut-rhythm']);
    expect(q.holds[1]).toMatchObject({ reason: 'Focus block' });

    q = await clearQuiet('user');
    expect(q.active).toBe(true);
    expect(q.holds.map(h => h.source)).toEqual(['plugin:walnut-rhythm']);

    q = await clearQuiet('plugin:walnut-rhythm');
    expect(q).toEqual({ active: false, allowPermissions: true, holds: [] });
  });

  it('a second set from the same source REPLACES its hold and keeps when quiet began', async () => {
    const first = await setQuiet({ source: 'user', reason: 'one' });
    const since = first.holds[0].since;
    const second = await setQuiet({ source: 'user', reason: 'two', until: Date.now() + 5_000 });
    expect(second.holds).toHaveLength(1);
    expect(second.holds[0]).toMatchObject({ reason: 'two', since });
  });

  it('refuses an `until` in seconds instead of treating it as long past', async () => {
    await expect(setQuiet({ source: 'user', until: Math.floor(Date.now() / 1000) + 600 }))
      .rejects.toThrow(/milliseconds/);
    expect((await getQuiet()).active).toBe(false);
  });

  it('an `until` already past clears the hold', async () => {
    await setQuiet({ source: 'user' });
    const q = await setQuiet({ source: 'user', until: Date.now() - 1 });
    expect(q.active).toBe(false);
  });

  it('`owner` gates a clear: a replaced generation cannot clear its successor', async () => {
    await setQuiet({ source: 'plugin:p', owner: 'p#2' });
    expect((await clearQuiet('plugin:p', { owner: 'p#1' })).active).toBe(true);
    expect((await clearQuiet('plugin:p', { owner: 'p#2' })).active).toBe(false);
  });
});

describe('allowPermissions', () => {
  it('defaults to true and is the AND of the live holds', async () => {
    let q = await setQuiet({ source: 'user' });
    expect(q.allowPermissions).toBe(true);
    expect(quietSuppresses(q)).toBe(true);
    expect(quietSuppresses(q, { permission: true })).toBe(false);

    q = await setQuiet({ source: 'plugin:p', allowPermissions: false });
    expect(q.allowPermissions).toBe(false);
    expect(quietSuppresses(q, { permission: true })).toBe(true);

    q = await clearQuiet('plugin:p');
    expect(q.allowPermissions).toBe(true);
  });

  it('nothing is suppressed when no hold is live', () => {
    expect(quietSuppresses({ active: false, allowPermissions: false, holds: [] })).toBe(false);
  });
});

describe('expiry', () => {
  it('ends a hold on its own and announces it at that moment', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    await setQuiet({ source: 'plugin:p', until: Date.now() + 60_000 });
    expect(events.at(-1)?.active).toBe(true);

    await vi.advanceTimersByTimeAsync(59_000);
    expect(peekQuiet().active).toBe(true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(events.at(-1)).toEqual({ active: false, allowPermissions: true, holds: [] });
    expect(peekQuiet().active).toBe(false);
  });

  it('a read after `until` sees the hold gone even before the timer ran', async () => {
    await setQuiet({ source: 'user', until: Date.now() + 40 });
    await new Promise(r => setTimeout(r, 60));
    expect(peekQuiet().active).toBe(false);
    expect((await getQuiet()).active).toBe(false);
  });
});

describe('persistence', () => {
  it('survives a restart with source, until, reason and since intact, and never writes `owner`', async () => {
    const until = Date.now() + 25 * 60_000;
    const set = await setQuiet({ source: 'plugin:p', until, reason: 'Pomodoro', allowPermissions: false, owner: 'p#9' });
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf-8'));
    expect(raw.version).toBe(1);
    expect(JSON.stringify(raw)).not.toContain('p#9');

    stopQuiet(); // the process forgets everything, as on a restart
    const after = await getQuiet();
    expect(after).toEqual(set);
    expect(after.allowPermissions).toBe(false);
  });

  it('a restart after `until` passed comes back loud and prunes the file', async () => {
    fs.writeFileSync(FILE, JSON.stringify({
      version: 1,
      holds: [{ source: 'user', since: Date.now() - 120_000, until: Date.now() - 1_000, allowPermissions: true }],
    }));
    expect((await getQuiet()).active).toBe(false);
    await new Promise(r => setTimeout(r, 30));
    expect(JSON.parse(fs.readFileSync(FILE, 'utf-8')).holds).toEqual([]);
  });

  it('an unreadable file starts loud instead of throwing', async () => {
    fs.writeFileSync(FILE, '{not json');
    expect((await getQuiet()).active).toBe(false);
  });
});

describe('quiet:changed', () => {
  it('fires once per change of the public state, never for a no-op', async () => {
    await getQuiet();
    expect(events).toHaveLength(0);
    await setQuiet({ source: 'user' });
    expect(events).toHaveLength(1);
    await setQuiet({ source: 'user' }); // identical state
    expect(events).toHaveLength(1);
    await setQuiet({ source: 'user', reason: 'Deep work' });
    expect(events).toHaveLength(2);
    await clearQuiet('user');
    await clearQuiet('user'); // already clear
    expect(events).toHaveLength(3);
    expect(events.at(-1)?.active).toBe(false);
  });

  it('is sent to the browser lane', async () => {
    const seen: string[][] = [];
    bus.subscribe('quiet-dest', (e) => { seen.push(e.destinations); }, { global: true, interest: ['quiet:'] });
    await setQuiet({ source: 'user' });
    bus.unsubscribe('quiet-dest');
    expect(seen).toEqual([['web-ui']]);
  });
});
