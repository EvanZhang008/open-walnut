/**
 * With the leader present, a same-host send is the daemon's own handleLocal exactly as before
 * unless the `host_call_entry` experiment is on: only then does this host's Walnut server say
 * `answersOnline` (at each follower.hello and in each report), and only a follower that said it
 * is handed one (follower-gateway-core.ts). Trigger fire delivery stays leader-away only and
 * capability-gated, with no flag.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import { createDaemonLink, type DaemonLink } from '../../src/host-server/daemon-link.js'
import { createFollowerGateway } from '../../src/providers/follower-gateway-core.js'
import { EXPERIMENTAL_FEATURES } from '../../src/core/experimental.js'

const ROOT = path.resolve(__dirname, '../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

/** A stand-in daemon socket that keeps each follower.hello's params. */
function fakeDaemon() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'answers-online-'))
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  const sockets = new Set<WebSocket>()
  const hellos: Array<Record<string, unknown>> = []
  wss.on('connection', (ws) => {
    sockets.add(ws)
    ws.on('message', (raw) => {
      const m = JSON.parse(String(raw)) as { id: number; cmd: string } & Record<string, unknown>
      if (m.cmd === 'follower.hello') hellos.push(m)
      if (m.cmd === 'follower.hello' || m.cmd === 'follower.status') ws.send(JSON.stringify({ id: m.id, ok: true, walnutId: 'wmarina1', primaryHeardAgoMs: 100 }))
    })
  })
  const ready = new Promise<void>((r) => wss.on('listening', () => {
    fs.writeFileSync(path.join(dir, 'daemon.port'), String((wss.address() as { port: number }).port))
    r()
  }))
  return {
    dir, ready, hellos,
    async close() {
      for (const s of sockets) s.terminate()
      await new Promise<void>((r) => wss.close(() => r()))
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

let cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const c of cleanup) await c(); cleanup = [] })

describe('answersOnline follows the host_call_entry experiment', () => {
  it('the experiment keeps its id, off by default, and names the same-host delivery while this computer answers', () => {
    const f = EXPERIMENTAL_FEATURES.find((x) => x.id === 'host_call_entry')!
    expect(f.default).toBe(false)
    expect(f.description).toMatch(/while this computer answers too/)
  })

  it('the hello says answersOnline only while the switch reads on', async () => {
    for (const on of [false, true]) {
      const d = fakeDaemon()
      await d.ready
      const link: DaemonLink = createDaemonLink({ daemonDir: d.dir, walnutId: 'wmarina1', home: '/h', token: 't', pollMs: 50, answersLocal: true, answersOnline: () => on, log: () => {} })
      cleanup.push(() => link.stop(), () => d.close())
      link.start()
      await vi.waitFor(() => { expect(d.hellos.length).toBeGreaterThan(0) }, { timeout: 10_000, interval: 10 })
      expect(d.hellos[0]!.answersLocal).toBe(true)
      expect('answersOnline' in d.hellos[0]!).toBe(on)
    }
  })

  it('the front wires the switch, says it again in each report, and both twins read it there', () => {
    const front = read('src/replica/front.ts')
    expect(front).toContain('answersOnline: () => callEntryOn,')
    expect(front).toContain('{ answersOnline: callEntryOn }')
    expect(front).not.toMatch(/answersOnline: true/)
    // Trigger delivery is no experiment: said whenever this server answers local calls.
    expect(front).toContain('deliversTriggers: true,')
    expect(read('src/providers/daemon-standalone.ts')).toContain('ws.data.answersOnline = said.answersOnline === true')
    expect(read('src/providers/daemon-source.ts')).toContain('ws.answersOnline = cmd.report.answersOnline === true')
  })

  it('a follower that did not say it is never handed a same-host send: the daemon\'s handleLocal takes it, as before', () => {
    const sock = { said: false }
    const g = createFollowerGateway<typeof sock>({
      follower: () => sock, mayWrite: () => false, answersOnline: (ws) => ws.said, now: () => 0,
      send: () => true, nextRelayId: () => 1, instanceId: 'i', attemptMs: () => 1_000,
      setTimer: () => null, clearTimer: () => {}, log: () => {},
    })
    expect(g.answersOnline('/h')).toBe(false)
    expect(g.handOff({ home: '/h', capability: 'tools.call', callerSid: 's', payload: {}, deadline: 1_000, online: true, fallback: () => {} }, () => {})).toBe(false)
    // The twins: no answersOnline, straight to handleLocal (the online branch is skipped).
    for (const src of [read('src/providers/daemon-standalone.ts'), read('src/providers/daemon-source.ts')]) {
      const at = src.indexOf('followerGateway.answersOnline(home) && offlineHost.localCandidate(')
      expect(at).toBeGreaterThan(0)
      expect(src.indexOf('offlineHost.handleLocal(home, callerSid, capability, payload)', at)).toBeGreaterThan(at)
    }
    sock.said = true
    expect(g.answersOnline('/h')).toBe(true)
  })
})
