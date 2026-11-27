/**
 * The CI proof that a Simulator run made no sound, without listening: the watch
 * (ios-native/tests/audio-output-watch.swift) logs which Simulator processes run audio, and
 * ios-native/tests/audio-output-check.py fails on output, or on the app opening the microphone.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(__dirname, '../..');
const CHECK = path.join(ROOT, 'ios-native/tests/audio-output-check.py');
const APP = '/Users/runner/Library/Developer/CoreSimulator/Devices/U/data/Containers/Bundle/Application/A/Walnut.app/Walnut';
const BOARD = '/Library/Developer/CoreSimulator/Volumes/iOS/RuntimeRoot/System/Library/CoreServices/SpringBoard.app/SpringBoard';

function judge(lines: string[], ...flags: string[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-check-'));
  const log = path.join(dir, 'audio-output.log');
  fs.writeFileSync(log, lines.join('\n') + '\n');
  const r = spawnSync('python3', ['-I', CHECK, log, ...flags], { encoding: 'utf8' });
  fs.rmSync(dir, { recursive: true, force: true });
  return { code: r.status, out: r.stdout };
}

describe('audio-output-check', () => {
  it('passes a run where the app was an audio client and ran nothing', () => {
    const r = judge(['#devices\t1', `1.0\t71371\t0\t0\t${APP}`, `1.1\t3659\t0\t0\t${BOARD}`, '#devices\t1'])
    expect(r).toEqual({ code: 0, out: 'silent: 2 Simulator process(es) were audio clients, none ran output\n' });
  });

  it('fails when any Simulator process runs output, the app or the system', () => {
    const app = judge(['#devices\t1', `1.0\t71371\t0\t0\t${APP}`, `2.0\t71371\t1\t1\t${APP}`]);
    expect(app.code).toBe(1);
    expect(app.out).toContain('::error::pid 71371 Walnut ran audio output in the Simulator at 2.0');
    const board = judge(['#devices\t1', `2.0\t3659\t1\t0\t${BOARD}`]);
    expect(board.code).toBe(1);
    expect(board.out).toContain('SpringBoard ran audio output');
  });

  it("fails when the app opens the microphone, but not on another process's input", () => {
    expect(judge(['#devices\t1', `2.0\t71371\t0\t1\t${APP}`]).code).toBe(1);
    expect(judge(['#devices\t1', `2.0\t3659\t0\t1\t${BOARD}`]).code).toBe(0);
  });

  it('says a Mac with no output device proves nothing, and --require-device fails it', () => {
    const r = judge(['#devices\t0', '#devices\t0']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('::warning::this Mac has no audio output device');
    expect(judge(['#devices\t0'], '--require-device').code).toBe(3);
    expect(judge([]).out).toContain('::warning::the watch wrote no device count');
  });

  it('never ends on "silent" when nothing was proven', () => {
    const last = (lines: string[]) => judge(lines).out.trim().split('\n').pop()!;
    // No output device, the process list never read, an empty log.
    for (const lines of [['#devices\t0', `1.0\t71371\t0\t0\t${APP}`], ['#devices\t1', '#unreadable\t1'], []]) {
      expect(last(lines)).toMatch(/^not proven: /);
      expect(judge(lines).out).not.toMatch(/^silent/m);
    }
    expect(last(['#devices\t1', `1.0\t71371\t0\t0\t${APP}`])).toMatch(/^silent: /);
  });

  it('the watch only reads: it opens no stream and sets nothing', () => {
    const src = fs.readFileSync(path.join(ROOT, 'ios-native/tests/audio-output-watch.swift'), 'utf8').replace(/\/\/[^\n]*/g, '');
    expect(src).not.toMatch(/AudioObjectSetPropertyData|AudioDeviceCreateIOProcID|AudioDeviceStart|AudioQueue|AudioUnit|AVAudio/);
  });
});
