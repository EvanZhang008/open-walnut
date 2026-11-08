/**
 * A `walnut` call waits out a restart of its host's daemon instead of failing in
 * the seconds between the two daemons (daemon-restart-mark.ts).
 *
 * 2026-11-03 on a dev box: the daemon was replaced during a deploy, and for 6 s
 * there was no bin/walnut and no gateway socket; every call in that window failed
 * at once ("no Walnut daemon on this host"). A stopping production daemon now
 * leaves `<dir>/restarting`; while it is fresh a call nothing listens for, or one
 * the stopping daemon turned away, waits and goes again. Without a mark nothing
 * changes: a host whose daemon is really gone still fails at once.
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import {
  RESTART_MARK_FRESH_SECS, RESTART_MARK_NAME, RESTART_POLL_MS, RESTART_RIDE_MAX_MS, restartMarkFresh, restartMarkText,
} from '../../src/providers/daemon-restart-mark.js'
import { RESTART_WAIT_LINE, daemonRestartingAt, requestRidingRestart, stoppingAnswer } from '../../src/providers/wn-cli.js'
import type { GatewayRequest, GatewayResponse } from '../../src/providers/gateway-core.js'

const NOW = 1_800_000_000_000
const REQ: GatewayRequest = { v: 1, op: 'tools.call', sid: 'external', args: { name: 'host_list', args: {} } }
const OK: GatewayResponse = { ok: true, result: { hosts: [] } }
const STOPPING: GatewayResponse = { ok: false, error: { code: 'hub_unreachable', message: 'daemon is shutting down; retry after reconnecting', detail: { stopping: true } } }

function errno(code: string): Error {
  return Object.assign(new Error(`connect ${code} /tmp/x/agent-gateway.sock`), { code })
}

/** A request that plays `steps` in order (an Error is thrown), counting the calls. */
function scripted(steps: Array<GatewayResponse | Error>) {
  let calls = 0
  return {
    get calls() { return calls },
    request: async (): Promise<GatewayResponse> => {
      const step = steps[Math.min(calls++, steps.length - 1)]
      if (step instanceof Error) throw step
      return step
    },
  }
}

function deps(over: { restarting?: () => boolean } = {}) {
  let t = NOW
  const told: string[] = []
  const slept: number[] = []
  return {
    told, slept,
    d: {
      restarting: over.restarting ?? (() => true),
      sleep: async (ms: number) => { slept.push(ms); t += ms },
      now: () => t,
      tell: (line: string) => { told.push(line) },
    },
  }
}

describe('restartMarkFresh: the mark says a successor is due', () => {
  it('fresh only for a whole epoch second under RESTART_MARK_FRESH_SECS old', () => {
    const sec = Math.floor(NOW / 1000)
    expect(restartMarkText(NOW)).toBe(String(sec))
    expect(restartMarkFresh(String(sec), NOW)).toBe(true)
    expect(restartMarkFresh(`${sec - RESTART_MARK_FRESH_SECS + 1}\n`, NOW)).toBe(true)
    expect(restartMarkFresh(String(sec - RESTART_MARK_FRESH_SECS), NOW)).toBe(false)
    // A clock a little ahead is tolerated, one far ahead is not a mark to trust.
    expect(restartMarkFresh(String(sec + 5), NOW)).toBe(true)
    expect(restartMarkFresh(String(sec + 6), NOW)).toBe(false)
    for (const bad of ['', ' ', 'abc', '12.5', '-3', String(NOW), null, undefined]) {
      expect(restartMarkFresh(bad as string | null | undefined, NOW)).toBe(false)
    }
  })

  it('daemonRestartingAt trusts only a small regular file of this user, never a link or a FIFO', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-restart-mark-'))
    try {
      const sock = path.join(dir, 'agent-gateway.sock')
      const mark = path.join(dir, RESTART_MARK_NAME)
      const real = path.join(dir, 'real')
      fs.writeFileSync(real, restartMarkText(NOW))
      fs.symlinkSync(real, mark)
      expect(daemonRestartingAt(sock, NOW)).toBe(false)
      fs.rmSync(mark)
      fs.writeFileSync(mark, restartMarkText(NOW) + ' '.repeat(40))
      expect(daemonRestartingAt(sock, NOW)).toBe(false)
      fs.rmSync(mark)
      if (process.platform !== 'win32') {
        execFileSync('mkfifo', [mark])
        expect(daemonRestartingAt(sock, NOW)).toBe(false)
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('daemonRestartingAt reads the mark beside the socket', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-restart-mark-'))
    try {
      const sock = path.join(dir, 'agent-gateway.sock')
      expect(daemonRestartingAt(sock, NOW)).toBe(false)
      fs.writeFileSync(path.join(dir, RESTART_MARK_NAME), restartMarkText(NOW - 2_000))
      expect(daemonRestartingAt(sock, NOW)).toBe(true)
      expect(daemonRestartingAt(sock, NOW + RESTART_MARK_FRESH_SECS * 1000)).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('requestRidingRestart: a call waits for the next daemon while the mark is fresh', () => {
  it.each(['ENOENT', 'ECONNREFUSED'])('no listener (%s), then the next daemon answers: the answer, one notice', async (code) => {
    const s = scripted([errno(code), errno(code), errno(code), OK])
    const { d, told, slept } = deps()
    await expect(requestRidingRestart('/x/agent-gateway.sock', REQ, 1000, { ...d, request: s.request })).resolves.toEqual(OK)
    expect(s.calls).toBe(4)
    expect(told).toEqual([RESTART_WAIT_LINE])
    expect(slept).toEqual([RESTART_POLL_MS, RESTART_POLL_MS, RESTART_POLL_MS])
  })

  it('the stopping daemon turned it away, then the next daemon answers', async () => {
    const s = scripted([STOPPING, errno('ENOENT'), OK])
    const { d, told } = deps()
    await expect(requestRidingRestart('/x/agent-gateway.sock', REQ, 1000, { ...d, request: s.request })).resolves.toEqual(OK)
    expect(s.calls).toBe(3)
    expect(told).toHaveLength(1)
    expect(stoppingAnswer(STOPPING)).toBe(true)
  })

  it('without a fresh mark nothing waits: the refusal and the stopping answer come back at once', async () => {
    const refused = scripted([errno('ENOENT'), OK])
    const a = deps({ restarting: () => false })
    await expect(requestRidingRestart('/x/s', REQ, 1000, { ...a.d, request: refused.request })).rejects.toMatchObject({ code: 'ENOENT' })
    expect(refused.calls).toBe(1)
    expect(a.told).toEqual([])
    const stopping = scripted([STOPPING, OK])
    const b = deps({ restarting: () => false })
    await expect(requestRidingRestart('/x/s', REQ, 1000, { ...b.d, request: stopping.request })).resolves.toEqual(STOPPING)
    expect(stopping.calls).toBe(1)
  })

  it('the mark goes stale (no successor came): the last failure is the answer', async () => {
    let looks = 0
    const s = scripted([errno('ENOENT')])
    const { d } = deps({ restarting: () => ++looks <= 3 })
    await expect(requestRidingRestart('/x/s', REQ, 1000, { ...d, request: s.request })).rejects.toMatchObject({ code: 'ENOENT' })
    expect(s.calls).toBe(4)
  })

  it('a mark rewritten forever still ends at RESTART_RIDE_MAX_MS', async () => {
    const s = scripted([errno('ECONNREFUSED')])
    const { d, slept } = deps()
    await expect(requestRidingRestart('/x/s', REQ, 1000, { ...d, request: s.request })).rejects.toMatchObject({ code: 'ECONNREFUSED' })
    expect(slept.reduce((a, b) => a + b, 0)).toBe(RESTART_RIDE_MAX_MS)
  })

  // 2026-11-03: a CLI that connected while the daemon finished its stop got "read ECONNRESET".
  it.each(['ECONNRESET', 'EPIPE'])('a call the exiting daemon never read (%s, on Linux) waits too', async (code) => {
    const s = scripted([errno(code), errno('ENOENT'), OK])
    const { d, told } = deps()
    await expect(requestRidingRestart('/x/s', REQ, 1000, { ...d, request: s.request, platform: 'linux' })).resolves.toEqual(OK)
    expect(s.calls).toBe(3)
    expect(told).toHaveLength(1)
  })

  // The flag is set by the real socket client: the daemon wrote part of an answer, so it read the call.
  it.runIf(process.platform === 'linux')('a reset after part of the answer came, over a real socket, does not wait', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrm-'))
    const sockPath = path.join(dir, 'agent-gateway.sock')
    let took = 0
    const server = net.createServer({ pauseOnConnect: true }, (s) => {
      took += 1
      s.write('{"ok":')
      setTimeout(() => s.destroy(), 200)
    })
    await new Promise<void>((resolve) => server.listen(sockPath, () => resolve()))
    try {
      const { d, told } = deps()
      const err = await requestRidingRestart(sockPath, REQ, 5000, { ...d, platform: 'linux' }).catch((e: unknown) => e)
      expect(err).toMatchObject({ code: 'ECONNRESET', answerStarted: true })
      expect(took).toBe(1)
      expect(told).toEqual([])
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('only failures where nothing ran wait: a reset after part of an answer, one on macOS, a timeout, a closed socket, or a server-away answer does not', async () => {
    const midAnswer = Object.assign(errno('ECONNRESET'), { answerStarted: true })
    for (const [step, platform] of [
      [midAnswer, 'linux'], [errno('ECONNRESET'), 'darwin'], [errno('EPIPE'), 'darwin'],
      [errno('EACCES'), 'linux'], [new Error('agent socket closed without a response'), 'linux'],
    ] as Array<[Error, NodeJS.Platform]>) {
      const s = scripted([step, OK])
      const { d, told } = deps()
      await expect(requestRidingRestart('/x/s', REQ, 1000, { ...d, request: s.request, platform })).rejects.toBe(step)
      expect(s.calls).toBe(1)
      expect(told).toEqual([])
    }
    const away: GatewayResponse = { ok: false, error: { code: 'hub_unreachable', message: 'the Walnut server is not answering' } }
    const s = scripted([away, OK])
    const { d } = deps()
    await expect(requestRidingRestart('/x/s', REQ, 1000, { ...d, request: s.request })).resolves.toEqual(away)
    expect(s.calls).toBe(1)
    expect(stoppingAnswer(away)).toBe(false)
  })
})

describe('one rule in every reader: the TS CLI, the JS twin CLI and both user shims', () => {
  const ROOT = path.resolve(__dirname, '../..')
  const source = fs.readFileSync(path.join(ROOT, 'src/providers/daemon-source.ts'), 'utf-8')
  const standalone = fs.readFileSync(path.join(ROOT, 'src/providers/daemon-standalone.ts'), 'utf-8')

  it('the JS twin names the same file, the same freshness and the same notice', () => {
    expect(RESTART_MARK_NAME).toBe('restarting')
    expect(source).toContain(`const RESTART_MARK_FILE = path.join(path.dirname(GATEWAY_SOCK_PATH), '${RESTART_MARK_NAME}');`)
    expect(source).toContain(`path.join(path.dirname(sockPath), '${RESTART_MARK_NAME}')`)
    expect(source).toContain(`age >= -5 && age < ${RESTART_MARK_FRESH_SECS};`)
    expect(source).toContain(`var wnRideUntil = Date.now() + ${RESTART_RIDE_MAX_MS};`)
    expect(source).toContain(`errOut('${RESTART_WAIT_LINE}')`)
  })

  it('both shims read the same file and age, say the same notice, and cap at the same time', () => {
    for (const twin of [source, standalone]) {
      expect(twin).toContain(`[ -f "$1/${RESTART_MARK_NAME}" ] && [ ! -h "$1/${RESTART_MARK_NAME}" ] || return 1`)
      expect(twin).toContain(`m=$(dd if="$1/${RESTART_MARK_NAME}" bs=16 count=1 2>/dev/null)`)
      expect(twin).toContain('case $m in ""|0*|*[!0-9]*|?????????????*) return 1 ;; esac')
      expect(twin).toContain(`[ "$a" -ge -5 ] && [ "$a" -lt ${RESTART_MARK_FRESH_SECS} ] && [ $i -lt ${RESTART_RIDE_MAX_MS / RESTART_POLL_MS} ] || return 1`)
      expect(twin).toContain(`echo "${RESTART_WAIT_LINE}" >&2`)
    }
  })

  it('both daemons write the mark first on a stop, answer `stopping` while closing, and remove it once listening', () => {
    for (const twin of [source, standalone]) {
      expect(twin).toMatch(/noteRestarting\(\);?\n\s+releaseGatewayWaiters\(\)/)
      expect(twin).toMatch(/'daemon is shutting down; retry after reconnecting', \{ stopping: true \}\)/)
      expect(twin).toMatch(/'the daemon is restarting; nothing was sent, try again', \{ stopping: true \}\)/)
      expect(twin).toMatch(/startGatewayListener\(\);?\n\s+writeWalnutShim\(\);?\n(\s+\/\/[^\n]*\n)?\s+try \{ fs\.unlinkSync\(RESTART_MARK_FILE\);? \} catch \{\}/)
      // A service update or handover pauses the gateway (it then answers `stopping`) up to
      // 15 s before stopDaemon: the mark goes down with the pause, and comes off when it resumes.
      expect(twin).toMatch(/const pause = daemonCommands\.pause\([^\n]*\n\s+\/\/[^\n]*\n\s+noteRestarting\(\)/)
      expect(twin.match(/pause\.resume\(\);?\s*\n?\s*clearRestartMark\(\)/g)?.length).toBe(2)
      // Relays the server still has are answered after the drain (its answers still come), before the exit.
      expect(twin).toMatch(/drain failed[^\n]*\n\s+\/\/[^\n]*\n\s+releaseGatewayRelays\(\);?\n\s+persistRegistry\(\)/)
      // ...with the mark fresh again when there is one to answer, and only then (a handover has none).
      expect(twin).toMatch(/function releaseGatewayRelays\(\)[^{]*\{\n\s+if \(gatewayRelayPending\.size === 0\) return;?\n\s+\/\/[^\n]*\n\s+noteRestarting\(\)/)
      // A relay's answer is taken while it drains, never refused as new work.
      expect(twin).toMatch(/cmd\.cmd === 'gateway-result' \? work\(\) : daemonCommands\.admit\(work\)/)
    }
  })

  it('the JS twin CLI rides a call the exiting daemon never read, on Linux, before any answer, as wn-cli.ts does', () => {
    expect(source).toContain(`if (process.platform === 'linux' && (e.code === 'ECONNRESET' || e.code === 'EPIPE') && !buf && wnRide()) return;`)
  })
})
