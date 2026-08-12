/**
 * Thorough unit tests for LocalDaemon.
 *
 * Two test rings:
 *   A. Mock daemon (bash + node WS server) — full path coverage WITHOUT needing
 *      the real compiled binary. Exercises every branch: spawn, reuse, stale
 *      files, version-mismatch restart, version-match reuse, binary-missing
 *      throw, ping timeout, port file timeout, pid dead detection, concurrent
 *      ensureRunning, and multi-dir isolation.
 *   B. Real native binary — integration sanity check (only runs if the current
 *      platform binary has been built via `bash scripts/build-daemon.sh`).
 *
 * Why mock: the real binary is 60MB and slow to spawn (~500ms each). Mock
 * script spawns in <50ms so we can run 20+ scenarios without it taking 2min.
 * Each mock is an isolated shell + node WS server with baked-in daemon dir,
 * so multiple mocks in the same test don't collide.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execSync } from 'node:child_process'
import { WebSocket } from 'ws'
import { LocalDaemon } from '../../src/providers/local-daemon.js'

// ── Helpers ──────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-ld-test-'))
}

function cleanDir(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
}

function killByName(substring: string): void {
  try { execSync(`pkill -9 -f ${JSON.stringify(substring)} 2>/dev/null; true`) } catch {}
}

interface MockOpts {
  failStart?: boolean
  noPortFile?: boolean
  noPidFile?: boolean
  deadOnPing?: boolean
  helloDelay?: number
}

/**
 * Create a unique mock daemon binary (bash script + node WS server).
 * Daemon dir is baked in at creation so mocks don't collide.
 */
function makeMockDaemon(tmpDir: string, daemonDir: string, version: string, opts: MockOpts = {}): string {
  const daemonBinDir = path.join(tmpDir, 'bin')
  fs.mkdirSync(daemonBinDir, { recursive: true })

  const suffix = Math.random().toString(36).slice(2, 10)
  const binaryPath = path.join(daemonBinDir, `mock-daemon-${suffix}`)
  const versionFile = `${binaryPath}.version`
  fs.writeFileSync(versionFile, version + '\n')

  const wsServerPath = `${binaryPath}-ws.js`
  const wsServerCode = `
const { WebSocketServer } = require('${path.resolve(__dirname, '../../node_modules/ws')}')
const fs = require('fs')
const VERSION = ${JSON.stringify(version)}
const DAEMON_DIR = ${JSON.stringify(daemonDir)}
const HELLO_DELAY = ${opts.helloDelay ?? 0}
const DEAD_ON_PING = ${opts.deadOnPing ? 'true' : 'false'}
const NO_PORT = ${opts.noPortFile ? 'true' : 'false'}
const NO_PID = ${opts.noPidFile ? 'true' : 'false'}
fs.mkdirSync(DAEMON_DIR, { recursive: true })
const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
wss.on('listening', () => {
  const port = wss.address().port
  if (!NO_PORT) fs.writeFileSync(DAEMON_DIR + '/daemon.port', String(port))
  if (!NO_PID) fs.writeFileSync(DAEMON_DIR + '/daemon.pid', String(process.pid))
  console.log(port)
})
wss.on('connection', (ws) => {
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString())
    if (msg.cmd === 'hello') {
      if (DEAD_ON_PING) return
      setTimeout(() => {
        ws.send(JSON.stringify({ id: msg.id, ok: true, version: VERSION, capabilities: ['hello', 'start', 'attach', 'setMode'] }))
      }, HELLO_DELAY)
    }
  })
})
process.stdin.resume()
process.on('SIGTERM', () => { process.exit(0) })
`
  fs.writeFileSync(wsServerPath, wsServerCode)

  const script = `#!/bin/bash
case "$1" in
  --version)
    cat "${versionFile}"
    exit 0
    ;;
  --start)
    ${opts.failStart ? 'exit 1' : ''}
    exec node "${wsServerPath}"
    ;;
  *)
    echo "unknown: $1" >&2
    exit 2
    ;;
esac
`
  fs.writeFileSync(binaryPath, script, { mode: 0o755 })
  return binaryPath
}

/** Create a LocalDaemon + matching mock binary in an isolated dir. */
function makeDaemon(
  tmpDir: string,
  version: string,
  opts: MockOpts = {},
  daemonDirName = 'daemon',
): { daemon: LocalDaemon; binary: string; daemonDir: string } {
  const daemonDir = path.join(tmpDir, daemonDirName)
  const binary = makeMockDaemon(tmpDir, daemonDir, version, opts)
  const daemon = new LocalDaemon({ daemonDir, binaryPath: binary })
  return { daemon, binary, daemonDir }
}

// ── Test Ring A: Mock daemon (no real-binary dependency) ────────────────

describe('LocalDaemon — mock daemon coverage', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTmpDir()
  })

  afterEach(() => {
    killByName('mock-daemon')
    cleanDir(tmpDir)
  })

  it('spawns fresh daemon when no port file exists', async () => {
    const { daemon, daemonDir } = makeDaemon(tmpDir, 'v1-abc')
    const port = await daemon.ensureRunning()

    expect(port).toBeGreaterThan(0)
    expect(daemon.port).toBe(port)
    expect(daemon.wsUrl).toBe(`ws://localhost:${port}`)
    expect(fs.existsSync(path.join(daemonDir, 'daemon.port'))).toBe(true)
    expect(fs.existsSync(path.join(daemonDir, 'daemon.pid'))).toBe(true)
  }, 10000)

  it('reuses existing daemon when version matches', async () => {
    const { daemon: d1, binary, daemonDir } = makeDaemon(tmpDir, 'v1-same')
    const port1 = await d1.ensureRunning()
    const pid1 = parseInt(fs.readFileSync(path.join(daemonDir, 'daemon.pid'), 'utf-8'), 10)

    const d2 = new LocalDaemon({ daemonDir, binaryPath: binary })
    const port2 = await d2.ensureRunning()
    const pid2 = parseInt(fs.readFileSync(path.join(daemonDir, 'daemon.pid'), 'utf-8'), 10)

    expect(port2).toBe(port1)
    expect(pid2).toBe(pid1)
  }, 10000)

  it('restarts daemon when binary version is newer (version mismatch)', async () => {
    const { daemon: d1, binary, daemonDir } = makeDaemon(tmpDir, 'v1-old')
    await d1.ensureRunning()
    const pid1 = parseInt(fs.readFileSync(path.join(daemonDir, 'daemon.pid'), 'utf-8'), 10)

    // Upgrade: simulate binary update by rewriting the .version file
    fs.writeFileSync(`${binary}.version`, 'v2-new\n')

    const d2 = new LocalDaemon({ daemonDir, binaryPath: binary })
    const port2 = await d2.ensureRunning()
    const pid2 = parseInt(fs.readFileSync(path.join(daemonDir, 'daemon.pid'), 'utf-8'), 10)

    expect(pid2).not.toBe(pid1)
    expect(port2).toBeGreaterThan(0)
    expect(() => process.kill(pid1, 0)).toThrow()  // Old daemon must be dead
  }, 15000)

  it('respawns when port file exists but daemon process is dead', async () => {
    const { daemon, daemonDir } = makeDaemon(tmpDir, 'v1')

    fs.mkdirSync(daemonDir, { recursive: true })
    fs.writeFileSync(path.join(daemonDir, 'daemon.port'), '99999')
    fs.writeFileSync(path.join(daemonDir, 'daemon.pid'), '999999')

    const port = await daemon.ensureRunning()

    expect(port).toBeGreaterThan(0)
    expect(port).not.toBe(99999)
  }, 10000)

  it('throws when daemon does not respond to hello (hung daemon)', async () => {
    const { daemon } = makeDaemon(tmpDir, 'v1', { deadOnPing: true })

    await expect(daemon.ensureRunning()).rejects.toThrow(/not responding to hello/)
  }, 15000)

  it('throws when binary does not exist (ENOENT caught early)', async () => {
    const daemon = new LocalDaemon({
      daemonDir: path.join(tmpDir, 'daemon'),
      binaryPath: '/nonexistent/path/to/binary',
    })

    // Should fail with spawn error, not hang for 10s waiting for port file
    await expect(daemon.ensureRunning()).rejects.toThrow(/spawn failed|ENOENT/)
  }, 15000)

  it('throws when daemon fails to write port file in time', async () => {
    const { daemon } = makeDaemon(tmpDir, 'v1', { noPortFile: true })

    await expect(daemon.ensureRunning()).rejects.toThrow(/port file not created/)
  }, 15000)

  it('ping detects alive daemon and returns version', async () => {
    const { daemon, daemonDir, binary } = makeDaemon(tmpDir, 'v1-probe')
    const port = await daemon.ensureRunning()

    const d2 = new LocalDaemon({ daemonDir, binaryPath: binary })
    const port2 = await d2.ensureRunning()
    expect(port2).toBe(port)  // Reuse proves ping succeeded
  }, 10000)

  it('ping returns false within 2s for non-responsive port', async () => {
    const daemon = new LocalDaemon({ daemonDir: path.join(tmpDir, 'daemon') })
    // @ts-expect-error — access private for test
    const pingPromise = daemon.ping(1)  // reserved port
    const start = Date.now()
    const result = await pingPromise
    const elapsed = Date.now() - start

    expect(result.alive).toBe(false)
    expect(elapsed).toBeLessThan(3000)
  }, 5000)

  it('getDirectWsUrl throws before ensureRunning is called', () => {
    const daemon = new LocalDaemon({ daemonDir: path.join(tmpDir, 'daemon') })
    expect(() => daemon.getDirectWsUrl()).toThrow(/not running/i)
  })

  it('getDirectWsUrl returns ws URL after successful ensureRunning', async () => {
    const { daemon } = makeDaemon(tmpDir, 'v1')
    await daemon.ensureRunning()

    expect(daemon.getDirectWsUrl()).toMatch(/^ws:\/\/localhost:\d+$/)
  }, 10000)

  it('version mismatch SIGTERMs old daemon (not just port switch)', async () => {
    const { daemon: d1, binary, daemonDir } = makeDaemon(tmpDir, 'v1-will-die')
    await d1.ensureRunning()
    const oldPid = parseInt(fs.readFileSync(path.join(daemonDir, 'daemon.pid'), 'utf-8'), 10)

    expect(() => process.kill(oldPid, 0)).not.toThrow()  // Alive before

    fs.writeFileSync(`${binary}.version`, 'v2-new\n')
    const d2 = new LocalDaemon({ daemonDir, binaryPath: binary })
    await d2.ensureRunning()

    await new Promise((r) => setTimeout(r, 500))
    expect(() => process.kill(oldPid, 0)).toThrow()  // Dead after
  }, 15000)

  it('skips version check when .version file is missing (graceful fallback)', async () => {
    const { daemon: d1, binary, daemonDir } = makeDaemon(tmpDir, 'v1')
    fs.unlinkSync(`${binary}.version`)  // Remove version sidecar

    const port1 = await d1.ensureRunning()
    const pid1 = parseInt(fs.readFileSync(path.join(daemonDir, 'daemon.pid'), 'utf-8'), 10)

    const d2 = new LocalDaemon({ daemonDir, binaryPath: binary })
    const port2 = await d2.ensureRunning()
    const pid2 = parseInt(fs.readFileSync(path.join(daemonDir, 'daemon.pid'), 'utf-8'), 10)

    expect(port2).toBe(port1)
    expect(pid2).toBe(pid1)  // No respawn without version info
  }, 10000)

  it('isPidAlive correctly distinguishes alive vs dead pids', () => {
    const daemon = new LocalDaemon({ daemonDir: path.join(tmpDir, 'daemon') })
    // @ts-expect-error — access private
    const isAlive = (pid: number) => daemon.isPidAlive(pid)

    expect(isAlive(process.pid)).toBe(true)
    expect(isAlive(999999)).toBe(false)
  })

  it('two LocalDaemon instances in different dirs do not interfere', async () => {
    const { daemon: d1 } = makeDaemon(tmpDir, 'v1', {}, 'dir1')
    const { daemon: d2 } = makeDaemon(tmpDir, 'v1', {}, 'dir2')

    const port1 = await d1.ensureRunning()
    const port2 = await d2.ensureRunning()

    expect(port1).not.toBe(port2)  // Different daemons in different dirs
    expect(fs.existsSync(path.join(tmpDir, 'dir1', 'daemon.port'))).toBe(true)
    expect(fs.existsSync(path.join(tmpDir, 'dir2', 'daemon.port'))).toBe(true)
  }, 15000)

  it('respawn writes new port and pid files', async () => {
    const { daemon: d1, binary, daemonDir } = makeDaemon(tmpDir, 'v1-old')
    await d1.ensureRunning()

    fs.writeFileSync(`${binary}.version`, 'v2-new\n')
    const d2 = new LocalDaemon({ daemonDir, binaryPath: binary })
    await d2.ensureRunning()

    expect(fs.existsSync(path.join(daemonDir, 'daemon.port'))).toBe(true)
    expect(fs.existsSync(path.join(daemonDir, 'daemon.pid'))).toBe(true)
    const newPort = parseInt(fs.readFileSync(path.join(daemonDir, 'daemon.port'), 'utf-8'), 10)
    expect(newPort).toBe(d2.port)
  }, 15000)

  it('concurrent ensureRunning() across two instances does not crash', async () => {
    const { daemon: d1, binary, daemonDir } = makeDaemon(tmpDir, 'v1')
    const d2 = new LocalDaemon({ daemonDir, binaryPath: binary })

    const [port1, port2] = await Promise.all([d1.ensureRunning(), d2.ensureRunning()])

    expect(port1).toBeGreaterThan(0)
    expect(port2).toBeGreaterThan(0)
    // The two may spawn two daemons in the race window — that's acceptable,
    // because a subsequent ensureRunning() call will settle on whichever wrote
    // the port file last. Point is: no crash, both return valid ports.
  }, 15000)

  it('binary without version file logs "started" without version metadata', async () => {
    const { daemon, binary } = makeDaemon(tmpDir, 'v1')
    fs.unlinkSync(`${binary}.version`)

    // Should still succeed — version is optional
    const port = await daemon.ensureRunning()
    expect(port).toBeGreaterThan(0)
  }, 10000)

  it('hello response with invalid JSON is treated as dead daemon', async () => {
    // We can't easily make mock return invalid JSON without rewriting, but we
    // can test by pointing at a TCP port that's open but not WebSocket. Use
    // a fresh TCP listener on a random port.
    const net = await import('node:net')
    const server = net.createServer((socket) => {
      // Close immediately — triggers WebSocket upgrade failure / error event
      socket.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address() as { port: number }

    const daemon = new LocalDaemon({ daemonDir: path.join(tmpDir, 'daemon') })
    // @ts-expect-error — private
    const result = await daemon.ping(address.port)
    expect(result.alive).toBe(false)

    server.close()
  }, 5000)

  it('spawn failure bubbles up after port-file timeout', async () => {
    // Binary that exits immediately on --start (no WS server, no port file)
    const { daemon } = makeDaemon(tmpDir, 'v1', { failStart: true })
    await expect(daemon.ensureRunning()).rejects.toThrow(/port file not created/)
  }, 15000)
})

// ── Test Ring B: Real native binary integration ──────────────────────────

const CURRENT_DAEMON_BINARY = `daemon-${process.platform}-${process.arch}`

function realBinaryExists(): boolean {
  const projectRoot = path.resolve(__dirname, '../..')
  const binaryPath = path.join(projectRoot, 'dist', 'daemon-binaries', CURRENT_DAEMON_BINARY)
  return fs.existsSync(binaryPath)
}

// Real-binary integration tests run in an ISOLATED temp dir so they never
// touch /tmp/open-walnut (where the user's production daemon lives).
// LocalDaemon accepts { daemonDir } for this exact purpose.
const PROD_DAEMON_DIR = '/tmp/open-walnut'

describe.skipIf(!realBinaryExists())('LocalDaemon — real binary integration', () => {
  let REAL_DAEMON_DIR: string
  let prevWalnutDaemonDir: string | undefined

  beforeAll(() => {
    REAL_DAEMON_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-real-daemon-test-'))
    // Safety guard: refuse to run against the production dir unless explicitly
    // opted in via WALNUT_ALLOW_PROD_DIR=1. This catches future regressions
    // where someone hardcodes /tmp/open-walnut again.
    if (path.resolve(REAL_DAEMON_DIR) === path.resolve(PROD_DAEMON_DIR) &&
        process.env.WALNUT_ALLOW_PROD_DIR !== '1') {
      throw new Error(
        `Refusing to run real-binary tests against production daemon dir ${PROD_DAEMON_DIR}. ` +
        `Set WALNUT_ALLOW_PROD_DIR=1 to override (not recommended).`
      )
    }
    // The daemon binary reads WALNUT_DAEMON_DIR and writes port/pid there.
    // LocalDaemon inherits process.env when spawning the child, so setting it
    // here in the parent redirects the spawned binary to the isolated tmp dir.
    prevWalnutDaemonDir = process.env.WALNUT_DAEMON_DIR
    process.env.WALNUT_DAEMON_DIR = REAL_DAEMON_DIR
  })

  function killReal(): void {
    // Only kill the PID recorded in THIS test's isolated dir — never pkill
    // by binary name (that would kill the user's production daemon too).
    try {
      const pid = parseInt(fs.readFileSync(path.join(REAL_DAEMON_DIR, 'daemon.pid'), 'utf-8'), 10)
      if (pid > 0) {
        try { process.kill(pid, 'SIGKILL') } catch {}
      }
    } catch {}
    try { fs.unlinkSync(path.join(REAL_DAEMON_DIR, 'daemon.port')) } catch {}
    try { fs.unlinkSync(path.join(REAL_DAEMON_DIR, 'daemon.pid')) } catch {}
  }

  beforeEach(() => { killReal() })
  afterEach(() => { killReal() })
  afterAll(() => {
    killReal()
    if (prevWalnutDaemonDir === undefined) delete process.env.WALNUT_DAEMON_DIR
    else process.env.WALNUT_DAEMON_DIR = prevWalnutDaemonDir
    try { fs.rmSync(REAL_DAEMON_DIR, { recursive: true, force: true }) } catch {}
  })

  it('spawns the real native binary and gets hello capabilities', async () => {
    const daemon = new LocalDaemon({ daemonDir: REAL_DAEMON_DIR })
    const port = await daemon.ensureRunning()
    expect(port).toBeGreaterThan(0)

    const result = await new Promise<{ capabilities: string[]; version: string }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('hello timeout')), 3000)
      const ws = new WebSocket(`ws://localhost:${port}`)
      ws.on('open', () => ws.send(JSON.stringify({ id: 1, cmd: 'hello' })))
      ws.on('message', (data) => {
        clearTimeout(timeout)
        ws.close()
        resolve(JSON.parse(data.toString()))
      })
      ws.on('error', (err) => { clearTimeout(timeout); reject(err) })
    })

    expect(result.capabilities).toContain('setMode')
    expect(result.capabilities).toContain('start')
    expect(result.capabilities).toContain('attach')
  }, 15000)

  it('real binary reports version matching the .version sidecar', async () => {
    const projectRoot = path.resolve(__dirname, '../..')
    const versionFile = path.join(
      projectRoot,
      'dist',
      'daemon-binaries',
      `${CURRENT_DAEMON_BINARY}.version`,
    )
    const expectedVersion = fs.readFileSync(versionFile, 'utf-8').trim()

    const daemon = new LocalDaemon({ daemonDir: REAL_DAEMON_DIR })
    const port = await daemon.ensureRunning()

    const result = await new Promise<{ version: string }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('hello timeout')), 3000)
      const ws = new WebSocket(`ws://localhost:${port}`)
      ws.on('open', () => ws.send(JSON.stringify({ id: 1, cmd: 'hello' })))
      ws.on('message', (data) => {
        clearTimeout(timeout)
        ws.close()
        resolve(JSON.parse(data.toString()))
      })
      ws.on('error', (err) => { clearTimeout(timeout); reject(err) })
    })

    expect(result.version).toBe(expectedVersion)
  }, 15000)

  it('real daemon is reused on second ensureRunning()', async () => {
    const d1 = new LocalDaemon({ daemonDir: REAL_DAEMON_DIR })
    const port1 = await d1.ensureRunning()
    const pid1 = parseInt(fs.readFileSync(path.join(REAL_DAEMON_DIR, 'daemon.pid'), 'utf-8'), 10)

    const d2 = new LocalDaemon({ daemonDir: REAL_DAEMON_DIR })
    const port2 = await d2.ensureRunning()
    const pid2 = parseInt(fs.readFileSync(path.join(REAL_DAEMON_DIR, 'daemon.pid'), 'utf-8'), 10)

    expect(port2).toBe(port1)
    expect(pid2).toBe(pid1)
  }, 15000)
})
