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

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** A small stand-in for a browser realm: just the classes the silencer touches. */
function fakeRealm(webdriver: boolean) {
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
    constructor() { this.destination = new AudioDestinationNode(this); }
    createGain() { return new GainNode(this); }
    createOscillator() { return new AudioNode(this); }
  }
  class AudioContext extends BaseContext {}
  class OfflineAudioContext extends BaseContext {}
  class HTMLMediaElement {
    private m = false;
    played = 0;
    get muted() { return this.m; }
    set muted(v: boolean) { this.m = v; }
    play() { this.played++; return Promise.resolve(); }
  }
  Object.defineProperty(HTMLMediaElement.prototype, 'muted', {
    ...Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'muted'),
    enumerable: true,
  });
  const spoken: Array<{ volume: number }> = [];
  class SpeechSynthesis { speak(u: { volume: number }) { spoken.push(u); } }
  const listeners: Record<string, (e: unknown) => void> = {};
  const document = { addEventListener: (t: string, f: (e: unknown) => void) => { listeners[t] = f; } };
  const realm = {
    navigator: { webdriver }, document,
    AudioNode, AudioDestinationNode, AudioContext, OfflineAudioContext, HTMLMediaElement, SpeechSynthesis,
  } as Record<string, unknown>;
  return { realm, connections, spoken, listeners, AudioContext, OfflineAudioContext, HTMLMediaElement, SpeechSynthesis };
}

function checkSilenced(f: ReturnType<typeof fakeRealm>) {
  const el = new f.HTMLMediaElement();
  el.muted = false;
  void el.play();
  expect(el.muted).toBe(true);
  expect(el.played).toBe(1);
  el.muted = false;
  expect(el.muted).toBe(true);
  // An autoplay element is muted as it starts loading.
  const auto = new f.HTMLMediaElement();
  f.listeners.loadstart?.({ target: auto });
  expect(auto.muted).toBe(true);
  // The browser's own controls unmute it without the setter: its volumechange mutes it again.
  (auto as unknown as { m: boolean }).m = false;
  expect(f.listeners.volumechange, 'a volumechange listener').toBeTypeOf('function');
  f.listeners.volumechange({ target: auto });
  expect(auto.muted).toBe(true);

  const ctx = new f.AudioContext();
  const osc = ctx.createOscillator();
  expect(osc.connect(ctx.destination)).toBe(ctx.destination);
  const toDest = f.connections.filter(([, to]) => to === ctx.destination);
  expect(toDest).toHaveLength(1);
  const gain = toDest[0][0] as { gain: { value: number } };
  expect(gain).not.toBe(osc);
  expect(gain.gain.value).toBe(0);
  expect(f.connections).toContainEqual([osc, gain]);
  // A second node reuses the same zero gain.
  ctx.createOscillator().connect(ctx.destination);
  expect(f.connections.filter(([, to]) => to === ctx.destination)).toHaveLength(1);

  // An offline context renders into a buffer: left alone.
  const off = new f.OfflineAudioContext();
  const o2 = off.createOscillator();
  o2.connect(off.destination);
  expect(f.connections).toContainEqual([o2, off.destination]);

  new f.SpeechSynthesis().speak({ volume: 1 });
  expect(f.spoken[0].volume).toBe(0);
}

describe('the page silencer', () => {
  it('silences media, Web Audio and speech under automation', () => {
    const f = fakeRealm(true);
    silenceAutomatedAudio(f.realm);
    checkSilenced(f);
  });

  it('leaves a person\'s browser alone', () => {
    const f = fakeRealm(false);
    const play = f.HTMLMediaElement.prototype.play;
    silenceAutomatedAudio(f.realm);
    expect(f.HTMLMediaElement.prototype.play).toBe(play);
    const el = new f.HTMLMediaElement();
    void el.play();
    expect(el.muted).toBe(false);
  });

  it('installs once', () => {
    const f = fakeRealm(true);
    silenceAutomatedAudio(f.realm);
    const play = f.HTMLMediaElement.prototype.play;
    silenceAutomatedAudio(f.realm);
    expect(f.HTMLMediaElement.prototype.play).toBe(play);
  });

  it('runs as a frame\'s source on its own, with nothing from this module', () => {
    const f = fakeRealm(true);
    vm.runInNewContext(AUTOMATION_SILENCE_JS, f.realm);
    checkSilenced(f);
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

  it('its web view script silences a page like the web silencer, with no webdriver gate', () => {
    const src = /static let webScript = #"([\s\S]*?)"#/.exec(read('ios-native/Walnut/Core/AudioSilence.swift'))?.[1];
    expect(src).toBeTruthy();
    const f = fakeRealm(false);
    vm.runInNewContext(src!, f.realm);
    checkSilenced(f);
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
