/**
 * The exact model windows Claude Code reported survive a restart (2026-11-07, the user: find the
 * real window, not the model name's guess). Before, the host+model cache lived in memory only, so
 * every deploy sent each session back to the name rule until its first turn ended.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const records: Array<Record<string, unknown>> = [];
vi.mock('../../src/core/session-tracker.js', () => ({ listSessions: async () => records }));

import { startModelWindowStore, resetModelWindowStore, flushModelWindowStore } from '../../src/providers/model-window-store.js';
import { rememberModelWindow, recallModelWindow, resetContextWindowCaches } from '../../src/providers/context-window.js';

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'model-windows-'));
  file = path.join(dir, 'cache', 'model-windows.json');
  resetContextWindowCaches();
  resetModelWindowStore(file);
  records.length = 0;
});

describe('model window store', () => {
  it('keeps what the CLI reported across a restart', async () => {
    await startModelWindowStore();
    rememberModelWindow('clouddev', 'global.anthropic.claude-opus-5-5', 1_000_000);
    await flushModelWindowStore();
    // The restart: memory is empty, the file is not.
    resetContextWindowCaches();
    resetModelWindowStore(file);
    expect(recallModelWindow('clouddev', 'claude-opus-5-5')).toBeUndefined();
    expect(await startModelWindowStore()).toBe(1);
    expect(recallModelWindow('clouddev', 'claude-opus-5-5')).toBe(1_000_000);
  });

  it('with no file yet, learns from the session records the CLI reported for, and only those', async () => {
    records.push(
      { host: 'clouddev', modelMaxWindow: 1_000_000, modelMaxWindowSource: 'cli-model-usage', modelMaxWindowModel: 'global.anthropic.claude-opus-5-5', lastActiveAt: '2026-11-06T00:00:00Z' },
      // A guess an older Walnut stored, and a record with no source: never learned.
      { host: 'clouddev', modelMaxWindow: 200_000, modelMaxWindowSource: 'model-string', modelMaxWindowModel: 'claude-opus-4-8' },
      { host: '__local__', modelMaxWindow: 200_000, modelMaxWindowModel: 'claude-haiku-4-5' },
    );
    expect(await startModelWindowStore()).toBe(1);
    expect(recallModelWindow('clouddev', 'claude-opus-5-5')).toBe(1_000_000);
    expect(recallModelWindow('clouddev', 'claude-opus-4-8')).toBeUndefined();
    expect(recallModelWindow(null, 'claude-haiku-4-5')).toBeUndefined();
  });

  it('a 1M request and the plain model stay apart, though the init line drops the marker', async () => {
    records.push(
      { host: 'mac', cliModel: 'claude-opus-4-8[1m]', modelMaxWindow: 1_000_000, modelMaxWindowSource: 'cli-model-usage', modelMaxWindowModel: 'claude-opus-4-8' },
    );
    await startModelWindowStore();
    expect(recallModelWindow('mac', 'claude-opus-4-8[1m]')).toBe(1_000_000);
    expect(recallModelWindow('mac', 'claude-opus-4-8')).toBeUndefined();
  });

  it('a broken file starts empty instead of failing the boot', async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, '{not json');
    expect(await startModelWindowStore()).toBe(0);
  });
});
