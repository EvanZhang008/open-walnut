/**
 * Uploads never ride the shared SSH master.
 *
 * 2026-10-14: the user's SSH certificate expired at 04:15, and the master the
 * server had authenticated earlier was the only connection that could still log
 * in. At 08:01 a deploy pushed a 9.6 MB host-server package over that master,
 * the proxy cut the connection mid-transfer, and with it every session on the
 * host; no new login worked until the user renewed the certificate. Every
 * upload (one stream, and each chunk) now opens its own connection
 * (`ControlMaster=no`, `ControlPath=none`), and a refused login ends the upload
 * at once instead of retrying the same refusal chunk after chunk.
 *
 * ssh is stubbed at spawn (one fake process per call) and at sshExec, so no
 * process, socket or upload is created.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import crypto from 'node:crypto'

interface Reply { code: number; stdout?: string; stderr?: string }
const replies: Reply[] = []
const calls: string[][] = []

vi.mock('node:child_process', async (orig) => {
  const real = await orig<typeof import('node:child_process')>()
  return {
    ...real,
    spawn: vi.fn((cmd: string, args: string[]) => {
      calls.push([cmd, ...args])
      const reply = replies.shift() ?? { code: 0 }
      const proc = new EventEmitter() as EventEmitter & Record<string, unknown>
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      proc.stdout = stdout
      proc.stderr = stderr
      proc.kill = vi.fn()
      proc.stdin = new Writable({
        write(_chunk, _enc, cb) { cb() },
        final(cb) {
          cb()
          setImmediate(() => {
            if (reply.stdout) stdout.write(reply.stdout)
            if (reply.stderr) stderr.write(reply.stderr)
            setImmediate(() => proc.emit('close', reply.code))
          })
        },
      })
      return proc
    }),
  }
})

const { DaemonConnection, SshLoginRefusedError } = await import('../../src/providers/daemon-connection.js')
const { REMOTE_BEGIN_MARKER, REMOTE_END_MARKER } = await import('../../src/providers/remote-sh.js')

type Priv = Record<string, unknown>
const MASTER = '/tmp/walnut-test-master-socket'
const marked = (body: string) => `motd line\n${REMOTE_BEGIN_MARKER}\n${body}\n${REMOTE_END_MARKER}\n`

function setup() {
  const conn = new DaemonConnection('devbox', { hostname: 'devbox.example.test', user: 'me' })
  ;(conn as unknown as Priv)._controlPath = MASTER
  const execs: string[] = []
  vi.spyOn(conn as unknown as Record<string, (...a: unknown[]) => Promise<string>>, 'sshExec').mockImplementation(async (...a: unknown[]) => {
    const cmd = String(a[0])
    execs.push(cmd)
    const joined = /wc -c < '([^']+)'$/.exec(cmd)
    if (cmd.startsWith('cat ') && joined) return String(DATA.length)
    return ''
  })
  return { conn, execs }
}

const DATA = Buffer.alloc(300_000, 7)
const SHA = crypto.createHash('sha256').update(DATA).digest('hex')

/** Every ssh spawn's args. */
const sshCalls = () => calls.filter((c) => c[0] === 'ssh').map((c) => c.slice(1))
const freshOnly = (args: string[]) => {
  const joined = args.join(' ')
  return joined.includes('ControlMaster=no') && joined.includes('ControlPath=none') && !joined.includes(MASTER)
}

beforeEach(() => { replies.length = 0; calls.length = 0 })
afterEach(() => { vi.restoreAllMocks() })

describe('uploadFile connections', () => {
  it('sends the one stream over its own connection, never the master', async () => {
    const { conn } = setup()
    replies.push({ code: 0, stdout: marked(`${SHA}\n${DATA.length}`) })
    await conn.uploadFile('/home/me/.open-walnut-host/incoming/pkg.tgz', DATA)
    expect(sshCalls()).toHaveLength(1)
    expect(freshOnly(sshCalls()[0])).toBe(true)
  })

  it('a refused login ends the upload at once: no chunks, and the error says why', async () => {
    const { conn } = setup()
    replies.push({ code: 255, stderr: 'me@devbox.example.test: Permission denied (publickey).\n' })
    const err = await conn.uploadFile('/home/me/x.tgz', DATA).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SshLoginRefusedError)
    expect((err as Error).message).toContain('refused (auth)')
    // What ssh said is in the error, so a wrong call can be checked later.
    expect((err as Error).message).toContain('Permission denied (publickey)')
    expect(sshCalls()).toHaveLength(1)
  })

  it('an expired certificate reads as cert_expired', async () => {
    const { conn } = setup()
    replies.push({ code: 255, stderr: 'Permission denied (publickey).\nwalnut-ssh-evidence: cert-expired (SSH certificate expired at 2026-10-14 04:15)\n' })
    const err = await conn.uploadFile('/home/me/x.tgz', DATA).catch((e: unknown) => e)
    expect((err as Error).message).toContain('refused (cert_expired)')
  })

  it('a proxy that cannot reach its own service is a cut, not a refused login', async () => {
    const { conn } = setup()
    replies.push({ code: 255, stderr: '\u001b[31m Error: SSH proxy client returned an error when reaching the proxy: getaddrinfo ENOTFOUND proxy.example.test\n Please retry SSH.\nConnection closed by UNKNOWN port 65535\n' })
    replies.push({ code: 0, stdout: marked('262144') })
    replies.push({ code: 0, stdout: marked(String(DATA.length - 262_144)) })
    await conn.uploadFile('/home/me/x.tgz', DATA)
    expect(sshCalls()).toHaveLength(3)
  })

  it('a stream the proxy cuts falls back to chunks, each on its own connection too', async () => {
    const { conn, execs } = setup()
    replies.push({ code: 255, stderr: 'Connection closed by UNKNOWN port 65535\n' })
    replies.push({ code: 0, stdout: marked('262144') })
    replies.push({ code: 0, stdout: marked(String(DATA.length - 262_144)) })
    await conn.uploadFile('/home/me/x.tgz', DATA)
    expect(sshCalls()).toHaveLength(3)
    for (const args of sshCalls()) expect(freshOnly(args), args.join(' ')).toBe(true)
    expect(execs.some((c) => c.startsWith('cat '))).toBe(true)
  })

  it('a login refused in the middle of the chunks stops there instead of retrying it', async () => {
    const { conn } = setup()
    replies.push({ code: 255, stderr: 'Connection closed by UNKNOWN port 65535\n' })
    replies.push({ code: 0, stdout: marked('262144') })
    replies.push({ code: 255, stderr: 'Permission denied (publickey).\n' })
    const err = await conn.uploadFile('/home/me/x.tgz', DATA).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SshLoginRefusedError)
    expect(sshCalls()).toHaveLength(3)
  })
})

describe('source deploy connections', () => {
  type Deploy = (opts?: { fresh?: boolean }) => Promise<void>
  const deploySource = (conn: InstanceType<typeof DaemonConnection>, opts?: { fresh?: boolean }) => {
    ;(conn as unknown as Priv)._bunPath = '/home/me/.bun/bin/bun'
    return ((conn as unknown as Priv).deploySource as Deploy).call(conn, opts)
  }

  // Never through the shared master, the first attempt included: a relay cut the master on that
  // 1.3 MB write and took every session's link with it (2026-10-31, 09:04:26).
  it('every attempt opens its own connection for every step', async () => {
    const { conn } = setup()
    replies.push({ code: 0, stdout: marked('') })
    await deploySource(conn)
    expect(sshCalls().length).toBeGreaterThanOrEqual(2)
    for (const args of sshCalls()) expect(freshOnly(args), args.join(' ')).toBe(true)

    calls.length = 0
    replies.push({ code: 0, stdout: marked('') })
    await deploySource(conn, { fresh: true })
    expect(sshCalls().length).toBeGreaterThanOrEqual(2)
    for (const args of sshCalls()) expect(freshOnly(args), args.join(' ')).toBe(true)
  })

  it('a refused login reads as one, with what ssh said', async () => {
    const { conn } = setup()
    replies.push({ code: 0, stdout: marked('') })
    replies.push({ code: 255, stderr: 'me@devbox.example.test: Permission denied (publickey).\n' })
    const err = await deploySource(conn, { fresh: true }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SshLoginRefusedError)
    expect((err as Error).message).toContain('Permission denied (publickey)')
  })

  it('any other failure keeps what ssh said in the error', async () => {
    const { conn } = setup()
    replies.push({ code: 0, stdout: marked('') })
    replies.push({ code: 255, stderr: 'mux_client_request_session: session request failed: Session open refused by peer\n' })
    const err = await deploySource(conn).catch((e: unknown) => e)
    expect(err).not.toBeInstanceOf(SshLoginRefusedError)
    expect((err as Error).message).toContain('code 255')
    expect((err as Error).message).toContain('Session open refused')
  })
})
