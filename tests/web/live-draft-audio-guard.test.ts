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
  'web/src/voice/voice-mic.ts:1': "voice conversation's level meter: voice activity and the dead-mic warning only; it never feeds an engine (the take is a MediaRecorder)",
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
    const timer = hook.slice(hook.indexOf('const draftTick = async'));
    expect(timer).toMatch(/await liveDraftSource\(\)/);
    expect(timer.slice(0, 600)).not.toMatch(/pcmRef\.current/);
    expect(hook).toMatch(/draftTimerRef\.current = setInterval\(draftTick,/);
  });

  it('the stop sends the whole recording once and hands its text over untouched', () => {
    // 2026-11-09, the user: "just send full ... just what ever we said it should
    // send it, without modify". The drafts are a preview; the text the stop
    // delivers is /transcribe's answer for the whole clip, as it came.
    const hook = readFileSync(join(ROOT, 'web/src/hooks/useSpeechToText.ts'), 'utf8');
    const stop = hook.slice(hook.indexOf('const handleStop = async'), hook.indexOf('recorder.onerror ='));
    expect((stop.match(/await transcribeAudio\(/g) ?? []).length).toBe(1);
    expect(stop).toMatch(/const finalText = result\.text;/);
    // No other pass or join makes the final text.
    expect(stop).not.toMatch(/draftTranscribe\(|joinSegments\(|decideStopAction|segmentsHold/);
    // The one assignment of the final text is that answer.
    expect(stop.match(/\bfinalText\s*=(?!=)\s*\S+/g)).toEqual(['finalText = result.text;']);
  });

  it('the recorder\'s draft has no byte cap, the first draft comes near a second, and every engine reads repaired audio', () => {
    // 2026-11-20, the user: "I talk and it just doesn't show anything for long
    // time". A headset take doubled its bytes (src/lib/audio-block-repeat.ts) and
    // hit the 4 MB cap 76 s in: no drafts for the rest of the take. The recorder's
    // path uploads only its open window, and moves onto a fresh draft recorder
    // instead of a time cap (the test below).
    const hook = readFileSync(join(ROOT, 'web/src/hooks/useSpeechToText.ts'), 'utf8');
    const rec = hook.slice(hook.indexOf('const liveDraftSource = async'), hook.indexOf('const webmDraftTick = async'));
    expect(rec).toMatch(/lanes\.advance\(/);
    expect(rec).not.toMatch(/blob\.size\s*>\s*DRAFT_MAX_BYTES/);
    expect(rec).toMatch(/takeRebase\(\)/);
    const first = Number(/const FIRST_DRAFT_MS = (\d+);/.exec(hook)?.[1]);
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThanOrEqual(1200);
    expect(hook).toMatch(/setTimeout\(\(\) => \{[^}]*void draftTick\(\)/);
    // A tick with no audio yet asks the recorder for it (WebKit's first chunk
    // comes 2 s in), and a tick that was decoding when the stop came uploads nothing.
    const tick = hook.slice(hook.indexOf('const draftTick = async'), hook.indexOf('draftTimerRef.current = setInterval(draftTick'));
    expect(tick).toMatch(/recorder\.requestData\(\)/);
    // Until the first words show, each new chunk drafts at once.
    expect(hook).toMatch(/addEventListener\('dataavailable', \(\) => \{\s*if \(!draftOnChunk && lastDraftRef\.current\) return;/);
    expect(tick).toMatch(/await liveDraftSource\(\);\s*(\/\/[^\n]*\n\s*)*if \(recorderStopped\(\)\) return;/);
    // Every WAV convertToWav hands out passes the repair...
    const convert = readFileSync(join(ROOT, 'src/core/stt/audio-convert.ts'), 'utf8');
    const body = convert.slice(convert.indexOf('async function toHeardWav'), convert.indexOf('async function heardOnce'));
    const returns = body.match(/return [^;]*;/g) ?? [];
    expect(returns.length).toBeGreaterThan(0);
    expect(returns.every((r) => /heardOnce\(outputPath\)/.test(r))).toBe(true);
    // ...and every engine reads its audio through convertToWav or audioForUpload.
    const engines = readdirSync(join(ROOT, 'src/core/stt')).filter((f) => /^engine-.*\.ts$/.test(f));
    expect(engines.length).toBeGreaterThan(3);
    for (const f of engines) {
      const src = readFileSync(join(ROOT, 'src/core/stt', f), 'utf8');
      // engine-qwen.ts only picks the MLX or llama engine; its own transcribe throws.
      const reads = (src.match(/async transcribe\([^)]*\)[^{]*\{[^\n]*/g) ?? []).filter((m) => !/\{ throw /.test(m));
      if (!reads.length) continue;
      expect(/convertToWav\(|audioForUpload\(/.test(src), `${f} reads repaired audio`).toBe(true);
    }
  });

  it('every take that comes back logs its timing for the daily voice review', () => {
    // 2026-11-20, the user asked for two weeks of daily checks on accuracy and
    // time; the review reads this line from the forwarded browser log.
    const hook = readFileSync(join(ROOT, 'web/src/hooks/useSpeechToText.ts'), 'utf8');
    const stop = hook.slice(hook.indexOf('const handleStop = async'), hook.indexOf('recorder.onerror ='));
    expect(stop).toMatch(/log\.info\('stt', 'take timing', \{/);
    for (const field of ['recordMs', 'firstWordsMs', 'stopToTextMs', 'engineMs', 'repeatFactor']) expect(stop).toContain(field);
    // Logged after the text, whether or not it came back empty.
    expect((stop.match(/logTiming\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('a take has no time limit and never stops silently', () => {
    // 2026-11-20, the user's mock interview: the live text froze at 5 minutes with
    // nothing on screen, and the page was recycled under the recording at 11.
    const hook = readFileSync(join(ROOT, 'web/src/hooks/useSpeechToText.ts'), 'utf8');
    // No time cap ends the draft: a long take moves onto a fresh draft recorder,
    // and only a browser that refuses one pauses it.
    expect(hook).not.toMatch(/RECORDER_DRAFT_MAX_MS|_MAX_MS \* 16/);
    const rec = hook.slice(hook.indexOf('const liveDraftSource = async'), hook.indexOf('const webmDraftTick = async'));
    expect(rec).toMatch(/lanes\.advance\(windowStartRef\.current/);
    expect(rec).toMatch(/lanes\.exhausted[\s\S]{0,40}retireDraftLane\(/);
    // Every pause of the live text is said on screen, with what the user reads.
    const retire = hook.slice(hook.indexOf('const retireDraftLane = useCallback'), hook.indexOf('const stopStream = useCallback'));
    expect(retire).toMatch(/setDraftNotice\(`Live text paused: \$\{shown\}/);
    for (const call of hook.match(/retireDraftLane\([^;]*\);/g) ?? []) expect(call, call).toMatch(/,\s*'[^']+'\);$/);
    const button = readFileSync(join(ROOT, 'web/src/components/common/MicButton.tsx'), 'utf8');
    expect(button).toMatch(/isRecording && !silenceWarning && draftNotice/);
    // The stop sends the whole clip as raw bytes: no size cap a take reaches.
    const stop = hook.slice(hook.indexOf('const handleStop = async'), hook.indexOf('recorder.onerror ='));
    expect(stop).toMatch(/await transcribeAudio\(blob, format/);
    // The page holds the take from the recorder's start until its stop is done,
    // so no reload or page recycle runs over it (unsaved-work.ts).
    expect(hook).toMatch(/recorder\.start\(CHUNK_MS\);\s*releaseTake = holdLiveTake\(\);/);
    expect(hook).toMatch(/recorder\.onstop = \(\) => \{ void handleStop\(\)\.finally\(\(\) => releaseTake\(\)\); \};/);
  });
});
