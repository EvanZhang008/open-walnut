/**
 * Every session either daemon twin starts carries the page silencer's preload first in
 * NODE_OPTIONS (src/providers/pw-silence-core.ts), so a Playwright run a task session starts
 * on a Mac is silent whatever branch it builds (2026-11-08: such runs, from branches cut
 * before the in-repo silence, switched a Mac's speaker on all night). Booted for real: the
 * preload file is written into the host's state dir with the generated text, a session's
 * own NODE_OPTIONS is kept after it, a Node program under the session that runs as the
 * Playwright runner installs the silencer into Playwright's instrumentation (a stand-in
 * playwright-core records it), and WALNUT_PW_SILENCE=0 on the daemon turns it all off.
 *
 * MACHINE SAFETY: HOME, the daemon dir and the state dir are temp paths; the "CLI" is /bin/sh
 * writing its env to a file; no browser starts; every process is killed after.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { PW_SILENCE_PRELOAD_NAME, pwSilencePreloadSource } from '../../src/providers/pw-silence-core.js'
import { guardedPath } from '../setup/exec-guard.js'
import { testBun } from '../helpers/bun-runtime.js'
import { SOURCE_TWIN } from '../helpers/source-twin.js'
import { onDaemonEarlyExit } from '../helpers/daemon-early-exit.js'

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-pw-silence-twins-')))
afterAll(() => { if (root.includes('walnut-pw-silence-twins-')) fs.rmSync(root, { recursive: true, force: true }) })
const scriptPath = path.join(root, 'daemon.cjs')
fs.writeFileSync(scriptPath, getDaemonSource(), { mode: 0o755 })
const BUN: string | undefined = testBun()
const STANDALONE = path.resolve(__dirname, '../../src/providers/daemon-standalone.ts')
// The source twin finds its sidecars next to it, as deployed (the preload rides task-dir-core, ACP needs acp-daemon-core).
if (BUN) {
  for (const name of ['task-dir-core', 'secrets-core', 'acp-daemon']) {
    const out = name === 'acp-daemon' ? 'acp-daemon-core.cjs' : `${name}.cjs`
    const built = spawnSync(BUN, ['build', '--target=node', '--format=cjs', '--outfile', path.join(root, out),
      path.resolve(__dirname, `../../src/providers/${name}.ts`)], { encoding: 'utf8' })
    if (built.status !== 0) throw new Error('sidecar build failed: ' + built.stderr)
  }
}
const TWINS: Array<{ name: string; command: () => [string, string[]] }> = [
  { name: `source twin (${SOURCE_TWIN.runtime})`, command: () => [SOURCE_TWIN.file, [scriptPath, '--start']] },
  ...(BUN ? [{ name: 'standalone twin (bun)', command: (): [string, string[]] => [BUN, [STANDALONE, '--start']] }] : []),
]
// A real Node for the runner stand-in (the preload is CommonJS for Node, as Playwright runs on it).
const NODE = ['/usr/local/bin/node', '/usr/bin/node', '/opt/homebrew/bin/node'].find((p) => fs.existsSync(p))

let proc: ChildProcess | null = null
let ws: WebSocket | null = null
let rpcId = 1
const started: number[] = []
afterEach(async () => {
  for (const pid of started.splice(0)) { try { process.kill(-pid, 'SIGKILL') } catch { /* gone */ } }
  try { ws?.close() } catch { /* closed */ }
  ws = null
  if (proc && proc.exitCode === null && proc.signalCode === null) {
    const exited = new Promise<void>((r) => { const t = setTimeout(r, 10_000); proc!.once('exit', () => { clearTimeout(t); r() }) })
    proc.kill('SIGKILL')
    await exited
  }
  proc = null
})

async function boot(twin: (typeof TWINS)[number], dir: string, extra: Record<string, string> = {}): Promise<void> {
  const home = path.join(dir, 'home')
  fs.mkdirSync(home, { recursive: true })
  const env: Record<string, string | undefined> = {
    ...process.env, SHELL: '/bin/sh', PATH: guardedPath([], '/usr/bin:/bin'), HOME: home, WALNUT_HOME_OVERRIDE: home,
    WALNUT_DAEMON_DIR: path.join(dir, 'daemon'), WALNUT_STREAMS_DIR: path.join(dir, 'streams'),
    WALNUT_LEGACY_STREAMS_DIR: path.join(dir, 'no-legacy'), WALNUT_SPAWN_JOURNAL: path.join(dir, 'spawn-journal.jsonl'),
    WALNUT_TASK_DIR_ROOT: path.join(dir, 'state', 'tasks'),
    WALNUT_SECRETS_DIR_ROOT: path.join(dir, 'state', 'secrets'),
    // What the daemon's own environment holds: kept, after the preload.
    NODE_OPTIONS: '--max-old-space-size=4096',
    BUN_OPTIONS: '--smol',
    ...extra,
  }
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'WALNUT_PW_SILENCE']) if (!(k in extra)) delete env[k]
  const [cmd, args] = twin.command()
  proc = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('daemon spawn timeout')), 30_000)
    proc!.stdout?.on('data', (chunk) => {
      const m = chunk.toString().trim().match(/^\d+$/m)
      if (m) { clearTimeout(timer); resolve(parseInt(m[0], 10)) }
    })
    onDaemonEarlyExit(proc!, { daemonDir: env.WALNUT_DAEMON_DIR }, (err) => { clearTimeout(timer); reject(err) })
  })
  ws = await new Promise<WebSocket>((resolve, reject) => {
    const s = new WebSocket(`ws://127.0.0.1:${port}`)
    s.on('open', () => resolve(s))
    s.on('error', reject)
  })
}

function rpc(cmd: Record<string, unknown>, timeoutMs = 60_000): Promise<Record<string, unknown>> {
  const id = rpcId++
  const sock = ws!
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('rpc timeout: ' + String(cmd.cmd))), timeoutMs)
    const onMessage = (data: Buffer) => {
      let msg: Record<string, unknown>
      try { msg = JSON.parse(data.toString()) } catch { return }
      if (msg.id === id) { clearTimeout(timer); sock.off('message', onMessage); resolve(msg) }
    }
    sock.on('message', onMessage)
    sock.send(JSON.stringify({ id, ...cmd }))
  })
}

async function waitFile(file: string, ms = 20_000): Promise<string> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (fs.existsSync(file)) { const t = fs.readFileSync(file, 'utf8'); if (t.includes('END')) return t }
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('no file ' + file)
}

/**
 * A stand-in playwright-core (it records its instrumentation's listeners), a runner at
 * node_modules/.bin/playwright and a script of a session's own in another folder, each
 * reporting "<listeners>,<init scripts a new context got>,<gated or none>|END".
 */
function fakeCheckout(dir: string): void {
  const core = path.join(dir, 'node_modules', 'playwright-core')
  fs.mkdirSync(core, { recursive: true })
  fs.writeFileSync(path.join(core, 'package.json'), JSON.stringify({ name: 'playwright-core', main: 'index.js' }))
  fs.writeFileSync(path.join(core, 'index.js'), [
    'const listeners = []',
    'module.exports = { _instrumentation: { addListener: (l) => listeners.push(l) }, listeners }',
  ].join('\n'))
  const report = (load: string) => [
    `const core = require(${load})`,
    'const l = core.listeners[0]',
    'const scripts = []',
    'Promise.resolve(l && l.runAfterCreateBrowserContext({ addInitScript: async (s) => { scripts.push(s.content) } })).then(() => {',
    "  process.stdout.write([core.listeners.length, scripts.length, scripts[0] && scripts[0].includes('webdriver') ? 'gated' : 'none'].join(',') + '|END')",
    '})',
  ].join('\n')
  const bin = path.join(dir, 'node_modules', '.bin')
  fs.mkdirSync(bin, { recursive: true })
  fs.writeFileSync(path.join(bin, 'playwright'), report("'playwright-core'"))
  // A session's own check script, elsewhere, run from a folder with no node_modules.
  fs.mkdirSync(path.join(dir, 'scratch'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'scratch', 'verify-ui.cjs'), report(JSON.stringify(core)))
  // The same through a helper: the main script never names Playwright.
  fs.writeFileSync(path.join(dir, 'scratch', 'lib.cjs'), `module.exports = require(${JSON.stringify(core)})`)
  fs.writeFileSync(path.join(dir, 'scratch', 'main.cjs'), report("'./lib.cjs'"))
  // The same inside a Worker (Bun starts one without BUN_OPTIONS' preload; the preload passes it on).
  fs.writeFileSync(path.join(dir, 'scratch', 'in-worker.cjs'), report(JSON.stringify(core))
    .replace("process.stdout.write(", "require('node:worker_threads').parentPort.postMessage("))
  fs.writeFileSync(path.join(dir, 'scratch', 'worker-main.cjs'), [
    "const { Worker } = require('node:worker_threads')",
    "const w = new Worker(require('node:path').join(__dirname, 'in-worker.cjs'))",
    "w.on('message', (m) => { process.stdout.write(m); w.terminate() })",
  ].join('\n'))
}

describe.each(TWINS)('$name', (twin) => {
  it('starts every session with the silencer preload first in NODE_OPTIONS, and the runner installs it', async () => {
    const dir = path.join(root, twin.name.replace(/\W+/g, '-'))
    await boot(twin, dir)
    const preload = path.join(dir, 'state', 'pw-silence', PW_SILENCE_PRELOAD_NAME)
    const seen = path.join(dir, 'seen.txt')
    fakeCheckout(dir)
    const runner = NODE
      ? `"${NODE}" node_modules/.bin/playwright > '${dir}/runner.txt' 2>&1; ` +
        `(cd /; "${NODE}" '${dir}/scratch/verify-ui.cjs' > '${dir}/script.txt' 2>&1; "${NODE}" '${dir}/scratch/main.cjs' > '${dir}/helper.txt' 2>&1; "${NODE}" '${dir}/scratch/worker-main.cjs' > '${dir}/worker.txt' 2>&1); ` +
        `"${NODE}" -e 'require("node:fs"); process.stdout.write(String(!!globalThis[Symbol.for("walnut.pwSilence")]))' > '${dir}/other.txt' 2>&1;`
      : ''
    const bunRun = BUN ? `(cd /; "${BUN}" '${dir}/scratch/verify-ui.cjs' > '${dir}/bun.txt' 2>&1; "${BUN}" '${dir}/scratch/main.cjs' > '${dir}/bun-helper.txt' 2>&1; "${BUN}" '${dir}/scratch/worker-main.cjs' > '${dir}/bun-worker.txt' 2>&1); ` : ''
    const script = `cd '${dir}'; ${runner} ${bunRun}printf '%s|%s|END' "\${NODE_OPTIONS-unset}" "\${BUN_OPTIONS-unset}" > '${seen}'; exec /bin/sleep 60`
    const reply = await rpc({ cmd: 'start', sid: 'pw-silence-session-1', args: ['/bin/sh', '-c', script], cwd: dir, message: 'init\n' })
    expect(reply.ok, JSON.stringify(reply)).toBe(true)
    const pid = Number((reply as { pid?: unknown }).pid ?? (reply as { result?: { pid?: unknown } }).result?.pid)
    if (pid > 1) started.push(pid)

    expect(await waitFile(seen)).toBe(`--require "${preload}" --max-old-space-size=4096|--preload=${preload} --smol|END`)
    // Bun reads only BUN_OPTIONS: a Bun script of the session's own gets it the same way.
    if (BUN) {
      expect(fs.readFileSync(path.join(dir, 'bun.txt'), 'utf8')).toBe('1,1,gated|END')
      expect(fs.readFileSync(path.join(dir, 'bun-helper.txt'), 'utf8')).toBe('1,1,gated|END')
      expect(fs.readFileSync(path.join(dir, 'bun-worker.txt'), 'utf8')).toBe('1,1,gated|END')
    }
    expect(fs.readFileSync(preload, 'utf8')).toBe(pwSilencePreloadSource())
    if (NODE) {
      // The runner added one listener, which put the gated silencer into the new context.
      expect(fs.readFileSync(path.join(dir, 'runner.txt'), 'utf8')).toBe('1,1,gated|END')
      // So does a script of the session's own, from a folder that has no Playwright of its own.
      expect(fs.readFileSync(path.join(dir, 'script.txt'), 'utf8')).toBe('1,1,gated|END')
      expect(fs.readFileSync(path.join(dir, 'helper.txt'), 'utf8')).toBe('1,1,gated|END')
      expect(fs.readFileSync(path.join(dir, 'worker.txt'), 'utf8')).toBe('1,1,gated|END')
      // A Node program that never loads Playwright is not touched.
      expect(fs.readFileSync(path.join(dir, 'other.txt'), 'utf8')).toBe('false')
    }
  }, 90_000)

  it('an ACP agent gets it too, and an engine env that clears NODE_OPTIONS keeps only the silencer', async () => {
    if (!NODE) return
    const dir = path.join(root, twin.name.replace(/\W+/g, '-') + '-acp')
    await boot(twin, dir)
    const preload = path.join(dir, 'state', 'pw-silence', PW_SILENCE_PRELOAD_NAME)
    // A stand-in agent worker: records its NODE_OPTIONS, answers initialize and newSession.
    const worker = path.join(dir, 'worker.cjs')
    fs.writeFileSync(worker, [
      "const fs = require('fs')",
      "fs.writeFileSync(process.env.SEEN_FILE, String(process.env.NODE_OPTIONS) + '|' + String(process.env.BUN_OPTIONS) + '|END')",
      "require('readline').createInterface({ input: process.stdin }).on('line', (line) => {",
      '  const m = JSON.parse(line)',
      "  const result = m.op === 'newSession' ? { sessionId: 'fake-acp' } : { ok: true }",
      "  process.stdout.write(JSON.stringify({ id: m.id, ok: true, result }) + '\\n')",
      '})',
    ].join('\n'))
    for (const [sid, env, want] of [
      ['pw-acp-inherit', {}, `--require "${preload}" --max-old-space-size=4096|--preload=${preload} --smol|END`],
      ['pw-acp-cleared', { NODE_OPTIONS: '', BUN_OPTIONS: '' }, `--require "${preload}"|--preload=${preload}|END`],
    ] as const) {
      const seen = path.join(dir, `${sid}.txt`)
      const reply = await rpc({ cmd: 'acpStart', sid, cwd: dir, workerCmd: [NODE, worker], adapterCmd: ['/bin/true'], env: { ...env, SEEN_FILE: seen } })
      expect(reply.ok, JSON.stringify(reply)).toBe(true)
      expect(await waitFile(seen), sid).toBe(want)
      await rpc({ cmd: 'acpStop', sid })
    }
  }, 90_000)

  it('WALNUT_PW_SILENCE=0 on the daemon writes no preload and leaves NODE_OPTIONS as it was', async () => {
    const dir = path.join(root, twin.name.replace(/\W+/g, '-') + '-off')
    await boot(twin, dir, { WALNUT_PW_SILENCE: '0' })
    const seen = path.join(dir, 'seen.txt')
    const script = `printf '%s|%s|END' "\${NODE_OPTIONS-unset}" "\${BUN_OPTIONS-unset}" > '${seen}'; exec /bin/sleep 60`
    const reply = await rpc({ cmd: 'start', sid: 'pw-silence-session-off', args: ['/bin/sh', '-c', script], cwd: dir, message: 'init\n' })
    expect(reply.ok, JSON.stringify(reply)).toBe(true)
    const pid = Number((reply as { pid?: unknown }).pid ?? (reply as { result?: { pid?: unknown } }).result?.pid)
    if (pid > 1) started.push(pid)
    expect(await waitFile(seen)).toBe('--max-old-space-size=4096|--smol|END')
    expect(fs.existsSync(path.join(dir, 'state', 'pw-silence'))).toBe(false)
  }, 90_000)
})

describe('every session spawn in both twins carries the silencer', () => {
  // A new spawn env (a Claude Code start, an ACP start) is found by the task-dir key every
  // session env must set (tests/core/work-place-rule.test.ts); each must set NODE_OPTIONS and
  // BUN_OPTIONS through pwSilenceOptions or pwSilenceAcpOptions in the same object. The dynamic cases above run both kinds.
  for (const file of ['daemon-standalone.ts', 'daemon-source.ts']) {
    it(file, () => {
      const src = fs.readFileSync(path.resolve(__dirname, '../../src/providers', file), 'utf8')
      const sites = [...src.matchAll(/WALNUT_TASK_DIR: /g)].map((m) => m.index!)
      expect(sites.length).toBe(2)
      for (const at of sites) {
        const around = src.slice(at, at + 600)
        expect(around, `${file} at ${src.slice(0, at).split('\n').length}`).toMatch(/\.\.\.pwSilence(Acp)?Options\(/)
      }
    })
  }
})
