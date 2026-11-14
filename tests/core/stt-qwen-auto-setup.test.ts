/**
 * The voice model sets itself up: which servers install it, and that a finished
 * install makes `qwen` the engine only when nobody picked one meanwhile.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-test-stt-auto'));

import {
  autoSetupDecision, startQwenAutoSetup, retryQwenAutoSetup, getQwenSetupStatus, isIsolatedServer,
  _resetQwenAutoSetupForTest, _qwenAutoSetupRunning,
} from '../../src/core/stt/auto-setup.js';
import { getConfig, updateConfig } from '../../src/core/config-manager.js';
import type { Config } from '../../src/core/types.js';
import type { QwenPlan } from '../../src/core/stt/qwen-plan.js';

const LLAMA: QwenPlan = { runtime: 'llama', size: '0.6B', target: 'linux-arm64' };
const cfg = (stt?: Config['stt']) => ({ stt } as Config);

describe('autoSetupDecision', () => {
  it.each([
    ['no engine chosen', cfg(), {}, false, LLAMA, true],
    ['qwen chosen', cfg({ engine: 'qwen' }), {}, false, LLAMA, true],
    ['another engine chosen', cfg({ engine: 'whisper-server' }), {}, false, LLAMA, false],
    ['an isolated server', cfg(), {}, true, LLAMA, false],
    ['an isolated server that opts in', cfg(), { WALNUT_STT_AUTO_SETUP: '1' }, true, LLAMA, true],
    ['turned off', cfg(), { WALNUT_STT_AUTO_SETUP: '0' }, false, LLAMA, false],
    ['no runtime for the platform', cfg(), {}, false, { runtime: 'none', reason: 'nope' } as QwenPlan, false],
  ] as const)('%s', (_name, config, env, isolated, plan, run) => {
    expect(autoSetupDecision({ config, env, isolated, plan }).run).toBe(run);
  });

  it('counts a test runner as an isolated server', async () => {
    expect(await isIsolatedServer()).toBe(true);
  });
});

describe('startQwenAutoSetup', () => {
  beforeEach(async () => {
    _resetQwenAutoSetupForTest();
    await updateConfig({ stt: {} });
  });

  it('installs in the background, then makes qwen the engine', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const install = vi.fn(async (_plan: QwenPlan, onEvent: (e: { type: 'progress'; percent: number; message: string }) => void) => {
      onEvent({ type: 'progress', percent: 40, message: 'Downloading' });
      await gate;
    });
    await startQwenAutoSetup({ isolated: false, plan: LLAMA, install, installed: async () => false });
    // Resolved before the download finished: boot never waits for it.
    expect(getQwenSetupStatus()).toMatchObject({ state: 'installing', runtime: 'llama 0.6B' });
    await vi.waitFor(() => expect(getQwenSetupStatus().percent).toBe(40));
    expect((await getConfig()).stt?.engine).toBeUndefined();
    release();
    await _qwenAutoSetupRunning();
    expect(getQwenSetupStatus().state).toBe('ready');
    expect((await getConfig()).stt?.engine).toBe('qwen');
  });

  it('keeps an engine the person picked while it installed', async () => {
    const install = vi.fn(async () => { await updateConfig({ stt: { engine: 'whisper-server' } }); });
    await startQwenAutoSetup({ isolated: false, plan: LLAMA, install, installed: async () => false });
    await _qwenAutoSetupRunning();
    expect((await getConfig()).stt?.engine).toBe('whisper-server');
  });

  it('does not download what is already installed', async () => {
    const install = vi.fn();
    await startQwenAutoSetup({ isolated: false, plan: LLAMA, install, installed: async () => true });
    await _qwenAutoSetupRunning();
    expect(install).not.toHaveBeenCalled();
    expect((await getConfig()).stt?.engine).toBe('qwen');
  });

  it('reports a failure and schedules a retry', async () => {
    const install = vi.fn(async () => { throw new Error('Not enough disk space for voice transcription'); });
    await startQwenAutoSetup({ isolated: false, plan: LLAMA, install, installed: async () => false });
    await _qwenAutoSetupRunning();
    const status = getQwenSetupStatus();
    expect(status.state).toBe('failed');
    expect(status.error).toContain('disk space');
    expect(Date.parse(status.retryAt!)).toBeGreaterThan(Date.now());
    expect((await getConfig()).stt?.engine).toBeUndefined();
    _resetQwenAutoSetupForTest();
  });

  it('a retry asks again: a person who picked another engine meanwhile gets no download', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const install = vi.fn(async () => { throw new Error('network down'); });
      await startQwenAutoSetup({ isolated: false, plan: LLAMA, install, installed: async () => false });
      await _qwenAutoSetupRunning();
      expect(install).toHaveBeenCalledTimes(1);
      await updateConfig({ stt: { engine: 'whisper-server' } });
      await vi.advanceTimersByTimeAsync(61_000);
      await _qwenAutoSetupRunning();
      expect(install).toHaveBeenCalledTimes(1);
      expect(getQwenSetupStatus()).toMatchObject({ state: 'skipped' });
    } finally {
      vi.useRealTimers();
      _resetQwenAutoSetupForTest();
    }
  });

  it('a person pressing Install runs it even where the boot job would not', async () => {
    await updateConfig({ stt: { engine: 'qwen' } });
    const install = vi.fn(async () => {});
    await retryQwenAutoSetup({ isolated: true, userAsked: true, plan: LLAMA, install, installed: async () => false });
    await _qwenAutoSetupRunning();
    expect(install).toHaveBeenCalledTimes(1);
    expect(getQwenSetupStatus().state).toBe('ready');
  });

  it('does nothing on an isolated server', async () => {
    const install = vi.fn();
    await startQwenAutoSetup({ isolated: true, plan: LLAMA, install, installed: async () => false });
    expect(install).not.toHaveBeenCalled();
    expect(getQwenSetupStatus()).toMatchObject({ state: 'skipped', message: 'isolated server' });
  });
});
