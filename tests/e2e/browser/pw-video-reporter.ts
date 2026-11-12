/**
 * In a PW_VIDEO run, each video .webm becomes an .mp4 beside it (H.264, CRF 18:
 * scripts/proof-video.mjs), one at a time: a test's own video as the test ends, then, before
 * the run returns, every other .webm this run wrote under the projects' output dirs without an
 * .mp4 (a context a spec made itself with recordVideo, e.g. into test.info().outputPath()).
 * Without ffmpeg on PATH it says so once and leaves the .webm files. Added by
 * withVideoReporter (pw-video.ts); it never changes a test's result.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import type { FullConfig, Reporter, TestCase, TestResult } from '@playwright/test/reporter'
import { collect, encodeArgs, hasTool, mp4PathFor } from '../../../scripts/proof-video.mjs'

function encode(webm: string): Promise<string> {
  const out: string = mp4PathFor(webm)
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', encodeArgs(webm, out), { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    p.stderr.on('data', (d: Buffer) => { err += d.toString() })
    p.on('error', reject)
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`ffmpeg exit ${code}: ${err.trim().slice(-300)}`))))
  })
}

/** The .webm files under `dirs` written since `since` (ms) that have no .mp4 beside them. */
export function unencoded(dirs: string[], since: number): string[] {
  const out = new Set<string>()
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue
    for (const f of collect([dir], ['.webm']) as string[]) {
      if (fs.statSync(f).mtimeMs >= since && !fs.existsSync(mp4PathFor(f))) out.add(f)
    }
  }
  return [...out]
}

export default class VideoReporter implements Reporter {
  private queue: Promise<void> = Promise.resolve()
  private ffmpeg: boolean | null = null
  private made: string[] = []
  private seen = new Set<string>()
  private dirs: string[] = []
  private started = Date.now()

  onBegin(config: FullConfig): void {
    this.started = Date.now()
    this.dirs = [...new Set(config.projects.map((p) => p.outputDir))]
  }

  private add(webm: string): void {
    if (this.seen.has(webm)) return
    this.seen.add(webm)
    this.queue = this.queue.then(async () => {
      this.ffmpeg ??= hasTool('ffmpeg')
      if (!this.ffmpeg) return
      try { this.made.push(await encode(webm)) } catch (e) { console.warn(`[pw-video] no MP4 for ${webm}: ${(e as Error).message}`) }
    })
  }

  onTestEnd(_test: TestCase, result: TestResult): void {
    for (const a of result.attachments) if (a.name === 'video' && a.path?.endsWith('.webm')) this.add(a.path)
  }

  async onEnd(): Promise<void> {
    await this.queue
    // A little before the run began: a file system's mtime may round down.
    for (const f of unencoded(this.dirs, this.started - 2000)) this.add(f)
    await this.queue
    if (this.ffmpeg === false) console.warn('[pw-video] no ffmpeg on PATH: the videos stay .webm (install ffmpeg for an MP4)')
    for (const f of this.made) console.log(`[pw-video] ${f}`)
  }

  printsToStdio(): boolean { return false }
}
