/**
 * A take heard ahead while it records, so the stop only waits for its tail.
 *
 * The web recorder uploads its clip in parts while the user talks (POST
 * /api/stt/takes/:id/append). Once 40 s of it are not yet heard, the growing
 * file is decoded and its finished part cut at quiet spots into pieces of about
 * 30 s (take-settle.ts), each heard by the normal engine path one at a time; a
 * piece with no sound in it is not heard at all (an engine fills silence with
 * words never said). The stop still sends the whole clip; when it starts with
 * the bytes appended here, decodes to exactly the samples every piece was heard
 * from (SHA-256, take-ledger.ts) and the engine is the one that heard them, only
 * the rest is heard and the texts are joined. Anything else hears the whole clip
 * as before: every failure here only stops the hearing ahead, never the take.
 *
 * Per take, in memory: its file under tmp/stt-takes of this Walnut's home (0700,
 * files 0600), how much is settled, the pieces. At most a few takes; one idle for
 * 15 minutes is dropped, and a take past 30 minutes is heard whole at its stop.
 */

import { readFile, appendFile, mkdir, rm, chmod, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { TMP_DIR } from '../../constants.js';
import type { BlockRepeatVerdict } from '../../lib/audio-block-repeat.js';
import { getConfig } from '../config-manager.js';
import type { Config } from '../types.js';
import { decodeToPcm } from './audio-convert.js';
import { transcribeAudio } from './index.js';
import { hasSound } from './long-silence.js';
import { settleCuts, SETTLE_MIN_SEC } from './take-settle.js';
import { RecentIds, pcmSha256 } from './take-ledger.js';
import { blockRepeatIn, heardOncePcm } from './wav-repair.js';
import { pcmToWav, joinSegmentTexts, SAMPLE_RATE } from './wav-segment.js';
import type { SttResult } from './types.js';
import { log } from '../../logging/index.js';
import { markSwitchRunning, clearSwitchRunning } from '../sessions/running-switches.js';

/** Hears one 16 kHz WAV through the normal engine path (transcribeAudio). */
export type HearWav = (wav: Buffer) => Promise<SttResult>;

/** The engine a text came from, as transcribeAudio names it. */
export interface EngineId { name: string; model?: string }

export const TAKE_ID = /^[A-Za-z0-9_-]{8,64}$/;
export const TAKE_IDLE_MS = 15 * 60_000;
export const MAX_TAKES = 4;
/** About two hours of the Mac app recorder: the whole clip's own limit too (stt.ts). */
export const MAX_TAKE_BYTES = 200 * 1024 * 1024;

const tuning = {
  /** Past this much audio a take is no longer heard ahead: each round decodes the whole file. */
  maxAheadSec: 30 * 60,
  /** Sound enough to tell the recorder's repeat must show within this, or the take is heard whole. */
  maxUnknownRepeatSec: 5 * 60,
  /** How long the stop waits for a piece still being heard before hearing the whole clip. */
  stopWaitMs: 10_000,
};

interface Piece {
  /** Samples [from, to) of the take as spoken. */
  from: number;
  to: number;
  text: string;
  /** SHA-256 of those samples: the whole clip must hold exactly them at the stop. */
  sha256: string;
  /** The engine that heard it; none for a piece with no sound, which was not heard. */
  engine?: EngineId;
  engineMs: number;
}

interface Take {
  id: string;
  format: string;
  language: string | undefined;
  hear: HearWav;
  path: string;
  /** Bytes on disk. */
  size: number;
  touchedAt: number;
  /** Samples (16 kHz, as spoken) already heard as pieces. */
  settled: number;
  pieces: Piece[];
  /** The recorder's repeat, read once there was sound enough; every decode is heard with it. */
  repeat: Exclude<BlockRepeatVerdict, null> | undefined;
  decodedSize: number;
  /** Bytes per spoken second, from the last decode: says when 40 s are unsettled without decoding. */
  bytesPerSec: number | null;
  chain: Promise<unknown>;
  work: Promise<void> | null;
  /** Why hearing ahead stopped for this take; the stop then hears the whole clip. */
  stopped: string | null;
  finishing: boolean;
  /**
   * The deploy hold's token: while a take is kept here a deploy waits (running-switches.ts, read by
   * scripts/lib/deploy-queue.sh), because a restart loses what was heard ahead (2026-11-23: a deploy
   * 3 minutes into a 4.5-minute take made the stop hear all of it, 10.8 s).
   */
  hold: string;
}

const takes = new Map<string, Take>();
/** Takes finished or dropped lately: a part still on its way must not make one again. */
const done = new RecentIds();
let sweepTimer: ReturnType<typeof setInterval> | null = null;
let liveDrafts = 0;

const takeDir = () => join(TMP_DIR, 'stt-takes');

/** The deploy hold's marker name for a take (TAKE_ID allows only file-safe characters). */
export const holdName = (id: string) => `stt-take-${id}`;

/** Runs `fn` after every earlier operation on the take: appends, removal and the stop never interleave. */
function serial<T>(t: Take, fn: () => Promise<T>): Promise<T> {
  const run = t.chain.then(fn, fn);
  t.chain = run.catch(() => {});
  return run;
}

function sweep(now = Date.now()): void {
  for (const t of takes.values()) {
    if (!t.finishing && now - t.touchedAt > TAKE_IDLE_MS) void forget(t, 'idle');
  }
  done.sweep(now);
  if (!takes.size && !done.size && sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
}

/** Ends the take here at once; its file goes after any append in flight. */
function forget(t: Take, why: string): Promise<void> {
  if (takes.get(t.id) === t) takes.delete(t.id);
  done.mark(t.id);
  void clearSwitchRunning(holdName(t.id), t.hold);
  t.stopped ??= why;
  return serial(t, () => rm(t.path, { force: true })).catch(() => {});
}

function stopTake(t: Take, why: string): void {
  if (t.stopped) return;
  t.stopped = why;
  t.pieces = [];
  log.stt.warn(`Take ${t.id}: hearing ahead stopped (${why}); the stop hears the whole clip`);
  void serial(t, () => rm(t.path, { force: true })).catch(() => {});
}

export type AppendOutcome =
  | { ok: true; size: number }
  | { ok: false; status: 400 | 404 | 409 | 410 | 413 | 503; error: string; size?: number };

/**
 * Appends `bytes` at `offset` of the take's file, which must be exactly its
 * size (409 with the size otherwise, so the client sends from there). A take
 * is made by its first append, at offset 0.
 */
export async function appendToTake(
  id: string, offset: number, bytes: Buffer,
  opts: { format: string; language: string | undefined; hear: HearWav },
): Promise<AppendOutcome> {
  sweep();
  let t = takes.get(id);
  if (!t) {
    if (done.has(id)) return { ok: false, status: 410, error: 'Take already finished' };
    if (offset !== 0) return { ok: false, status: 404, error: 'Unknown take' };
    const made = newTake(id, opts);
    if (!made) return { ok: false, status: 503, error: 'Too many takes being stopped at once' };
    t = made;
  }
  const take = t;
  return serial(take, async (): Promise<AppendOutcome> => {
    if (take.stopped || take.finishing) return { ok: false, status: 410, error: `Take is no longer heard ahead: ${take.stopped ?? 'stopped'}` };
    if (take.format !== opts.format) return { ok: false, status: 400, error: `Take is ${take.format}, not ${opts.format}` };
    if (offset !== take.size) return { ok: false, status: 409, error: 'Offset does not match the take', size: take.size };
    if (take.size + bytes.length > MAX_TAKE_BYTES) {
      stopTake(take, 'too large');
      return { ok: false, status: 413, error: 'Take too large to hear ahead' };
    }
    if (bytes.length) {
      await appendFile(take.path, bytes, { mode: 0o600 });
      take.size += bytes.length;
    }
    take.touchedAt = Date.now();
    kick(take);
    return { ok: true, size: take.size };
  });
}

/**
 * Made in one step, so two appends at offset 0 make one take; its file is
 * cleared before the first append runs. Null when every take kept is being
 * stopped: none of those may be dropped to make room.
 */
function newTake(id: string, opts: { format: string; language: string | undefined; hear: HearWav }): Take | null {
  // Full: the take touched longest ago makes room (a page closed mid-take leaves one).
  while (takes.size >= MAX_TAKES) {
    const oldest = [...takes.values()].filter((x) => !x.finishing).sort((a, b) => a.touchedAt - b.touchedAt)[0];
    if (!oldest) return null;
    void forget(oldest, 'evicted by a newer take');
  }
  const path = join(takeDir(), `${id}.${opts.format}`);
  const t: Take = {
    id, format: opts.format, language: opts.language, hear: opts.hear,
    path, size: 0, touchedAt: Date.now(),
    settled: 0, pieces: [], repeat: undefined, decodedSize: 0, bytesPerSec: null,
    chain: prepareDir().then(() => rm(path, { force: true })),
    work: null, stopped: null, finishing: false,
    hold: markSwitchRunning(holdName(id), 'a dictation is being heard ahead'),
  };
  takes.set(id, t);
  if (!sweepTimer) {
    sweepTimer = setInterval(() => sweep(), 60_000);
    sweepTimer.unref?.();
  }
  return t;
}

/**
 * The takes' folder, readable by this user only, without what an earlier run
 * left there (a crash, a restart mid-take): any file no take here holds that
 * nothing touched for as long as a take may idle.
 */
async function prepareDir(): Promise<void> {
  const dir = takeDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const held = new Set([...takes.values()].map((t) => t.path));
  for (const name of await readdir(dir)) {
    const path = join(dir, name);
    if (held.has(path)) continue;
    const info = await stat(path).catch(() => null);
    if (info && Date.now() - info.mtimeMs > TAKE_IDLE_MS) await rm(path, { force: true, recursive: true }).catch(() => {});
  }
}

function kick(t: Take): void {
  if (t.work || t.stopped || t.finishing) return;
  t.work = settle(t)
    .catch((err: unknown) => stopTake(t, err instanceof Error ? err.message : String(err)))
    .finally(() => { t.work = null; });
}

/** Whether there are new bytes and, by the last decode's rate, 40 s not yet heard. */
function due(t: Take): boolean {
  if (t.stopped || t.finishing || t.size <= t.decodedSize) return false;
  if (!t.bytesPerSec) return true;
  return t.size / t.bytesPerSec - t.settled / SAMPLE_RATE >= SETTLE_MIN_SEC;
}

/**
 * Where to decode from to get the spoken samples from about `spoken` on: a
 * sample of the decoded file that starts a group of copies (or `spoken` itself
 * when nothing repeats), the spoken sample it is, and the repeat as seen from it.
 */
export function decodeStart(repeat: Exclude<BlockRepeatVerdict, null>, spoken: number): { raw: number; spoken: number; repeat: Exclude<BlockRepeatVerdict, null> } {
  if (repeat === 'none') return { raw: spoken, spoken, repeat };
  if (spoken <= repeat.phase) return { raw: spoken, spoken, repeat: { ...repeat, phase: repeat.phase - spoken } };
  const groups = Math.floor((spoken - repeat.phase) / repeat.block);
  return {
    raw: repeat.phase + groups * repeat.block * repeat.factor,
    spoken: repeat.phase + groups * repeat.block,
    repeat: { ...repeat, phase: 0 },
  };
}

/** Hears every finished piece of what has arrived, one at a time. */
async function settle(t: Take): Promise<void> {
  while (due(t)) {
    const size = t.size;
    if (t.bytesPerSec && size / t.bytesPerSec > tuning.maxAheadSec) {
      stopTake(t, `longer than ${tuning.maxAheadSec / 60} minutes`);
      return;
    }
    // Appends only add bytes, so the first `size` are a whole prefix whatever lands meanwhile.
    const bytes = (await readFile(t.path)).subarray(0, size);
    if (t.stopped || t.finishing) return;
    const last = t.pieces[t.pieces.length - 1];
    let start: ReturnType<typeof decodeStart>;
    let raw: Int16Array;
    if (t.repeat === undefined) {
      raw = await decodeToPcm(bytes, t.format);
      t.decodedSize = size;
      const verdict = blockRepeatIn(raw);
      if (verdict === null) {
        // Too little sound to tell a repeat yet: cut nothing that might be heard at the wrong tempo.
        if (raw.length) t.bytesPerSec = size / (raw.length / SAMPLE_RATE);
        if (raw.length > tuning.maxUnknownRepeatSec * SAMPLE_RATE) stopTake(t, 'no sound enough to tell how the recorder wrote it');
        continue;
      }
      t.repeat = verdict;
      start = { raw: 0, spoken: 0, repeat: verdict };
    } else {
      // Only the part from the last piece on is read and repaired: a long take costs each round its new part.
      start = decodeStart(t.repeat, last ? last.from : t.settled);
      raw = await decodeToPcm(bytes, t.format, start.raw);
      t.decodedSize = size;
    }
    const part = heardOncePcm(raw, start.repeat);
    const length = start.spoken + part.length;
    if (length) t.bytesPerSec = size / (length / SAMPLE_RATE);
    if (length > tuning.maxAheadSec * SAMPLE_RATE) {
      stopTake(t, `longer than ${tuning.maxAheadSec / 60} minutes`);
      return;
    }
    const at = (spoken: number, to = length) => part.subarray(spoken - start.spoken, to - start.spoken);
    if (last && (last.to > length || await pcmSha256(at(last.from, last.to)) !== last.sha256)) {
      stopTake(t, 'the growing file decoded to other sound where a piece was heard');
      return;
    }
    for (const end of settleCuts(at(t.settled), 0).map((cut) => t.settled + cut)) {
      await liveDraftsIdle(t);
      if (t.stopped || t.finishing) return;
      const samples = at(t.settled, end);
      const sha256 = await pcmSha256(samples);
      // Silence alone is never heard: the engine would get a moment of it and fill it with words.
      const heard = hasSound(samples, SAMPLE_RATE) ? await t.hear(pcmToWav(samples)) : null;
      if (t.stopped) return;
      t.pieces.push({
        from: t.settled, to: end, text: heard?.text ?? '', sha256, engineMs: heard?.durationMs ?? 0,
        ...(heard?.engine ? { engine: { name: heard.engine, ...(heard.model ? { model: heard.model } : {}) } } : {}),
      });
      t.settled = end;
    }
  }
}

/** Marks a live draft in flight; a piece waits for drafts to finish, so the live text stays quick. */
export function noteLiveDraft(): () => void {
  liveDrafts++;
  let ended = false;
  return () => { if (!ended) { ended = true; liveDrafts--; } };
}

/** Waits for live drafts, at most 5 s, and not at all once the take is stopping. */
async function liveDraftsIdle(t: Take, maxWaitMs = 5000): Promise<void> {
  const until = Date.now() + maxWaitMs;
  while (liveDrafts > 0 && Date.now() < until && !t.finishing && !t.stopped) await new Promise((r) => setTimeout(r, 100));
}

export interface HeardAhead {
  pieces: Array<{ text: string; engineMs: number; engine?: EngineId }>;
  /** The rest of the take after the pieces, 16 kHz as spoken. */
  tail: Int16Array;
  aheadSec: number;
  tailSec: number;
}

const sameEngine = (a: EngineId | null | undefined, b: EngineId | null | undefined) =>
  !!a && !!b && a.name === b.name && (a.model ?? '') === (b.model ?? '');

/** Resolves true once `work` is done, false after `ms`. */
function within(ms: number, work: Promise<unknown>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work.then(() => true, () => true),
    new Promise<boolean>((r) => { timer = setTimeout(() => r(false), ms); timer.unref?.(); }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * At the stop: the pieces heard ahead and the rest of `clip`, or null when the
 * whole clip must be heard (an unknown take, nothing settled yet, hearing ahead
 * stopped, a piece still being heard after 10 s, another engine now, or the
 * clip is not the take that was appended). Ends the take.
 */
export async function finishTake(
  id: string, clip: Buffer,
  opts: { format: string; language: string | undefined; engine: EngineId | null },
): Promise<HeardAhead | null> {
  sweep();
  const t = takes.get(id);
  if (!t) {
    done.mark(id);
    log.stt.info(`Take ${id}: not heard ahead here (unknown or expired); hearing the whole clip`);
    return null;
  }
  t.finishing = true;
  done.mark(id);
  const whole = (why: string) => {
    log.stt.info(`Take ${id}: ${why}; hearing the whole clip`);
    return null;
  };
  try {
    if (!await within(tuning.stopWaitMs, Promise.all([t.chain, t.work]))) {
      return whole(`a piece was still being heard ${tuning.stopWaitMs / 1000}s after the stop`);
    }
    if (t.stopped) return whole(`hearing ahead had stopped (${t.stopped})`);
    if (!t.pieces.length || t.repeat === undefined) return null;
    if (t.format !== opts.format || t.language !== opts.language) return whole('the clip differs in format or language from the take');
    if (t.pieces.some((p) => p.engine && !sameEngine(p.engine, opts.engine))) return whole('the engine changed since the pieces were heard');
    const appended = (await readFile(t.path)).subarray(0, t.size);
    if (clip.length < appended.length || !clip.subarray(0, appended.length).equals(appended)) return whole('the clip does not start with the appended bytes');
    const raw = await decodeToPcm(clip, opts.format);
    const verdict = blockRepeatIn(raw) ?? 'none';
    if (!sameRepeat(verdict, t.repeat)) return whole('the whole clip repeats otherwise than the part heard ahead');
    const pcm = heardOncePcm(raw, t.repeat);
    for (const p of t.pieces) {
      if (p.to > pcm.length || await pcmSha256(pcm.subarray(p.from, p.to)) !== p.sha256) return whole('the whole clip decodes to other sound where a piece was heard');
    }
    const tail = pcm.subarray(t.settled);
    return {
      pieces: t.pieces.map((p) => ({ text: p.text, engineMs: p.engineMs, ...(p.engine ? { engine: p.engine } : {}) })),
      tail, aheadSec: t.settled / SAMPLE_RATE, tailSec: tail.length / SAMPLE_RATE,
    };
  } finally {
    await forget(t, 'finished');
  }
}

/** Whether two readings of the recorder's repeat are the same: copies, block length and where they start. */
export function sameRepeat(a: Exclude<BlockRepeatVerdict, null>, b: Exclude<BlockRepeatVerdict, null>): boolean {
  if (a === 'none' || b === 'none') return a === b;
  return a.factor === b.factor && a.block === b.block && a.phase === b.phase;
}

export type TakeResult = SttResult & {
  heardAheadSec: number;
  /** Engine time the pieces took while the take recorded; `durationMs` is the stop's own. */
  aheadEngineMs: number;
};

/**
 * Hears the tail (none when it holds no sound) and joins it to the pieces: the
 * take's final text. Null when the tail was heard by another engine than the
 * pieces: the whole clip is heard instead.
 */
export async function hearRest(id: string, ahead: HeardAhead, hear: HearWav): Promise<TakeResult | null> {
  const tail = hasSound(ahead.tail, SAMPLE_RATE) ? await hear(pcmToWav(ahead.tail)) : null;
  const tailEngine = tail?.engine ? { name: tail.engine, ...(tail.model ? { model: tail.model } : {}) } : null;
  if (tailEngine && ahead.pieces.some((p) => p.engine && !sameEngine(p.engine, tailEngine))) {
    log.stt.info(`Take ${id}: the tail was heard by another engine than the pieces; hearing the whole clip`);
    return null;
  }
  const aheadEngineMs = ahead.pieces.reduce((sum, p) => sum + p.engineMs, 0);
  const durationMs = tail?.durationMs ?? 0;
  log.stt.info(`Take ${id}: ${ahead.pieces.length} pieces (${ahead.aheadSec.toFixed(1)}s, ${aheadEngineMs}ms) heard while recording, ${ahead.tailSec.toFixed(1)}s tail heard at the stop in ${durationMs}ms${tail ? '' : ' (no sound in it, not heard)'}`);
  const named = tail?.engine ? { engine: tail.engine, ...(tail.model ? { model: tail.model } : {}) } : {};
  return {
    text: joinSegmentTexts([...ahead.pieces.map((p) => p.text), tail?.text ?? '']),
    durationMs, ...named,
    heardAheadSec: Math.round(ahead.aheadSec * 10) / 10,
    aheadEngineMs,
  };
}

/** Hears one piece of a take through the normal engine path in `language`, with `config` or the current one. */
export function hearWavIn(language: string | undefined, config?: Config): HearWav {
  return async (wav) => transcribeAudio(config ?? await getConfig(), { audio: wav.toString('base64'), format: 'wav', language });
}

/** Drops a take nobody will finish (a discarded recording); a part still on its way will not make it again. */
export async function dropTake(id: string): Promise<boolean> {
  const t = takes.get(id);
  if (!t) { done.mark(id); return false; }
  if (t.finishing) return false;
  t.finishing = true;
  await forget(t, 'dropped');
  return true;
}

/** Test hook: forget every take. */
export async function _resetTakesForTest(): Promise<void> {
  const all = [...takes.values()];
  for (const t of all) t.finishing = true;
  await Promise.all(all.map(async (t) => { await t.work?.catch(() => {}); await forget(t, 'reset'); }));
  liveDrafts = 0;
  done.clear();
  Object.assign(tuning, { maxAheadSec: 30 * 60, maxUnknownRepeatSec: 5 * 60, stopWaitMs: 10_000 });
  sweep();
}

/** Test hook: shorter limits. */
export function _tuneTakesForTest(next: Partial<typeof tuning>): void {
  Object.assign(tuning, next);
}

/** Test hook: how many takes are kept. */
export function _takeCountForTest(): number {
  return takes.size;
}

/** Test hook: the folder the takes' files are in. */
export function _takeDirForTest(): string {
  return takeDir();
}

