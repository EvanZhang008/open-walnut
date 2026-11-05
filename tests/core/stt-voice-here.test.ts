/**
 * An isolated server runs no voice (src/core/stt/voice-here.ts): it starts,
 * adopts and calls no speech process, loads no speech model, and records
 * nothing, even where the machine already has the model. 2026-11-05: an
 * isolated test server whose data home was a task directory started the speech
 * daemon on the Mac. WALNUT_STT_AUTO_SETUP=1 lets one run voice, and the user's
 * own server is unchanged.
 *
 * Nothing real runs here: `node:child_process` and `fetch` (the probe a daemon
 * is adopted through) are stubs that only record their calls, so a regression
 * shows up as a recorded call, never as a daemon, a port touched or a
 * microphone opened.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-test-voice-here'));

const calls = vi.hoisted(() => ({
  spawn: [] as Array<{ cmd: string; args: string[] }>,
  execFile: [] as Array<{ cmd: string; args: string[] }>,
  /** spawnSync, exec, execSync, execFileSync, fork: no voice path uses them, so any call is recorded and refused. */
  other: [] as string[],
}));

/**
 * A child that is never a real process: no pid, signals only flip a field. One
 * that is not `alive` exits at once, and its exit is sticky, so a listener the
 * engine attaches after an await still hears it.
 */
function fakeChild(alive: boolean) {
  const proc = new EventEmitter() as EventEmitter & Record<string, unknown>;
  const stream = () => Object.assign(new EventEmitter(), { destroy() {}, end() {}, write() { return true; } });
  proc.stdin = stream();
  proc.stdout = stream();
  proc.stderr = stream();
  proc.pid = undefined;
  proc.exitCode = null;
  proc.unref = () => {};
  let exited = false;
  const exit = (code: number) => {
    if (proc.exitCode !== null) return;
    proc.exitCode = code;
    setImmediate(() => { exited = true; proc.emit('exit', code, null); });
  };
  for (const method of ['on', 'once'] as const) {
    const attach = EventEmitter.prototype[method].bind(proc);
    proc[method] = (event: string, fn: (...a: unknown[]) => void) => {
      if (event === 'exit' && exited) setImmediate(() => fn(proc.exitCode, null));
      return attach(event, fn);
    };
  }
  proc.kill = () => { exit(0); return true; };
  if (!alive) exit(1);
  return proc;
}

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const spawn = (cmd: string, args: string[] = []) => {
    calls.spawn.push({ cmd, args });
    // ffmpeg recording stays up until stopped; a daemon start dies at once.
    return fakeChild(cmd === 'ffmpeg');
  };
  const execFile = (cmd: string, args: string[], ...rest: unknown[]) => {
    calls.execFile.push({ cmd, args });
    const cb = rest.find((r) => typeof r === 'function') as ((err: Error | null, out?: unknown) => void) | undefined;
    const stdout = cmd === 'which' ? `/usr/bin/${args[0]}\n` : args.includes('-version') ? 'ffmpeg version 8' : 'hello there';
    setImmediate(() => cb?.(null, { stdout, stderr: '' }));
    return fakeChild(false);
  };
  const refuse = (name: string) => (cmd: string) => {
    calls.other.push(`${name} ${cmd}`);
    throw new Error(`${name} stub: nothing real runs in this test`);
  };
  return {
    ...actual, spawn, execFile,
    spawnSync: refuse('spawnSync'), exec: refuse('exec'), execSync: refuse('execSync'),
    execFileSync: refuse('execFileSync'), fork: refuse('fork'),
  };
});

const config = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('../../src/core/config-manager.js', () => ({
  getConfig: async () => config.value,
  updateConfig: async () => {},
}));
vi.mock('../../src/core/components/index.js', () => ({
  loadComponent: async () => null,
  resolveComponent: () => null,
  markInstalledBroken: () => {},
}));

import {
  voiceOffHere, voiceOffReason, isolatedHere, isolationOf, assertVoiceHere, VoiceOffHereError, _setVoiceIsolationForTest,
} from '../../src/core/stt/voice-here.js';
import { isIsolatedServer } from '../../src/core/stt/auto-setup.js';
import { createMlxEngine } from '../../src/core/stt/engine-mlx.js';
import { createLlamaEngine } from '../../src/core/stt/engine-llama.js';
import { createWhisperServerEngine } from '../../src/core/stt/engine-whisper-server.js';
import { createWhisperCppEngine } from '../../src/core/stt/engine-whisper-cpp.js';
import { createSherpaEngine } from '../../src/core/stt/engine-sherpa.js';
import { createQwenEngine } from '../../src/core/stt/engine-qwen.js';
import { cleanupTranscript, isCleanupAvailable, warmupCleanup } from '../../src/core/stt/cleanup-mlx.js';
import { startMicRecording, stopMicRecording, isMicRecording } from '../../src/core/stt/mic-record.js';
import { prewarmSttEngines, getOrCreateEngine } from '../../src/core/stt/index.js';
import { liveRole } from '../../src/core/stt/voice-archive-transcribe.js';
import { audioCaptureService } from '../../src/core/audio-capture.js';
import { initAudioTranscriber } from '../../src/core/audio-transcriber.js';
import { bus } from '../../src/core/event-bus.js';
import { TMP_DIR } from '../../src/constants.js';
import { pcmToWav } from '../../src/core/stt/wav-segment.js';
import type { Config } from '../../src/core/types.js';

const refused = () => Object.assign(new TypeError('fetch failed'), {
  cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
});
const fetchMock = vi.fn(async (_url: string | URL, _init?: unknown): Promise<Response> => { throw refused(); });
const fetched = () => fetchMock.mock.calls.map((c) => String(c[0]));

/** A real file, so the engines' "is it installed" checks pass and only the gate can stop them. */
const REAL_FILE = process.execPath;
const STATE_FILE = path.join(TMP_DIR, 'recording-state.json');
let tmpHome = '';
const savedOptIn = process.env.WALNUT_STT_AUTO_SETUP;

beforeAll(() => {
  // Installed for the whole file and never lifted before the engines are shut
  // down, so no test, passing or failing, reaches a real port.
  vi.stubGlobal('fetch', fetchMock);
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-voice-here-'));
});

afterAll(() => {
  getOrCreateEngine({} as Config); // retires any engine a test left adopted, through the stub
  vi.unstubAllGlobals();
  fs.rmSync(tmpHome, { recursive: true, force: true });
  if (savedOptIn === undefined) delete process.env.WALNUT_STT_AUTO_SETUP;
  else process.env.WALNUT_STT_AUTO_SETUP = savedOptIn;
});

beforeEach(() => {
  calls.spawn.length = 0;
  calls.execFile.length = 0;
  calls.other.length = 0;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => { throw refused(); });
  delete process.env.WALNUT_STT_AUTO_SETUP;
  _setVoiceIsolationForTest(undefined);
});

afterEach(() => {
  _setVoiceIsolationForTest(undefined);
  vi.restoreAllMocks();
});

function expectNothingRan(): void {
  expect(calls.spawn).toEqual([]);
  expect(calls.execFile).toEqual([]);
  expect(calls.other).toEqual([]);
  expect(fetched()).toEqual([]);
}

describe('the decision', () => {
  const home = '/home/u';
  const facts = (walnutHome: string, env: NodeJS.ProcessEnv = {}) => ({
    env: { HOME: home, ...env }, isEphemeral: false, walnutHome,
    tmpRoots: [], taskDirRoots: [`${home}/.local/state/open-walnut/tasks`], accountHome: home,
  });

  it('a server whose data home is a task directory runs no voice, and the reason names the opt-in', () => {
    expect(isolationOf(facts(`${home}/.local/state/open-walnut/tasks/t1/home`))).toBe('task-dir');
    const off = voiceOffReason('task-dir', {});
    expect(off).toContain('task directory');
    expect(off).toContain('WALNUT_STT_AUTO_SETUP=1');
    expect(voiceOffReason('task-dir', { WALNUT_STT_AUTO_SETUP: '1' })).toBeNull();
    // =0 stops only the install: it neither turns an isolated server on nor the user's own off.
    expect(voiceOffReason('task-dir', { WALNUT_STT_AUTO_SETUP: '0' })).toContain('isolated server');
    expect(voiceOffReason(null, { WALNUT_STT_AUTO_SETUP: '0' })).toBeNull();
  });

  it('the search model\'s switch changes nothing: the user\'s own server keeps voice with it off, a task dir stays isolated with it on', () => {
    expect(isolationOf(facts(`${home}/.open-walnut`))).toBeNull();
    expect(isolationOf(facts(`${home}/.open-walnut`, { WALNUT_SEARCH_V2_SEMANTIC: '0' }))).toBeNull();
    expect(isolationOf(facts(`${home}/.local/state/open-walnut/tasks/t1/home`, { WALNUT_SEARCH_V2_SEMANTIC: '1' }))).toBe('task-dir');
    // A HOME that is not the account's own, and an ephemeral child, whatever the switch says.
    expect(isolationOf({ ...facts(`${home}/.open-walnut`, { WALNUT_SEARCH_V2_SEMANTIC: '1' }), env: { HOME: '/tmp/fake', WALNUT_SEARCH_V2_SEMANTIC: '1' } })).toBe('fake-home');
    expect(isolationOf({ ...facts(`${home}/.open-walnut`), isEphemeral: true })).toBe('ephemeral');
  });

  it.each(['test-runner', 'ephemeral', 'temp-home', 'task-dir', 'fake-home'] as const)('%s is said in plain words', (why) => {
    const off = voiceOffReason(why, {});
    expect(off).toMatch(/^Voice is off on this isolated server \([^)]+\), so it starts no speech process and records nothing\./);
  });

  it('the test runner is isolated, and the install reads the same rule', async () => {
    expect(isolatedHere()).toBe('test-runner');
    expect(voiceOffHere()).toContain('the test runner');
    expect(await isIsolatedServer()).toBe(true);
    _setVoiceIsolationForTest(null);
    expect(await isIsolatedServer()).toBe(false);
    expect(voiceOffHere()).toBeNull();
  });

  it('WALNUT_STT_AUTO_SETUP=1 turns it on, and only =1 does', () => {
    expect(() => assertVoiceHere()).toThrow(VoiceOffHereError);
    process.env.WALNUT_STT_AUTO_SETUP = '0';
    expect(() => assertVoiceHere()).toThrow(VoiceOffHereError);
    process.env.WALNUT_STT_AUTO_SETUP = '1';
    expect(() => assertVoiceHere()).not.toThrow();
  });
});

describe('an isolated server starts, adopts and records nothing', () => {
  it('mlx (and qwen on a Mac): not available, and no warm daemon on the shared port is probed or started', async () => {
    const engine = createMlxEngine({ pythonPath: REAL_FILE });
    const avail = await engine.isAvailable();
    expect(avail.available).toBe(false);
    expect(avail.error).toContain('WALNUT_STT_AUTO_SETUP=1');
    await expect(engine.warmup!()).rejects.toBeInstanceOf(VoiceOffHereError);
    await expect(engine.transcribe({ audio: '', format: 'wav' })).rejects.toBeInstanceOf(VoiceOffHereError);
    expectNothingRan();
  });

  it('llama-server (qwen on Linux): not available, no probe of its port, no spawn', async () => {
    const engine = createLlamaEngine({ size: '0.6B', target: 'linux-x64', threads: 2, home: tmpHome });
    const avail = await engine.isAvailable();
    expect(avail).toEqual({ available: false, error: voiceOffHere() });
    await expect(engine.warmup!()).rejects.toBeInstanceOf(VoiceOffHereError);
    // A webm would go through ffmpeg first: refused before that conversion too.
    await expect(engine.transcribe({ audio: 'AAAA', format: 'webm' })).rejects.toBeInstanceOf(VoiceOffHereError);
    expectNothingRan();
  });

  it('qwen, whatever runtime this platform plans', async () => {
    const engine = createQwenEngine({ mlx_python_path: REAL_FILE })!;
    expect((await engine.isAvailable()).available).toBe(false);
    if (engine.warmup) await expect(engine.warmup()).rejects.toThrow();
    expectNothingRan();
  });

  it('whisper-server: not available, no which, no spawn', async () => {
    const engine = createWhisperServerEngine({ binaryPath: REAL_FILE, modelPath: REAL_FILE, port: 1 });
    try {
      expect((await engine.isAvailable()).error).toBe(voiceOffHere());
      await expect(engine.warmup!()).rejects.toBeInstanceOf(VoiceOffHereError);
      await expect(engine.transcribe({ audio: '', format: 'wav' })).rejects.toBeInstanceOf(VoiceOffHereError);
    } finally {
      engine.shutdown?.();
    }
    expectNothingRan();
  });

  it('whisper-cli: not available and never run', async () => {
    const engine = createWhisperCppEngine({ binaryPath: REAL_FILE, modelPath: REAL_FILE });
    expect((await engine.isAvailable()).error).toBe(voiceOffHere());
    await expect(engine.transcribe({ audio: 'AAAA', format: 'webm' })).rejects.toBeInstanceOf(VoiceOffHereError);
    expectNothingRan();
  });

  it('sherpa-onnx: not available and no model loaded into this process', async () => {
    const engine = createSherpaEngine({ modelDir: tmpHome, modelType: 'sense_voice' });
    expect((await engine.isAvailable()).error).toBe(voiceOffHere());
    await expect(engine.transcribe({ audio: 'AAAA', format: 'webm' })).rejects.toBeInstanceOf(VoiceOffHereError);
    expectNothingRan();
  });

  it('the cleanup model: not available, warmup and cleanup touch no daemon, the text comes back as it was', async () => {
    const cfg = { stt: { mlx_python_path: REAL_FILE } } as Config;
    expect((await isCleanupAvailable(cfg)).error).toBe(voiceOffHere());
    await warmupCleanup(cfg);
    const out = await cleanupTranscript(cfg, 'um so the the plan');
    expect(out).toMatchObject({ text: 'um so the the plan', applied: false, reason: voiceOffHere() });
    expectNothingRan();
  });

  it('global dictation opens no microphone', async () => {
    await expect(startMicRecording()).rejects.toBeInstanceOf(VoiceOffHereError);
    expect(isMicRecording()).toBe(false);
    expectNothingRan();
  });

  it('the boot prewarm a copied config asks for loads nothing, and makes no engine', async () => {
    // A whisper-server engine, once made, holds signal handlers: none are added.
    const handlers = process.listenerCount('SIGTERM');
    await prewarmSttEngines({
      stt: {
        engine: 'whisper-server', whisper_server_path: REAL_FILE, whisper_server_model: REAL_FILE, prewarm_on_start: true,
        secondary_engine: 'mlx', mlx_python_path: REAL_FILE,
      },
    } as Config);
    expect(process.listenerCount('SIGTERM')).toBe(handlers);
    expectNothingRan();
  });

  it('live pieces of a take are not taken for an engine that will not run', async () => {
    config.value = { stt: { engine: 'qwen' } };
    expect(await liveRole()).toEqual({ takes: false, now: false });
    expectNothingRan();
  });

  it('system audio: no permission or app probe, no recording, no resume of a copied recording state', async () => {
    vi.spyOn(audioCaptureService, 'isAvailable').mockReturnValue(true);
    const start = vi.spyOn(audioCaptureService, 'start');
    expect(audioCaptureService.checkPermissions()).toEqual({ granted: false, message: voiceOffHere() });
    expect(audioCaptureService.listApps()).toEqual([]);
    await expect(audioCaptureService.start({ source: 'mic', mode: 'continuous' })).rejects.toBeInstanceOf(VoiceOffHereError);
    start.mockClear();

    fs.mkdirSync(TMP_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ source: 'both', mode: 'continuous' }));
    await audioCaptureService.resume();
    expect(start).not.toHaveBeenCalled();
    // Left as it was: it is the copied data's, not this server's to clear.
    expect(fs.existsSync(STATE_FILE)).toBe(true);
    expect(audioCaptureService.getStatus().recording).toBe(false);
    expectNothingRan();
  });

  it('the audio transcriber does not start', () => {
    const subscribe = vi.spyOn(bus, 'subscribe');
    initAudioTranscriber();
    expect(subscribe).not.toHaveBeenCalled();
  });
});

describe.each([
  ['an isolated server with WALNUT_STT_AUTO_SETUP=1', () => { process.env.WALNUT_STT_AUTO_SETUP = '1'; }],
  ['the user\'s own server (unchanged)', () => { _setVoiceIsolationForTest(null); }],
])('%s runs voice as before', (_name, mayRun) => {
  beforeEach(() => mayRun());

  it('mlx adopts the warm daemon its port answers for, and spawns none', async () => {
    const model = 'test/model';
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ status: 'ok', model }), { status: 200 }));
    const engine = createMlxEngine({ pythonPath: REAL_FILE, model, port: 1 });
    expect(await engine.isAvailable()).toEqual({ available: true });
    expect(calls.execFile.map((c) => c.args.join(' '))).toEqual(['-c import mlx_audio']);
    await engine.warmup!();
    expect(fetched()).toEqual(['http://127.0.0.1:1/']);
    expect(calls.spawn).toEqual([]);
    engine.shutdown?.(); // an HTTP shutdown, through the stub
  });

  it('mlx starts a daemon when nothing answers', async () => {
    const engine = createMlxEngine({ pythonPath: REAL_FILE, port: 1 });
    await expect(engine.warmup!()).rejects.toThrow(/exited during startup/);
    expect(calls.spawn.map((c) => c.cmd)).toEqual([REAL_FILE]);
  });

  it('llama-server is probed and started', async () => {
    const engine = createLlamaEngine({ size: '0.6B', target: 'linux-x64', threads: 2, home: tmpHome, port: 1 });
    await expect(engine.warmup!()).rejects.toThrow(/exited during startup/);
    expect(fetched()[0]).toBe('http://127.0.0.1:1/props');
    expect(calls.spawn).toHaveLength(1);
    expect(calls.spawn[0].args).toContain('--port');
  });

  it('whisper-server is started', async () => {
    const engine = createWhisperServerEngine({ binaryPath: REAL_FILE, modelPath: REAL_FILE });
    try {
      expect(await engine.isAvailable()).toEqual({ available: true });
      await expect(engine.warmup!()).rejects.toThrow(/exited during startup/);
      expect(calls.spawn.map((c) => c.cmd)).toEqual([REAL_FILE]);
    } finally {
      engine.shutdown?.();
    }
  });

  it('whisper-cli runs', async () => {
    const engine = createWhisperCppEngine({ binaryPath: REAL_FILE, modelPath: REAL_FILE });
    const wav = pcmToWav(new Int16Array(1600)).toString('base64');
    expect(await engine.transcribe({ audio: wav, format: 'wav' })).toMatchObject({ text: 'hello there' });
    expect(calls.execFile.map((c) => c.cmd)).toContain(REAL_FILE);
  });

  it('the cleanup daemon is probed and started', async () => {
    const cfg = { stt: { mlx_python_path: REAL_FILE, cleanup_port: 1 } } as Config;
    expect(await isCleanupAvailable(cfg)).toEqual({ available: true });
    const out = await cleanupTranscript(cfg, 'so the the plan');
    expect(out.applied).toBe(false);
    expect(fetched()[0]).toBe('http://127.0.0.1:1/');
    expect(calls.spawn.map((c) => c.cmd)).toEqual([REAL_FILE]);
  });

  it('global dictation records through ffmpeg', async () => {
    await startMicRecording();
    expect(isMicRecording()).toBe(true);
    const rec = calls.spawn.find((c) => c.cmd === 'ffmpeg');
    expect(rec?.args).toContain('avfoundation');
    // The stub wrote no audio, so the stop reports an empty recording.
    await expect(stopMicRecording()).rejects.toThrow(/empty|ENOENT/);
    const wavPath = rec!.args[rec!.args.length - 1];
    fs.rmSync(path.dirname(wavPath), { recursive: true, force: true });
  });

  it('live pieces are taken for a local engine', async () => {
    config.value = { stt: { engine: 'qwen' } };
    expect(await liveRole()).toEqual({ takes: true, now: true });
  });

  it('a recording state is resumed and the transcriber starts', async () => {
    const start = vi.spyOn(audioCaptureService, 'start').mockResolvedValue({ recordingId: 'r1' });
    fs.mkdirSync(TMP_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ source: 'system', mode: 'on-demand' }));
    await audioCaptureService.resume();
    expect(start).toHaveBeenCalledWith({ source: 'system', mode: 'on-demand' });
    fs.rmSync(STATE_FILE, { force: true });

    const subscribe = vi.spyOn(bus, 'subscribe').mockImplementation(() => {});
    initAudioTranscriber();
    expect(subscribe).toHaveBeenCalledTimes(1);
  });
});
