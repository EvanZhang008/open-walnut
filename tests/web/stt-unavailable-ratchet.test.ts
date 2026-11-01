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

  it('no-sound wording lives in mic-health.ts (plus the stop gate for a stream that never carried sound)', () => {
    const ALLOWED: Record<string, string> = {
      'utils/mic-health.ts': 'the live warnings',
      // onstop's deadStream gate: the analyser never saw any signal this
      // recording, so there is nothing to transcribe (and Whisper hallucinates on zeros).
      'hooks/useSpeechToText.ts': 'stop gate for a never-alive stream',
    };
    const wording = files.filter((f) => /No sound (from|detected)/i.test(f.text)).map((f) => f.rel).sort();
    expect(wording).toEqual(Object.keys(ALLOWED).sort());
    const hook = files.find((f) => f.rel === 'hooks/useSpeechToText.ts')!.text;
    // The hook's only own no-sound line is the never-alive stop gate.
    expect(hook.match(/No sound (from|detected)/gi)).toHaveLength(1);
    expect(hook).toMatch(/const deadStream = analyserAttachedRef\.current && !sawAnyNonDeadRef\.current/);
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
