/**
 * The live draft hears the recorder's own audio, and every place the web app
 * taps the mic through Web Audio is listed here.
 *
 * 2026-11-08, the user on the Mac app: "the most recent speech to text is
 * extremely weird". The draft was built from a Web Audio side capture. In WebKit
 * a MediaStreamAudioSourceNode pulls the mic's samples on the audio thread and
 * outputs zeros whenever the read gets ahead of the mic's writes, so the capture
 * kept time while holes opened in it; the recording (MediaRecorder, which the
 * mic pushes to) kept every word. A new Web Audio tap feeding speech to an
 * engine would bring that back, so this test lists every one.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '../..');
const DIRS = ['web/src', 'src', 'packages'];

function sources(dir: string): string[] {
  const out: string[] = [];
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return out; }
  for (const name of names) {
    if (name === 'node_modules' || name === 'dist') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (/\.(ts|tsx|js|jsx|mjs)$/.test(name) && !/\.test\./.test(name)) out.push(p);
  }
  return out;
}

const TAP = /createMediaStreamSource\(|createScriptProcessor\(|audioWorklet\.addModule\(|new MediaStreamTrackProcessor\(/g;

/** Every Web Audio tap of the mic, and what it may be used for. */
const KNOWN: Record<string, string> = {
  'web/src/hooks/useSpeechToText.ts:1': 'the level meter and the dead-mic warning only; it never feeds an engine',
  'web/src/utils/pcm-stream.ts:2': 'the side capture: the live draft reads it only where the recorder\'s audio does not decode',
};

describe('ratchet: Web Audio taps of the mic', () => {
  it('are only the known ones', () => {
    const found: Record<string, string> = {};
    for (const d of DIRS) for (const f of sources(join(ROOT, d))) {
      const n = (readFileSync(f, 'utf8').match(TAP) ?? []).length;
      if (n) found[`${relative(ROOT, f)}:${n}`] = KNOWN[`${relative(ROOT, f)}:${n}`] ?? 'NEW: say what it feeds';
    }
    expect(found).toEqual(KNOWN);
  });

  it('the live draft tries the recorder\'s audio before the side capture', () => {
    const hook = readFileSync(join(ROOT, 'web/src/hooks/useSpeechToText.ts'), 'utf8');
    const fn = hook.slice(hook.indexOf('const liveDraftSource = async'), hook.indexOf('const webmDraftTick = async'));
    expect(fn).toContain('rec.refresh(blob)');
    expect(fn.indexOf('rec.refresh(blob)')).toBeLessThan(fn.indexOf('pcmRef.current'));
    // The draft timer goes through it, never straight to the side capture.
    const timer = hook.slice(hook.indexOf('draftTimerRef.current = setInterval'));
    expect(timer).toMatch(/await liveDraftSource\(\)/);
    expect(timer.slice(0, 600)).not.toMatch(/pcmRef\.current/);
    // And every finished dictation is checked against its whole recording.
    expect(hook).toMatch(/draftMismatch\(liveText, text\)/);
    expect((hook.match(/checkAgainstWholeClip\(clip, /g) ?? []).length).toBe(2);
  });

  it('the stop decodes the recorder\'s audio to its end before it trusts the pieces', () => {
    const hook = readFileSync(join(ROOT, 'web/src/hooks/useSpeechToText.ts'), 'utf8');
    const stop = hook.slice(hook.indexOf('recorder.onstop = async'));
    const refresh = stop.indexOf('await pcm.refresh(blob)');
    expect(refresh).toBeGreaterThan(0);
    expect(refresh).toBeLessThan(stop.indexOf('decideStopAction('));
    // The pieces stand only on that fresh decode; anything else hears the whole clip.
    expect(stop).toMatch(/const segmentsHold = recFresh && live\.skipped === 0/);
    expect(stop).toMatch(/if \(segmentsHold\) \{/);
  });
});
