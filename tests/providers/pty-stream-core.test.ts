/**
 * Terminal streams in the daemon (pty-stream-core.ts) through the stream relay
 * (stream-relay-core.ts), with a fake pty: the parts a real terminal cannot show
 * on demand. Flow control (the pty's process stopped while a window is unacked and
 * continued once acked, hung up past the hard cap), the exit after the last output,
 * the hang-up on close and on a link drop, the sshd-like env, and the one id space
 * a link's streams share.
 */
import { describe, it, expect } from 'vitest'
import { createPtyStreams, type PtyChild, type PtySpawnOptions, type PtyTerminal } from '../../src/providers/pty-stream-core.js'
import { createStreamRelay } from '../../src/providers/stream-relay-core.js'

interface Fake {
  argv: string[]
  opts: PtySpawnOptions
  signals: string[]
  written: Buffer[]
  sizes: Array<[number, number]>
  closed: boolean
  out(bytes: Buffer): void
  end(code: number | null, signal?: string): void
}

type Deps = Parameters<typeof createPtyStreams<string>>[0]

function harness(over: { env?: Record<string, string | undefined> } & Partial<Pick<Deps, 'user' | 'executable' | 'foregroundGroup' | 'ownGroup' | 'killGroup'>> = {}) {
  const sent: Array<{ link: string; ev: string; data: Record<string, unknown> }> = []
  const fakes: Fake[] = []
  const ptys = createPtyStreams<string>({
    send: (link, ev, data) => sent.push({ link, ev, data }),
    log: () => {},
    eofWaitMs: 5,
    user: over.user ?? (() => ({ shell: '/bin/passwd-shell', home: '/home/passwd', name: 'pw' })),
    env: over.env ?? { SHELL: '/bin/sh', HOME: '/home/u', USER: 'u', PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', WALNUT_TOKEN: 'secret', AWS_SECRET_ACCESS_KEY: 'x' },
    executable: over.executable,
    foregroundGroup: over.foregroundGroup,
    ownGroup: over.ownGroup,
    killGroup: over.killGroup,
    spawn: (argv, opts) => {
      let resolveExit!: (n: number) => void
      const exited = new Promise<number>((r) => { resolveExit = r })
      const terminal: PtyTerminal = {
        write: (d) => { fake.written.push(Buffer.from(d)); return d.length },
        resize: (c, r) => { fake.sizes.push([c, r]) },
        close: () => { fake.closed = true },
      }
      const child = { pid: 4242 + fakes.length, exited, exitCode: null as number | null, signalCode: null as string | null, terminal, kill: (sig?: string) => { fake.signals.push(sig ?? 'SIGTERM') } }
      const fake: Fake = {
        argv, opts, signals: [], written: [], sizes: [], closed: false,
        out: (bytes) => opts.terminal.data(terminal, bytes),
        end: (code, signal) => { child.exitCode = code; child.signalCode = signal ?? null; opts.terminal.exit(terminal); resolveExit(code ?? 0) },
      }
      fakes.push(fake)
      return child as unknown as PtyChild
    },
  })
  const relay = createStreamRelay<string>({ send: (link, ev, data) => sent.push({ link, ev, data }), log: () => {}, ptys })
  const evs = (sid: string) => sent.filter((s) => s.data.sid === sid).map((s) => s.ev)
  return { sent, fakes, ptys, relay, evs }
}

const open = (relay: ReturnType<typeof harness>['relay'], sid: string, extra: Record<string, unknown> = {}) =>
  relay.openPty('a', sid, { cmd: 'stream.open', sid, to: 'pty', command: 'exec dtach -A /tmp/s', cols: 80, rows: 24, ...extra })

describe('terminal streams in the daemon', () => {
  it('runs the passwd shell `-c <command>` in its home with an sshd-like env, never the daemon\'s own secrets', () => {
    const h = harness()
    open(h.relay, 'o1', { env: { LC_ALL: 'C.UTF-8', EVIL: 'x', LANG: 'bad value; rm' } })
    const [f] = h.fakes
    // A daemon started from cron has SHELL=/bin/sh: passwd still wins, as with sshd.
    expect(f!.argv).toEqual(['/bin/passwd-shell', '-c', 'exec dtach -A /tmp/s'])
    expect(f!.opts.cwd).toBe('/home/passwd')
    expect(f!.opts.env).toEqual({
      HOME: '/home/passwd', SHELL: '/bin/passwd-shell', TERM: 'xterm-256color', PWD: '/home/passwd', PATH: '/usr/bin:/bin',
      USER: 'pw', LOGNAME: 'pw', LANG: 'en_US.UTF-8', LC_ALL: 'C.UTF-8',
    })
    expect(f!.opts.terminal.cols).toBe(80)
    expect(h.sent.find((s) => s.ev === 'stream-accept')?.data).toEqual({ sid: 'o1', pid: 4242 })
  })

  it('takes the passwd shell and home when the env names none', () => {
    const h = harness({ env: {} })
    open(h.relay, 'o1')
    expect(h.fakes[0]!.argv[0]).toBe('/bin/passwd-shell')
    expect(h.fakes[0]!.opts.cwd).toBe('/home/passwd')
    expect(h.fakes[0]!.opts.env.PATH).toBe('/usr/local/bin:/usr/bin:/bin')
  })

  it('takes the passwd shell unless it is no login shell, then a usable env SHELL, then /bin/sh; the env says the one chosen', () => {
    const exe = new Set(['/bin/bash', '/bin/zsh', '/bin/sh'])
    const shellOf = (passwd: string | undefined, envShell: string | undefined) => {
      const h = harness({ user: () => ({ shell: passwd, home: '/home/w', name: 'w' }), env: { SHELL: envShell }, executable: (p) => exe.has(p) })
      open(h.relay, 'o1')
      const f = h.fakes[0]!
      expect(f.opts.env.SHELL).toBe(f.argv[0])
      return f.argv[0]
    }
    // The cloud box's service user: nologin in passwd, SHELL=/bin/bash in the service env.
    expect(shellOf('/usr/sbin/nologin', '/bin/bash')).toBe('/bin/bash')
    // A daemon started from cron: SHELL=/bin/sh in its env, the user's zsh in passwd.
    expect(shellOf('/bin/zsh', '/bin/sh')).toBe('/bin/zsh')
    expect(shellOf('/bin/false', '/usr/sbin/nologin')).toBe('/bin/sh')
    // A shell passwd names that is not there (or not executable) is passed over too.
    expect(shellOf('/opt/gone/fish', '/bin/zsh')).toBe('/bin/zsh')
    expect(shellOf(undefined, '/bin/missing')).toBe('/bin/sh')
  })

  it('opens from the env when passwd has no entry for the daemon\'s uid (os.userInfo throws)', () => {
    const h = harness({ user: () => { throw new Error('ENOENT: no such file or directory, uv_os_get_passwd') }, env: { SHELL: '/bin/bash', HOME: '/srv/w', USER: 'svc' }, executable: () => true })
    open(h.relay, 'o1')
    const f = h.fakes[0]!
    expect(f.argv[0]).toBe('/bin/bash')
    expect(f.opts.cwd).toBe('/srv/w')
    expect(f.opts.env.USER).toBe('svc')
    expect(h.evs('o1')).toEqual(['stream-accept'])
  })

  it('writes input to the pty and acks it, resizes it, and reports the exit after the last output', async () => {
    const h = harness()
    open(h.relay, 'o1')
    const f = h.fakes[0]!
    h.relay.frame('a', 'data', { sid: 'o1', d: Buffer.from('ls\r').toString('base64') })
    expect(Buffer.concat(f.written).toString()).toBe('ls\r')
    expect(h.sent.at(-1)).toEqual({ link: 'a', ev: 'stream-ack', data: { sid: 'o1', n: 3 } })
    h.relay.frame('a', 'resize', { sid: 'o1', cols: 120, rows: 40 })
    h.relay.frame('a', 'resize', { sid: 'o1', cols: 0, rows: 40 })
    expect(f.sizes).toEqual([[120, 40]])
    f.out(Buffer.from('bye\r\n'))
    f.end(7)
    await expect.poll(() => h.evs('o1').at(-1)).toBe('stream-end')
    expect(h.evs('o1')).toEqual(['stream-accept', 'stream-ack', 'stream-data', 'stream-end'])
    expect(h.sent.at(-1)!.data).toEqual({ sid: 'o1', exit: { code: 7, signal: null } })
    expect(f.closed).toBe(true)
    expect(h.relay.count()).toBe(0)
  })

  it('stops the pty\'s process while a window is unacked, continues it once acked, and hangs up past the hard cap', () => {
    const h = harness()
    open(h.relay, 'o1')
    const f = h.fakes[0]!
    const piece = Buffer.alloc(100 * 1024, 0x61)
    f.out(piece); f.out(piece)
    expect(f.signals).toEqual([])
    f.out(piece)
    expect(f.signals).toEqual(['SIGSTOP'])
    f.out(piece)
    expect(f.signals).toEqual(['SIGSTOP'])
    h.relay.frame('a', 'ack', { sid: 'o1', n: 200 * 1024 })
    expect(f.signals).toEqual(['SIGSTOP', 'SIGCONT'])
    // A plain shell's child is not stopped with it: past 16 MB unacked the stream ends.
    for (let i = 0; i < 170; i++) f.out(piece)
    expect(h.sent.find((s) => s.ev === 'stream-close')?.data.error).toMatch(/far more than the link carried/)
    expect(f.signals).toContain('SIGHUP')
    expect(f.closed).toBe(true)
    expect(h.relay.count()).toBe(0)
  })

  it('stops the terminal\'s foreground group, read once per pause, and continues the same group', () => {
    const asks: Array<(n: number | null) => void> = []
    const groupSignals: Array<[number, string]> = []
    let ownAsks = 0
    const h = harness({
      foregroundGroup: (pid, cb) => { expect(pid).toBe(4242); asks.push(cb) },
      ownGroup: (cb) => { ownAsks++; cb(77) },
      killGroup: (pgid, sig) => { groupSignals.push([pgid, sig]) },
    })
    open(h.relay, 'o1')
    const f = h.fakes[0]!
    const piece = Buffer.alloc(100 * 1024, 0x61)
    f.out(piece); f.out(piece); f.out(piece)
    f.out(piece)
    // One read per pause, however much more output comes while it is out.
    expect(asks.length).toBe(1)
    expect(groupSignals).toEqual([])
    asks[0]!(5150)
    expect(groupSignals).toEqual([[5150, 'SIGSTOP']])
    expect(f.signals).toEqual([])
    h.relay.frame('a', 'ack', { sid: 'o1', n: 400 * 1024 })
    expect(groupSignals).toEqual([[5150, 'SIGSTOP'], [5150, 'SIGCONT']])
    expect(ownAsks).toBe(1)

    // A group read that comes back after the ack stops nothing.
    f.out(Buffer.alloc(300 * 1024))
    h.relay.frame('a', 'ack', { sid: 'o1', n: 300 * 1024 })
    asks[1]!(5150)
    expect(groupSignals.length).toBe(2)
  })

  it('falls back to the pty\'s own process for a group it may not stop: unread, not above 1, or the daemon\'s own', () => {
    for (const answer of [null, -1, 0, 1, 77, 3.5]) {
      const groupSignals: Array<[number, string]> = []
      const h = harness({
        foregroundGroup: (_pid, cb) => cb(answer),
        ownGroup: (cb) => cb(77),
        killGroup: (pgid, sig) => { groupSignals.push([pgid, sig]) },
      })
      open(h.relay, 'o1')
      const f = h.fakes[0]!
      f.out(Buffer.alloc(300 * 1024))
      h.relay.frame('a', 'ack', { sid: 'o1', n: 300 * 1024 })
      expect(groupSignals, String(answer)).toEqual([])
      expect(f.signals, String(answer)).toEqual(['SIGSTOP', 'SIGCONT'])
    }
  })

  it('a close hangs up (and continues a stopped one so it hears it), a link drop hangs every terminal up', () => {
    const h = harness()
    open(h.relay, 'o1'); open(h.relay, 'o2')
    const big = Buffer.alloc(300 * 1024)
    h.fakes[0]!.out(big)
    h.relay.frame('a', 'close', { sid: 'o1' })
    expect(h.fakes[0]!.signals).toEqual(['SIGSTOP', 'SIGHUP', 'SIGCONT'])
    expect(h.fakes[0]!.closed).toBe(true)
    h.relay.dropLink('a')
    expect(h.fakes[1]!.signals).toEqual(['SIGHUP'])
    expect(h.relay.count()).toBe(0)
  })

  it('refuses a bad command or size, a used id, more than 32 on a link, and a daemon without a pty', () => {
    const h = harness()
    open(h.relay, 'o1', { command: '' })
    open(h.relay, 'o2', { cols: 99999 })
    open(h.relay, 'o3')
    open(h.relay, 'o3')
    const closes = h.sent.filter((s) => s.ev === 'stream-close').map((s) => String(s.data.error))
    expect(closes).toEqual([
      expect.stringMatching(/needs a command/), expect.stringMatching(/cols and rows/), 'that stream id is already in use',
    ])
    for (let i = 0; i < 31; i++) open(h.relay, `o-p${i}`)
    open(h.relay, 'o-p99')
    expect(h.sent.at(-1)!.data.error).toMatch(/too many terminal streams on this link/)
    expect(h.ptys.count('a')).toBe(32)
    const none = createStreamRelay<string>({ send: (link, ev, data) => h.sent.push({ link, ev, data }), log: () => {} })
    none.openPty('a', 'o9', { command: 'true', cols: 80, rows: 24 })
    expect(h.sent.at(-1)!.data).toEqual({ sid: 'o9', error: 'this daemon opens no terminal streams' })
    const noPty = createPtyStreams<string>({ send: (link, ev, data) => h.sent.push({ link, ev, data }), log: () => {}, user: () => ({}), env: {} })
    noPty.open('a', 'o8', { command: 'true', cols: 80, rows: 24 })
    expect(String(h.sent.at(-1)!.data.error)).toMatch(/no pty \(it runs on Node\)/)
  })

  it('a port stream and a terminal share the link\'s id space', () => {
    const h = harness()
    open(h.relay, 'o1')
    h.relay.openPort('a', 'o1', 80, '127.0.0.1')
    expect(h.sent.at(-1)!.data).toEqual({ sid: 'o1', error: 'that stream id is already in use' })
  })
})
