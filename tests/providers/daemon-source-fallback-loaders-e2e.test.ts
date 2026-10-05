/**
 * The source-fallback daemon starts and answers hello whatever loaded the
 * server (2026-10-04).
 *
 * getDaemonSource() inlines core functions by fn.toString(), so the text it
 * ships is whatever the loader made of them. tsx (it runs the e2e fixture
 * servers) and any esbuild build with keepNames rewrite named inner functions
 * into __name(fn, "f"), a helper only their own module defines: every source
 * deploy from such a server refused with "__name is not defined", and a host
 * with no daemon binary got no daemon at all. Each case loads daemon-source.ts
 * one real way, writes the source, starts it as local-daemon.ts runs
 * daemon-fallback.cjs (process.execPath <file> --start) and sends the hello a
 * DaemonConnection sends first.
 *
 * MACHINE SAFETY: HOME, the daemon dir and the streams dir are temp paths; the
 * daemon is SIGKILLed after each case.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { WebSocket } from 'ws'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as esbuild from 'esbuild'

const run = promisify(execFile)
const REPO = path.resolve(__dirname, '../..')
const DAEMON_SOURCE_TS = path.join(REPO, 'src/providers/daemon-source.ts')
const TSX = path.join(REPO, 'node_modules/.bin/tsx')
// The target dist is built for, read from the build config so the case follows it.
const TARGET = /target:\s*'([^']+)'/.exec(fs.readFileSync(path.join(REPO, 'tsup.config.ts'), 'utf8'))![1]

let root = ''
let proc: ChildProcess | null = null

afterEach(async () => {
  if (proc && proc.exitCode === null && proc.signalCode === null) {
    const exited = new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 10_000)
      proc!.once('exit', () => { clearTimeout(t); resolve() })
    })
    proc.kill('SIGKILL')
    await exited
  }
  proc = null
  if (root) fs.rmSync(root, { recursive: true, force: true })
  root = ''
})

/** A script that writes getDaemonSource() of this checkout to argv[2]. */
function writeGenerator(dir: string): string {
  const file = path.join(dir, 'gen.mjs')
  fs.writeFileSync(file, [
    `import { getDaemonSource } from ${JSON.stringify(DAEMON_SOURCE_TS)}`,
    `import fs from 'node:fs'`,
    `fs.writeFileSync(process.argv[2], getDaemonSource())`,
  ].join('\n'))
  return file
}

async function bundled(dir: string, keepNames: boolean): Promise<string> {
  const outfile = path.join(dir, 'gen-bundle.mjs')
  await esbuild.build({
    entryPoints: [writeGenerator(dir)], outfile, bundle: true, platform: 'node', format: 'esm',
    target: TARGET, keepNames, logLevel: 'silent',
  })
  const out = path.join(dir, 'daemon-fallback.cjs')
  await run(process.execPath, [outfile, out], { timeout: 120_000 })
  return out
}

async function underTsx(dir: string): Promise<string> {
  const out = path.join(dir, 'daemon-fallback.cjs')
  await run(TSX, [writeGenerator(dir), out], { cwd: REPO, timeout: 120_000 })
  return out
}

async function startAndHello(script: string): Promise<Record<string, unknown>> {
  const home = path.join(root, 'home')
  const streams = path.join(root, 'streams')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(streams, { recursive: true })
  proc = spawn(process.execPath, [script, '--start'], {
    env: {
      ...process.env,
      SHELL: '/bin/sh',
      PATH: '/usr/bin:/bin',
      HOME: home,
      WALNUT_DAEMON_DIR: path.join(root, 'daemon'),
      WALNUT_STREAMS_DIR: streams,
      WALNUT_LEGACY_STREAMS_DIR: path.join(root, 'no-legacy-streams'),
      WALNUT_SPAWN_JOURNAL: path.join(root, 'spawn-journal.jsonl'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  proc.stderr?.on('data', (c) => { stderr += c })
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('daemon spawn timeout: ' + stderr.slice(-500))), 60_000)
    proc!.stdout?.on('data', (chunk) => {
      const m = chunk.toString().trim().match(/^\d+$/m)
      if (m) { clearTimeout(timer); resolve(parseInt(m[0], 10)) }
    })
    proc!.on('exit', (code) => { clearTimeout(timer); reject(new Error(`daemon exited early (${code}): ${stderr.slice(-500)}`)) })
  })
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('hello timeout')), 30_000)
      ws.on('error', (e) => { clearTimeout(timer); reject(e) })
      ws.on('open', () => ws.send(JSON.stringify({ id: 1, cmd: 'hello' })))
      ws.on('message', (data) => {
        const msg = JSON.parse(String(data)) as Record<string, unknown>
        if (msg.id === 1) { clearTimeout(timer); resolve(msg) }
      })
    })
  } finally {
    ws.terminate()
  }
}

const LOADERS: Array<{ name: string; keepsNames: boolean; make: (dir: string) => Promise<string> }> = [
  { name: 'an esbuild bundle as tsup builds dist (keepNames off)', keepsNames: false, make: (d) => bundled(d, false) },
  { name: 'an esbuild bundle with keepNames', keepsNames: true, make: (d) => bundled(d, true) },
  { name: 'tsx, which runs the e2e fixture servers', keepsNames: true, make: underTsx },
]

describe.each(LOADERS)('source-fallback daemon loaded by $name', ({ keepsNames, make }) => {
  it('starts and answers hello', async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-srcfb-')))
    const script = await make(root)
    const text = fs.readFileSync(script, 'utf8')
    // The case really ships the loader's helper calls, so it cannot pass vacuously.
    if (keepsNames) expect(text).toMatch(/\b__name\(/)
    const stamped = /^const DAEMON_VERSION = '([^']+)';$/m.exec(text)?.[1]
    expect(stamped).toBeTruthy()

    const hello = await startAndHello(script)
    expect(hello.ok).toBe(true)
    expect(hello.version).toBe(stamped)
    expect(Array.isArray(hello.capabilities)).toBe(true)
  }, 240_000)
})
