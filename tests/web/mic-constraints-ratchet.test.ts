/**
 * Every mic the web app opens asks for the dictation constraints, and those
 * keep echo cancellation off.
 *
 * 2026-11-01, the user on the Mac app: the mic went silent while he talked and
 * came back seconds later. In WebKit, echo cancellation runs the capture
 * through Apple's voice processing unit, which builds an aggregate device from
 * the input and output devices and rebuilds it whenever the output changes (any
 * app starting or stopping sound) or a Bluetooth headset switches profile. The
 * user's Mac app logged "Unable to build a valid aggregate after 10 tries" at
 * the recordings that lost seconds of audio; a test copy of the Mac app with
 * AirPods as input stalled mid-recording when another app started playing,
 * and stopped stalling with echo cancellation off. A new getUserMedia call
 * that leaves it on brings the stall back, so this test lists every call.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { DICTATION_AUDIO_CONSTRAINTS } from '../../web/src/utils/mic-constraints.js';

const ROOT = join(__dirname, '../../web/src');

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (/\.(ts|tsx|js|jsx|mjs)$/.test(name) && !/\.test\./.test(name)) out.push(p);
  }
  return out;
}

describe('mic constraints', () => {
  it('keep echo cancellation off', () => {
    expect(DICTATION_AUDIO_CONSTRAINTS.echoCancellation).toBe(false);
  });

  it('every getUserMedia call passes DICTATION_AUDIO_CONSTRAINTS as its audio', () => {
    const calls: Array<{ file: string; call: string }> = [];
    for (const p of sources(ROOT)) {
      const text = readFileSync(p, 'utf8');
      for (const m of text.matchAll(/getUserMedia\s*(?:\?\.)?\(([^)]*)\)/g)) calls.push({ file: relative(ROOT, p), call: m[1] });
    }
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c.call, c.file).toMatch(/^\s*\{\s*audio:\s*DICTATION_AUDIO_CONSTRAINTS\s*,?\s*\}\s*$/);
  });
});
