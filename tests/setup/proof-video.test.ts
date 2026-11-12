/**
 * Proof videos (PW_VIDEO=1) are sharp: recorded at the size of the engine's frames
 * (tests/e2e/browser/pw-video.ts), encoded to H.264 at CRF 18 (scripts/proof-video.mjs), and
 * checked. On 2026-11-12 every proof clip was Playwright's default, 800x450 at about
 * 60 kbit/s, because the main config gave no size, and about forty specs and configs each fixed
 * their own in CSS pixels.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fitVideo, MAX_LONG_SIDE, SIZED, sizeServerContexts, videoSize, type ContextOptionsLike } from '../e2e/browser/pw-video'
import { unencoded } from '../e2e/browser/pw-video-reporter'
import { POINTER_OVERLAY_JS } from '../e2e/browser/pointer-overlay'
import { encodeArgs, judgeVideo, mp4PathFor, parseProbe, parseX264Settings } from '../../scripts/proof-video.mjs'

const ROOT = path.resolve(__dirname, '../..')
const require = createRequire(import.meta.url)
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const tracked = () => execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n').filter((f) => f && fs.existsSync(path.join(ROOT, f)))

/** ffprobe -print_format json -show_format -show_streams, cut to the fields the check reads. */
const probe = (w: number, h: number, bitRate: number, duration = 18.56) => JSON.stringify({
  streams: [{ codec_type: 'video', codec_name: 'h264', width: w, height: h, avg_frame_rate: '25/1' }],
  format: { duration: String(duration), bit_rate: String(bitRate), size: String(Math.round((bitRate * duration) / 8)) },
})

describe('the video size of a recording context', () => {
  const rec = () => ({ dir: '/tmp/v' })

  it('WebKit records its device pixels, Chromium its CSS pixels (its headless screencast sends no more)', () => {
    const page = (): ContextOptionsLike => ({ recordVideo: rec(), viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 })
    const webkit = page()
    fitVideo('webkit', webkit)
    expect(webkit.recordVideo!.size).toEqual({ width: 2560, height: 1440 })
    const chromium = page()
    fitVideo('chromium', chromium)
    expect(chromium.recordVideo!.size).toEqual({ width: 1280, height: 720 })
    expect(videoSize('firefox', page())).toEqual({ width: 1280, height: 720 })
  })

  it('never changes the device scale a spec or project chose', () => {
    const one: ContextOptionsLike = { recordVideo: rec(), viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 }
    fitVideo('webkit', one)
    expect(one.deviceScaleFactor).toBe(1)
    expect(one.recordVideo!.size).toEqual({ width: 1280, height: 800 })
    const phone: ContextOptionsLike = { recordVideo: rec(), viewport: { width: 393, height: 852 }, deviceScaleFactor: 3 }
    fitVideo('webkit', phone)
    expect(phone.deviceScaleFactor).toBe(3)
    expect(phone.recordVideo!.size).toEqual({ width: 786, height: 1704 })
  })

  it('leaves a context with no viewport at Playwright\'s own default, and takes Playwright\'s viewport when none is named', () => {
    const none: ContextOptionsLike = { recordVideo: rec(), noDefaultViewport: true, deviceScaleFactor: 2 }
    fitVideo('webkit', none)
    expect(none.recordVideo).toEqual({ dir: '/tmp/v' })
    expect(videoSize('webkit', { deviceScaleFactor: 2 })).toEqual({ width: 2560, height: 1440 })
  })

  it('caps the scale at 2 and the long side at 2560, and rounds to even sizes', () => {
    expect(videoSize('webkit', { viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2 })).toEqual({ width: 2560, height: 1440 })
    expect(videoSize('chromium', { viewport: { width: 3000, height: 1000 }, deviceScaleFactor: 1 })).toEqual({ width: 2560, height: 852 })
    expect(Math.max(...Object.values(videoSize('webkit', { viewport: { width: 1700, height: 900 }, deviceScaleFactor: 2 })!))).toBeLessThanOrEqual(MAX_LONG_SIDE)
    expect(videoSize('chromium', { viewport: { width: 1281, height: 801 }, deviceScaleFactor: 1 })).toEqual({ width: 1280, height: 800 })
  })

  it('keeps a size the caller gave, and leaves a context that records nothing alone', () => {
    const given: ContextOptionsLike = { recordVideo: { dir: '/tmp/v', size: { width: 640, height: 480 } }, viewport: { width: 1280, height: 800 } }
    fitVideo('webkit', given)
    expect(given.recordVideo!.size).toEqual({ width: 640, height: 480 })
    const plain: ContextOptionsLike = { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 }
    fitVideo('webkit', plain)
    expect(plain).toEqual({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })
  })

  it('sizes every context Playwright\'s server makes, once, by its engine', async () => {
    // The installed Playwright still has the server method pw-video wraps (an upgrade that moves it fails here).
    const root = path.dirname(require.resolve('playwright-core/package.json'))
    const { Browser } = require(path.join(root, 'lib/server/browser.js'))
    expect(typeof Browser.prototype.newContext).toBe('function')
    expect(Browser.prototype[SIZED]).toBe(true)
    // The wrapper itself, on a stand-in prototype.
    const seen: ContextOptionsLike[] = []
    const proto: Record<string | symbol, unknown> = { newContext: async (_p: unknown, o: ContextOptionsLike) => { seen.push(o) } }
    expect(sizeServerContexts(proto)).toBe(true)
    expect(sizeServerContexts(proto)).toBe(true)
    const call = proto.newContext as (this: unknown, p: unknown, o: ContextOptionsLike) => Promise<void>
    await call.call({ options: { name: 'webkit' } }, null, { recordVideo: rec(), viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 })
    expect(seen[0].recordVideo!.size).toEqual({ width: 2560, height: 1600 })
    expect(sizeServerContexts(undefined)).toBe(false)
  })
})

describe('the MP4 reporter', () => {
  it('finds the .webm files of this run that have no .mp4 (a spec\'s own recordVideo context)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-video-rep-'))
    try {
      const put = (rel: string, mtime?: number) => {
        const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'x')
        if (mtime) fs.utimesSync(f, mtime / 1000, mtime / 1000)
        return f
      }
      const since = Date.now() - 60_000
      const own = put('t1/phone/abc.webm')
      put('t2/video.webm'); put('t2/video.mp4')
      put('t3/old.webm', since - 3_600_000)
      expect(unencoded([dir, path.join(dir, 'missing')], since)).toEqual([own])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('the proof video check', () => {
  it('fails the clip of the report: 800x450, x264 CRF 23, 64 kbit/s', () => {
    const problems = judgeVideo(parseProbe(probe(800, 450, 63_878)), { rc: 'crf', crf: 23 })
    expect(problems).toHaveLength(2)
    expect(problems[0]).toMatch(/800x450: the long side is under 1280 px/)
    expect(problems[1]).toMatch(/CRF 23/)
  })

  it('passes a sharp clip of a page that sits still, whatever its bitrate', () => {
    expect(judgeVideo(parseProbe(probe(2560, 1440, 109_000)), { rc: 'crf', crf: 18 })).toEqual([])
    // A portrait phone clip: its long side counts.
    expect(judgeVideo(parseProbe(probe(786, 1704, 300_000)), { rc: 'crf', crf: 18 })).toEqual([])
  })

  it('fails an x264 clip encoded to a bitrate, and a clip of another encoder under 1 Mbit/s', () => {
    expect(judgeVideo(parseProbe(probe(1280, 800, 400_000)), { rc: 'abr', crf: null })[0]).toMatch(/not a CRF encode/)
    expect(judgeVideo(parseProbe(probe(1280, 800, 400_000)), null)[0]).toMatch(/400 kbit\/s from an encoder other than x264/)
    expect(judgeVideo(parseProbe(probe(1280, 800, 2_000_000)), null)).toEqual([])
    expect(judgeVideo(parseProbe(JSON.stringify({ streams: [{ codec_type: 'audio' }], format: {} })))).toEqual(['no video stream'])
  })

  it('reads the rate control x264 writes into the stream', () => {
    const sei = 'junk\u0000x264 - core 164 r3108 31e19f9 - H.264/MPEG-4 AVC codec - options: cabac=1 ref=3 rc_lookahead=40 rc=crf mbtree=1 crf=18.0 qcomp=0.60'
    expect(parseX264Settings(sei)).toEqual({ rc: 'crf', crf: 18 })
    expect(parseX264Settings('no encoder string')).toBeNull()
  })

  it('takes the bitrate from size and duration when ffprobe gives none', () => {
    const info = parseProbe({ streams: [{ codec_type: 'video', codec_name: 'h264', width: 1280, height: 720, r_frame_rate: '30/1' }], format: { duration: '10', size: '1250000' } })
    expect(info).toMatchObject({ width: 1280, height: 720, fps: 30, bitrate: 1_000_000 })
  })

  it('encodes H.264 at CRF 18, yuv420p, index first, next to the .webm, without scaling', () => {
    const args = encodeArgs('/r/video.webm', '/r/video.mp4')
    expect(args.join(' ')).toContain('-c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p -movflags +faststart /r/video.mp4')
    expect(args).not.toContain('-vf')
    expect(mp4PathFor('/r/t/video-1.webm')).toBe('/r/t/video-1.mp4')
  })

  const ffmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0 && spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status === 0
  it.skipIf(!ffmpeg)('the CLI encodes a .webm and checks real files (ffmpeg on PATH)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-video-'))
    try {
      const gen = (args: string[]) => execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', ...args], { stdio: 'pipe' })
      gen(['-i', 'testsrc2=size=1280x720:rate=25:duration=1', '-c:v', 'libvpx', '-b:v', '1M', path.join(dir, 'video.webm')])
      gen(['-i', 'testsrc2=size=800x450:rate=25:duration=1', '-c:v', 'libx264', '-crf', '23', '-pix_fmt', 'yuv420p', path.join(dir, 'small.mp4')])
      const cli = (...a: string[]) => spawnSync(process.execPath, [path.join(ROOT, 'scripts/proof-video.mjs'), ...a], { encoding: 'utf8' })
      expect(cli('encode', dir).status).toBe(0)
      expect(fs.existsSync(path.join(dir, 'video.mp4'))).toBe(true)
      const check = cli('check', dir)
      expect(check.status).toBe(1)
      expect(check.stdout).toMatch(/LOW .*small\.mp4: 800x450 .*crf 23/)
      expect(check.stdout).toMatch(/ok .*video\.mp4: 1280x720 h264 crf 18 25 fps/)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('the pointer drawn in proof videos', () => {
  it('takes no events, no layout and no selector of the page', () => {
    expect(POINTER_OVERLAY_JS).toContain("attachShadow({ mode: 'closed' })")
    expect(POINTER_OVERLAY_JS).toContain('pointer-events:none')
    expect(POINTER_OVERLAY_JS).toContain('position:fixed')
    expect(POINTER_OVERLAY_JS).toContain('z-index:2147483647')
    expect(POINTER_OVERLAY_JS).toContain("setAttribute('aria-hidden', 'true')")
    expect(POINTER_OVERLAY_JS).toContain('document.documentElement.appendChild(host)')
    expect(POINTER_OVERLAY_JS).toContain('passive: true')
    // Nothing that blocks an event, and no timer a page clock would run.
    expect(POINTER_OVERLAY_JS).not.toMatch(/preventDefault|stopPropagation|stopImmediatePropagation|setTimeout|setInterval/)
  })
})

/**
 * Each `video:` / `recordVideo:` value that names a size, and each legacy `videosPath` /
 * `videoSize` option. A value runs to the comma or closing bracket at its own depth, so a
 * template literal's `${...}`, a nested object or a ternary is read whole.
 */
function fixedVideoSizes(src: string): string[] {
  const out: string[] = []
  for (const m of src.matchAll(/\b(videosPath|videoSize)\s*:/g)) out.push(m[1])
  for (const m of src.matchAll(/\b(recordVideo|video)\s*:/g)) {
    // Open brackets, template literals (`) and their ${ holes, innermost last.
    const stack: string[] = []
    let i = m.index! + m[0].length
    for (; i < src.length; i++) {
      const c = src[i]
      if (stack.at(-1) === '`') {
        if (c === '\\') i++
        else if (c === '`') stack.pop()
        else if (c === '$' && src[i + 1] === '{') { stack.push('${'); i++ }
        continue
      }
      if (c === "'" || c === '"') {
        for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++
      } else if (c === '`') stack.push('`')
      else if ('{[('.includes(c)) stack.push(c)
      else if ('}])'.includes(c)) { if (!stack.length) break; stack.pop() }
      else if ((c === ',' || c === ';' || c === '\n') && !stack.length) break
    }
    const value = src.slice(m.index! + m[0].length, i)
    if (/\bsize\s*:/.test(value)) out.push(`${m[1]}:${value.slice(0, 80)}`)
  }
  return out
}

describe('ratchet: every recording goes through pw-video', () => {
  const configs = () => tracked().filter((f) => /\.config\.ts$/.test(f) && !/node_modules|^web\/|^vitest|^tsup|^site\//.test(f))
    .filter((f) => /defineConfig\(/.test(read(f)) && /@playwright\/test/.test(read(f)))

  it('every Playwright config loads it, so a context that records anywhere is sized', () => {
    const all = configs()
    expect(all.length).toBeGreaterThanOrEqual(8)
    expect(all.filter((f) => !/^import (?:\{[^}]*\} from )?'[./\w-]*pw-video\.js'/m.test(read(f)))).toEqual([])
  })

  it('every config that sets a video takes VIDEO_USE and the MP4 reporter', () => {
    const recording = configs().filter((f) => /\bvideo:/.test(read(f)))
    expect(recording.length).toBeGreaterThanOrEqual(4)
    for (const f of recording) {
      expect(read(f), f).toMatch(/from '[./\w-]*pw-video\.js'/)
      expect(read(f), f).toMatch(/video: VIDEO_USE/)
      expect(read(f), f).toMatch(/reporter: withVideoReporter\(/)
    }
  })

  it('no spec, demo or config fixes a video size of its own (the viewport decides it)', () => {
    const files = tracked().filter((f) => (/^tests\/e2e\/browser\/.*\.ts$/.test(f) || /^scripts\/demos\/.*\.ts$/.test(f)) && f !== 'tests/e2e/browser/pw-video.ts')
    const fixed = files.flatMap((f) => fixedVideoSizes(read(f)).map((v) => `${f}: ${v}`))
    expect(fixed).toEqual([])
  })

  it('the size finder reads whole expressions (template literals, nested objects, ternaries)', () => {
    expect(fixedVideoSizes("recordVideo: { dir: `${SHOTS}/${test.info().project.name}-demo`, size: { width: 1280, height: 900 } },")).toHaveLength(1)
    expect(fixedVideoSizes("test.use({ video: process.env.X ? { mode: 'on', size: { width: 1, height: 1 } } : 'off', viewport: { width: 1, height: 1 } })")).toHaveLength(1)
    expect(fixedVideoSizes("browser.newContext({ videosPath: dir })")).toHaveLength(1)
    expect(fixedVideoSizes("browser.newContext({ videoSize: { width: 1, height: 1 } })")).toHaveLength(1)
    expect(fixedVideoSizes("test.use({ video: 'on', viewport: { width: 1280, height: 800 }, screen: { size: 1 } })")).toEqual([])
    expect(fixedVideoSizes("recordVideo: { dir: `${SHOTS}/x` },\n  viewport: { width: 1, height: 1 }, size: 3")).toEqual([])
  })
})
