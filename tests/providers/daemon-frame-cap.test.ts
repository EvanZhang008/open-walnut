/**
 * Nothing this machine sends a host's daemon goes out over the daemon's frame cap
 * (src/providers/daemon-frame-cap.ts).
 *
 * 2026-11-07/08: clouddev sessions read the whole /api/tasks (34 MB) and /api/sessions
 * (27 MB) through `walnut tools call api`. Each answer went to the daemon as one
 * gateway-result frame, Bun closed the socket on it, the daemon asked the relay again on
 * the next socket and got the same answer from the relay memo: the link died every 3 to
 * 4 s for minutes, and every other session's relays and streams on the host with it.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-frame-cap-test'))

import { DaemonConnection } from '../../src/providers/daemon-connection.js'
import { assertFrameFits, DAEMON_FRAME_MAX_BYTES, DaemonFrameTooLargeError } from '../../src/providers/daemon-frame-cap.js'
import * as router from '../../src/core/peers/capability-router.js'
import { classifyDeliveryFailure } from '../../src/providers/delivery-failure.js'

const ROOT = path.resolve(__dirname, '../..')

afterEach(() => {
  vi.restoreAllMocks()
  DaemonConnection.resetGatewayRelaysForTest()
})

describe('assertFrameFits', () => {
  it('lets a frame up to the cap through and refuses one byte more, counting UTF-8 bytes', () => {
    expect(() => assertFrameFits('x'.repeat(DAEMON_FRAME_MAX_BYTES), 'f', 'h')).not.toThrow()
    expect(() => assertFrameFits('x'.repeat(DAEMON_FRAME_MAX_BYTES + 1), 'f', 'h')).toThrow(DaemonFrameTooLargeError)
    // Under the cap in characters, over it in bytes (each e-acute is two bytes in UTF-8).
    const accents = '\u00e9'.repeat(DAEMON_FRAME_MAX_BYTES / 2 + 1)
    expect(accents.length).toBeLessThan(DAEMON_FRAME_MAX_BYTES)
    expect(() => assertFrameFits(accents, 'f', 'h')).toThrow(/MB, over the 16\.0 MB/)
  })
})

type Internals = {
  handleGatewayRequest: (e: unknown) => Promise<void>
  _connected: boolean
  ws: unknown
  pendingCommands: Map<number, { resolve: (r: unknown) => void }>
}

/** A connection whose socket records every frame written and acks each command at once. */
function linked(): { conn: DaemonConnection; frames: string[] } {
  const conn = new DaemonConnection('devbox', null)
  const c = conn as unknown as Internals
  const frames: string[] = []
  c._connected = true
  c.ws = {
    readyState: 1,
    send(message: string) {
      frames.push(message)
      const { id } = JSON.parse(message) as { id: number }
      queueMicrotask(() => c.pendingCommands.get(id)?.resolve({ ok: true }))
    },
  }
  return { conn, frames }
}

const relay = (relayId: number) => ({ ev: 'gateway-request', relayId, instanceId: 'd-1', capability: 'tools.call', callerSid: 'sid-1', payload: { name: 'api', args: {} } })

describe('a relay whose answer is over the cap', () => {
  it('is answered with an error naming its size, never written whole, and a resend after the ack gets a small word', async () => {
    const { conn, frames } = linked()
    const c = conn as unknown as Internals
    let runs = 0
    vi.spyOn(router, 'handleGatewayCapability').mockImplementation(async () => {
      runs += 1
      return { ok: true, result: { body: 'x'.repeat(DAEMON_FRAME_MAX_BYTES + 1024) } }
    })
    await c.handleGatewayRequest(relay(9))
    await c.handleGatewayRequest(relay(9))
    expect(runs).toBe(1)
    expect(frames.every((f) => Buffer.byteLength(f) <= DAEMON_FRAME_MAX_BYTES)).toBe(true)
    const first = JSON.parse(frames[0]!) as Record<string, unknown>
    expect(first).toMatchObject({ cmd: 'gateway-result', relayId: 9, errorCode: 'bad_request', detail: { tooLarge: true } })
    expect(String(first.error)).toMatch(/^The answer is 16\.0 MB, more than the 16\.0 MB one message to devbox can carry/)
    expect(frames.length).toBe(2)
  })

  it('a resend after the small answer went unacked gets the small answer, and the op ran once', async () => {
    const { conn, frames } = linked()
    const c = conn as unknown as Internals
    // The first ack never comes back (the link dropped under it): the send fails.
    const ws = c.ws as { send: (m: string) => void }
    const ack = ws.send
    let drop = true
    ws.send = (m: string) => { frames.push(m); if (drop) { drop = false; const { id } = JSON.parse(m) as { id: number }; queueMicrotask(() => c.pendingCommands.get(id)?.resolve({ ok: false, error: 'lost' })); return } ack.call(ws, m); frames.pop() }
    let runs = 0
    vi.spyOn(router, 'handleGatewayCapability').mockImplementation(async () => { runs += 1; return { ok: true, result: { body: 'x'.repeat(DAEMON_FRAME_MAX_BYTES) } } })
    await c.handleGatewayRequest(relay(11))
    await c.handleGatewayRequest(relay(11))
    expect(runs).toBe(1)
    expect(frames).toHaveLength(2)
    for (const f of frames) expect(JSON.parse(f)).toMatchObject({ relayId: 11, errorCode: 'bad_request', detail: { tooLarge: true } })
  })

  it('a queued message over the cap is a permanent failure with its reason, never retried', () => {
    const verdict = classifyDeliveryFailure(new DaemonFrameTooLargeError('the send command', 20 * 1024 * 1024, 'devbox'))
    expect(verdict).toMatchObject({ kind: 'permanent', code: 'too_large' })
    expect(verdict.reason).toMatch(/^Not sent: the send command to devbox is 20\.0 MB/)
    // Wrapped on the way (only the words are left), the same.
    expect(classifyDeliveryFailure(new Error(`send failed: ${new DaemonFrameTooLargeError('x', 1, 'h').message}`)).kind).toBe('permanent')
  })

  it('an answer under the cap still goes whole', async () => {
    const { conn, frames } = linked()
    vi.spyOn(router, 'handleGatewayCapability').mockImplementation(async () => ({ ok: true, result: { body: 'y'.repeat(1_000_000) } }))
    await (conn as unknown as Internals).handleGatewayRequest(relay(10))
    expect(JSON.parse(frames[0]!)).toMatchObject({ relayId: 10, result: { body: 'y'.repeat(1_000_000) } })
  })

  it('any other command over the cap is refused before a byte is written', async () => {
    const { conn, frames } = linked()
    await expect(conn.send('send', { sid: 's', text: 'z'.repeat(DAEMON_FRAME_MAX_BYTES) })).rejects.toThrow(DaemonFrameTooLargeError)
    expect(frames).toEqual([])
  })
})

// ── Ratchet: every write of a frame to a daemon's socket is checked against the cap ──

/**
 * Files that write frames to a daemon's (or its bridge's) socket. A write of a variable is
 * checked when assertFrameFits ran on that variable after it was made and before the
 * write; the rest are listed with why they cannot grow.
 */
const WRITERS: Record<string, Record<string, string>> = {
  'src/providers/daemon-connection.ts': {
    "ws.send(JSON.stringify({ id, cmd: 'client.role', role: 'probe' }))": 'a fixed frame of a few bytes',
    "ws.send(JSON.stringify({ id, cmd: 'hello', ...serverHello(this.isReadOnlyRemote) }))": 'the hello: a fixed set of small fields',
  },
  'src/web/ws/bridge-registry.ts': {
    'send: (frame) => { ws.send(JSON.stringify(frame)) },': 'stream frames: link-stream.ts cuts data into 48 KB pieces',
  },
  'src/host-server/daemon-link.ts': {
    'socket.send(JSON.stringify(frame))': 'stream frames: link-stream.ts cuts data into 48 KB pieces',
    "try { ws.send(JSON.stringify({ cmd: 'follower.report', report: body })) } catch { /* the next one */ }": 'a follower report: a few counts',
  },
  'src/providers/stream-lane.ts': {
    'ws.send(JSON.stringify(frame))': 'stream frames: link-stream.ts cuts data into 48 KB pieces',
    'ws.send(JSON.stringify({ id, ...frame }))': 'the lane\'s own open and close asks, a few fields',
  },
  'src/providers/local-daemon.ts': {
    "socket.on('open', () => socket.send(JSON.stringify({ ...payload, id: 7, cmd })))": 'exec.run of a short probe command on this machine',
    "socket.send(JSON.stringify({ id: 1, cmd: 'hello' }))": 'a fixed frame',
    "socket.send(JSON.stringify({ id: 2, cmd: 'exec.list' }))": 'a fixed frame',
  },
  'src/providers/daemon-service-cli.ts': {
    "socket.on('open', () => socket.send(JSON.stringify({ id: 1, cmd: 'hello' })))": 'a fixed frame',
    'socket.send(JSON.stringify({ ...command, id }))': 'the service handover\'s own commands, a few fields',
  },
}

/** Files that open a WebSocket and name a daemon, but write no frame to a daemon's socket. */
const NOT_WRITERS: Record<string, string> = {
  'src/web/ws/daemon-tunnel.ts': 'a byte pipe: the frames in it are DaemonConnection\'s, checked there',
  'src/providers/cloud-session-link.ts': 'writes no frame (a session link the companion reads)',
  'src/integrations/cloud-bridge-config.ts': 'writes no frame (a probe of the companion)',
  'src/providers/daemon-standalone.ts': 'the daemon itself: what it sends goes to a Walnut server, whose limit is 100 MB',
  'src/commands/net.ts': 'dials the Walnut server, not a daemon',
}

/** `X.send(<one argument>)` outside comments, with X not this (the method that checks). */
function socketWrites(line: string): string[] {
  if (/^\s*(?:\*|\/\/)/.test(line)) return []
  const out: string[] = []
  const re = /([\w\]\)]+)(?:!|\?)?\.send\(/g
  for (let m = re.exec(line); m; m = re.exec(line)) {
    if (m[1] === 'this') continue
    // Its argument list, to the matching paren: a command call (`conn.send('status', ...)`) has two.
    let depth = 1
    let i = m.index + m[0].length
    let comma = false
    for (; i < line.length && depth > 0; i++) {
      const ch = line[i]
      if ('([{'.includes(ch!)) depth += 1
      else if (')]}'.includes(ch!)) depth -= 1
      else if (ch === ',' && depth === 1) comma = true
    }
    if (!comma) out.push(line.slice(m.index + m[0].length, i - 1))
  }
  return out
}

function srcFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) srcFiles(p, out)
    else if (/\.ts$/.test(name)) out.push(p)
  }
  return out
}

describe('ratchet: frames to a daemon', () => {
  it('every socket write in a daemon client is checked against the cap or listed with why it stays small', () => {
    const unchecked: string[] = []
    for (const [file, listed] of Object.entries(WRITERS)) {
      const lines = readFileSync(path.join(ROOT, file), 'utf8').split('\n')
      const seen = new Set<string>()
      lines.forEach((line, i) => {
        const args = socketWrites(line)
        if (args.length === 0) return
        const text = line.trim()
        if (listed[text]) { seen.add(text); return }
        const sent = args.length === 1 && /^\w+$/.test(args[0]!) ? args[0] : undefined
        if (sent) {
          const before = lines.slice(Math.max(0, i - 150), i)
          const checked = before.findLastIndex((l) => l.includes(`assertFrameFits(${sent},`))
          const made = before.findLastIndex((l) => new RegExp(`\\b(?:const|let)\\s+${sent}\\b|\\b${sent}\\s*=[^=]|[(,]\\s*${sent}\\s*[:,)]`).test(l))
          // Made (declared, assigned or taken as a parameter) before the check, in the lines between.
          if (checked >= 0 && made >= 0 && made <= checked) return
        }
        unchecked.push(`${file}:${i + 1}: ${text}`)
      })
      for (const text of Object.keys(listed)) if (!seen.has(text)) unchecked.push(`${file}: listed but gone: ${text}`)
    }
    expect(unchecked).toEqual([])
  })

  it('every file that opens a WebSocket and names a daemon is in one of the lists', () => {
    const files = srcFiles(path.join(ROOT, 'src'))
      .filter((f) => { const t = readFileSync(f, 'utf8'); return t.includes('new WebSocket(') && /daemon/i.test(t) })
      .map((f) => path.relative(ROOT, f))
    expect(files.filter((f) => !WRITERS[f] && !NOT_WRITERS[f])).toEqual([])
    // The two that write nothing still write nothing (the others are a pipe and the daemon).
    for (const f of ['src/providers/cloud-session-link.ts', 'src/integrations/cloud-bridge-config.ts']) {
      expect(readFileSync(path.join(ROOT, f), 'utf8').split('\n').flatMap(socketWrites), f).toEqual([])
    }
  })

  it('every sender of a gateway-result replaces an answer over the cap', () => {
    const senders = srcFiles(path.join(ROOT, 'src'))
      .filter((f) => /\(\s*(?:host,\s*)?'gateway-result'/.test(readFileSync(f, 'utf8')))
      .map((f) => path.relative(ROOT, f))
    expect(senders.sort()).toEqual(['src/core/leader/backup-gateway.ts', 'src/providers/daemon-connection.ts'])
    for (const f of senders) expect(readFileSync(path.join(ROOT, f), 'utf8')).toContain('tooLargeGatewayReply(')
  })
})

describe('the cap is the daemon\'s', () => {
  // Bun.serve is the daemon's server (daemon-standalone.ts keeps its WebSocket defaults).
  it.runIf(typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined')('Bun closes the socket on a frame one byte over it and keeps one at it', async () => {
    const standalone = readFileSync(path.join(ROOT, 'src/providers/daemon-standalone.ts'), 'utf8')
    expect(standalone).not.toMatch(/maxPayloadLength/)
    const Bun = (globalThis as unknown as { Bun: { serve: (o: unknown) => { port: number; stop: (f?: boolean) => void } } }).Bun
    let got = 0
    const server = Bun.serve({
      port: 0, hostname: '127.0.0.1',
      fetch(req: Request, s: { upgrade: (r: Request) => boolean }) { return s.upgrade(req) ? undefined : new Response('no') },
      websocket: { message() { got += 1 } },
    })
    try {
      const trial = (bytes: number) => new Promise<'open' | 'closed'>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${server.port}`)
        ws.onopen = () => { ws.send('x'.repeat(bytes)); setTimeout(() => { resolve(ws.readyState === WebSocket.OPEN ? 'open' : 'closed'); ws.close() }, 1500) }
        ws.onclose = () => resolve('closed')
      })
      expect(await trial(DAEMON_FRAME_MAX_BYTES)).toBe('open')
      expect(got).toBe(1)
      expect(await trial(DAEMON_FRAME_MAX_BYTES + 1)).toBe('closed')
    } finally {
      server.stop(true)
    }
  }, 20_000)
})
