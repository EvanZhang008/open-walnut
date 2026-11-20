/**
 * The Mac's "Now Playing" media, read and paused for voice input (media-hold.ts).
 *
 * macOS keeps one Now Playing app: Spotify, Music, a browser tab playing a video, Walnut's
 * own window playing Rhythm's focus music. The system's MediaRemote framework knows it and
 * can send it Play and Pause, whatever app it is. Since macOS 15.4 only Apple's own
 * binaries may read it, so the script runs in `osascript` (JavaScript for Automation),
 * which is one: no helper to install, no permission prompt, no Apple Events to the app.
 *
 * The script never toggles. Pause is sent only to an app that plays now, and Play only to
 * the same app (bundle and process) that Walnut paused and that is still paused. Only when
 * the system refused the command do Spotify and Music get their own scripting command as a
 * second try (as Walnut's Rhythm plugin drives Spotify): that one is an Apple Event, and
 * the first time macOS asks whether Walnut may control the app.
 *
 * Off the Mac, and on an isolated server (tests, ephemeral copies), there is no
 * controller at all: such a server must never touch the music of the Mac it runs on.
 */
import { execFile } from 'node:child_process'

/** The app Walnut paused. bundle + pid name it exactly; name is for people. */
export interface PausedPlayer {
  bundle: string
  pid: number
  name: string
  pausedAt: number
}

export interface NowPlaying {
  playing: boolean
  bundle: string
  pid: number
  name: string
}

export interface MediaController {
  /** What plays now, or null when it could not be read. */
  read(): Promise<NowPlaying | null>
  /** Pause the Now Playing app if it plays. paused: null when nothing played. */
  pauseNowPlaying(): Promise<{ paused: Omit<PausedPlayer, 'pausedAt'> | null; error?: string }>
  /** Play this app again, only while it is still Now Playing and paused. */
  resume(player: PausedPlayer): Promise<{ resumed: boolean; reason?: string }>
}

const SCRIPT_TIMEOUT_MS = 6_000

/**
 * JavaScript for Automation. argv: action ("read" | "pause" | "play"), then for play the
 * bundle and pid to resume. Prints one JSON line. MediaRemote commands: 0 Play, 1 Pause
 * (MRMediaRemoteCopyCommandDescription names them so on macOS 26).
 */
export const MEDIA_REMOTE_JXA = String.raw`
function run(argv) {
  ObjC.import('Foundation');
  var action = argv[0] || 'read';
  var bundle = $.NSBundle.bundleWithPath('/System/Library/PrivateFrameworks/MediaRemote.framework/');
  if (!bundle.load) return JSON.stringify({ ok: false, error: 'MediaRemote did not load' });
  var R = $.NSClassFromString('MRNowPlayingRequest');
  if (R.isNil()) return JSON.stringify({ ok: false, error: 'this macOS has no MRNowPlayingRequest' });
  function now() {
    var out = { playing: R.localIsPlaying === true, bundle: '', pid: 0, name: '' };
    try {
      var c = R.localNowPlayingPlayerPath.client;
      out.bundle = ObjC.unwrap(c.bundleIdentifier) || '';
      out.pid = Number(c.processIdentifier) || 0;
      out.name = ObjC.unwrap(c.displayName) || '';
    } catch (e) {}
    return out;
  }
  function send(cmd) {
    ObjC.bindFunction('MRMediaRemoteSendCommand', ['bool', ['int', 'id']]);
    return $.MRMediaRemoteSendCommand(cmd, $()) === true;
  }
  function settle(wantPlaying) {
    for (var i = 0; i < 8; i++) {
      if ((R.localIsPlaying === true) === wantPlaying) return true;
      delay(0.1);
    }
    return false;
  }
  function byScript(id, verb) {
    if (id !== 'com.spotify.client' && id !== 'com.apple.Music') return false;
    try { var app = Application(id); if (verb === 'pause') app.pause(); else app.play(); return true; } catch (e) { return false; }
  }
  var before = now();
  if (action === 'read') return JSON.stringify({ ok: true, now: before });
  if (action === 'pause') {
    if (!before.playing) return JSON.stringify({ ok: true, now: before, paused: false });
    var sent = send(1);
    var quiet = settle(false);
    if (!quiet && !sent && byScript(before.bundle, 'pause')) quiet = settle(false);
    // A command the system took counts even when the state read lags: the resume checks again.
    return JSON.stringify({ ok: true, now: before, paused: quiet || sent, verified: quiet });
  }
  if (action === 'play') {
    var wantBundle = argv[1] || '';
    var wantPid = Number(argv[2] || 0);
    if (before.playing) return JSON.stringify({ ok: true, now: before, resumed: false, reason: 'playing' });
    if (before.bundle !== wantBundle || before.pid !== wantPid) return JSON.stringify({ ok: true, now: before, resumed: false, reason: 'other-app' });
    var played = send(0);
    var on = settle(true);
    if (!on && !played && byScript(wantBundle, 'play')) on = settle(true);
    return JSON.stringify({ ok: true, now: before, resumed: on || played, verified: on });
  }
  return JSON.stringify({ ok: false, error: 'unknown action ' + action });
}
`

export type ScriptRunner = (args: string[]) => Promise<string>

/** Runs the script in osascript, off the event loop, with a deadline. */
function osascriptRunner(): ScriptRunner {
  return (args) => new Promise((resolve, reject) => {
    execFile('osascript', ['-l', 'JavaScript', '-e', MEDIA_REMOTE_JXA, ...args], { timeout: SCRIPT_TIMEOUT_MS }, (error, stdout, stderr) => {
      if (error) reject(new Error((stderr || error.message).trim().slice(0, 300)))
      else resolve(stdout)
    })
  })
}

function parse(out: string): Record<string, unknown> {
  const line = out.trim().split('\n').pop() ?? ''
  const parsed = JSON.parse(line) as Record<string, unknown>
  if (parsed.ok !== true) throw new Error(typeof parsed.error === 'string' ? parsed.error : 'the media script failed')
  return parsed
}

function nowOf(value: unknown): NowPlaying {
  const v = (value ?? {}) as Partial<NowPlaying>
  return { playing: v.playing === true, bundle: String(v.bundle ?? ''), pid: Number(v.pid) || 0, name: String(v.name ?? '') }
}

/** The controller over MediaRemote; `run` is replaceable for tests. */
export function mediaRemoteController(run: ScriptRunner = osascriptRunner()): MediaController {
  return {
    async read() {
      try { return nowOf(parse(await run(['read'])).now) } catch { return null }
    },
    async pauseNowPlaying() {
      try {
        const out = parse(await run(['pause']))
        const before = nowOf(out.now)
        if (!before.playing) return { paused: null }
        if (out.paused !== true) return { paused: null, error: `${before.name || before.bundle || 'The player'} did not pause` }
        return { paused: { bundle: before.bundle, pid: before.pid, name: before.name } }
      } catch (error) {
        return { paused: null, error: error instanceof Error ? error.message : String(error) }
      }
    },
    async resume(player) {
      try {
        const out = parse(await run(['play', player.bundle, String(player.pid)]))
        return out.resumed === true ? { resumed: true } : { resumed: false, reason: String(out.reason ?? 'not-resumed') }
      } catch (error) {
        return { resumed: false, reason: error instanceof Error ? error.message : String(error) }
      }
    },
  }
}
