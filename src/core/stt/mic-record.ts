/**
 * Server-side microphone recording (macOS) for global dictation.
 *
 * Walnut records the mic itself via ffmpeg/avfoundation so that ANY thin
 * client (Hammerspoon hotkey, Alfred, `curl`) can drive dictation without
 * needing its own macOS microphone permission — the TCC grant rides on the
 * node/ffmpeg process tree that walnut already runs under. Single-slot by
 * design: one dictation at a time, second start returns busy.
 */

import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, unlink, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { log } from '../../logging/index.js';
import { sttSpawnEnv } from './spawn-env.js';

const execFileAsync = promisify(execFile);

// Auto-stop guard: a forgotten hotkey must not record the room for hours.
const MAX_RECORD_MS = 5 * 60 * 1000;

let current: { proc: ChildProcess; wavPath: string; startedAt: number; killTimer: NodeJS.Timeout } | null = null;

/**
 * Find the built-in microphone's avfoundation index by name. Indices shift as
 * virtual devices (Zoom/Teams) come and go, so resolve at each start; virtual
 * devices are skipped, any remaining "microphone" wins, else device 0.
 */
async function findMicDevice(): Promise<string> {
  try {
    // -list_devices exits non-zero by design; the listing is on stderr either way.
    const out = await execFileAsync('ffmpeg', ['-f', 'avfoundation', '-list_devices', 'true', '-i', ''], {
      timeout: 10_000, env: sttSpawnEnv(),
    }).catch((e: { stderr?: string }) => ({ stderr: e.stderr ?? '' }));
    const stderr = (out as { stderr?: string }).stderr ?? '';
    let inAudio = false;
    for (const line of stderr.split('\n')) {
      if (/audio devices/i.test(line)) inAudio = true;
      if (!inAudio) continue;
      const m = line.match(/\[(\d+)\]\s+(.*)$/);
      if (m && /microphone/i.test(m[2]) && !/zoom|teams|virtual/i.test(m[2])) return m[1];
    }
  } catch { /* fall through */ }
  return '0';
}

export function isMicRecording(): boolean {
  return current !== null;
}

/** Start a mic recording. Throws if one is already running. */
export async function startMicRecording(): Promise<{ startedAt: number }> {
  if (current) throw new Error('A dictation recording is already in progress');
  const dir = await mkdtemp(join(tmpdir(), 'walnut-dictate-'));
  const wavPath = join(dir, 'rec.wav');
  const device = await findMicDevice();
  log.stt.info(`Dictation recording started (avfoundation device :${device})`);
  const proc = spawn('ffmpeg', ['-f', 'avfoundation', '-i', `:${device}`, '-ar', '16000', '-ac', '1', '-y', wavPath], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: sttSpawnEnv(),
  });
  const errTail: string[] = [];
  proc.stderr?.on('data', (d: Buffer) => {
    errTail.push(d.toString().slice(0, 200));
    if (errTail.length > 5) errTail.shift();
  });
  const killTimer = setTimeout(() => {
    log.stt.warn(`Dictation recording hit the ${MAX_RECORD_MS / 60000}min cap — auto-stopping`);
    proc.kill('SIGINT');
  }, MAX_RECORD_MS);
  const startedAt = Date.now();
  current = { proc, wavPath, startedAt, killTimer };
  proc.on('exit', () => {
    // Leave `current` for stop() to consume; exit-before-stop (crash, TCC
    // denial) is detected there by the missing/empty wav.
  });
  proc.on('error', () => {});

  // Fail fast if ffmpeg dies immediately (bad device, no permission prompt).
  await new Promise(r => setTimeout(r, 400));
  if (proc.exitCode !== null) {
    clearTimeout(killTimer);
    current = null;
    throw new Error(`ffmpeg exited at start: ${errTail.join(' | ') || 'unknown error'}`);
  }
  return { startedAt };
}

/**
 * Stop the recording and return the finished wav as base64 (16kHz mono).
 * SIGINT = ffmpeg's graceful stop, which finalizes the wav header.
 */
export async function stopMicRecording(): Promise<{ audioBase64: string; durationMs: number }> {
  const rec = current;
  if (!rec) throw new Error('No dictation recording in progress');
  current = null;
  clearTimeout(rec.killTimer);
  const { proc, wavPath, startedAt } = rec;

  if (proc.exitCode === null) {
    const exited = new Promise<void>(resolve => proc.once('exit', () => resolve()));
    proc.kill('SIGINT');
    await Promise.race([exited, new Promise(r => setTimeout(r, 3000))]);
    if (proc.exitCode === null) proc.kill('SIGKILL');
    await Promise.race([exited, new Promise(r => setTimeout(r, 1000))]);
  }

  try {
    const buf = await readFile(wavPath);
    if (buf.length < 4000) throw new Error('Recording is empty — microphone may be blocked (check mic permission for walnut/node)');
    return { audioBase64: buf.toString('base64'), durationMs: Date.now() - startedAt };
  } finally {
    await unlink(wavPath).catch(() => {});
  }
}
