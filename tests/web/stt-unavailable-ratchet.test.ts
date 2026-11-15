/**
 * Every place the web app decides "voice is not working" goes through one rule.
 *
 * 2026-10-31, the user on the Mac app: "while I talk it suddenly says not
 * available, and two seconds later it is available". Two members of that class
 * were live: the no-sound warning fired on a few seconds of pipeline stall
 * after speech, and a status blip mid-recording could dim the mic and turn the
 * stop click into a jump to Settings. The rules now live in mic-health.ts and
 * sttBlocksMic; this test fails when a new file samples the mic level, words a
 * no-sound message, or reads the engine status for a mic control on its own.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '../../web/src');

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) out.push(p);
  }
  return out;
}
const files = sources(ROOT).map((p) => ({ rel: relative(ROOT, p), text: readFileSync(p, 'utf8') }));

describe('voice unavailable: one rule per decision', () => {
  it('every mic level sampler takes its no-sound decision from mic-health.ts', () => {
    const samplers = files.filter((f) => /get(Byte|Float)TimeDomainData\(/.test(f.text));
    expect(samplers.map((f) => f.rel)).toEqual(['hooks/useSpeechToText.ts']);
    for (const f of samplers) expect(f.text).toMatch(/from '@\/utils\/mic-health'/);
  });

  it('no-sound wording lives in mic-health.ts only: the live warnings and the stop verdicts', () => {
    const wording = files.filter((f) => /No sound (from|detected)/i.test(f.text)).map((f) => f.rel).sort();
    expect(wording).toEqual(['utils/mic-health.ts']);
  });

  // 2026-11-15: a Send 90 ms into a recording (the button still said "Starting the
  // microphone") showed "No sound detected ... Check your mic device" and held the
  // send, and a take whose recorder had no bytes yet ended silently whatever the mic
  // had heard. The stop had its own two rules beside the live warning's 3 s one.
  it('the stop decides what a take holds through classifyTake only, never its own size or silence check', () => {
    const hook = files.find((f) => f.rel === 'hooks/useSpeechToText.ts')!.text;
    const onstop = hook.slice(hook.indexOf('recorder.onstop'), hook.indexOf('recorder.onerror'));
    expect(onstop).toMatch(/classifyTake\(blob\.size, health\)/);
    expect(onstop).toMatch(/TAKE_ERRORS\[verdict\]/);
    expect(onstop).not.toMatch(/blob\.size\s*(===|<=|<|==)\s*0/);
    expect(onstop).not.toMatch(/setError\(\s*['"`]/);
    // No other file judges a stopped take on its own.
    expect(files.filter((f) => /\bclassifyTake\(/.test(f.text)).map((f) => f.rel).sort())
      .toEqual(['hooks/useSpeechToText.ts', 'utils/mic-health.ts']);
  });

  it('every mic control decides availability through sttBlocksMic, never the raw status', () => {
    const micControls = files.filter((f) => /useSttStatus\(/.test(f.text) && /useSpeechToText\(|mic-btn/.test(f.text));
    expect(micControls.length).toBeGreaterThan(0);
    for (const f of micControls) {
      expect(f.text, f.rel).toMatch(/sttBlocksMic\(/);
      expect(f.text.match(/\.isAvailable\b/g) ?? [], f.rel).toHaveLength(0);
    }
  });
});
