/**
 * Audio format conversion helpers using ffmpeg.
 * Converts browser-recorded WebM/Opus to 16kHz mono WAV for local STT engines.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, unlink, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { sttSpawnEnv } from './spawn-env.js';
import { cafToWav } from './caf-to-wav.js';
import { repairWavFile } from './wav-repair.js';
import { wavDataRange } from './wav-segment.js';

const execFileAsync = promisify(execFile);

function tempPath(ext: string): string {
  return join(tmpdir(), `walnut-stt-${randomBytes(6).toString('hex')}.${ext}`);
}

/** Every GET /api/stt/status and POST /api/stt/draft asks, and each probe is a spawn. */
/** ffmpeg's time to decode a clip of `bytes`: 30 s, plus 10 s per 10 MB (about six minutes of the web recorder). */
export function convertTimeoutMs(bytes: number): number {
  return 30_000 + Math.ceil(Math.max(0, bytes) / (10 * 1024 * 1024)) * 10_000;
}

const FFMPEG_FOUND_TTL_MS = 10 * 60_000;
const FFMPEG_MISSING_TTL_MS = 30_000;

const ffmpegProbes = new Map<string, { available: boolean; at: number; ttlMs: number }>();
const ffmpegProbesInFlight = new Map<string, Promise<boolean>>();

async function probeFfmpeg(extraDirs: string[], previous: boolean | undefined): Promise<{ available: boolean; ttlMs: number }> {
  try {
    await execFileAsync('ffmpeg', ['-version'], { timeout: 5000, env: sttSpawnEnv(extraDirs) });
    return { available: true, ttlMs: FFMPEG_FOUND_TTL_MS };
  } catch (err) {
    // A timeout on a loaded machine is not a missing ffmpeg: keep an earlier
    // "found", and ask again soon rather than trusting it for ten minutes.
    const timedOut = (err as { killed?: boolean } | null)?.killed === true;
    return { available: timedOut && previous === true, ttlMs: FFMPEG_MISSING_TTL_MS };
  }
}

/** Check if ffmpeg is available on the system (augmented PATH, see spawn-env.ts).
 *  `extraDirs` prepends additional dirs to the probe PATH (e.g. the resolved
 *  whisper-server binary's own prefix, where a bundled ffmpeg may sit).
 *  Memoized per `extraDirs`: found for 10 minutes, missing or timed out for 30s. */
export function isFfmpegAvailable(extraDirs: string[] = []): Promise<boolean> {
  const key = extraDirs.join('\0');
  const cached = ffmpegProbes.get(key);
  if (cached && Date.now() - cached.at < cached.ttlMs) return Promise.resolve(cached.available);
  const pending = ffmpegProbesInFlight.get(key);
  if (pending) return pending;

  const probe = probeFfmpeg(extraDirs, cached?.available)
    .then(({ available, ttlMs }) => {
      ffmpegProbes.set(key, { available, at: Date.now(), ttlMs });
      return available;
    })
    .finally(() => ffmpegProbesInFlight.delete(key));
  ffmpegProbesInFlight.set(key, probe);
  return probe;
}

/** Test hook: forget every cached ffmpeg probe. */
export function _resetFfmpegProbeCacheForTest(): void {
  ffmpegProbes.clear();
  ffmpegProbesInFlight.clear();
}

/**
 * True when the buffer is already exactly what the engines want (16kHz mono
 * 16-bit PCM WAV), so ffmpeg has nothing to do. Walks the RIFF chunk list to
 * find `fmt ` rather than assuming a 44-byte header, and rejects anything it
 * cannot fully verify.
 */
export function isConformingWav(buf: Buffer): boolean {
  if (buf.length < 44) return false;
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return false;
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === 'fmt ') {
      if (offset + 8 + 16 > buf.length) return false;
      const audioFormat = buf.readUInt16LE(offset + 8);
      const channels = buf.readUInt16LE(offset + 10);
      const sampleRate = buf.readUInt32LE(offset + 12);
      const bitsPerSample = buf.readUInt16LE(offset + 22);
      return audioFormat === 1 && channels === 1 && sampleRate === 16000 && bitsPerSample === 16;
    }
    offset += 8 + size + (size % 2); // RIFF chunks are word-aligned
  }
  return false;
}

/**
 * Convert base64 audio to 16kHz mono WAV file.
 * Returns the path to the WAV file (caller must clean up).
 *
 * Already-conforming WAV skips ffmpeg entirely. That matters for live dictation:
 * the browser encodes each draft slice as 16kHz mono WAV itself, so converting
 * was pure overhead on a 2s timer — a process spawn that normally costs ~100ms
 * but was measured at 3.3s on a busy machine, the largest single spike in a slow
 * dictation.
 */
export async function convertToWav(audioBase64: string, inputFormat: string): Promise<string> {
  return (await toHeardWav(audioBase64, inputFormat)).path;
}

/**
 * The audio a cloud engine uploads: the original bytes as they are, unless the
 * repair (wav-repair.ts) changed what the engine would hear, then that WAV.
 * A WAV over `maxBytes`, or no ffmpeg on this box, keeps the original.
 */
export async function audioForUpload(
  audioBase64: string, format: string, maxBytes: number,
): Promise<{ audio: Buffer; format: string }> {
  const original = { audio: Buffer.from(audioBase64, 'base64'), format };
  let path: string | null = null;
  try {
    const wav = await toHeardWav(audioBase64, format);
    path = wav.path;
    if (!wav.repaired) return original;
    const audio = await readFile(wav.path);
    return audio.length <= maxBytes ? { audio, format: 'wav' } : original;
  } catch {
    return original;
  } finally {
    if (path) await unlink(path).catch(() => {});
  }
}

/**
 * `audio` as recorded, decoded to 16 kHz mono PCM from sample `fromSample` on:
 * no repair (the caller runs the parts of it it needs, wav-repair.ts). A take
 * heard ahead while it records reads its growing file through this
 * (take-ahead.ts); only the samples it asks for are read into memory, so a
 * long take costs each round only its new part on the event loop.
 */
export async function decodeToPcm(audio: Buffer, inputFormat: string, fromSample = 0): Promise<Int16Array> {
  const outputPath = tempPath('wav');
  try {
    await decodeToWavFile(audio, inputFormat, outputPath);
    return await readWavPcmFrom(outputPath, fromSample);
  } finally {
    await unlink(outputPath).catch(() => {});
  }
}

async function readWavPcmFrom(path: string, fromSample: number): Promise<Int16Array> {
  const file = await open(path, 'r');
  try {
    const { size } = await file.stat();
    const head = Buffer.alloc(Math.min(size, 64 * 1024));
    await readFully(file, head, 0);
    const { start, end } = wavDataRange(head, size);
    const from = Math.min(end, start + 2 * Math.max(0, Math.floor(fromSample)));
    // Not pooled, so the samples start 2-byte aligned.
    const out = Buffer.alloc(end - from);
    await readFully(file, out, from);
    return new Int16Array(out.buffer, out.byteOffset, out.length / 2);
  } finally {
    await file.close();
  }
}

async function readFully(file: Awaited<ReturnType<typeof open>>, into: Buffer, position: number): Promise<void> {
  for (let at = 0; at < into.length;) {
    const { bytesRead } = await file.read(into, at, into.length - at, position + at);
    if (!bytesRead) throw new Error('WAV ended early');
    at += bytesRead;
  }
}

/** Writes `audio` to `outputPath` as a 16 kHz mono 16-bit WAV, as it was recorded. */
async function decodeToWavFile(audio: Buffer, inputFormat: string, outputPath: string): Promise<void> {
  if (inputFormat === 'wav' && isConformingWav(audio)) {
    await writeFile(outputPath, audio);
    return;
  }
  // The phone's PCM CAF is rewrapped in-process, so no box needs ffmpeg for it.
  if (inputFormat === 'caf') {
    const wav = cafToWav(audio);
    if (wav) {
      await writeFile(outputPath, wav);
      return;
    }
  }

  const inputPath = tempPath(inputFormat);
  try {
    await writeFile(inputPath, audio);
    await execFileAsync('ffmpeg', [
      '-y', '-i', inputPath,
      // 16kHz mono required by sherpa-onnx and whisper.cpp engines
      '-ar', '16000',     // 16kHz sample rate
      '-ac', '1',         // mono
      '-c:a', 'pcm_s16le', // 16-bit PCM
      outputPath,
    // A take has no time limit: an hour of audio decodes in seconds, and a loaded machine gets room.
    ], { timeout: convertTimeoutMs(audio.length), env: sttSpawnEnv() }).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') throw new Error(`Reading ${inputFormat} audio needs ffmpeg, which is not installed`);
      throw err;
    });
  } finally {
    await unlink(inputPath).catch(() => {});
  }
}

async function toHeardWav(audioBase64: string, inputFormat: string): Promise<{ path: string; repaired: boolean }> {
  const outputPath = tempPath('wav');
  await decodeToWavFile(Buffer.from(audioBase64, 'base64'), inputFormat, outputPath);
  return heardOnce(outputPath);
}

/**
 * Every WAV an engine reads passes here (wav-repair.ts): a recording that
 * repeats each 10 ms is heard once and long silences are shortened. A repair
 * that fails leaves the audio as it was.
 */
async function heardOnce(wavPath: string): Promise<{ path: string; repaired: boolean }> {
  const repaired = await repairWavFile(wavPath).catch(() => false);
  return { path: wavPath, repaired };
}

/** Clean up a temp file */
export async function cleanupTempFile(filePath: string): Promise<void> {
  await unlink(filePath).catch(() => {});
}
