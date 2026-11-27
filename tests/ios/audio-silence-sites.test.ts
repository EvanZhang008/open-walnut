/**
 * The iOS app opens no audio hardware where a test or an agent runs it (`AudioSilence`).
 *
 * 2026-11-26: a letter's mic in a UI test started a real AVAudioRecorder in the Simulator,
 * and the quiet guard on a Mac with a person at it saw the app running audio OUTPUT
 * (CoreAudio's kAudioProcessPropertyIsRunningOutput): the Simulator does not enforce a
 * record-only session, so a recording runs the Mac's output too. Playing at volume zero, the
 * old meaning of silent, runs it as well.
 *
 * So every call that can open audio hardware (a recorder, a player, speech, a system sound,
 * the session switched on, the microphone, an alert sound) must be kept from running while
 * `AudioSilence.isOn`: an early exit on it before the call in its own function or closure
 * (`guard !AudioSilence.isOn else { return }`, `if AudioSilence.isOn { ...; return }`), or
 * the call in the not-silent branch of an `if` on it. A mention of the flag is not a check.
 * A web view configuration installs the page silencer instead. This test finds every such
 * call in the app's source and fails on one that is not covered; its self-test proves an
 * uncovered call fails it. A file that starts importing an audio framework is listed here
 * first, so a call through an API this list does not name yet is looked at.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** The app's own Swift: every target that ships, never the test targets. */
function appSources(): string[] {
  const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'ios-native'], { cwd: ROOT, encoding: 'utf8' });
  return out.split('\n')
    .filter((f) => f.endsWith('.swift') && !/^ios-native\/Walnut(UI)?Tests\//.test(f) && !/^ios-native\/tests\//.test(f))
    .filter((f) => fs.existsSync(path.join(ROOT, f)))
    .sort();
}

/** `Name(` or `Name.init(`: the ways Swift spells a constructor call. */
const ctor = (...names: string[]) => `\\b(?:${names.join('|')})(?:\\s*\\.init)?\\(`;

/** Every call that can open audio hardware. */
export const OPENERS: Array<[string, RegExp]> = [
  ['recorder', new RegExp(ctor('AVAudioRecorder'), 'g')],
  ['audio player', new RegExp(ctor('AVAudioPlayer'), 'g')],
  ['media player', new RegExp(ctor('AVPlayer', 'AVQueuePlayer'), 'g')],
  // `let p: AVPlayer = .init(url: u)`: the type is named once, before the call.
  ['typed init', /:\s*(?:AVAudioRecorder|AVAudioPlayer|AV(?:Queue)?Player|AVAudioEngine|AVAudioPlayerNode|AVSpeechSynthesizer|AVSpeechUtterance|CHHapticEngine|WKWebView)\s*[?!]?\s*=\s*\.init\(/g],
  ['player view', new RegExp(`${ctor('AVPlayerViewController')}|\\bVideoPlayer\\(\\s*player:`, 'g')],
  ['audio engine', new RegExp(ctor('AVAudioEngine', 'AVAudioPlayerNode'), 'g')],
  ['speech', new RegExp(ctor('AVSpeechSynthesizer', 'AVSpeechUtterance'), 'g')],
  ['haptic engine', new RegExp(ctor('CHHapticEngine'), 'g')],
  ['system sound', /\bAudioServicesPlay\w*Sound\w*\(/g],
  ['input click', /\bplayInputClick\(/g],
  ['audio queue or unit', /\bAudioQueueNew\w*\(|\bAudioComponentInstanceNew\(|\bAudioOutputUnitStart\(/g],
  // Any receiver's, in any file: Swift calls these without importing an audio framework.
  ['session on', /\.setActive\(\s*true/g],
  // `self.play()` is the type's own method, which reaches a player only through a site here.
  ['play', /(?<!\bself\??)\.(?:play|prepareToPlay)\(\)|\.play\(\s*at:|\.playImmediately\(\s*atRate:/g],
  // A bare play() inside an extension is the extended type's: a player's, when it extends one.
  ['bare play', /(?<![.\w]|\bfunc\s+)play\(\)/g],
  ['microphone', /\.default\(for:\s*\.audio\)/g],
  ['photo shutter', /\.capturePhoto\(/g],
  ['alert sound', /\bAlertConfiguration\(|\bUNNotificationSound\b/g],
  ['web view', /\bWKWebViewConfiguration\(\)/g],
  // With no configuration of ours, a web view has no page silencer on it.
  ['web view, default configuration', new RegExp(`${ctor('WKWebView')}\\s*(?:frame:(?:(?!configuration:)[^)])*)?\\)`, 'g')],
];

/** A web view's silencer goes on its configuration once made. */
const WEB_GATE = /\bAudioSilence\.install\(on:/;
const SILENT = 'AudioSilence.isOn';
const NOT_SILENT = '!AudioSilence.isOn';

/**
 * Sites that need no check of their own, each with why, keyed by the file, the declaration
 * holding the call and the call's own text (never by its order, which a new call above it
 * would shift onto another site). A stale entry fails, so the list only names real sites.
 */
const ALLOWED: Record<string, string> = {
  'ios-native/Walnut/Core/SpeechOutput.swift SpeechOutput AVSpeechSynthesizer(':
    'the synthesizer is built once and opens nothing; it speaks only through AVSpeechUtterance in speak(), checked there',
  'ios-native/Walnut/Views/Sessions/SessionMediaView.swift makeUIViewController AVPlayerViewController(':
    'it shows SessionMediaPlayback.player, which while silent holds a picture-only item with no audio track',
  'ios-native/Walnut/Views/Sessions/SessionMediaView.swift pictureOnlyPlayer AVPlayer(':
    'the silent player: it has no item until a picture-only composition (no audio track at all) goes in',
  'ios-native/Walnut/Views/Chat/Camera/LiveCameraSource.swift takePhoto .capturePhoto(':
    'while silent its settings suppress the shutter sound (isShutterSoundSuppressionEnabled, iOS 18) wherever iOS allows it; where the law of the place forbids that, iOS plays it whatever the app asks; the Simulator has no camera (UI tests use FakeCameraSource)',
  'ios-native/Walnut/App/WalnutApp.swift body .setActive(true':
    'TimeHeartbeatReporter.setActive, not the audio session',
};

/** Comments and string contents blanked to spaces, so offsets and lines stay the same. */
export function code(src: string): string {
  const out = src.split('');
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  let i = 0;
  while (i < src.length) {
    if (src.startsWith('//', i)) {
      const end = src.indexOf('\n', i);
      const stop = end < 0 ? src.length : end;
      blank(i, stop);
      i = stop;
    } else if (src.startsWith('/*', i)) {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? src.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (/^#+"/.test(src.slice(i, i + 8))) {
      const hashes = /^#+/.exec(src.slice(i))![0];
      const multi = src.startsWith(`${hashes}"""`, i);
      const close = multi ? `"""${hashes}` : `"${hashes}`;
      const open = hashes.length + (multi ? 3 : 1);
      const end = src.indexOf(close, i + open);
      const stop = end < 0 ? src.length : end + close.length;
      blank(i + open, stop - close.length);
      i = stop;
    } else if (src.startsWith('"""', i)) {
      const end = src.indexOf('"""', i + 3);
      const stop = end < 0 ? src.length : end + 3;
      blank(i + 3, stop - 3);
      i = stop;
    } else if (src[i] === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"' && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      blank(i + 1, j);
      i = j + 1;
    } else {
      i++;
    }
  }
  return out.join('');
}

/** Where every `{` closes. */
function blocks(text: string): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  const open: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') open.push(i);
    else if (text[i] === '}' && open.length) pairs.push([open.pop()!, i]);
  }
  return pairs;
}

const TYPE_HEADER = /(?:^|\s)(?:class|struct|enum|extension|actor|protocol)\s+([\w.]+)[^{}=()]*$/;

/** One file's blocks, and what each `if` and `guard` on the silence does. */
class Source {
  readonly pairs: Array<[number, number]>;
  readonly closeOf = new Map<number, number>();
  /** Statements that leave their block while silent, with where their own body ends. */
  readonly exits: Array<{ at: number; end: number }> = [];
  /** Block openings whose code runs only while not silent. */
  readonly notSilent = new Set<number>();
  /** Condition stretches evaluated only once `!AudioSilence.isOn` held. */
  readonly afterCheck: Array<[number, number]> = [];

  constructor(readonly text: string) {
    this.pairs = blocks(text);
    for (const [o, c] of this.pairs) this.closeOf.set(o, c);
    for (const m of text.matchAll(/\b(if|guard)\b/g)) this.statement(m[1], m.index!, m.index! + m[0].length);
  }

  /** The innermost block holding `at`, by its `{`; -1 at the top of the file. */
  blockOf(at: number): number {
    let best = -1;
    for (const [o, c] of this.pairs) if (o < at && at < c && o > best) best = o;
    return best;
  }

  /** The text before a block's `{`, back to the brace before it. */
  header(o: number): string {
    const t = this.text;
    return t.slice(Math.max(t.lastIndexOf('}', o - 1), t.lastIndexOf('{', o - 1)) + 1, o).trim();
  }

  /** A block's own statements, with every block inside it blanked out. */
  topLevel(o: number): string {
    const c = this.closeOf.get(o)!;
    const out = this.text.slice(o + 1, c).split('');
    for (const [a, b] of this.pairs) if (a > o && b < c) for (let k = a - o - 1; k < b - o; k++) out[k] = ' ';
    return out.join('');
  }

  /** `if` or `guard` at `kw`: its conditions run to the first `{` outside parentheses. */
  private statement(word: string, kw: number, from: number) {
    const t = this.text;
    let depth = 0;
    let open = -1;
    for (let i = from; i < t.length; i++) {
      const ch = t[i];
      if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth--;
      else if (ch === '{' && depth <= 0) { open = i; break; }
      else if (ch === '}') break;
    }
    if (open < 0 || !this.closeOf.has(open)) return;
    let cond = t.slice(from, open);
    if (word === 'guard') cond = cond.replace(/\belse\s*$/, '');
    const parts = splitTop(cond);
    const close = this.closeOf.get(open)!;
    // Anything in the conditions after `!AudioSilence.isOn` runs only when it held.
    const check = parts.find((p) => p.text === NOT_SILENT);
    if (check) this.afterCheck.push([from + check.end, open]);
    const negated = parts.some((p) => p.text === NOT_SILENT);
    if (word === 'guard') {
      if (negated) this.exits.push({ at: kw, end: close });
      return;
    }
    if (negated) this.notSilent.add(open);
    if (parts.length === 1 && parts[0].text === SILENT) {
      if (/\b(?:return|throw|break|continue)\b|\bfatalError\(/.test(this.topLevel(open))) this.exits.push({ at: kw, end: close });
      // Every `else` of `if AudioSilence.isOn` runs only while not silent.
      let at = close + 1;
      for (;;) {
        const rest = /^\s*else\s*(?:if\b)?/.exec(t.slice(at));
        if (!rest) break;
        const next = t.indexOf('{', at + rest[0].length);
        if (next < 0 || !this.closeOf.has(next)) break;
        this.notSilent.add(next);
        at = this.closeOf.get(next)! + 1;
      }
    }
  }
}

/** Conditions split at their top-level commas, each trimmed with its spaces folded. */
function splitTop(cond: string): Array<{ text: string; end: number }> {
  const out: Array<{ text: string; end: number }> = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i <= cond.length; i++) {
    const ch = cond[i];
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    if (i === cond.length || (ch === ',' && depth === 0)) {
      out.push({ text: cond.slice(start, i).replace(/\s+/g, ' ').trim(), end: i });
      start = i + 1;
    }
  }
  return out;
}

export interface Site { file: string; kind: string; decl: string; text: string; line: number; covered: boolean }

/**
 * Every opener in one file, and whether the silence keeps it from running: an early exit
 * before it in a block around it (`guard !AudioSilence.isOn else { ... }`, or
 * `if AudioSilence.isOn { ...; return }`), the not-silent branch of an `if` on it, or a
 * condition after `!AudioSilence.isOn`. A mention of the flag anywhere else covers nothing.
 */
export function sitesIn(file: string, src: string): Site[] {
  const text = code(src);
  const s = new Source(text);
  const sites: Site[] = [];
  for (const [kind, re] of OPENERS) {
    for (const m of text.matchAll(re)) {
      const at = m.index!;
      // Innermost first: the closure or function holding the call, then the ones around it,
      // up to the type, where a check no longer belongs to this call.
      const around: number[] = [];
      let type = '';
      for (const [o] of s.pairs.filter(([o, c]) => o < at && at < c).sort((a, b) => b[0] - a[0])) {
        const t = TYPE_HEADER.exec(` ${s.header(o)}`);
        if (t) { type = `${/\bextension\b/.test(s.header(o)) ? 'extension ' : ''}${t[1]}`; break; }
        around.push(o);
      }
      if (kind === 'bare play' && !type.startsWith('extension ')) continue;
      const inAround = (o: number) => around.includes(o);
      const covered = kind === 'web view'
        ? around.some((o) => WEB_GATE.test(text.slice(o, s.closeOf.get(o))))
        : s.exits.some((g) => g.end < at && inAround(s.blockOf(g.at)))
          || around.some((o) => s.notSilent.has(o))
          || s.afterCheck.some(([a, b]) => a <= at && at < b && (inAround(s.blockOf(a)) || around.length === 0));
      sites.push({ file, kind, decl: declOf(s, around, type, file), text: m[0].replace(/\s+/g, ''), line: text.slice(0, at).split('\n').length, covered });
    }
  }
  return sites;
}

/** The function, initializer or property the call is in, else its type. */
function declOf(s: Source, around: number[], type: string, file: string): string {
  for (const o of around) {
    const h = s.header(o);
    const fn = /\bfunc\s+(\w+)\s*(?:<[^>]*>)?\s*\(/.exec(h) ?? /\b(init)[?!]?\s*(?:<[^>]*>)?\s*\(/.exec(h);
    if (fn && /^\)?\s*(?:(?:async|throws|rethrows)\b\s*)*(?:->[^\n]*)?(?:\bwhere\b[^\n]*)?$/.test(afterParens(h, fn.index + fn[0].length))) return fn[1];
    const v = /\bvar\s+(\w+)\s*:\s*[^\n=]*$/.exec(h);
    if (v) return v[1];
  }
  return type.replace(/^extension /, '') || path.basename(file);
}

/** What follows the parameter list that opens at `from` (just past its `(`). */
function afterParens(h: string, from: number): string {
  let depth = 1;
  for (let i = from; i < h.length; i++) {
    if (h[i] === '(') depth++;
    else if (h[i] === ')' && --depth === 0) return h.slice(i + 1).trim();
  }
  return '(';
}

const key = (s: Site) => `${s.file} ${s.decl} ${s.text}`;
const uncovered = (sites: Site[]) => sites
  .filter((s) => !s.covered && !(key(s) in ALLOWED))
  .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
  .map((s) => `${s.file}:${s.line} (${s.kind})`);

/**
 * Every app file that imports an audio framework, so a new one is looked at for calls
 * through an API OPENERS does not name. Adding a file here means reading it first.
 */
const AUDIO_IMPORTERS = [
  'ios-native/Walnut/Core/AudioSessionHandoff.swift',
  'ios-native/Walnut/Core/AudioSilence.swift',
  'ios-native/Walnut/Core/SilentVoiceTake.swift',
  'ios-native/Walnut/Core/SpeechOutput.swift',
  'ios-native/Walnut/Core/VideoStills.swift',
  'ios-native/Walnut/Core/VoiceRecorder.swift',
  'ios-native/Walnut/Core/VoiceSessionDiagnosis.swift',
  'ios-native/Walnut/Stores/FocusMusicPlayer.swift',
  'ios-native/Walnut/Talk/TalkCue.swift',
  'ios-native/Walnut/Talk/TalkPlayback.swift',
  'ios-native/Walnut/Talk/TalkRecorder.swift',
  'ios-native/Walnut/Talk/TalkSession.swift',
  'ios-native/Walnut/Talk/TalkSetupView.swift',
  'ios-native/Walnut/Views/Chat/Camera/CameraCaptureModel.swift',
  'ios-native/Walnut/Views/Chat/Camera/CameraCaptureView.swift',
  'ios-native/Walnut/Views/Chat/Camera/CameraClipMaker.swift',
  'ios-native/Walnut/Views/Chat/Camera/CameraSource.swift',
  'ios-native/Walnut/Views/Chat/Camera/FakeCameraSource.swift',
  'ios-native/Walnut/Views/Chat/Camera/LiveCameraSource.swift',
  'ios-native/Walnut/Views/Chat/ComposerView.swift',
  'ios-native/Walnut/Views/Sessions/SessionMediaView.swift',
  'ios-native/Walnut/Views/Settings/VoiceHistoryDetailView.swift',
  'ios-native/Walnut/Views/Shared/ReplyPictures.swift',
];
const AUDIO_IMPORT = /^import\s+(?:AVFoundation|AVFAudio|AudioToolbox|AVKit|CoreHaptics|MediaPlayer|CoreAudio|Speech|AVRouting)\b/m;

describe('ratchet: no iOS audio hardware opens while AudioSilence is on', () => {
  const files = appSources();
  const sites = files.flatMap((f) => sitesIn(f, read(f)));

  it('finds the sites it is meant to find', () => {
    // A broken pattern that finds nothing would pass every check below.
    const found = new Set(sites.map((s) => `${s.file} ${s.kind}`));
    for (const known of [
      'ios-native/Walnut/Core/VoiceRecorder.swift recorder',
      'ios-native/Walnut/Core/VoiceRecorder.swift session on',
      'ios-native/Walnut/Core/SpeechOutput.swift speech',
      'ios-native/Walnut/Stores/FocusMusicPlayer.swift media player',
      'ios-native/Walnut/Views/Settings/VoiceHistoryDetailView.swift audio player',
      'ios-native/Walnut/Talk/TalkPlayback.swift play',
      'ios-native/Walnut/Talk/TalkRecorder.swift recorder',
      'ios-native/Walnut/Talk/TalkCue.swift system sound',
      'ios-native/Walnut/Talk/TalkActivity.swift alert sound',
      'ios-native/Walnut/Views/Sessions/SessionMediaView.swift media player',
      'ios-native/Walnut/Views/Chat/Camera/LiveCameraSource.swift microphone',
      'ios-native/Walnut/Views/Inbox/LetterHTMLBody.swift web view',
    ]) expect(found, known).toContain(known);
    expect(sites.length).toBeGreaterThanOrEqual(20);
  });

  it('every site checks AudioSilence.isOn in its own function first', () => {
    expect(uncovered(sites)).toEqual([]);
  });

  it('every allowed site still exists', () => {
    const keys = new Set(sites.map(key));
    expect(Object.keys(ALLOWED).filter((k) => !keys.has(k))).toEqual([]);
  });

  it('the allowed shutter and silent player do what their reasons say', () => {
    const camera = code(read('ios-native/Walnut/Views/Chat/Camera/LiveCameraSource.swift'));
    expect(camera).toMatch(/if AudioSilence\.isOn, photoOutput\.isShutterSoundSuppressionSupported \{\s*settings\.isShutterSoundSuppressionEnabled = true/);
    const media = code(read('ios-native/Walnut/Views/Sessions/SessionMediaView.swift'));
    expect(media).toMatch(/static func pictureOnlyPlayer\(\) -> AVPlayer \{ AVPlayer\(\) \}/);
    expect(media).toMatch(/addMutableTrack\(withMediaType: \.video/);
    expect(media).not.toMatch(/addMutableTrack\(withMediaType: \.audio/);
  });

  it('every file importing an audio framework is listed', () => {
    expect(files.filter((f) => AUDIO_IMPORT.test(read(f)))).toEqual(AUDIO_IMPORTERS);
  });

  it('nothing plays at volume zero instead of not playing', () => {
    // Volume zero still runs the Mac's output; a silent run takes a stand-in path.
    expect(files.filter((f) => /AudioSilence\.volume\(|\.volume\s*=\s*0\b/.test(read(f)))).toEqual([]);
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

  it('a silent take writes its file with no recorder, session or player', () => {
    const take = code(read('ios-native/Walnut/Core/SilentVoiceTake.swift'));
    expect(take).not.toMatch(/AVAudioSession|AVAudioRecorder|AVAudioPlayer|AVAudioEngine|activateSession|\.play\(/);
    expect(take).toMatch(/AVAudioFile\(forWriting:/);
    // The permission is asked first (it is TCC only, no audio hardware), so a denied
    // microphone reads the same in a silent run as on a phone.
    const recorder = code(read('ios-native/Walnut/Core/VoiceRecorder.swift'));
    const start = recorder.slice(recorder.indexOf('func start() async -> Bool'));
    expect(start).toMatch(/guard await Self\.requestPermission\(\) else \{[^}]*\}\s*if AudioSilence\.isOn \{ return beginSilentTake\(\) \}/);
  });
});

describe('self-test: an uncovered site fails the ratchet', () => {
  // On the first line, so the line numbers below stay the fake's own.
  const check = (src: string) => uncovered(sitesIn('Fake.swift', `import AVFoundation; ${src}`));

  it('flags a player, a play and a system sound with no check', () => {
    expect(check(`final class P {
      func go(_ u: URL) {
        let p = try? AVAudioPlayer(contentsOf: u)
        p?.play()
        AudioServicesPlaySystemSound(1519)
      }
    }`)).toEqual(['Fake.swift:3 (audio player)', 'Fake.swift:4 (play)', 'Fake.swift:5 (system sound)']);
  });

  it('passes the same calls behind an if or a guard on AudioSilence.isOn', () => {
    expect(check(`final class P {
      func go(_ u: URL) {
        if AudioSilence.isOn { return }
        let p = try? AVAudioPlayer(contentsOf: u)
        p?.play()
      }
      func cue() {
        guard !AudioSilence.isOn else { return }
        AudioServicesPlaySystemSound(1519)
      }
    }`)).toEqual([]);
  });

  it('a check in another function, after the call, or in a comment or string covers nothing', () => {
    expect(check(`final class P {
      func check() { guard !AudioSilence.isOn else { return } }
      func a() { try? AVAudioSession.sharedInstance().setActive(true) }
      func b() {
        let e = AVAudioEngine()
        if AudioSilence.isOn { return }
      }
      func c() {
        // if AudioSilence.isOn { return }
        let log = "if AudioSilence.isOn"
        AudioServicesPlaySystemSound(1520)
      }
    }`)).toEqual(['Fake.swift:3 (session on)', 'Fake.swift:5 (audio engine)', 'Fake.swift:11 (system sound)']);
  });

  it('a check inside a closure covers the closure, and a stored property is never covered', () => {
    expect(check(`final class P {
      let synth = CHHapticEngine()
      init(activate: @escaping () throws -> Void = {
        guard !AudioSilence.isOn else { return }
        try AVAudioSession.sharedInstance().setActive(true)
      }) {}
      func later() {
        Task {
          if AudioSilence.isOn { return }
          let r = try? AVAudioRecorder(url: u, settings: [:])
        }
      }
    }`)).toEqual(['Fake.swift:2 (haptic engine)']);
  });

  it("a type's own play() is not a site, a player's is", () => {
    expect(check(`final class P {
      func remote() { self?.play(); self.play() }
      func resume() { self.player?.play() }
    }`)).toEqual(['Fake.swift:3 (play)']);
  });

  it('a session switch-on or a play counts in a file with no audio import', () => {
    // Swift reaches AVAudioSession and a player's play() without importing the framework.
    expect(uncovered(sitesIn('Fake.swift', 'final class R {\n  func f() { s.setActive(true); p.play() }\n}'))).toEqual([
      'Fake.swift:2 (session on)', 'Fake.swift:2 (play)']);
  });

  it('a mention of the flag that does not stop the call covers nothing', () => {
    expect(check(`final class P {
      func silentBranch() {
        if AudioSilence.isOn { AudioServicesPlaySystemSound(1) }
      }
      func wrongWay() {
        guard AudioSilence.isOn else { return }
        AudioServicesPlaySystemSound(2)
      }
      func either() {
        if x || AudioSilence.isOn { return }
        AudioServicesPlaySystemSound(3)
      }
      func noExit() {
        if AudioSilence.isOn { print() }
        AudioServicesPlaySystemSound(4)
      }
      func elsewhere() {
        if ready { guard !AudioSilence.isOn else { return } }
        AudioServicesPlaySystemSound(5)
      }
    }`)).toEqual(['Fake.swift:3 (system sound)', 'Fake.swift:7 (system sound)', 'Fake.swift:11 (system sound)',
      'Fake.swift:15 (system sound)', 'Fake.swift:19 (system sound)']);
  });

  it('the not-silent branch of an if on the flag is covered, and a condition after the check', () => {
    expect(check(`final class P {
      func a() {
        if AudioSilence.isOn { stand() } else { AudioServicesPlaySystemSound(1) }
      }
      func b() {
        if !AudioSilence.isOn { AudioServicesPlaySystemSound(2) }
      }
      func c() {
        if sound, !AudioSilence.isOn, let mic = AVCaptureDevice.default(for: .audio) { use(mic) }
        if sound, let mic = AVCaptureDevice.default(for: .audio), !AudioSilence.isOn { use(mic) }
      }
      func d() {
        guard !AudioSilence.isOn else { stand(); return }
        Task { try AVAudioSession.sharedInstance().setActive(true) }
      }
    }`)).toEqual(['Fake.swift:10 (microphone)']);
  });

  it('finds the other spellings of an opener', () => {
    expect(check(`final class P {
      func a(u: URL) {
        let p = AVPlayer.init(url: u)
        let q: AVPlayer = .init(url: u)
        let v = VideoPlayer(player: p)
        p.playImmediately(atRate: 1)
        node.play(at: nil)
        UIDevice.current.playInputClick()
        let w = WKWebView(frame: .zero)
        let x = WKWebView()
      }
    }
    extension AVAudioPlayer { func go() { play() } }
    final class Q { func play() {} ; func again() { play() } }`)).toEqual([
      'Fake.swift:3 (media player)', 'Fake.swift:4 (typed init)', 'Fake.swift:5 (player view)', 'Fake.swift:6 (play)',
      'Fake.swift:7 (play)', 'Fake.swift:8 (input click)', 'Fake.swift:9 (web view, default configuration)',
      'Fake.swift:10 (web view, default configuration)', 'Fake.swift:13 (bare play)']);
  });

  it('an allowed site is the one it names, wherever it moves in its declaration', () => {
    const sites = sitesIn('Fake.swift', 'final class R {\n  func f() { x.setActive(true) }\n  func g() { y.setActive(true) }\n}');
    expect(sites.map(key)).toEqual(['Fake.swift f .setActive(true', 'Fake.swift g .setActive(true']);
  });

  it('a web view configuration needs the page silencer', () => {
    expect(check(`struct V {
      func make() -> WKWebView { let c = WKWebViewConfiguration(); return WKWebView(frame: .zero, configuration: c) }
      func good() -> WKWebView { let c = WKWebViewConfiguration(); AudioSilence.install(on: c); return WKWebView(frame: .zero, configuration: c) }
    }`)).toEqual(['Fake.swift:2 (web view)']);
  });
});
