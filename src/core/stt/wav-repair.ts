/**
 * The 16 kHz WAV an engine reads, made fit to hear: a recording that holds
 * every 10 ms of sound twice is heard once (src/lib/audio-block-repeat.ts says
 * how that happens and how it is found), and silences over 2 s are shortened
 * (long-silence.ts). The local engines read audio through convertToWav, and
 * the ones that take a file as it is (whisper-server, the OpenAI API) through
 * audioForUpload, so one repair covers the final pass, the drafts, a Redo of a
 * saved recording and every engine alike. The saved recording is never
 * changed; only the copy the engine reads is.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { findBlockRepeat, removeBlockRepeat, type BlockRepeat, type BlockRepeatVerdict } from '../../lib/audio-block-repeat.js';
import { shortenLongSilences } from './long-silence.js';
import { wavPcm, pcmToWav, SAMPLE_RATE } from './wav-segment.js';
import { log } from '../../logging/index.js';

export interface WavRepair {
  wav: Buffer;
  /** The repeat that was removed, when there was one. */
  repeat: BlockRepeat | null;
  /** Seconds of long silence removed. */
  silenceSec: number;
  beforeSec: number;
  afterSec: number;
}

/**
 * The recorder's block repeat in 16 kHz `pcm`, read from its sound. The one
 * reading every engine's audio gets (repairWav) and a take heard ahead while it
 * records (take-ahead.ts) alike.
 */
export function blockRepeatIn(pcm: Int16Array): BlockRepeatVerdict {
  const floats = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) floats[i] = pcm[i] / 32768;
  return findBlockRepeat(floats, SAMPLE_RATE);
}

/** `pcm` as spoken: the first copy of every block when `verdict` is a repeat, else `pcm` itself. */
export function heardOncePcm(pcm: Int16Array, verdict: BlockRepeatVerdict): Int16Array {
  return verdict && verdict !== 'none' ? removeBlockRepeat(pcm, verdict) : pcm;
}

/** `buf` (16 kHz mono 16-bit WAV, as convertToWav writes it) as the engine should hear it; null when it is fine as it is. */
export function repairWav(buf: Buffer): WavRepair | null {
  let pcm: Int16Array;
  try { pcm = wavPcm(buf); } catch { return null; }
  if (pcm.length < 2) return null;
  const beforeSec = pcm.length / SAMPLE_RATE;
  const verdict = blockRepeatIn(pcm);
  const repeat = verdict && verdict !== 'none' ? verdict : null;
  pcm = heardOncePcm(pcm, verdict);
  const cut = shortenLongSilences(pcm, SAMPLE_RATE);
  if (cut) pcm = cut.samples;
  if (!repeat && !cut) return null;
  return { wav: pcmToWav(pcm), repeat, silenceSec: cut?.removedSec ?? 0, beforeSec, afterSec: pcm.length / SAMPLE_RATE };
}

/** Repairs the WAV file at `path` in place (repairWav); true when it changed. */
export async function repairWavFile(path: string): Promise<boolean> {
  const buf = await readFile(path);
  const fixed = repairWav(buf);
  if (!fixed) return false;
  await writeFile(path, fixed.wav);
  const said: string[] = [];
  if (fixed.repeat) said.push(`each 10 ms was recorded ${fixed.repeat.factor} times (a recorder fault), heard once`);
  if (fixed.silenceSec > 0) said.push(`${fixed.silenceSec.toFixed(1)}s of long silence shortened`);
  log.stt.info(`Audio for the engine: ${said.join('; ')}: ${fixed.beforeSec.toFixed(1)}s became ${fixed.afterSec.toFixed(1)}s`);
  return true;
}
