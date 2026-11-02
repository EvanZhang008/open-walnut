/**
 * A process whose stdout/stderr reader went away keeps running once
 * guardProcessStdio is installed (src/web/server.ts installs it with its exit
 * diagnostics). Real bun children, a real pipe whose read end the test closes.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const GUARD = path.resolve(__dirname, '../../src/lib/stdio-epipe-guard.ts')
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })

/** Runs a child that writes far more than a pipe holds to `stream` after its reader is closed. */
async function runWithClosedReader(stream: 'stdout' | 'stderr', guarded: boolean): Promise<{ code: number | null; report: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stdio-epipe-'))
  dirs.push(dir)
  const report = path.join(dir, 'report.txt')
  const script = path.join(dir, 'child.ts')
  fs.writeFileSync(script, [
    `import fs from 'node:fs'`,
    `import { guardProcessStdio } from ${JSON.stringify(GUARD)}`,
    `process.on('uncaughtException', (e: NodeJS.ErrnoException) => { fs.appendFileSync(${JSON.stringify(report)}, 'uncaught ' + e.code + '\\n'); process.exit(7) })`,
    guarded ? `guardProcessStdio((name, err) => fs.appendFileSync(${JSON.stringify(report)}, 'noted ' + name + ' ' + err.code + '\\n'))` : '',
    // Wait for the parent to close its read end, then write past the pipe buffer, twice.
    `setTimeout(() => {`,
    `  for (let i = 0; i < 4; i++) process.${stream}.write('x'.repeat(256 * 1024) + '\\n')`,
    `  setTimeout(() => { process.${stream}.write('after\\n'); setTimeout(() => { fs.appendFileSync(${JSON.stringify(report)}, 'survived\\n'); process.exit(0) }, 200) }, 200)`,
    `}, 300)`,
  ].join('\n'))
  const child = spawn(process.execPath, [script], { stdio: ['ignore', stream === 'stdout' ? 'pipe' : 'ignore', stream === 'stderr' ? 'pipe' : 'ignore'] })
  // The reader goes away: the parent's end of the pipe closes.
  child[stream]!.destroy()
  const code = await new Promise<number | null>((resolve) => child.on('exit', (c) => resolve(c)))
  return { code, report: fs.existsSync(report) ? fs.readFileSync(report, 'utf8') : '' }
}

describe('guardProcessStdio', () => {
  for (const stream of ['stdout', 'stderr'] as const) {
    it(`without it, a write to a ${stream} nobody reads ends the process (the crash it prevents)`, async () => {
      const r = await runWithClosedReader(stream, false)
      // Bun 1.4 throws the EPIPE out of write() and exits 1 (7 when the handler gets it first).
      expect(r.code).not.toBe(0)
      expect(r.report).not.toContain('survived')
    }, 15_000)

    it(`with it, the process notes the closed ${stream} once and keeps running`, async () => {
      const r = await runWithClosedReader(stream, true)
      expect(r.report).not.toContain('uncaught')
      expect(r.report.match(/noted/g)).toHaveLength(1)
      expect(r.report).toContain(`noted ${stream} EPIPE`)
      expect(r.report).toContain('survived')
      expect(r.code).toBe(0)
    }, 15_000)
  }
})
