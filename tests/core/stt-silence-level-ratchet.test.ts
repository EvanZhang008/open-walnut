/**
 * Every fixed loudness threshold in the voice code, named with what it decides.
 *
 * 2026-11-25: a fixed silence floor (0.0015 RMS) sat above the user's own words in the
 * first 3 s of a built-in-mic take, which that mic records dimmed, so they were cut and
 * the take came back as four characters. What the engine hears is now cut by one
 * measure, src/core/stt/long-silence.ts, which judges a dimmed start against its own
 * floor. A new fixed threshold elsewhere would bring the same loss back where that fix
 * does not reach, so each one is listed here; a new one fails until it is added with
 * what it decides, or uses long-silence.ts.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');
const DIRS = ['src/core/stt', 'src/lib', 'web/src/hooks', 'web/src/utils', 'web/src/voice'];

/** `file:NAME` of each fixed loudness threshold, and what it decides. */
const THRESHOLDS: Record<string, string> = {
  'src/core/stt/long-silence.ts:SILENCE_CEILING': 'the cut: a block above it is never silence',
  'src/core/stt/long-silence.ts:SILENCE_FLOOR_MIN': 'the cut: the clip level, never used for a dimmed start',
  'src/core/stt/long-silence.ts:SILENCE_ABSOLUTE': 'the cut: under one 16-bit step',
  'src/lib/audio-block-repeat.ts:LOUD_RMS': 'which blocks are loud enough to compare for a recorder fault; nothing is cut by it',
  'web/src/voice/voice-activity.ts:ECHO_MIN_RMS': 'whether the speaker plays sound, in voice conversation; never dictation',
  'web/src/hooks/useSpeechToText.ts:VOICE_RMS': 'the live preview only (its cut points and a log line); the sent text never reads it',
  'web/src/utils/mic-health.ts:DEAD_STREAM_RMS': 'whether the capture is stuck, for the dead-mic warning; no text depends on it',
};

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (/\.(ts|tsx|mts)$/.test(name) && !/\.test\./.test(name)) out.push(p);
  }
  return out;
}

// A constant whose name says it is a loudness level, set to a fraction.
const THRESHOLD = /\bconst\s+([A-Z0-9_]*(?:RMS|SILENCE|SILENT|LOUDNESS|NOISE)[A-Z0-9_]*)\s*=\s*0?\.\d/g;

function found(): string[] {
  const out: string[] = [];
  for (const p of DIRS.flatMap((d) => files(join(ROOT, d)))) {
    for (const m of readFileSync(p, 'utf8').matchAll(THRESHOLD)) out.push(`${relative(ROOT, p)}:${m[1]}`);
  }
  return out.sort();
}

describe('fixed loudness thresholds in the voice code', () => {
  it('each one is named, with what it decides', () => {
    const unnamed = found().filter((k) => !(k in THRESHOLDS));
    expect(unnamed, `a fixed loudness threshold outside long-silence.ts: ${unnamed.join(', ')}`).toEqual([]);
  });

  it('each one named still exists', () => {
    expect(Object.keys(THRESHOLDS).filter((k) => !found().includes(k))).toEqual([]);
  });
});
