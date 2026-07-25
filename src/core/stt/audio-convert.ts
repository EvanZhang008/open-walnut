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
 * Convert base64 audio to 16kHz mono WAV file.
 * Returns the path to the WAV file (caller must clean up).
 */
export async function convertToWav(audioBase64: string, inputFormat: string): Promise<string> {
  const inputPath = tempPath(inputFormat);
  const outputPath = tempPath('wav');

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
