/**
 * isFfmpegAvailable runs on every GET /api/stt/status and POST /api/stt/draft
 * (through each engine's isAvailable). It used to spawn `ffmpeg -version` every
 * time; under load the 5s timeout failed and the browser then showed no
 * microphone for a minute. Pinned here: found is memoized for 10 minutes, missing
 * for 30s, per extraDirs key, concurrent callers share one spawn, and a timeout
 * does not turn an earlier "found" into "missing".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

type ExecCallback = (err: (Error & { code?: string | number; killed?: boolean }) | null, out?: unknown) => void;

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile: execFileMock,
}));

import { isFfmpegAvailable, _resetFfmpegProbeCacheForTest } from '../../src/core/stt/audio-convert.js';

function ffmpegAnswers(outcome: () => Parameters<ExecCallback>[0]): void {
  execFileMock.mockImplementation((_file: string, _args: string[], _opts: unknown, cb: ExecCallback) => {
    setImmediate(() => {
      const err = outcome();
      cb(err, err ? undefined : { stdout: 'ffmpeg version 8', stderr: '' });
    });
  });
}

const notFound = () => Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' });
const timedOut = () => Object.assign(new Error('timed out'), { killed: true });

beforeEach(() => {
  _resetFfmpegProbeCacheForTest();
  execFileMock.mockReset();
  vi.useFakeTimers({ toFake: ['Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('isFfmpegAvailable memoization', () => {
  it('spawns once for repeated status checks while found (10 minutes)', async () => {
    ffmpegAnswers(() => null);
    for (let i = 0; i < 10; i++) expect(await isFfmpegAvailable()).toBe(true);
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock.mock.calls[0][0]).toBe('ffmpeg');
    expect(execFileMock.mock.calls[0][1]).toEqual(['-version']);

    vi.setSystemTime(Date.now() + 10 * 60_000 - 1_000);
    expect(await isFfmpegAvailable()).toBe(true);
    expect(execFileMock).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + 2_000);
    expect(await isFfmpegAvailable()).toBe(true);
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it('remembers a miss for 30s only, so an install is picked up quickly', async () => {
    ffmpegAnswers(notFound);
    expect(await isFfmpegAvailable()).toBe(false);
    vi.setSystemTime(Date.now() + 29_000);
    expect(await isFfmpegAvailable()).toBe(false);
    expect(execFileMock).toHaveBeenCalledTimes(1);

    ffmpegAnswers(() => null);
    vi.setSystemTime(Date.now() + 2_000);
    expect(await isFfmpegAvailable()).toBe(true);
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it('keys the memo by extraDirs', async () => {
    ffmpegAnswers(() => null);
    await isFfmpegAvailable();
    await isFfmpegAvailable(['/opt/whisper/bin']);
    await isFfmpegAvailable(['/opt/whisper/bin']);
    await isFfmpegAvailable(['/other/bin']);
    expect(execFileMock).toHaveBeenCalledTimes(3);
    const paths = execFileMock.mock.calls.map((c) => ((c[2] as { env: NodeJS.ProcessEnv }).env.PATH ?? '').split(':'));
    expect(paths[0]).not.toContain('/opt/whisper/bin');
    expect(paths[1]).toContain('/opt/whisper/bin');
    expect(paths[2]).toContain('/other/bin');
  });

  it('shares one spawn between concurrent callers', async () => {
    ffmpegAnswers(() => null);
    const results = await Promise.all(Array.from({ length: 25 }, () => isFfmpegAvailable()));
    expect(results.every(Boolean)).toBe(true);
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it('a timeout after an earlier "found" still says found, and re-probes in 30s', async () => {
    ffmpegAnswers(() => null);
    expect(await isFfmpegAvailable()).toBe(true);

    ffmpegAnswers(timedOut);
    vi.setSystemTime(Date.now() + 10 * 60_000 + 1);
    expect(await isFfmpegAvailable()).toBe(true);
    expect(execFileMock).toHaveBeenCalledTimes(2);

    ffmpegAnswers(() => null);
    vi.setSystemTime(Date.now() + 31_000);
    expect(await isFfmpegAvailable()).toBe(true);
    expect(execFileMock).toHaveBeenCalledTimes(3);
  });

  it('a timeout with no earlier answer reads as missing (short memo)', async () => {
    ffmpegAnswers(timedOut);
    expect(await isFfmpegAvailable()).toBe(false);
    ffmpegAnswers(() => null);
    vi.setSystemTime(Date.now() + 31_000);
    expect(await isFfmpegAvailable()).toBe(true);
  });

  it('a real miss after an earlier "found" is reported as missing', async () => {
    ffmpegAnswers(() => null);
    expect(await isFfmpegAvailable()).toBe(true);
    ffmpegAnswers(notFound);
    vi.setSystemTime(Date.now() + 10 * 60_000 + 1);
    expect(await isFfmpegAvailable()).toBe(false);
  });
});
