/**
 * Whether this Mac's screen is shared or recorded right now, for the browser on this machine:
 * while it is, the extension keeps Walnut's agent window minimized, so an agent's pages never show
 * in a share (2026-11-17, the user: "sometimes I'm screen sharing and it suddenly grabs me and
 * does something very sensitive ... my screen share is usually by application"). Sharing Chrome
 * as an application shares every Chrome window that is on screen, the agent window behind theirs
 * included; a minimized window is not drawn, so it is in no share.
 *
 * How it is known: macOS's own "screen watcher" flag (CoreGraphics' CGSIsScreenWatcherPresent),
 * the one the system's "while sharing the screen" behavior reads. It is set by any app that
 * captures the screen, a window or an app (meeting apps, a browser's screen share, a recorder),
 * and needs no permission. Read by one long-running `osascript -l JavaScript` (present on every
 * Mac, no compiler), which prints one line on each change and one a minute. It ends with the server:
 * each check it compares its parent pid with the server's (its argument), and leaves when the
 * server that spawned it is gone (2026-11-24: a closed pipe did not end it, JXA's console.log ignores the
 * failed write, and 67 readers of servers long gone held about 0.8 GB). The server also stops it
 * when it exits. Off the Mac, without the experiment, or while Walnut runs its tests, nothing
 * starts and nothing is ever shared.
 *
 * Only the extension in a browser on this machine hears it (the poll route, browser-v1.ts): a
 * browser elsewhere shares another screen.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { experimentalEnabled } from '../experimental.js'
import { getConfig } from '../config-manager.js'
import { nativeHelpersAllowed } from '../helper-build.js'
import { log } from '../../logging/index.js'

export const SHARE_EXPERIMENT = 'agent_window_hides_while_sharing' as const
/** How often the flag is read, in seconds (osascript's delay). */
export const SHARE_CHECK_S = 2
/** A heartbeat line every this many checks, so the server sees a reader that still runs. */
const BEAT_EVERY = 30

/**
 * The reader: CoreGraphics' screen-watcher flag, one line per change (JXA's console.log goes to
 * stderr). Its argument is the server's pid: it leaves when its parent is no longer that server
 * (the server ended and launchd took the reader), and never starts for a server already gone.
 */
export const SHARE_SCRIPT = `ObjC.import('CoreGraphics')
ObjC.bindFunction('CGSIsScreenWatcherPresent', ['bool', []])
ObjC.bindFunction('getppid', ['int', []])
function run(argv) {
  var parent = Number(argv[0]), last = null, beat = 0
  while ($.getppid() === parent) {
    var s = !!$.CGSIsScreenWatcherPresent()
    if (s !== last || ++beat >= ${BEAT_EVERY}) { console.log(s ? 'shared' : 'clear'); last = s; beat = 0 }
    delay(${SHARE_CHECK_S})
  }
}`

const state = { shared: false, child: undefined as ChildProcess | undefined, restartAt: 0, wakers: new Set<() => void>() }

/** Whether the screen is shared now (false when nothing reads it). */
export function screenShared(): boolean { return state.shared }

/** Called on every change (the poll route wakes the local extension's waiting poll). */
export function onScreenShareChange(fn: () => void): () => void {
  state.wakers.add(fn)
  return () => state.wakers.delete(fn)
}

/** A line of the reader: the state it says, or none for anything else. */
export function parseShareLine(line: string): boolean | undefined {
  const s = line.trim()
  return s === 'shared' ? true : s === 'clear' ? false : undefined
}

function set(shared: boolean): void {
  if (shared === state.shared) return
  state.shared = shared
  log.web.info('screen share changed', { shared })
  for (const fn of state.wakers) { try { fn() } catch { /* one waker never stops the others */ } }
}

/** Whether a reader may run here at all: the Mac, and a real home (helper-build.ts: never a test's or an ephemeral server's). */
export function shareWatchAllowed(platform: string = process.platform, helpers: () => boolean = nativeHelpersAllowed): boolean {
  return platform === 'darwin' && helpers()
}

/** The experiment went off: the reader ends, and nothing is shared. */
function stopReader(): void {
  const c = state.child
  state.child = undefined
  c?.kill()
  set(false)
}

/** Start the reader once (again after it ended, at most once a minute). */
function ensureReader(): void {
  if (state.child || Date.now() < state.restartAt) return
  state.restartAt = Date.now() + 60_000
  let child: ChildProcess
  try {
    child = spawn('/usr/bin/osascript', ['-l', 'JavaScript', '-e', SHARE_SCRIPT, String(process.pid)], { stdio: ['ignore', 'ignore', 'pipe'] })
  } catch { return }
  state.child = child
  let buf = ''
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (d: string) => {
    buf += d
    let i: number
    while ((i = buf.indexOf('\n')) >= 0) {
      const v = parseShareLine(buf.slice(0, i))
      buf = buf.slice(i + 1)
      if (v !== undefined) set(v)
    }
    if (buf.length > 4096) buf = ''
  })
  const done = (code?: number | null) => {
    if (state.child !== child) return
    state.child = undefined
    set(false)
    // A Mac where the flag cannot be read (osascript failed): said once a minute at most, by the restart's pace.
    if (code) log.web.warn('screen share reader ended', { code })
  }
  child.on('error', () => done(-1))
  child.on('exit', (code) => done(code))
  child.unref()
  stopOnServerExit()
}

let exitHooked = false
/** The server stops its reader when it exits (the reader's own parent check covers a kill). */
function stopOnServerExit(): void {
  if (exitHooked) return
  exitHooked = true
  process.once('exit', () => { try { state.child?.kill() } catch { /* already gone */ } })
}

/**
 * The share state for a poll of the extension: undefined (say nothing) for a browser on another
 * machine, off the Mac, or with the experiment off; else whether the screen is shared now.
 */
export async function shareStateForPoll(local: boolean): Promise<boolean | undefined> {
  if (!local || !shareWatchAllowed()) return undefined
  const on = experimentalEnabled((await getConfig().catch(() => undefined))?.experimental, SHARE_EXPERIMENT)
  if (!on) { stopReader(); return undefined }
  ensureReader()
  return state.shared
}

export function _setScreenSharedForTesting(shared: boolean): void { set(shared) }
export function _resetScreenShareForTesting(): void {
  state.child?.kill()
  state.child = undefined
  state.shared = false
  state.restartAt = 0
  state.wakers.clear()
}
