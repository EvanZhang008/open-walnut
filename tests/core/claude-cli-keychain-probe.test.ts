/**
 * The macOS keychain existence probe used to be a synchronous `security` spawn on
 * the server's event loop (boot + every config change). It is now an async
 * execFile with a 3s timeout and a 30s memo; the sync entry point only reads that
 * memo and starts a background probe. The `-w` flag stays absent, so the secret
 * value is never emitted.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type ExecCallback = (err: (Error & { code?: string | number; killed?: boolean }) | null) => void;

const { execFileMock, execFileSyncMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  execFileSyncMock: vi.fn(() => {
    throw new Error('execFileSync must not be called');
  }),
}));

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile: execFileMock,
  execFileSync: execFileSyncMock,
}));
vi.mock('../../src/constants.js', async () => {
  const { createMockConstants } = await import('../helpers/mock-constants.js');
  const base = createMockConstants('walnut-keychain-probe');
  return { ...base, CLAUDE_CREDENTIALS_FILE: path.join(base.CLAUDE_HOME, '.credentials.json') };
});

import {
  hasClaudeSubscriptionAuth,
  hasClaudeSubscriptionAuthAsync,
  detectClaudeCliAsync,
  _resetKeychainProbeForTest,
} from '../../src/core/claude-cli-detect.js';

const AUTH_ENV = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'HOME', 'PATH'];
const savedEnv: Record<string, string | undefined> = {};
const realPlatform = process.platform;
let fakeHome: string;

/** Answer every `security` call on the next tick; `present` = exit 0. */
function keychainAnswers(outcome: () => Parameters<ExecCallback>[0]): void {
  execFileMock.mockImplementation((_file: string, _args: string[], _opts: unknown, cb: ExecCallback) => {
    setImmediate(() => cb(outcome()));
  });
}
const present = () => null;
const absent = () => Object.assign(new Error('exit 44'), { code: 44 });
const timedOut = () => Object.assign(new Error('timed out'), { killed: true });

/** Let a background probe's callback run. */
const settle = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  _resetKeychainProbeForTest();
  execFileMock.mockReset();
  execFileSyncMock.mockClear();
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  vi.useFakeTimers({ toFake: ['Date'] });
  for (const k of AUTH_ENV) savedEnv[k] = process.env[k];
  // A controlled install: a fake `claude` on PATH, no settings.json, no auth env.
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-keychain-home-'));
  const bin = path.join(fakeHome, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  process.env.HOME = fakeHome;
  process.env.PATH = bin;
  for (const k of AUTH_ENV.slice(0, 4)) delete process.env[k];
});

afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  for (const k of AUTH_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

describe('keychain subscription probe', () => {
  it('asks for existence only: no -w, a 3s timeout, never a sync spawn', async () => {
    keychainAnswers(present);
    expect(await hasClaudeSubscriptionAuthAsync()).toBe(true);
    const [file, args, opts] = execFileMock.mock.calls[0];
    expect(file).toBe('security');
    expect(args).toEqual(['find-generic-password', '-s', 'Claude Code-credentials']);
    expect(args).not.toContain('-w');
    expect(opts).toMatchObject({ timeout: 3_000 });
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('memoizes for 30s and shares one spawn between concurrent callers', async () => {
    keychainAnswers(present);
    const all = await Promise.all(Array.from({ length: 10 }, () => hasClaudeSubscriptionAuthAsync()));
    expect(all.every(Boolean)).toBe(true);
    expect(await hasClaudeSubscriptionAuthAsync()).toBe(true);
    expect(execFileMock).toHaveBeenCalledTimes(1);

    keychainAnswers(absent);
    vi.setSystemTime(Date.now() + 31_000);
    expect(await hasClaudeSubscriptionAuthAsync()).toBe(false);
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it('the sync form never blocks: cold it answers from the file store and probes in the background', async () => {
    keychainAnswers(present);
    expect(hasClaudeSubscriptionAuth()).toBe(false); // nothing known yet, no credentials file
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileSyncMock).not.toHaveBeenCalled();

    await settle();
    expect(hasClaudeSubscriptionAuth()).toBe(true);
    expect(execFileMock).toHaveBeenCalledTimes(1); // fresh memo, no new probe
  });

  it('the sync form still sees the JSON credential store with no keychain item', async () => {
    keychainAnswers(absent);
    const credFile = path.join((await import('../../src/constants.js')).CLAUDE_HOME, '.credentials.json');
    fs.mkdirSync(path.dirname(credFile), { recursive: true });
    fs.writeFileSync(credFile, '{}');
    try {
      expect(hasClaudeSubscriptionAuth()).toBe(true);
      expect(await hasClaudeSubscriptionAuthAsync()).toBe(true);
    } finally {
      fs.rmSync(credFile, { force: true });
    }
  });

  it('a timeout keeps the last known answer and caches nothing', async () => {
    keychainAnswers(present);
    expect(await hasClaudeSubscriptionAuthAsync()).toBe(true);

    keychainAnswers(timedOut);
    vi.setSystemTime(Date.now() + 31_000);
    expect(await hasClaudeSubscriptionAuthAsync()).toBe(true);
    expect(await hasClaudeSubscriptionAuthAsync()).toBe(true);
    expect(execFileMock).toHaveBeenCalledTimes(3); // no memo from a timeout: each call asks
  });

  it('detectClaudeCliAsync reports the subscription on the first call', async () => {
    keychainAnswers(present);
    const caps = await detectClaudeCliAsync();
    expect(caps.installed).toBe(true);
    expect(caps.subscriptionAuth).toBe(true);
    expect(caps.subscriptionReady).toBe(true);
    expect(caps.auth).toEqual({ mode: 'subscription', label: 'your Claude subscription' });
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });
});
