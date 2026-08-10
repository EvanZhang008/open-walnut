/**
 * Voice recording store — the durable backbone of "voice input never loses data".
 *
 * Every /api/stt/transcribe call saves the raw audio to disk BEFORE the engine
 * runs, then writes the transcription result (or error) next to it. If the
 * browser drops the response (tab close, main-thread starvation aborting the
 * fetch), the text still exists here and the UI can list/re-insert/re-transcribe
 * it later via /api/stt/recordings.
 *
 * Layout:
 *   <WALNUT_HOME>/tmp/stt-recordings/<iso-ts>.<format>   raw audio
 *   <WALNUT_HOME>/tmp/stt-recordings/<iso-ts>.json       metadata + result/error
 *
 * Under tmp/ because these are machine-local binary blobs (capped at
 * MAX_RECORDINGS): regenerable-by-recording, never worth syncing. The old
 * location was `homedir()/.open-walnut/stt-debug` — a hardcoded home that
 * ignored WALNUT_HOME, so test runs and ephemeral child servers wrote into the
 * REAL user directory. tmp/ is gitignored, so nothing here reaches sync.
 * Pre-existing stt-debug/ dirs are left alone (also gitignored); old recordings
 * simply stop being listed.
 */

import { mkdir, writeFile, readFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { TMP_DIR } from '../../constants.js';
import type { SttResult } from './types.js';

// Computed lazily (not at module load) so a test that redirects WALNUT_HOME
// — or mocks constants.js — is honoured rather than frozen at import time.
function dir(): string {
  return join(TMP_DIR, 'stt-recordings');
}
const MAX_RECORDINGS = 100;

// IDs are the ISO-timestamp basename (colons/dots → dashes). Strict allowlist —
// these become file paths, so anything else would be a traversal vector.
const ID_RE = /^[0-9A-Za-z-]+$/;
const AUDIO_EXTS = ['webm', 'mp4', 'ogg', 'wav', 'mp3', 'm4a', 'flac'];

export interface RecordingMeta {
  id: string;
  timestamp: string;
  format: string;
  language: string;
  audioSizeBytes: number;
  /** Present when transcription succeeded */
  result?: SttResult;
  /** Present when the engine threw */
  error?: string;
}

export function recordingsDir(): string {
  return dir();
}

/** Persist raw audio before transcription. Returns the recording id + path. */
export async function saveRecordingAudio(
  audioBase64: string,
  format: string,
): Promise<{ id: string; audioPath: string }> {
  await mkdir(dir(), { recursive: true });
  const id = new Date().toISOString().replace(/[:.]/g, '-');
  const audioPath = join(dir(), `${id}.${format}`);
  await writeFile(audioPath, Buffer.from(audioBase64, 'base64'));
  return { id, audioPath };
}

/** Write (or overwrite) the metadata/result JSON for a recording. */
export async function writeRecordingResult(
  id: string,
  meta: Omit<RecordingMeta, 'id' | 'timestamp'> & { timestamp?: string },
): Promise<void> {
  if (!ID_RE.test(id)) throw new Error(`Invalid recording id: ${id}`);
  await mkdir(dir(), { recursive: true });
  await writeFile(
    join(dir(), `${id}.json`),
    JSON.stringify({ timestamp: new Date().toISOString(), ...meta }, null, 2),
  );
  await pruneOldRecordings().catch(() => {});
}

/** List recent recordings, newest first. */
export async function listRecordings(limit = 20): Promise<RecordingMeta[]> {
  let files: string[];
  try {
    files = await readdir(dir());
  } catch {
    return [];
  }
  // JSON basenames are ISO timestamps → lexicographic sort == chronological.
  const jsonFiles = files.filter(f => f.endsWith('.json')).sort().reverse().slice(0, limit);
  const out: RecordingMeta[] = [];
  for (const jf of jsonFiles) {
    const id = jf.slice(0, -5);
    if (!ID_RE.test(id)) continue;
    try {
      const raw = JSON.parse(await readFile(join(dir(), jf), 'utf-8'));
      out.push({
        id,
        timestamp: raw.timestamp ?? '',
        format: raw.format ?? 'webm',
        language: raw.language ?? 'auto',
        audioSizeBytes: raw.audioSizeBytes ?? 0,
        result: raw.result ?? undefined,
        error: raw.error ?? undefined,
      });
    } catch {
      // Unreadable metadata — skip
    }
  }
  return out;
}

/** Read a recording's audio back as base64 (for re-transcription). */
export async function readRecordingAudio(
  id: string,
): Promise<{ audio: string; format: string } | null> {
  if (!ID_RE.test(id)) return null;
  let files: string[];
  try {
    files = await readdir(dir());
  } catch {
    return null;
  }
  const audioFile = files.find(f =>
    f.startsWith(`${id}.`) && AUDIO_EXTS.includes(f.slice(id.length + 1)));
  if (!audioFile) return null;
  const buf = await readFile(join(dir(), audioFile));
  return { audio: buf.toString('base64'), format: audioFile.slice(id.length + 1) };
}

/** Keep only the newest MAX_RECORDINGS recordings. */
async function pruneOldRecordings(): Promise<void> {
  const files = await readdir(dir());
  const jsonFiles = files.filter(f => f.endsWith('.json')).sort();
  if (jsonFiles.length <= MAX_RECORDINGS) return;
  for (const jf of jsonFiles.slice(0, jsonFiles.length - MAX_RECORDINGS)) {
    const stem = jf.slice(0, -5);
    await unlink(join(dir(), jf)).catch(() => {});
    for (const af of files) {
      if (af.startsWith(`${stem}.`) && !af.endsWith('.json')) {
        await unlink(join(dir(), af)).catch(() => {});
      }
    }
  }
}
