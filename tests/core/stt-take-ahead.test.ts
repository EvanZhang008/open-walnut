/**
 * A take heard ahead while it records (src/core/stt/take-ahead.ts): the
 * append protocol, the pieces settled from the growing file, and the stop
 * that hears only the tail when the clip is that take, else nothing changes.
 * WAV takes (no ffmpeg) except the one real WebM/Opus take; the engine is a stub.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { readdir, stat, writeFile, utimes, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('stt-take-ahead'));

import { WALNUT_HOME } from '../../src/constants.js';
import {
  appendToTake, finishTake, hearRest, dropTake, noteLiveDraft, sameRepeat, decodeStart,
  _resetTakesForTest, _takeCountForTest, _tuneTakesForTest, _takeDirForTest,
  MAX_TAKES, TAKE_IDLE_MS, type HearWav, type EngineId,
} from '../../src/core/stt/take-ahead.js';
import { decodeToPcm } from '../../src/core/stt/audio-convert.js';
import { removeBlockRepeat } from '../../src/lib/audio-block-repeat.js';
import { pcmToWav, wavPcm } from '../../src/core/stt/wav-segment.js';
import { speechPcm, repeatBlocks, RATE } from '../helpers/speech-pcm.js';

const STUB: EngineId = { name: 'stub', model: 'm1' };

/** A stub engine that says how long each WAV it heard was; silence it "hears" as words never said. */
function stubHear(engine: EngineId = STUB) {
  const heard: number[] = [];
  const hear = vi.fn<HearWav>(async (wav) => {
    const pcm = wavPcm(wav);
    const sec = pcm.length / RATE;
    heard.push(sec);
    const silent = pcm.every((x) => Math.abs(x) < 100);
    return { text: silent ? 'Thank you.' : `[${sec.toFixed(1)}s]`, durationMs: 5, engine: engine.name, ...(engine.model ? { model: engine.model } : {}) };
  });
  return { hear, heard };
}

/** An engine that answers only when told to. */
function hangingHear() {
  const waiting: Array<() => void> = [];
  const hear = vi.fn<HearWav>(() => new Promise((resolve) => {
    waiting.push(() => resolve({ text: 'late', durationMs: 1, engine: STUB.name, model: STUB.model }));
  }));
  return { hear, release: () => { for (const go of waiting.splice(0)) go(); } };
}

const ID = 'take-unit-0001';
/** A real WAV, so a decode of any prefix of it succeeds (and settles nothing). */
const SMALL = pcmToWav(speechPcm(3));
const opts = (hear: HearWav, format = 'wav') => ({ format, language: undefined, hear });
const stopOpts = (engine: EngineId | null = STUB, format = 'wav') => ({ format, language: undefined, engine });
const silence = (sec: number) => new Int16Array(Math.round(sec * RATE));
function concat(...parts: Int16Array[]): Int16Array {
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** Appends `clip` in `parts` parts, as the recorder would. */
async function appendInParts(id: string, clip: Buffer, parts: number, hear: HearWav, format = 'wav') {
  const step = Math.ceil(clip.length / parts);
  for (let at = 0; at < clip.length; at += step) {
    const out = await appendToTake(id, at, clip.subarray(at, Math.min(clip.length, at + step)), opts(hear, format));
    expect(out).toMatchObject({ ok: true });
  }
}

beforeEach(async () => { await _resetTakesForTest(); });
afterEach(async () => { vi.restoreAllMocks(); await _resetTakesForTest(); });

describe('append protocol', () => {
  it('appends only at the size the server holds, and answers 409 with that size otherwise', async () => {
    const { hear } = stubHear();
    const part = (from: number) => SMALL.subarray(from, from + 1000);
    expect(await appendToTake(ID, 0, part(0), opts(hear))).toEqual({ ok: true, size: 1000 });
    expect(await appendToTake(ID, 500, part(500), opts(hear))).toMatchObject({ ok: false, status: 409, size: 1000 });
    expect(await appendToTake(ID, 2000, part(2000), opts(hear))).toMatchObject({ ok: false, status: 409, size: 1000 });
    expect(await appendToTake(ID, 1000, part(1000), opts(hear))).toEqual({ ok: true, size: 2000 });
  });

  it('a take is made only by its first append at offset 0', async () => {
    const { hear } = stubHear();
    expect(await appendToTake('take-unknown-1', 10, Buffer.alloc(5), opts(hear))).toMatchObject({ ok: false, status: 404 });
    expect(_takeCountForTest()).toBe(0);
  });

  it('keeps at most a few takes: a new one drops the one touched longest ago', async () => {
    const { hear } = stubHear();
    for (let i = 0; i <= MAX_TAKES; i++) {
      expect(await appendToTake(`take-bound-${i}`, 0, SMALL.subarray(0, 100), opts(hear))).toMatchObject({ ok: true });
    }
    expect(_takeCountForTest()).toBe(MAX_TAKES);
    expect(await appendToTake('take-bound-0', 100, SMALL.subarray(100, 200), opts(hear))).toMatchObject({ ok: false, status: 410 });
    expect(await appendToTake(`take-bound-${MAX_TAKES}`, 100, SMALL.subarray(100, 200), opts(hear))).toMatchObject({ ok: true });
  });

  it('a take being stopped is never the one dropped to make room', async () => {
    const slow = hangingHear();
    const clip = pcmToWav(speechPcm(60, 3));
    await appendInParts('take-evict-0', clip, 1, slow.hear);
    await vi.waitFor(() => expect(slow.hear).toHaveBeenCalled(), { timeout: 10_000 });
    // The oldest take is at its stop, waiting for its piece.
    const stopping = finishTake('take-evict-0', clip, stopOpts());
    const { hear } = stubHear();
    for (let i = 1; i < MAX_TAKES; i++) await appendToTake(`take-evict-${i}`, 0, SMALL.subarray(0, 100), opts(hear));
    expect(await appendToTake('take-evict-new', 0, SMALL.subarray(0, 100), opts(hear))).toMatchObject({ ok: true });
    // The next oldest made room; the one being stopped is still there.
    expect(await appendToTake('take-evict-1', 100, SMALL.subarray(100, 200), opts(hear))).toMatchObject({ ok: false, status: 410 });
    expect(_takeCountForTest()).toBe(MAX_TAKES);
    slow.release();
    expect(await stopping).not.toBeNull();
  });

  it('a take idle for 15 minutes is dropped', async () => {
    const { hear } = stubHear();
    const now = Date.now();
    await appendToTake('take-idle-01', 0, SMALL.subarray(0, 100), opts(hear));
    vi.spyOn(Date, 'now').mockReturnValue(now + TAKE_IDLE_MS + 1000);
    await appendToTake('take-idle-02', 0, SMALL.subarray(0, 100), opts(hear));
    expect(await appendToTake('take-idle-01', 100, SMALL.subarray(100, 200), opts(hear))).toMatchObject({ ok: false, status: 410 });
    expect(_takeCountForTest()).toBe(1);
  });

  it('a dropped take takes no more parts', async () => {
    const { hear } = stubHear();
    await appendToTake(ID, 0, SMALL.subarray(0, 100), opts(hear));
    expect(await dropTake(ID)).toBe(true);
    expect(await appendToTake(ID, 100, SMALL.subarray(100, 200), opts(hear))).toMatchObject({ ok: false, status: 410 });
  });
});

describe('the take files: private, never left behind', () => {
  it('live in tmp/stt-takes of this Walnut home, the folder 0700 and each file 0600', async () => {
    const { hear } = stubHear();
    await appendToTake(ID, 0, SMALL.subarray(0, 1000), opts(hear));
    const dir = _takeDirForTest();
    expect(dir).toBe(join(WALNUT_HOME, 'tmp', 'stt-takes'));
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, `${ID}.wav`))).mode & 0o777).toBe(0o600);
  });

  it('a new take removes what an earlier run left, but not a file still being written', async () => {
    const dir = _takeDirForTest();
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'take-crashed-01.webm'), 'old');
    const old = (Date.now() - TAKE_IDLE_MS - 60_000) / 1000;
    await utimes(join(dir, 'take-crashed-01.webm'), old, old);
    await writeFile(join(dir, 'take-other-run-01.webm'), 'fresh');
    const { hear } = stubHear();
    await appendToTake(ID, 0, SMALL.subarray(0, 100), opts(hear));
    expect((await readdir(dir)).sort()).toEqual(['take-other-run-01.webm', `${ID}.wav`]);
    await rm(join(dir, 'take-other-run-01.webm'));
  });

  it('a drop racing an append in flight leaves no file and no take, in any order', async () => {
    const { hear } = stubHear();
    const big = pcmToWav(speechPcm(20, 8));
    for (let i = 0; i < 12; i++) {
      const id = `take-race-${String(i).padStart(2, '0')}`;
      const appending = appendToTake(id, 0, big, opts(hear));
      if (i % 3) await new Promise((r) => setTimeout(r, i % 4));
      const dropping = dropTake(id);
      await Promise.all([appending, dropping]);
      // A part that was still on its way makes no take again.
      expect(await appendToTake(id, 0, big, opts(hear))).toMatchObject({ ok: false, status: 410 });
    }
    expect(_takeCountForTest()).toBe(0);
    expect(await readdir(_takeDirForTest())).toEqual([]);
  });

  it('a first part landing after the stop or after a drop of a take never seen makes no take', async () => {
    const { hear } = stubHear();
    await appendToTake(ID, 0, SMALL.subarray(0, 100), opts(hear));
    expect(await finishTake(ID, SMALL, stopOpts())).toBeNull();
    expect(await appendToTake(ID, 0, SMALL.subarray(0, 100), opts(hear))).toMatchObject({ ok: false, status: 410 });
    expect(await dropTake('take-dropped-early')).toBe(false);
    expect(await appendToTake('take-dropped-early', 0, SMALL.subarray(0, 100), opts(hear))).toMatchObject({ ok: false, status: 410 });
    expect(_takeCountForTest()).toBe(0);
    expect(await readdir(_takeDirForTest())).toEqual([]);
  });
});

describe('hearing ahead', () => {
  it('a short take settles nothing, and its stop hears the whole clip', async () => {
    const { hear } = stubHear();
    const clip = pcmToWav(speechPcm(35));
    await appendInParts(ID, clip, 3, hear);
    expect(await finishTake(ID, clip, stopOpts())).toBeNull();
    expect(hear).not.toHaveBeenCalled();
  });

  it('hears finished pieces of about 30 s while it records, and at the stop only the tail is left', async () => {
    const { hear, heard } = stubHear();
    const pcm = speechPcm(150, 11);
    const clip = pcmToWav(pcm);
    await appendInParts(ID, clip, 10, hear);
    await vi.waitFor(() => expect(heard.length).toBeGreaterThanOrEqual(3), { timeout: 10_000 });
    const ahead = await finishTake(ID, clip, stopOpts());
    expect(ahead).not.toBeNull();
    expect(ahead!.pieces.length).toBe(heard.length);
    for (const sec of heard) expect(sec).toBeLessThanOrEqual(30);
    // Pieces and tail cover the take exactly, once.
    expect(ahead!.aheadSec + ahead!.tailSec).toBeCloseTo(150, 3);
    expect(ahead!.tailSec).toBeGreaterThanOrEqual(5);
    expect(ahead!.tailSec).toBeLessThan(75);
    const result = await hearRest(ID, ahead!, hear);
    expect(result!.text).toBe([...heard].map((s) => `[${s.toFixed(1)}s]`).join(' '));
    expect(heard[heard.length - 1]).toBeCloseTo(ahead!.tailSec, 1);
    expect(Math.abs(result!.heardAheadSec - ahead!.aheadSec)).toBeLessThanOrEqual(0.051);
    // The stop's own engine time, and the pieces' apart from it.
    expect(result!.durationMs).toBe(5);
    expect(result!.aheadEngineMs).toBe(5 * ahead!.pieces.length);
    expect(result).toMatchObject({ engine: 'stub', model: 'm1' });
  });

  it('a take whose recorder wrote each block twice is heard once, with the repair every engine read gets', async () => {
    const { hear, heard } = stubHear();
    const spoken = speechPcm(100, 5);
    const clip = pcmToWav(repeatBlocks(spoken, 2));
    await appendInParts(ID, clip, 8, hear);
    await vi.waitFor(() => expect(heard.length).toBeGreaterThanOrEqual(2), { timeout: 10_000 });
    const ahead = await finishTake(ID, clip, stopOpts());
    expect(ahead).not.toBeNull();
    // Measured as spoken: 100 s, not the 200 s the file holds.
    expect(ahead!.aheadSec + ahead!.tailSec).toBeCloseTo(100, 1);
  });

  it('a piece waits while a live draft runs', async () => {
    const { hear, heard } = stubHear();
    const done = noteLiveDraft();
    const clip = pcmToWav(speechPcm(60, 2));
    await appendInParts(ID, clip, 2, hear);
    await new Promise((r) => setTimeout(r, 400));
    expect(heard.length).toBe(0);
    done();
    await vi.waitFor(() => expect(heard.length).toBeGreaterThanOrEqual(1), { timeout: 5_000 });
  });
});

describe('silence is never heard', () => {
  it('40 s of silence in the middle of a take adds no text: the silent pieces are not sent to the engine', async () => {
    const { hear, heard } = stubHear();
    const pcm = concat(speechPcm(50, 12), silence(40), speechPcm(60, 13));
    const clip = pcmToWav(pcm);
    await appendInParts(ID, clip, 10, hear);
    await vi.waitFor(() => expect(heard.length).toBeGreaterThanOrEqual(3), { timeout: 10_000 });
    const ahead = await finishTake(ID, clip, stopOpts());
    expect(ahead).not.toBeNull();
    // Some pieces were all silence, kept as no text and never heard.
    expect(ahead!.pieces.length).toBeGreaterThan(heard.length);
    expect(ahead!.pieces.some((p) => p.text === '' && !p.engine)).toBe(true);
    const result = await hearRest(ID, ahead!, hear);
    expect(result!.text).not.toContain('Thank you.');
    expect(ahead!.aheadSec + ahead!.tailSec).toBeCloseTo(150, 3);
  });

  it('a tail that is all silence is not heard', async () => {
    const { hear, heard } = stubHear();
    const pcm = concat(speechPcm(80, 14), silence(35));
    const clip = pcmToWav(pcm);
    await appendInParts(ID, clip, 1, hear);
    await vi.waitFor(() => expect(heard.length).toBeGreaterThanOrEqual(2), { timeout: 10_000 });
    const ahead = await finishTake(ID, clip, stopOpts());
    expect(ahead).not.toBeNull();
    expect(ahead!.tail.every((x) => x === 0)).toBe(true);
    const before = hear.mock.calls.length;
    const result = await hearRest(ID, ahead!, hear);
    expect(hear.mock.calls.length).toBe(before);
    expect(result!.text).not.toContain('Thank you.');
    expect(result!.text).toBe(ahead!.pieces.map((p) => p.text).filter(Boolean).join(' '));
    expect(result!.durationMs).toBe(0);
  });

  it('a stop with only a silent tail left hears nothing', async () => {
    const { hear } = stubHear();
    const result = await hearRest(ID, { pieces: [{ text: 'said before', engineMs: 7, engine: STUB }], tail: silence(3), aheadSec: 40, tailSec: 3 }, hear);
    expect(hear).not.toHaveBeenCalled();
    expect(result).toMatchObject({ text: 'said before', durationMs: 0, aheadEngineMs: 7 });
  });
});

describe('the stop does not wait long', () => {
  it('returns at once while a piece waits for a live draft', async () => {
    const { hear } = stubHear();
    const draft = noteLiveDraft();
    const clip = pcmToWav(speechPcm(60, 15));
    await appendInParts(ID, clip, 1, hear);
    await new Promise((r) => setTimeout(r, 300));
    const started = Date.now();
    expect(await finishTake(ID, clip, stopOpts())).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(hear).not.toHaveBeenCalled();
    draft();
  });

  it('a piece the engine is still hearing is waited for a bounded time, then the whole clip is heard', async () => {
    _tuneTakesForTest({ stopWaitMs: 200 });
    const slow = hangingHear();
    const clip = pcmToWav(speechPcm(60, 16));
    await appendInParts(ID, clip, 1, slow.hear);
    await vi.waitFor(() => expect(slow.hear).toHaveBeenCalled(), { timeout: 10_000 });
    const started = Date.now();
    expect(await finishTake(ID, clip, stopOpts())).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
    slow.release();
  });

  it('a take past the hearing-ahead limit is heard whole at its stop', async () => {
    _tuneTakesForTest({ maxAheadSec: 60 });
    const { hear } = stubHear();
    const clip = pcmToWav(speechPcm(100, 17));
    await appendInParts(ID, clip, 1, hear);
    await new Promise((r) => setTimeout(r, 300));
    expect(await finishTake(ID, clip, stopOpts())).toBeNull();
    expect(hear).not.toHaveBeenCalled();
  });

  it('a take that grows past the limit stops hearing ahead', async () => {
    _tuneTakesForTest({ maxAheadSec: 70 });
    const { hear } = stubHear();
    const clip = pcmToWav(speechPcm(110, 18));
    const half = Math.floor(clip.length / 2);
    expect(await appendToTake(ID, 0, clip.subarray(0, half), opts(hear))).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(hear).toHaveBeenCalled(), { timeout: 10_000 });
    await appendToTake(ID, half, clip.subarray(half), opts(hear));
    await vi.waitFor(async () => expect(await appendToTake(ID, clip.length, Buffer.alloc(0), opts(hear))).toMatchObject({ status: 410 }), { timeout: 10_000 });
    expect(await finishTake(ID, clip, stopOpts())).toBeNull();
  });
});

describe('the stop falls back to the whole clip', () => {
  async function settledTake(id: string, hear = stubHear().hear) {
    const pcm = speechPcm(100, 9);
    const clip = pcmToWav(pcm);
    await appendInParts(id, clip, 5, hear);
    await vi.waitFor(() => expect(hear).toHaveBeenCalled(), { timeout: 10_000 });
    return { clip, pcm };
  }

  it('when the clip does not start with the appended bytes', async () => {
    const { pcm } = await settledTake(ID);
    const other = Int16Array.from(pcm);
    other[RATE] = (other[RATE]! + 1000) | 0;
    expect(await finishTake(ID, pcmToWav(other), stopOpts())).toBeNull();
  });

  it('when the clip is shorter than what was appended', async () => {
    const { clip } = await settledTake(ID);
    expect(await finishTake(ID, clip.subarray(0, clip.length - 10), stopOpts())).toBeNull();
  });

  it('when the language differs, or the take is unknown', async () => {
    const { clip } = await settledTake(ID);
    expect(await finishTake(ID, clip, { format: 'wav', language: 'en', engine: STUB })).toBeNull();
    // A take is finished once: a second stop hears the whole clip.
    expect(await finishTake(ID, clip, stopOpts())).toBeNull();
    expect(await finishTake('take-never-seen', clip, stopOpts())).toBeNull();
  });

  it('when the engine or its model changed since the pieces were heard', async () => {
    const { clip } = await settledTake(ID);
    expect(await finishTake(ID, clip, stopOpts({ name: 'stub', model: 'm2' }))).toBeNull();
    const { clip: again } = await settledTake('take-unit-0002');
    expect(await finishTake('take-unit-0002', again, stopOpts({ name: 'other' }))).toBeNull();
    const { clip: none } = await settledTake('take-unit-0003');
    expect(await finishTake('take-unit-0003', none, stopOpts(null))).toBeNull();
    const { clip: same } = await settledTake('take-unit-0004');
    expect(await finishTake('take-unit-0004', same, stopOpts())).not.toBeNull();
  });

  it('when the tail is heard by another engine than the pieces', async () => {
    const { clip } = await settledTake(ID);
    const ahead = await finishTake(ID, clip, stopOpts());
    expect(ahead).not.toBeNull();
    expect(await hearRest(ID, ahead!, stubHear({ name: 'other' }).hear)).toBeNull();
  });

  it('when a piece failed while it recorded', async () => {
    const hear = vi.fn<HearWav>(async () => { throw new Error('engine down'); });
    const clip = pcmToWav(speechPcm(100, 4));
    await appendInParts(ID, clip, 5, hear);
    await vi.waitFor(() => expect(hear).toHaveBeenCalled(), { timeout: 10_000 });
    await vi.waitFor(async () => expect(await appendToTake(ID, clip.length, Buffer.alloc(0), opts(hear))).toMatchObject({ ok: false, status: 410 }));
    expect(await finishTake(ID, clip, stopOpts())).toBeNull();
  });
});

describe('the recorder repeat', () => {
  const r = { factor: 2, block: 160, phase: 37, within: 0.95, across: 0.1 };

  it('is the same only with the same copies, block and phase', () => {
    expect(sameRepeat(r, { ...r, within: 0.9 })).toBe(true);
    expect(sameRepeat(r, { ...r, phase: 41 })).toBe(false);
    expect(sameRepeat(r, { ...r, factor: 3 })).toBe(false);
    expect(sameRepeat(r, 'none')).toBe(false);
    expect(sameRepeat('none', 'none')).toBe(true);
  });

  it('a part decoded from a later sample is heard once to exactly the same samples', () => {
    const spoken = speechPcm(20, 19);
    const raw = repeatBlocks(spoken, 2, 37);
    const whole = removeBlockRepeat(raw, r);
    for (const from of [0, 10, 37, 200, 5 * RATE + 3, 12 * RATE]) {
      const start = decodeStart(r, from);
      expect(start.spoken).toBeLessThanOrEqual(from);
      const part = start.repeat === 'none' ? raw.subarray(start.raw) : removeBlockRepeat(raw.subarray(start.raw), start.repeat);
      expect(Buffer.from(part.buffer, part.byteOffset, part.byteLength).equals(Buffer.from(whole.buffer, whole.byteOffset + 2 * start.spoken, 2 * (whole.length - start.spoken)))).toBe(true);
    }
  });
});

const hasOpus = (() => {
  const run = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' });
  return run.status === 0 && /libopus/.test(run.stdout);
})();

/** `pcm` as a streaming WebM/Opus file, the kind a browser recorder writes (no seeking back). */
function webmOpus(pcm: Int16Array): Buffer {
  return execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-f', 's16le', '-ar', String(RATE), '-ac', '1', '-i', 'pipe:0',
    '-c:a', 'libopus', '-b:a', '32k', '-f', 'webm', 'pipe:1',
  ], { input: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength), maxBuffer: 64 * 1024 * 1024 });
}

describe.skipIf(!hasOpus)('a real WebM/Opus take', () => {
  it('decodes a growing prefix to the same samples as the whole file, but for its last seconds', async () => {
    const file = webmOpus(speechPcm(70, 20));
    const whole = await decodeToPcm(file, 'webm');
    const prefix = await decodeToPcm(file.subarray(0, Math.floor(file.length * 0.6)), 'webm');
    const sure = prefix.length - 5 * RATE;
    expect(sure).toBeGreaterThan(30 * RATE);
    expect(Buffer.from(prefix.buffer, prefix.byteOffset, 2 * sure).equals(Buffer.from(whole.buffer, whole.byteOffset, 2 * sure))).toBe(true);
    // Read from a later sample, the same samples.
    const later = await decodeToPcm(file, 'webm', 20 * RATE);
    expect(Buffer.from(later.buffer, later.byteOffset, later.byteLength).equals(Buffer.from(whole.buffer, whole.byteOffset + 40 * RATE, 2 * (whole.length - 20 * RATE)))).toBe(true);
  }, 60_000);

  it('is heard ahead from its growing file, and its stop hears only the tail', async () => {
    const { hear, heard } = stubHear();
    const file = webmOpus(speechPcm(120, 21));
    await appendInParts(ID, file, 8, hear, 'webm');
    await vi.waitFor(() => expect(heard.length).toBeGreaterThanOrEqual(2), { timeout: 30_000 });
    const ahead = await finishTake(ID, file, stopOpts(STUB, 'webm'));
    expect(ahead).not.toBeNull();
    const spoken = (await decodeToPcm(file, 'webm')).length / RATE;
    expect(ahead!.aheadSec + ahead!.tailSec).toBeCloseTo(spoken, 3);
    expect(ahead!.tailSec).toBeGreaterThanOrEqual(5);
  }, 60_000);
});
