/**
 * A video of one app's own window, for the desktop end-to-end runs
 * (scripts/desktop-update-e2e.mjs --video). It never films the screen. An app
 * that has WALNUT_DESKTOP_E2E_SNAPSHOTS writes its console page's own pixels
 * into `dir` itself (`snapshots: true`; WebKit draws them, so a covered window
 * and a locked Mac are filmed too). For an older app each frame is
 * `screencapture -l <window>`, the window's own pixels, found by the process
 * whose executable is `exe` (an exact path, never a pattern) on every frame;
 * that needs the Screen Recording permission and an unlocked session, and gives
 * no frames otherwise. Either way the app quitting and the updated app opening
 * are one video: frames are <epoch ms>.png.
 *
 *   const rec = startAppWindowVideo({ exe, dir, snapshots })
 *   ...
 *   const mp4 = await rec.stop(out)                 // ffmpeg, or null without it
 */
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const WINDOW_LIST = `
import CoreGraphics
import Foundation
let pids = Set(CommandLine.arguments.dropFirst().compactMap { Int32($0) })
let list = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] ?? []
for w in list {
  guard let pid = w[kCGWindowOwnerPID as String] as? Int32, pids.contains(pid),
        (w[kCGWindowLayer as String] as? Int) == 0,
        let id = w[kCGWindowNumber as String] as? Int,
        let b = w[kCGWindowBounds as String] as? [String: Any],
        let width = b["Width"] as? Double, width > 400 else { continue }
  print(id)
}
`

/** The pids whose executable is exactly `exe`. */
function pidsOf(exe) {
  try {
    return execFileSync('/bin/ps', ['-axww', '-o', 'pid=,comm='], { encoding: 'utf8' }).split('\n')
      .map((row) => row.match(/^\s*(\d+)\s+(.*\S)\s*$/))
      .filter((m) => m && m[2] === exe)
      .map((m) => m[1])
  } catch { return [] }
}

/** Whether the app at `binary` writes its own frames (WALNUT_DESKTOP_E2E_SNAPSHOTS). */
export function writesOwnSnapshots(binary) {
  try { return fs.readFileSync(binary).includes('WALNUT_DESKTOP_E2E_SNAPSHOTS') } catch { return false }
}

export function startAppWindowVideo({ exe, dir, snapshots = false, everyMs = 1000 }) {
  fs.mkdirSync(dir, { recursive: true })
  const frames = () => fs.readdirSync(dir).filter((f) => /^\d+\.png$/.test(f)).length
  let stopped = false
  const tool = path.join(path.dirname(dir), 'window-list')
  if (!snapshots) execFileSync('/usr/bin/xcrun', ['swiftc', '-O', '-o', tool, '-'], { input: WINDOW_LIST, stdio: ['pipe', 'ignore', 'inherit'] })
  const tick = () => {
    if (stopped || snapshots) return
    const pids = pidsOf(exe)
    if (pids.length) {
      const ids = spawnSync(tool, pids, { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean)
      if (ids[0]) {
        // -x no sound, -o no shadow; -l one window, wherever it is in the stack.
        spawnSync('/usr/sbin/screencapture', ['-x', '-o', '-l', ids[0], path.join(dir, `${Date.now()}.png`)])
      }
    }
    setTimeout(tick, everyMs)
  }
  tick()
  return {
    frames,
    async stop(out) {
      stopped = true
      if (!frames()) return null
      const ffmpeg = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'].find((p) => fs.existsSync(p))
      if (!ffmpeg) return null
      // About a frame a second: one second of the run is a quarter second of video, 1280 wide.
      const r = spawnSync(ffmpeg, ['-y', '-loglevel', 'error', '-framerate', String(4000 / everyMs), '-pattern_type', 'glob', '-i', path.join(dir, '*.png'),
        '-vf', 'scale=1280:-2', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', out], { encoding: 'utf8' })
      if (r.status !== 0) throw new Error(`ffmpeg: ${r.stderr}`)
      return out
    },
  }
}
