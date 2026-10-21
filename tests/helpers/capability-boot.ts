/**
 * Probes for the capability boot tests (tests/integration/capability-boot-*.test.ts):
 * what a booted server answers at each door a capability opens, and the boot
 * log lines its jobs write. Used against a real startServer in the test's own
 * process; nothing here starts or stops a server.
 */
import net from 'node:net'
import { vi } from 'vitest'

/** The first status line a WebSocket upgrade to `path` gets, or 'closed' when the server drops it unanswered. */
export function upgradeAnswer(port: number, path: string, token?: string): Promise<string> {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1')
    let buf = ''
    const done = (answer: string) => { sock.destroy(); resolve(answer) }
    const timer = setTimeout(() => done(buf ? buf.split('\r\n')[0] : 'timeout'), 10_000)
    sock.on('connect', () => {
      sock.write([
        `GET ${path} HTTP/1.1`, `Host: 127.0.0.1:${port}`, 'Connection: Upgrade', 'Upgrade: websocket',
        'Sec-WebSocket-Version: 13', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        ...(token ? [`Authorization: Bearer ${token}`] : []), '', '',
      ].join('\r\n'))
    })
    sock.on('data', (d) => {
      buf += d.toString('latin1')
      if (buf.includes('\r\n')) { clearTimeout(timer); done(buf.split('\r\n')[0]) }
    })
    sock.on('error', () => { clearTimeout(timer); done(buf ? buf.split('\r\n')[0] : 'closed') })
    sock.on('close', () => { clearTimeout(timer); done(buf ? buf.split('\r\n')[0] : 'closed') })
  })
}

/** The status an HTTP request with no credential gets. */
export async function statusOf(port: number, method: string, path: string): Promise<number> {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers: { connection: 'close', 'content-type': 'application/json' }, ...(method === 'GET' ? {} : { body: '{}' }),
  })
  await r.arrayBuffer().catch(() => undefined)
  return r.status
}

export interface LogLine { sub: string; msg: string; data: Record<string, unknown> }

/** Records every info and warn line of the given subsystems (the logger still writes them). */
export function recordLogs(log: Record<string, { info: (...a: any[]) => unknown; warn: (...a: any[]) => unknown }>, subs: string[]): { lines: LogLine[]; has(msg: string): boolean; data(msg: string): Record<string, unknown> | undefined } {
  const lines: LogLine[] = []
  for (const sub of subs) {
    for (const level of ['info', 'warn'] as const) {
      const real = log[sub][level].bind(log[sub])
      vi.spyOn(log[sub], level).mockImplementation((msg: unknown, data?: unknown) => {
        lines.push({ sub, msg: String(msg), data: (data ?? {}) as Record<string, unknown> })
        return real(msg, data)
      })
    }
  }
  return {
    lines,
    has: (msg) => lines.some((l) => l.msg === msg),
    data: (msg) => lines.find((l) => l.msg === msg)?.data,
  }
}
