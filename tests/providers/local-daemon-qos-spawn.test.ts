/**
 * The local daemon is spawned through the utility QoS clamp exactly when the
 * server asked for it (WALNUT_DAEMON_QOS_CLAMP=1, set only by the Interactive
 * launchd job dev-prod.sh loads), and inherits the server's band otherwise.
 *
 * The clamp program is swapped for a stand-in that records its argv and execs
 * the rest (src/lib/background-qos.ts `_setQosClampProgramForTest`), so the
 * test sees the spawn go through it on any platform, with a mock daemon (bash +
 * a node WS server) in an isolated dir.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { LocalDaemon } from '../../src/providers/local-daemon.js'
import { QOS_CLAMP_ENV, _setQosClampProgramForTest } from '../../src/lib/background-qos.js'

const WS_MODULE = path.resolve(import.meta.dirname, '../../node_modules/ws')

function mockDaemon(dir: string, daemonDir: string): string {
  const bin = path.join(dir, 'qos-mock-daemon')
  const server = `${bin}-ws.cjs`
  fs.writeFileSync(server, `
const { WebSocketServer } = require(${JSON.stringify(WS_MODULE)})
const fs = require('fs')
const DIR = ${JSON.stringify(daemonDir)}
fs.mkdirSync(DIR, { recursive: true })
const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
wss.on('listening', () => {
  fs.writeFileSync(DIR + '/daemon.port', String(wss.address().port))
  fs.writeFileSync(DIR + '/daemon.pid', String(process.pid))
})
wss.on('connection', (ws) => ws.on('message', (d) => {
  const msg = JSON.parse(d.toString())
  if (msg.cmd === 'hello') ws.send(JSON.stringify({ id: msg.id, ok: true, version: 'v-qos', capabilities: ['hello'] }))
}))
process.stdin.resume()
process.on('SIGTERM', () => process.exit(0))
`)
  fs.writeFileSync(`${bin}.version`, 'v-qos\n')
  fs.writeFileSync(bin, `#!/bin/bash
case "$1" in
  --version) echo v-qos ;;
  --start) exec node ${JSON.stringify(server)} ;;
  *) exit 2 ;;
esac
`, { mode: 0o755 })
  return bin
}

/** Stand-in for taskpolicy: record the argv, check the clamp flags, exec the program. */
function clampStandIn(dir: string): { program: string; log: string } {
  const program = path.join(dir, 'clamp-stand-in')
  const log = path.join(dir, 'clamp.log')
  fs.writeFileSync(program, `#!/bin/bash
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
[[ "$1" == -c && "$2" == utility ]] || exit 64
shift 2
exec "$@"
`, { mode: 0o755 })
  return { program, log }
}

describe('local daemon spawn and the QoS clamp', () => {
  let dir: string
  let daemonDir: string
  let saved: string | undefined

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-ld-qos-'))
    daemonDir = path.join(dir, 'daemon')
    saved = process.env[QOS_CLAMP_ENV]
  })

  afterEach(() => {
    _setQosClampProgramForTest(null)
    if (saved === undefined) delete process.env[QOS_CLAMP_ENV]
    else process.env[QOS_CLAMP_ENV] = saved
    try {
      const pid = Number(fs.readFileSync(path.join(daemonDir, 'daemon.pid'), 'utf8'))
      if (pid > 0) process.kill(pid, 'SIGTERM')
    } catch { /* never started or already gone */ }
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('goes through the clamp when the server was raised (WALNUT_DAEMON_QOS_CLAMP=1)', async () => {
    const bin = mockDaemon(dir, daemonDir)
    const clamp = clampStandIn(dir)
    _setQosClampProgramForTest(clamp.program)
    process.env[QOS_CLAMP_ENV] = '1'
    const daemon = new LocalDaemon({ daemonDir, binaryPath: bin })
    const port = await daemon.ensureRunning()
    expect(port).toBeGreaterThan(0)
    // The clamp execs the program, so the pid LocalDaemon tracks is the daemon's.
    expect(fs.readFileSync(clamp.log, 'utf8')).toBe(`-c utility ${bin} --start\n`)
  }, 15_000)

  it('inherits the server band by default: a terminal or Mac app server never clamps', async () => {
    const bin = mockDaemon(dir, daemonDir)
    const clamp = clampStandIn(dir)
    _setQosClampProgramForTest(clamp.program)
    delete process.env[QOS_CLAMP_ENV]
    const daemon = new LocalDaemon({ daemonDir, binaryPath: bin })
    expect(await daemon.ensureRunning()).toBeGreaterThan(0)
    expect(fs.existsSync(clamp.log)).toBe(false)
  }, 15_000)
})
