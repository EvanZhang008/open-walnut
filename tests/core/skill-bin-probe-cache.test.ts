/**
 * Skill eligibility asks `which` for every binary a skill declares, and
 * GET /api/skills runs it on every page load and socket reconnect. It used to be
 * a synchronous spawn per skill per request (p90 10.7s under load). These tests
 * pin the cache: one spawn per binary per 10 minutes, shared by concurrent
 * callers, and a slow machine never hides a skill.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';

type ExecCallback = (err: (Error & { code?: string | number; killed?: boolean }) | null) => void;

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile: execFileMock,
}));
vi.mock('../../src/constants.js', () => createMockConstants('walnut-skill-bin-probe'));

import { isEligible, _resetBinProbeCacheForTest } from '../../src/core/skill-loader.js';

const needs = (...bins: string[]) => ({ metadata: { openclaw: { requires: { bins } } } });

/** Answer every `which` with the given outcome on the next tick. */
function whichAnswers(outcome: (name: string) => Parameters<ExecCallback>[0]): void {
  execFileMock.mockImplementation((_file: string, args: string[], _opts: unknown, cb: ExecCallback) => {
    setImmediate(() => cb(outcome(args[0])));
  });
}

const exitCode = (code: number) => Object.assign(new Error(`exit ${code}`), { code });

beforeEach(() => {
  _resetBinProbeCacheForTest();
  execFileMock.mockReset();
  vi.useFakeTimers({ toFake: ['Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('skill eligibility binary probe cache', () => {
  it('spawns `which` once per binary for repeated checks, off the event loop', async () => {
    whichAnswers(() => null);
    for (let i = 0; i < 5; i++) expect(await isEligible(needs('docker'))).toBe(true);
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock.mock.calls[0][0]).toBe('which');
    expect(execFileMock.mock.calls[0][1]).toEqual(['docker']);
    expect(execFileMock.mock.calls[0][2]).toMatchObject({ timeout: expect.any(Number) });
  });

  it('shares one probe between concurrent callers', async () => {
    whichAnswers(() => null);
    const results = await Promise.all(Array.from({ length: 20 }, () => isEligible(needs('gh'))));
    expect(results.every(Boolean)).toBe(true);
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it('caches a miss too, and asks again after 10 minutes', async () => {
    whichAnswers(() => exitCode(1));
    expect(await isEligible(needs('absent-tool'))).toBe(false);
    vi.advanceTimersByTime(9 * 60_000);
    expect(await isEligible(needs('absent-tool'))).toBe(false);
    expect(execFileMock).toHaveBeenCalledTimes(1);

    // Installed meanwhile: the next probe after the TTL sees it.
    whichAnswers(() => null);
    vi.advanceTimersByTime(60_001);
    expect(await isEligible(needs('absent-tool'))).toBe(true);
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it('keys the cache per binary name', async () => {
    whichAnswers((name) => (name === 'present' ? null : exitCode(1)));
    expect(await isEligible(needs('present'))).toBe(true);
    expect(await isEligible(needs('missing'))).toBe(false);
    expect(await isEligible(needs('present', 'missing'))).toBe(false);
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it('a timed-out probe counts as found and is not cached', async () => {
    whichAnswers(() => Object.assign(new Error('killed'), { killed: true, code: null as unknown as number }));
    expect(await isEligible(needs('slow-tool'))).toBe(true);
    whichAnswers(() => exitCode(1));
    expect(await isEligible(needs('slow-tool'))).toBe(false);
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it('a failed spawn (EAGAIN) counts as found and is not cached', async () => {
    whichAnswers(() => Object.assign(new Error('spawn EAGAIN'), { code: 'EAGAIN' }));
    expect(await isEligible(needs('busy-tool'))).toBe(true);
    whichAnswers(() => null);
    expect(await isEligible(needs('busy-tool'))).toBe(true);
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it('no `which` on the system (ENOENT) keeps the old answer: missing, and cached', async () => {
    whichAnswers(() => Object.assign(new Error('spawn which ENOENT'), { code: 'ENOENT' }));
    expect(await isEligible(needs('anything'))).toBe(false);
    expect(await isEligible(needs('anything'))).toBe(false);
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it('never probes a skill that fails a cheaper check first', async () => {
    whichAnswers(() => null);
    const fm = { metadata: { openclaw: { requires: { bins: ['docker'], platform: ['__fake_os__'] } } } };
    expect(await isEligible(fm)).toBe(false);
    expect(execFileMock).not.toHaveBeenCalled();
  });
});
