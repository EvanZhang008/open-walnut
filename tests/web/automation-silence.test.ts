/**
 * No sound from a browser or a Simulator that a test or an agent drives (2026-11-08: a
 * Playwright WebKit run on someone else's Mac, with a person at it, woke its built-in
 * speaker at every first click of a page, through the reminder chime's audio unlock).
 *
 *   - the page silencer mutes media, routes Web Audio to the speakers through a gain of
 *     zero and speaks at volume zero, only under automation, in the page and as the
 *     source a frame runs;
 *   - the chime never opens the audio device under automation;
 *   - ratchets: every sound API in the web app and the plugins this repository ships, every
 *     sandboxed frame, and every sound site of the iOS app is listed with how it stays
 *     silent, so a new one fails here until it does;
 *   - every Chromium project of the Playwright config mutes itself, and every UI test
 *     launch of the iOS app passes the silent argument.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { silenceAutomatedAudio, AUTOMATION_SILENCE_JS } from '../../web/src/utils/automation-silence';
import { PW_SILENCE_JS, pwSilenceDir, pwSilencePreloadSource, withPwSilenceNodeOptions } from '../../src/providers/pw-silence-core';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/**
 * A small stand-in for a browser realm: just the classes the silencer touches. `sink` makes
 * its AudioContext one that can run without an output device (Chromium's setSinkId).
 */
function fakeRealm(webdriver: boolean, { sink = false } = {}) {
  const connections: Array<[unknown, unknown]> = [];
  class AudioNode {
    context: unknown;
    constructor(ctx: unknown) { this.context = ctx; }
    connect(target: unknown) { connections.push([this, target]); return target; }
  }
  class AudioDestinationNode extends AudioNode {}
  class GainNode extends AudioNode { gain = { value: 1 }; }
  class BaseContext {
    destination: AudioDestinationNode;
    options: Record<string, unknown> | undefined;
    constructor(options?: Record<string, unknown>) { this.options = options; this.destination = new AudioDestinationNode(this); }
    createGain() { return new GainNode(this); }
    createOscillator() { return new AudioNode(this); }
  }
  class AudioContext extends BaseContext {}
  const sinkMoves: unknown[] = [];
  if (sink) (AudioContext.prototype as unknown as { setSinkId: (id: unknown) => Promise<void> }).setSinkId = (id) => { sinkMoves.push(id); return Promise.resolve(); };
  class OfflineAudioContext extends BaseContext {}
  class HTMLMediaElement {
    private m = false;
    private a = false;
    played = 0;
    paused = true;
    own: Record<string, (e: unknown) => void> = {};
    get muted() { return this.m; }
    set muted(v: boolean) { this.m = v; }
    get autoplay() { return this.a; }
    set autoplay(v: boolean) { this.a = v; }
    play() { this.played++; this.paused = false; return Promise.resolve(); }
    pause() { this.paused = true; }
    addEventListener(t: string, f: (e: unknown) => void) { this.own[t] = f; }
    /** What the browser does on its own: autoplay starts it, with no play() call. */
    autoplayNow() { if (!this.a) return; this.paused = false; this.own.play?.({ type: 'play', target: this }); }
  }
  for (const k of ['muted', 'autoplay']) {
    Object.defineProperty(HTMLMediaElement.prototype, k, { ...Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, k), enumerable: true });
  }
  class Audio extends HTMLMediaElement { constructor(public src?: string) { super(); } }
  const spoken: Array<{ volume: number }> = [];
  class SpeechSynthesis { speak(u: { volume: number }) { spoken.push(u); } }
  const listeners: Record<string, (e: unknown) => void> = {};
  const document = { addEventListener: (t: string, f: (e: unknown) => void) => { listeners[t] = f; } };
  const realm = {
    navigator: { webdriver }, document, Promise,
    AudioNode, AudioDestinationNode, AudioContext, OfflineAudioContext, HTMLMediaElement, Audio, SpeechSynthesis,
  } as Record<string, unknown>;
  return { realm, connections, spoken, listeners, sinkMoves, AudioContext, OfflineAudioContext, HTMLMediaElement, SpeechSynthesis };
}

type Realm = ReturnType<typeof fakeRealm>;
const tried = (f: Realm) => f.realm.__walnutAudio as { contexts: number; blocked: number; plays: number; speech: number };

/** Nothing reaches an audio device: no media plays, no context gets an output, no speech. */
async function checkSilenced(f: Realm) {
  const el = new f.HTMLMediaElement();
  el.muted = false;
  const started = (el.play() as Promise<unknown>).then(() => 'played', (e: Error) => e.message);
  expect(await started).toBe('No audio in a test run');
  expect(el.played, 'the native play never runs').toBe(0);
  expect(el.muted).toBe(true);
  el.muted = false;
  expect(el.muted).toBe(true);
  // An autoplay element is muted as it starts loading and paused as it starts playing.
  const auto = new f.HTMLMediaElement();
  f.listeners.loadstart?.({ type: 'loadstart', target: auto });
  expect(auto.muted).toBe(true);
  auto.paused = false;
  f.listeners.play?.({ type: 'play', target: auto });
  expect(auto.paused).toBe(true);
  // The browser's own controls unmute it without the setter: its volumechange mutes it again.
  (auto as unknown as { m: boolean }).m = false;
  expect(f.listeners.volumechange, 'a volumechange listener').toBeTypeOf('function');
  f.listeners.volumechange({ type: 'volumechange', target: auto });
  expect(auto.muted).toBe(true);
  expect(tried(f).plays).toBe(2);
  // A detached `new Audio()` sends the document nothing: it is guarded where it is made, and
  // the browser's own autoplay of it is paused by its own listener.
  const A = f.realm.Audio as new (src?: string) => InstanceType<typeof f.HTMLMediaElement>;
  const detached = new A('tone.wav');
  expect(detached).toBeInstanceOf(f.HTMLMediaElement);
  expect(detached.muted).toBe(true);
  detached.autoplay = true;
  expect(detached.autoplay, 'autoplay stays off').toBe(false);
  (detached as unknown as { a: boolean }).a = true;   // a parser set the attribute
  detached.autoplayNow();
  expect(detached.paused).toBe(true);
  expect(tried(f).plays).toBe(3);

  // An offline context renders into a buffer: left alone.
  const off = new f.OfflineAudioContext();
  const o2 = off.createOscillator();
  o2.connect(off.destination);
  expect(f.connections).toContainEqual([o2, off.destination]);

  new f.SpeechSynthesis().speak({ volume: 1 });
  expect(f.spoken, 'speech is never spoken').toHaveLength(0);
  expect(tried(f).speech).toBe(1);
}

/** Where the engine has no way to run a context without a device, making one fails. */
function checkNoContext(f: Realm) {
  const Ctor = f.realm.AudioContext as new () => unknown;
  expect(() => new Ctor()).toThrow('No audio in a test run');
  expect(tried(f)).toMatchObject({ contexts: 1, blocked: 1 });
}

/** Where it has (Chromium), every context is made without a device and stays so. */
async function checkDevicelessContext(f: Realm) {
  const Ctor = f.realm.AudioContext as new (o?: Record<string, unknown>) => InstanceType<typeof f.AudioContext>;
  const ctx = new Ctor({ latencyHint: 'interactive' });
  expect(ctx).toBeInstanceOf(f.AudioContext);
  expect(ctx).toBeInstanceOf(Ctor);
  expect(ctx.options).toEqual({ latencyHint: 'interactive', sinkId: { type: 'none' } });
  await (ctx as unknown as { setSinkId: (id: string) => Promise<void> }).setSinkId('');
  expect(f.sinkMoves, 'never moved onto a device').toEqual([]);
  expect(tried(f)).toMatchObject({ contexts: 1, blocked: 0 });
  // Wired to its destination, it still goes through a gain of zero.
  const osc = ctx.createOscillator();
  expect(osc.connect(ctx.destination)).toBe(ctx.destination);
  const toDest = f.connections.filter(([, to]) => to === ctx.destination);
  expect(toDest).toHaveLength(1);
  const gain = toDest[0][0] as { gain: { value: number } };
  expect(gain).not.toBe(osc);
  expect(gain.gain.value).toBe(0);
  expect(f.connections).toContainEqual([osc, gain]);
}

/** Every copy of the silencer, run on its own in a realm, against every check. */
async function checkAll(run: (f: Realm) => void) {
  const a = fakeRealm(true); run(a); await checkSilenced(a); checkNoContext(a);
  const b = fakeRealm(true, { sink: true }); run(b); await checkDevicelessContext(b);
}

describe('the page silencer', () => {
  it('opens no audio output under automation: no media, no context with a device, no speech', async () => {
    await checkAll((f) => silenceAutomatedAudio(f.realm));
  });

  it('leaves a person\'s browser alone', () => {
    const f = fakeRealm(false);
    const play = f.HTMLMediaElement.prototype.play;
    silenceAutomatedAudio(f.realm);
    expect(f.HTMLMediaElement.prototype.play).toBe(play);
    const el = new f.HTMLMediaElement();
    void el.play();
    expect(el.muted).toBe(false);
    expect(el.played).toBe(1);
    expect(f.realm.AudioContext).toBe(f.AudioContext);
    expect(f.realm.__walnutAudio).toBeUndefined();
  });

  it('installs once', () => {
    const f = fakeRealm(true);
    silenceAutomatedAudio(f.realm);
    const play = f.HTMLMediaElement.prototype.play;
    silenceAutomatedAudio(f.realm);
    expect(f.HTMLMediaElement.prototype.play).toBe(play);
  });

  it('runs as a frame\'s source on its own, with nothing from this module', async () => {
    await checkAll((f) => vm.runInNewContext(AUTOMATION_SILENCE_JS, f.realm));
  });

  it('every run a Mac\'s runner starts gets the same rules, whatever branch it builds', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const preload = require('../e2e/browser/pw-silence-preload.cjs') as { SILENCE_JS: string; install: (core: unknown) => boolean; isPlaywrightCore: (r: string) => boolean };
    await checkAll((f) => vm.runInNewContext(preload.SILENCE_JS, f.realm));
    const person = fakeRealm(false);
    vm.runInNewContext(preload.SILENCE_JS, person.realm);
    expect(person.realm.__walnutSilent, 'a person\'s browser is untouched').toBeUndefined();
    // It hands every new browser context that script, through the runner's instrumentation.
    const listeners: Array<{ runAfterCreateBrowserContext: (c: unknown) => Promise<void> }> = [];
    const core = { _instrumentation: { addListener: (l: (typeof listeners)[number]) => listeners.push(l) } };
    expect(preload.install(core)).toBe(true);
    expect(preload.install(core), 'once per Playwright library').toBe(false);
    expect(listeners).toHaveLength(1);
    // It acts on a load of the library, whatever loads it, and on nothing else.
    for (const r of ['playwright-core', '/x/node_modules/playwright-core', '/x/node_modules/playwright-core/index.js']) expect(preload.isPlaywrightCore(r), r).toBe(true);
    for (const r of ['playwright', '@playwright/test', 'playwright-core/lib/utils', './my-playwright-core-notes', 'fs']) expect(preload.isPlaywrightCore(r), r).toBe(false);
    const added: string[] = [];
    await listeners[0].runAfterCreateBrowserContext({ addInitScript: async (x: { content: string }) => { added.push(x.content); } });
    expect(added).toEqual([preload.SILENCE_JS]);
    // The iOS web views run the very same text, with no gate.
    const swift = /static let webScript = #"([\s\S]*?)"#/.exec(read('ios-native/Walnut/Core/AudioSilence.swift'))?.[1];
    expect(preload.SILENCE_JS).toContain(swift!);
    expect(swift).toBe(PW_SILENCE_JS);
    // The committed copy is the generated one (scripts/pw-silence-preload.ts writes it).
    expect(read('tests/e2e/browser/pw-silence-preload.cjs')).toBe(pwSilencePreloadSource());
  });

  it('a session\'s NODE_OPTIONS gets the preload first, once, and keeps what it had', () => {
    const f = '/state/pw-silence/pw-silence-preload.cjs';
    expect(withPwSilenceNodeOptions(undefined, f)).toBe(`--require "${f}"`);
    expect(withPwSilenceNodeOptions('  ', f)).toBe(`--require "${f}"`);
    expect(withPwSilenceNodeOptions('--max-old-space-size=8192', f)).toBe(`--require "${f}" --max-old-space-size=8192`);
    const once = withPwSilenceNodeOptions('--inspect', f);
    expect(withPwSilenceNodeOptions(once, f), 'never twice').toBe(once);
    // Another copy (a temp one that may be gone, an older one, later in the line) gives way to this one, first.
    expect(withPwSilenceNodeOptions('--inspect --require "/tmp/run 1/pw-silence-preload.cjs" -r /old/pw-silence-preload.cjs --require=/o/pw-silence-preload.cjs --no-warnings', f))
      .toBe(`--require "${f}" --inspect --no-warnings`);
    expect(withPwSilenceNodeOptions('--require "/x/other-preload.cjs"', f), 'a preload of the user\'s own stays').toBe(`--require "${f}" --require "/x/other-preload.cjs"`);
    // No file (off, unwritable) or a path the quoting cannot carry: unchanged, never a broken --require.
    expect(withPwSilenceNodeOptions('--inspect', null)).toBe('--inspect');
    expect(withPwSilenceNodeOptions(undefined, '/a"b/pw-silence-preload.cjs')).toBeUndefined();
    expect(withPwSilenceNodeOptions('--inspect', '/st\\ate/pw-silence-preload.cjs'), 'Node unescapes a backslash in quotes').toBe('--inspect');
    expect(pwSilenceDir('/home/u/.local/state/open-walnut/tasks')).toBe('/home/u/.local/state/open-walnut/pw-silence');
  });

  it('every Walnut-built frame runs it before any script of its content', async () => {
    const { wrapBoardHtml } = await import('../../web/src/components/board/board-model');
    const board = wrapBoardHtml('<p>x</p><script>new AudioContext()</script>', '/*runtime*/', '');
    expect(board.indexOf(AUTOMATION_SILENCE_JS)).toBeGreaterThan(-1);
    expect(board.indexOf(AUTOMATION_SILENCE_JS)).toBeLessThan(board.indexOf('new AudioContext'));
    const { islandRuntimeScript } = await import('../../web/src/components/chat/island-runtime');
    expect(islandRuntimeScript('k', {})).toContain(AUTOMATION_SILENCE_JS);
    // The Files preview's documents, served with the bridge in their head.
    const { withPreviewBridge } = await import('../../src/web/preview-bridge');
    const doc = withPreviewBridge('<html><head><script>new Audio("a.mp3").play()</script></head></html>');
    expect(doc.indexOf(AUTOMATION_SILENCE_JS)).toBeGreaterThan(-1);
    expect(doc.indexOf(AUTOMATION_SILENCE_JS)).toBeLessThan(doc.indexOf('new Audio'));
  });
});

describe('the WebKit voice specs, the one place a test browser may make an AudioContext', () => {
  // Their synthetic microphone and the app's meter need one; nothing they make reaches a
  // destination but through a gain of zero, and no media or speech plays. A new spec that
  // claims the exemption fails here until it is listed, with why.
  const VOICE_TEST_SPECS: Record<string, string> = {
    'tests/e2e/browser/mic-stall.webkit.spec.ts': 'the mic warning in WebKit, from a synthetic mic',
    'tests/e2e/browser/stt-failure-recovery.webkit.spec.ts': 'dictation failures in WebKit, from a synthetic mic',
  };

  it('only the listed specs claim it', () => {
    const found = filesMatching(['tests', 'web', 'src', 'scripts', 'plugin-store', 'packages'], /WalnutVoiceTest'/, /\.(ts|tsx|js|mjs|cjs)$/, /automation-silence\.test\.ts$/);
    expect(found).toEqual(Object.keys(VOICE_TEST_SPECS).sort());
  });

  it('gets a context there, still wired through a gain of zero, and nothing else', async () => {
    for (const run of [
      (f: Realm) => silenceAutomatedAudio(f.realm),
      (f: Realm) => vm.runInNewContext(AUTOMATION_SILENCE_JS, f.realm),
    ]) {
      const f = fakeRealm(true);
      (f.realm.navigator as { userAgent?: string }).userAgent = 'Mozilla/5.0 Safari/605.1.15 WalnutVoiceTest';
      run(f);
      const Ctor = f.realm.AudioContext as new () => InstanceType<typeof f.AudioContext>;
      const ctx = new Ctor();
      expect(ctx).toBeInstanceOf(f.AudioContext);
      const osc = ctx.createOscillator();
      osc.connect(ctx.destination);
      const toDest = f.connections.filter(([, to]) => to === ctx.destination);
      expect((toDest[0][0] as { gain: { value: number } }).gain.value).toBe(0);
      await checkSilenced(f);
    }
  });
});

describe('the chime', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

  it('never opens the audio device under automation', async () => {
    let built = 0;
    vi.stubGlobal('AudioContext', class { state = 'suspended'; constructor() { built++; } resume() { return Promise.resolve(); } suspend() { return Promise.resolve(); } });
    vi.stubGlobal('navigator', { webdriver: true });
    const added: string[] = [];
    vi.stubGlobal('window', { addEventListener: (t: string) => added.push(t), removeEventListener: () => {} });
    const { armChime, playChime } = await import('../../web/src/utils/chime');
    armChime();
    playChime('reminder');
    expect(built).toBe(0);
    expect(added).toEqual([]);
  });
});

/** Files under `dirs` (tracked or new) whose text matches `re`. */
function filesMatching(dirs: string[], re: RegExp, exts: RegExp, skip: RegExp): string[] {
  const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', ...dirs], { cwd: ROOT, encoding: 'utf8' });
  return out.split('\n').filter((f) => f && exts.test(f) && !skip.test(f) && fs.existsSync(path.join(ROOT, f)))
    .filter((f) => re.test(read(f))).sort();
}

describe('ratchet: every sound in the web app stays silent under automation', () => {
  const SOUND = /\bnew\s+Audio\s*\(|\bAudioContext\b|<audio\b|<video\b|speechSynthesis|SpeechSynthesisUtterance|createOscillator|\.destination\b/;
  // Each file that can make sound, and how it stays silent in a browser under automation.
  const SILENT_BY: Record<string, string> = {
    'web/src/utils/chime.ts': 'returns before it builds an AudioContext (automatedBrowser)',
    'web/src/utils/pcm-stream.ts': 'its capture node reaches the speakers only through a gain of zero, and the page silencer',
    'web/src/hooks/useSpeechToText.ts': 'a meter: its graph never reaches the speakers',
    'web/src/components/common/FileContentView.tsx': 'its <audio>/<video> are muted by the page silencer, and its HTML preview runs it per load',
    'web/src/apps/mail/mail-html.ts': 'drops every media element from a mail',
    'web/src/utils/file-kind.ts': 'only names the media kinds a file view shows',
    'plugin-store/walnut-rhythm/src/web/music.ts': 'a media element in the page: muted by the page silencer',
  };

  it('lists every file that can make sound', () => {
    const found = filesMatching(['web/src', 'plugin-store'], SOUND, /\.(ts|tsx|js|jsx)$/, /\.test\.|automation-silence\.ts$/);
    expect(found).toEqual(Object.keys(SILENT_BY).sort());
  });

  it('the page installs the silencer before the app mounts', () => {
    const main = read('web/src/main.tsx');
    expect(main).toMatch(/silenceAutomatedAudio\(\)/);
    expect(main.indexOf('silenceAutomatedAudio()')).toBeLessThan(main.indexOf('createRoot('));
  });
});

describe('ratchet: every sandboxed frame stays silent under automation', () => {
  const FRAME = /sandbox=|sandbox:\s*['"`]/;
  const SILENT_BY: Record<string, string> = {
    'web/src/components/board/TaskBoardPane.tsx': 'wrapBoardHtml puts the silencer ahead of the board\'s scripts',
    'web/src/components/chat/RichBlocks.tsx': 'islandRuntimeScript starts with the silencer',
    'web/src/components/chat/IslandPreview.tsx': 'runs no script of its content (the runtime copies markup only) and its CSP loads no media',
    'web/src/components/common/FileContentView.tsx': 'its own origin: the server puts the silencer first in the preview bridge (preview-bridge.ts), and a test run silences it at document start',
    'web/src/components/inbox/LetterBody.tsx': 'a letter: no scripts in its sandbox, media blocked by its CSP',
    'web/src/apps/mail/MailReaderBody.tsx': 'a mail: media elements dropped (mail-html.ts), no scripts',
    'web/src/pages/PluginAppPage.tsx': 'a plugin\'s own page: a test run silences it at document start (pw-silence.ts), and Chromium mutes itself',
    'web/src/components/sessions/SessionWebView.tsx': 'another origin (a dev server): a test run silences it at document start (pw-silence.ts), and Chromium mutes itself',
  };

  it('lists every sandboxed frame', () => {
    const found = filesMatching(['web/src'], FRAME, /\.(tsx|jsx)$/, /\.test\./);
    expect(found).toEqual(Object.keys(SILENT_BY).sort());
  });

  it('letters and mail run no script', () => {
    for (const f of ['web/src/components/inbox/LetterBody.tsx', 'web/src/apps/mail/MailReaderBody.tsx']) {
      const name = /sandbox=\{(\w+)\}/.exec(read(f))?.[1];
      expect(name, f).toBeTruthy();
      const decl = filesMatching(['web/src'], new RegExp(`${name}\\s*=`), /\.(ts|tsx)$/, /\.test\./)
        .map((p) => new RegExp(`${name}\\s*=\\s*([^;]+);`).exec(read(p))?.[1] ?? '').join(' ');
      expect(decl, f).not.toMatch(/allow-scripts/);
    }
  });
});

describe('every Playwright config', () => {
  const configs = filesMatching(['.'], /defineConfig\(/, /(^|\/)[\w.-]*\.config\.ts$/, /node_modules|^web\/|^vitest|^tsup|^site\//)
    .filter((f) => /@playwright\/test/.test(read(f)));

  it('silences every frame of every context it makes', () => {
    expect(configs.length).toBeGreaterThanOrEqual(8);
    for (const f of configs) expect(read(f), f).toMatch(/from '[./\w-]*pw-silence\.js'/);
    const hook = read('tests/e2e/browser/pw-silence.ts');
    expect(hook).toMatch(/runAfterCreateBrowserContext/);
    expect(hook).toMatch(/addInitScript\(\{ content: AUTOMATION_SILENCE_JS \}\)/);
    expect(hook).toMatch(/CHROMIUM_SILENT = \['--mute-audio'\]/);
  });

  it('every Chromium project mutes itself', () => {
    for (const f of configs) {
      const uses = [...read(f).matchAll(/\.\.\.devices\['Desktop Chrome'\]([^\n]*)/g)];
      for (const [, rest] of uses) expect(rest, f).toContain('launchOptions: { args: CHROMIUM_SILENT }');
    }
  });

  it('a spec that switches to another engine starts it without the Chromium switches', async () => {
    // The *.webkit.spec.ts files run in a Chromium project with browserName 'webkit', so the
    // project's launch options reach WebKit, which refuses --mute-audio (2026-11-08).
    const { engineArgs, CHROMIUM_SILENT } = await import('../e2e/browser/pw-silence');
    expect(engineArgs('chromium', CHROMIUM_SILENT)).toEqual(CHROMIUM_SILENT);
    for (const engine of ['webkit', 'firefox']) expect(engineArgs(engine, [...CHROMIUM_SILENT, '--keep'])).toEqual(['--keep']);
    expect(engineArgs('webkit', undefined)).toBeUndefined();
    expect(read('tests/e2e/browser/pw-silence.ts')).toMatch(/for \(const engine of \['webkit', 'firefox'\]\)/);
  });
});

describe('ratchet: the iOS app makes no sound where a test or an agent runs it', () => {
  // A web view is a sound site too: its page can play media or Web Audio.
  const SOUND = /AVSpeechSynthesizer\(|AVAudioPlayer\(|AVPlayer\(|AVQueuePlayer\(|AudioServicesPlay\w*Sound|AlertConfiguration\(|AVAudioEngine\(|UNNotificationSound|VideoPlayer\(|WKWebViewConfiguration\(|WKWebView\(frame/;

  it('every sound site reads AudioSilence', () => {
    const found = filesMatching(['ios-native'], SOUND, /\.swift$/, /Tests\//);
    expect(found.length).toBeGreaterThan(0);
    const missing = found.filter((f) => !read(f).includes('AudioSilence.'));
    // SpeechOutput builds its synthesizer once; the volume goes on each utterance.
    expect(missing).toEqual([]);
  });

  it('every web view configuration installs the page silencer', () => {
    const found = filesMatching(['ios-native'], /WKWebViewConfiguration\(\)/, /\.swift$/, /Tests\//);
    expect(found.length).toBeGreaterThanOrEqual(3);
    for (const f of found) expect(read(f), f).toMatch(/AudioSilence\.install\(on: /);
  });

  it('its web view script silences a page like the web silencer, with no webdriver gate', async () => {
    const src = /static let webScript = #"([\s\S]*?)"#/.exec(read('ios-native/Walnut/Core/AudioSilence.swift'))?.[1];
    expect(src).toBeTruthy();
    await checkAll((f) => vm.runInNewContext(src!, f.realm));
    // No webdriver gate: a person's realm in the app is silenced too.
    const g = fakeRealm(false);
    vm.runInNewContext(src!, g.realm);
    await checkSilenced(g);
  });

  it('is silent in the Simulator and under tests, never on a device', () => {
    const src = read('ios-native/Walnut/Core/AudioSilence.swift');
    expect(src).toMatch(/return simulator && !defaults\.bool\(forKey: allowArgument\)/);
    expect(src).toMatch(/XCTestConfigurationFilePath/);
  });

  it('every UI test launch passes the silent argument', () => {
    const launch = read('ios-native/WalnutUITests/UITestLaunch.swift');
    expect(launch).toMatch(/silentAudioArguments = \["-walnut\.silentAudio", "YES"\]/);
    expect(launch).toMatch(/\+ keychainArguments \+ silentAudioArguments \+ arguments/);
  });
});
