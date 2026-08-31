/**
 * Audio format conversion helpers using ffmpeg.
 * Converts browser-recorded WebM/Opus to 16kHz mono WAV for local STT engines.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { sttSpawnEnv } from './spawn-env.js';

const execFileAsync = promisify(execFile);

function tempPath(ext: string): string {
  return join(tmpdir(), `walnut-stt-${randomBytes(6).toString('hex')}.${ext}`);
}

/** Check if ffmpeg is available on the system (augmented PATH — see spawn-env.ts).
 *  `extraDirs` prepends additional dirs to the probe PATH (e.g. the resolved
 *  whisper-server binary's own prefix, where a bundled ffmpeg may sit). */
export async function isFfmpegAvailable(extraDirs: string[] = []): Promise<boolean> {
  try {
    await execFileAsync('ffmpeg', ['-version'], { timeout: 5000, env: sttSpawnEnv(extraDirs) });
    return true;
  } catch {
    return false;
  }
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
  const inputPath = tempPath(inputFormat);
  const outputPath = tempPath('wav');

  if (inputFormat === 'wav') {
    const buf = Buffer.from(audioBase64, 'base64');
    if (isConformingWav(buf)) {
      await writeFile(outputPath, buf);
      return outputPath;
    }
  }

  try {
    await writeFile(inputPath, Buffer.from(audioBase64, 'base64'));
    await execFileAsync('ffmpeg', [
      '-y', '-i', inputPath,
      // 16kHz mono required by sherpa-onnx and whisper.cpp engines
      '-ar', '16000',     // 16kHz sample rate
      '-ac', '1',         // mono
      '-c:a', 'pcm_s16le', // 16-bit PCM
      outputPath,
    ], { timeout: 30_000, env: sttSpawnEnv() });
    return outputPath;
  } finally {
    await unlink(inputPath).catch(() => {});
  }
}

/** Clean up a temp file */
export async function cleanupTempFile(filePath: string): Promise<void> {
  await unlink(filePath).catch(() => {});
}
