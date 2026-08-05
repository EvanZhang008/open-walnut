/**
 * Frozen prompt snapshot + drift detection for the bounded memory stores
 * (src/core/memory-prompt-snapshot.ts, wired into BoundedMemoryStore).
 *
 * The contract under test, restated: writes hit disk immediately, but a scope
 * that was pinned at a turn boundary keeps serving the block captured then until
 * the NEXT boundary re-pins it (or someone explicitly invalidates). See the
 * module header for why "freeze until the next turn boundary" beats both "read
 * live every turn" and Hermes's "freeze for the whole session".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import {
  BoundedMemoryStore,
  beginMemoryPromptTurn,
  getBoundedMemory,
  invalidateMemoryPromptSnapshots,
  promptScope,
} from '../../src/core/bounded-memory.js';
import { MemoryPromptSnapshots } from '../../src/core/memory-prompt-snapshot.js';
import { WALNUT_HOME, MEMORY_FILE, USER_FILE } from '../../src/constants.js';

let store: BoundedMemoryStore;

const entry = (title: string, body = 'Some rule body.') => `## ${title}\n\n${body}`;

/** Write raw bytes straight to disk — an "external" edit that bypasses the store. */
function externalWrite(file: string, entries: string[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `# M\n\n${entries.join('\n\n')}\n`, 'utf-8');
}

beforeEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(path.dirname(MEMORY_FILE), { recursive: true });
  // The module-level store cache is a singleton keyed by file path, so pins and
  // the write epoch survive between tests in this file. Thaw everything first.
  invalidateMemoryPromptSnapshots();
  store = new BoundedMemoryStore();
});

afterEach(async () => {
  invalidateMemoryPromptSnapshots();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
});

// ── The core Hermes behavior ──

describe('frozen snapshot serves stale content mid-turn', () => {
  it('holds the pinned block while the agent\'s own write lands on disk', async () => {
    await store.add(entry('Rule A', 'first rule'));
    const scope = 'general:conv-1';
    store.beginPromptTurn(scope);

    // Mid-turn write: durable immediately...
    const res = await store.add(entry('Rule B', 'learned mid-turn'));
    expect(res.success).toBe(true);
    expect(fs.readFileSync(MEMORY_FILE, 'utf-8')).toContain('learned mid-turn');
    const snap = await store.read();
    expect(snap.entries).toHaveLength(2);

    // ...but INVISIBLE to the prompt for the rest of this turn. This is the
    // anti-re-learn guarantee: the model must not see an entry it just wrote.
    const frozen = store.renderForPrompt(scope)!;
    expect(frozen).toContain('first rule');
    expect(frozen).not.toContain('learned mid-turn');
  });

  it('every render inside one turn returns the same bytes', async () => {
    await store.add(entry('Rule A'));
    const scope = 'general:conv-1';
    store.beginPromptTurn(scope);
    const first = store.renderForPrompt(scope);
    await store.add(entry('Rule B'));
    externalWrite(MEMORY_FILE, [entry('Totally Different')]);
    expect(store.renderForPrompt(scope)).toBe(first);
    expect(store.renderForPrompt(scope)).toBe(first);
  });

  it('freezes emptiness too: a store empty at pin time stays null for the turn', async () => {
    const scope = 'general:conv-1';
    store.beginPromptTurn(scope);
    expect(store.renderForPrompt(scope)).toBeNull();
    await store.add(entry('Rule A'));
    expect(store.renderForPrompt(scope)).toBeNull();
    // Next boundary adopts it.
    store.beginPromptTurn(scope);
    expect(store.renderForPrompt(scope)).toContain('## Rule A');
  });
});

// ── Refresh policy ──

describe('refresh policy', () => {
  it('an UNPINNED scope reads live from disk (freezing is opt-in)', async () => {
    await store.add(entry('Rule A'));
    expect(store.renderForPrompt('never-pinned')).toContain('## Rule A');
    await store.add(entry('Rule B'));
    expect(store.renderForPrompt('never-pinned')).toContain('## Rule B');
  });

  it('no scope argument reads live (pre-freeze behavior is preserved)', async () => {
    const scope = 'general:conv-1';
    await store.add(entry('Rule A'));
    store.beginPromptTurn(scope);
    await store.add(entry('Rule B', 'fresh'));
    expect(store.renderForPrompt(scope)).not.toContain('fresh');
    expect(store.renderForPrompt()).toContain('fresh');
  });

  it('the NEXT turn boundary adopts the agent\'s own mid-turn write', async () => {
    // This is why the policy is "freeze until write-by-self, adopted at the next
    // boundary" and not "freeze forever": the background-review fork's whole job
    // is writing memory, and a permanent freeze would discard that learning.
    const scope = 'general:conv-1';
    await store.add(entry('Rule A'));
    store.beginPromptTurn(scope);
    await store.add(entry('Reviewed', 'lesson from the review fork'));
    expect(store.renderForPrompt(scope)).not.toContain('lesson from the review fork');

    store.beginPromptTurn(scope); // next real turn
    expect(store.renderForPrompt(scope)).toContain('lesson from the review fork');
  });

  it('explicit invalidate thaws immediately, without waiting for a boundary', async () => {
    const scope = 'general:conv-1';
    await store.add(entry('Rule A'));
    store.beginPromptTurn(scope);
    externalWrite(MEMORY_FILE, [entry('Hand Edited', 'typed by the user')]);
    expect(store.renderForPrompt(scope)).not.toContain('typed by the user');

    store.invalidatePromptSnapshot(scope);
    expect(store.renderForPrompt(scope)).toContain('typed by the user');
  });

  it('invalidate with no scope thaws every scope', async () => {
    await store.add(entry('Rule A'));
    store.beginPromptTurn('general:a');
    store.beginPromptTurn('general:b');
    await store.add(entry('Rule B', 'later'));
    expect(store.renderForPrompt('general:a')).not.toContain('later');
    store.invalidatePromptSnapshot();
    expect(store.renderForPrompt('general:a')).toContain('later');
    expect(store.renderForPrompt('general:b')).toContain('later');
  });

  it('scopes are independent — one conversation re-pinning does not move another', async () => {
    await store.add(entry('Rule A'));
    store.beginPromptTurn('general:a');
    store.beginPromptTurn('general:b');
    await store.add(entry('Rule B', 'only A should see this'));

    store.beginPromptTurn('general:a'); // A takes a turn; B does not
    expect(store.renderForPrompt('general:a')).toContain('only A should see this');
    expect(store.renderForPrompt('general:b')).not.toContain('only A should see this');
  });
});

// ── Drift detection (the previously-unused contentHash) ──

describe('drift detection', () => {
  it('fires with origin=external on a hand edit that bypassed the store', async () => {
    const scope = 'general:conv-1';
    await store.add(entry('Rule A'));
    expect(store.beginPromptTurn(scope)).toBeNull(); // first pin: nothing to compare

    externalWrite(MEMORY_FILE, [entry('Rule A'), entry('Injected By Hand')]);
    const drift = store.beginPromptTurn(scope);
    expect(drift).not.toBeNull();
    expect(drift!.origin).toBe('external');
    expect(drift!.scope).toBe(scope);
    expect(drift!.previousHash).not.toBe(drift!.currentHash);
    expect(store.lastPromptDrift()).toEqual(drift);
  });

  it('attributes the store\'s own write as origin=self, not external', async () => {
    const scope = 'general:conv-1';
    await store.add(entry('Rule A'));
    store.beginPromptTurn(scope);
    await store.add(entry('Rule B'));
    const drift = store.beginPromptTurn(scope);
    expect(drift).not.toBeNull();
    expect(drift!.origin).toBe('self');
  });

  it('reports no drift when the file did not change between boundaries', async () => {
    const scope = 'general:conv-1';
    await store.add(entry('Rule A'));
    store.beginPromptTurn(scope);
    expect(store.beginPromptTurn(scope)).toBeNull();
    expect(store.beginPromptTurn(scope)).toBeNull();
  });

  it('a REJECTED write is not mistaken for a self change', async () => {
    // A failed mutation writes nothing and must not bump the write epoch, or a
    // later external edit would be misattributed to us.
    const scope = 'general:conv-1';
    await store.add(entry('Rule A'));
    store.beginPromptTurn(scope);
    expect((await store.remove('no-such-entry')).success).toBe(false);

    externalWrite(MEMORY_FILE, [entry('Rule A'), entry('External')]);
    const drift = store.beginPromptTurn(scope);
    expect(drift!.origin).toBe('external');
  });

  it('detectDrift answers mid-turn without disturbing the frozen render', async () => {
    const scope = 'general:conv-1';
    await store.add(entry('Rule A', 'pinned body'));
    store.beginPromptTurn(scope);
    expect(store.detectDrift(scope).drifted).toBe(false);

    externalWrite(MEMORY_FILE, [entry('Rule A', 'changed on disk')]);
    const d = store.detectDrift(scope);
    expect(d.drifted).toBe(true);
    expect(d.pinnedHash).not.toBe(d.diskHash);
    // Asking must not thaw: the turn keeps its consistent view.
    expect(store.renderForPrompt(scope)).toContain('pinned body');
  });

  it('an unpinned scope reports no drift (nothing to compare against)', async () => {
    await store.add(entry('Rule A'));
    const d = store.detectDrift('never-pinned');
    expect(d.drifted).toBe(false);
    expect(d.pinnedHash).toBeUndefined();
    expect(d.diskHash).toBeTruthy();
  });
});

// ── Module-level turn helper (what loop.ts calls) ──

describe('beginMemoryPromptTurn', () => {
  it('pins BOTH global stores under one scope so they cannot disagree', async () => {
    const mem = getBoundedMemory();
    const user = getBoundedMemory(undefined, 'user');
    await mem.add(entry('Behavior Rule', 'memory side'));
    await user.add(entry('Who I Am', 'user side'));

    const { scope } = beginMemoryPromptTurn('general', 'conv-1');
    expect(scope).toBe(promptScope('general', 'conv-1'));

    await mem.add(entry('New Rule', 'memory mid-turn'));
    await user.add(entry('New Fact', 'user mid-turn'));

    expect(mem.renderForPrompt(scope)).not.toContain('memory mid-turn');
    expect(user.renderForPrompt(scope)).not.toContain('user mid-turn');
    expect(mem.renderForPrompt(scope)).toContain('memory side');
    expect(user.renderForPrompt(scope)).toContain('user side');
  });

  it('returns drift from either store', async () => {
    const mem = getBoundedMemory();
    await mem.add(entry('Rule A'));
    beginMemoryPromptTurn('general', 'conv-1');

    externalWrite(USER_FILE, [entry('Snuck In', 'via the sync plane')]);
    const { drift } = beginMemoryPromptTurn('general', 'conv-1');
    expect(drift).toHaveLength(1);
    expect(drift[0].origin).toBe('external');
  });

  it('pins the GENERAL stores even when called with another agentId', async () => {
    // buildMemoryContext always injects the general stores; agentId only keys the
    // scope. Pinning a per-agent store instead would freeze nothing.
    const mem = getBoundedMemory();
    await mem.add(entry('Rule A', 'general store'));
    const { scope } = beginMemoryPromptTurn('some-console-agent', 'conv-9');
    await mem.add(entry('Rule B', 'mid-turn'));
    expect(mem.renderForPrompt(scope)).toContain('general store');
    expect(mem.renderForPrompt(scope)).not.toContain('mid-turn');
  });

  it('scope key defaults are stable', () => {
    expect(promptScope()).toBe('general:_default');
    expect(promptScope(undefined, 'c1')).toBe('general:c1');
    expect(promptScope('a1', 'c1')).toBe('a1:c1');
  });
});

describe('invalidateMemoryPromptSnapshots', () => {
  it('thaws both global stores (the memory-editor path)', async () => {
    const mem = getBoundedMemory();
    const user = getBoundedMemory(undefined, 'user');
    await mem.add(entry('Rule A'));
    await user.add(entry('Fact A'));
    const { scope } = beginMemoryPromptTurn('general', 'conv-1');

    externalWrite(MEMORY_FILE, [entry('Edited Memory', 'by the human')]);
    externalWrite(USER_FILE, [entry('Edited Profile', 'by the human')]);
    expect(mem.renderForPrompt(scope)).not.toContain('by the human');

    invalidateMemoryPromptSnapshots();
    expect(mem.renderForPrompt(scope)).toContain('by the human');
    expect(user.renderForPrompt(scope)).toContain('by the human');
  });

  it('scoped invalidate leaves other scopes frozen', async () => {
    const mem = getBoundedMemory();
    await mem.add(entry('Rule A'));
    beginMemoryPromptTurn('general', 'conv-a');
    beginMemoryPromptTurn('general', 'conv-b');
    externalWrite(MEMORY_FILE, [entry('Rule A'), entry('Later', 'new content')]);

    invalidateMemoryPromptSnapshots('general', 'conv-a');
    expect(mem.renderForPrompt(promptScope('general', 'conv-a'))).toContain('new content');
    expect(mem.renderForPrompt(promptScope('general', 'conv-b'))).not.toContain('new content');
  });
});

// ── Pin table bookkeeping ──

describe('MemoryPromptSnapshots', () => {
  it('evicts the oldest scope past the cap instead of growing forever', () => {
    const snaps = new MemoryPromptSnapshots('MEMORY.md');
    for (let i = 0; i < 12; i++) snaps.pin(`s${i}`, `block ${i}`, `hash${i}`, 0);
    // Oldest are gone (they degrade to a live read, which is still correct);
    // the most recent survive.
    expect(snaps.get('s0')).toBeUndefined();
    expect(snaps.get('s11')).toBeDefined();
    expect(snaps.get('s11')!.block).toBe('block 11');
  });

  it('re-pinning an existing scope refreshes in place, not as a new entry', () => {
    const snaps = new MemoryPromptSnapshots('MEMORY.md');
    snaps.pin('s1', 'v1', 'h1', 0);
    snaps.pin('s1', 'v2', 'h2', 1);
    expect(snaps.get('s1')!.block).toBe('v2');
    // Filling the cap must not evict a scope that keeps being re-pinned.
    for (let i = 0; i < 20; i++) {
      snaps.pin('s1', `v${i}`, `h${i}`, i);
      snaps.pin(`other${i}`, 'x', `oh${i}`, 0);
    }
    expect(snaps.get('s1')).toBeDefined();
  });

  it('counts drifts and resetDrift clears history without thawing pins', () => {
    const snaps = new MemoryPromptSnapshots('MEMORY.md');
    snaps.pin('s1', 'a', 'h1', 0);
    expect(snaps.pin('s1', 'b', 'h2', 0)!.origin).toBe('external');
    expect(snaps.pin('s1', 'c', 'h3', 1)!.origin).toBe('self');
    expect(snaps.totalDrifts()).toBe(2);
    snaps.resetDrift();
    expect(snaps.lastDrift()).toBeNull();
    expect(snaps.totalDrifts()).toBe(0);
    expect(snaps.get('s1')).toBeDefined();
  });
});
