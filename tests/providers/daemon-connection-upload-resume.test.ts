/**
 * uploadFile is cheap to repeat and resumes a cut chunked upload.
 *
 * The host server's file is 50-60 MB gzipped, 240 chunks when a proxy kills the
 * one stream. Before: every attempt removed the last attempt's chunks and began
 * at chunk 0 with a cap of 30 failures whatever the chunk count, and every
 * reconnect sent the whole file again even when the host had it. Now one round
 * trip asks the host for the file's sha and size first, the chunks stay keyed by
 * the sha, and only the missing ones are sent. The daemon binary deploy keeps
 * its old chunk path (clean dir, cap 30).
 *
 * ssh is stubbed at spawn (one fake process per call, answering by what it was
 * sent) and at sshExec, so no process, socket or upload is created. The same
 * code against real files: daemon-connection-upload-fake-ssh.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import crypto from 'node:crypto'

interface Reply { code: number; stdout?: string; stderr?: string }
interface Spawned { args: string[]; bytes: number }
const spawned: Spawned[] = []
let respond: (args: string[], stdin: Buffer) => Reply = () => ({ code: 255, stderr: 'Connection closed by UNKNOWN port 65535\n' })

vi.mock('node:child_process', async (orig) => {
  const real = await orig<typeof import('node:child_process')>()
  return {
    ...real,
    spawn: vi.fn((cmd: string, args: string[]) => {
      const proc = new EventEmitter() as EventEmitter & Record<string, unknown>
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const parts: Buffer[] = []
      proc.stdout = stdout
      proc.stderr = stderr
      proc.kill = vi.fn()
      proc.stdin = new Writable({
        write(chunk, _enc, cb) { parts.push(Buffer.from(chunk)); cb() },
        final(cb) {
          cb()
          const input = Buffer.concat(parts)
          if (cmd === 'ssh') spawned.push({ args, bytes: input.length })
          const reply = respond(args, input)
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
const { parseChunkList, parseUploadPrecheck, resumeFailureCap } = await import('../../src/providers/upload-resume.js')

type Priv = Record<string, unknown>
type DC = InstanceType<typeof DaemonConnection>
const CHUNK = 262_144
const CUT: Reply = { code: 255, stderr: 'Connection closed by UNKNOWN port 65535\n' }
const marked = (body: string) => `motd line\n${REMOTE_BEGIN_MARKER}\n${body}\n${REMOTE_END_MARKER}\n`
const sha256 = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex')
const REMOTE = '/home/me/.open-walnut-host/incoming/walnut-1.gz'

/** The chunk index an upload command writes, or null for the one stream. */
const chunkOf = (args: string[]): number | null => {
  const m = /chunk_(\d+)/.exec(args[args.length - 1] ?? '')
  return m ? Number(m[1]) : null
}
/** A chunk the host took whole: it answers with the byte count, as `wc -c` would. */
const okChunk = (stdin: Buffer): Reply => ({ code: 0, stdout: marked(String(stdin.length)) })
const chunkCalls = () => spawned.filter((s) => chunkOf(s.args) !== null)
const streamCalls = () => spawned.filter((s) => chunkOf(s.args) === null)

interface ExecAnswers { precheck?: string; list?: string; joinedSize?: number; joinedSha?: string }
function setup(data: Buffer, answers: ExecAnswers = {}) {
  const conn = new DaemonConnection('devbox', { hostname: 'devbox.example.test', user: 'me' })
  // One chunk at a time: these cases pin the resume and retry rules in order (lanes: below).
  ;(conn as unknown as Priv).chunkPacing = { backoffMs: [0, 0, 0, 0, 0], gapMs: 0, parallel: 1 }
  const execs: string[] = []
  vi.spyOn(conn as unknown as Record<string, (...a: unknown[]) => Promise<string>>, 'sshExec').mockImplementation(async (...a: unknown[]) => {
    const cmd = String(a[0])
    execs.push(cmd)
    if (cmd.startsWith('mkdir -p ') && cmd.includes('if [ -f ')) return answers.precheck ?? ''
    if (cmd.includes('wc -c chunk_*')) return answers.list ?? ''
    if (cmd.startsWith('cat ') && /wc -c < '[^']+'$/.test(cmd)) return String(answers.joinedSize ?? data.length)
    if (cmd.startsWith('(sha256sum ')) return answers.joinedSha ?? ''
    return ''
  })
  return { conn, execs }
}

beforeEach(() => {
  spawned.length = 0
  respond = (args, stdin) => (chunkOf(args) === null ? CUT : okChunk(stdin))
})
afterEach(() => { vi.restoreAllMocks() })

describe('uploadFile: a file the host already has', () => {
  const DATA = Buffer.alloc(300_000, 7)
  const SHA = sha256(DATA)

  it('the same sha and size is not sent at all', async () => {
    const { conn, execs } = setup(DATA, { precheck: `sha=${SHA}\nsize=${DATA.length}` })
    await expect(conn.uploadFile(REMOTE, DATA)).resolves.toEqual({ skipped: true })
    expect(spawned).toHaveLength(0)
    // One round trip: the mkdir and the sum in the same script, either sha tool.
    expect(execs).toHaveLength(1)
    expect(execs[0]).toContain(`mkdir -p '/home/me/.open-walnut-host/incoming'`)
    expect(execs[0]).toContain(`sha256sum '${REMOTE}' || shasum -a 256 '${REMOTE}'`)
    expect(execs[0]).toContain(`wc -c < '${REMOTE}'`)
  })

  it.each([
    ['another sha', `sha=${'0'.repeat(64)}\nsize=300000`],
    ['the same sha at another size', `sha=${SHA}\nsize=299999`],
    ['a host that cannot compute a sha', 'sha=\nsize=300000'],
    ['no file', ''],
  ])('%s is sent', async (_what, precheck) => {
    respond = () => ({ code: 0, stdout: marked(`${SHA}\n${DATA.length}`) })
    const { conn } = setup(DATA, { precheck })
    await expect(conn.uploadFile(REMOTE, DATA)).resolves.toEqual({ skipped: false })
    expect(spawned).toHaveLength(1)
    expect(spawned[0].bytes).toBe(DATA.length)
  })

  it('takes the caller\'s sha, and computes the same one without it, off the event loop', async () => {
    const spy = vi.spyOn(crypto, 'createHash')
    const a = setup(DATA, { precheck: `sha=${SHA}\nsize=${DATA.length}` })
    await a.conn.uploadFile(REMOTE, DATA)
    expect(spy).not.toHaveBeenCalled()
    expect(a.execs[0]).toContain(`'${SHA}'`)
    const b = setup(DATA, { precheck: `sha=${SHA}\nsize=${DATA.length}` })
    await expect(b.conn.uploadFile(REMOTE, DATA, { sha256: SHA.toUpperCase() })).resolves.toEqual({ skipped: true })
    await expect(b.conn.uploadFile(REMOTE, DATA, { sha256: 'abc' })).rejects.toThrow(/64 hex/)
  })
})

describe('the one stream checks with sha256sum or shasum', () => {
  it('a host where only `shasum -a 256` answers takes the stream', async () => {
    const DATA = Buffer.alloc(100_000, 3)
    const SHA = sha256(DATA)
    respond = () => ({ code: 0, stdout: marked(`${SHA}\n${DATA.length}`) })
    const { conn } = setup(DATA)
    await expect(conn.uploadFile(REMOTE, DATA)).resolves.toEqual({ skipped: false })
    expect(spawned).toHaveLength(1)
    const command = spawned[0].args[spawned[0].args.length - 1]
    expect(command).toContain('sha256sum')
    expect(command).toContain('|| shasum -a 256')
    // One line for the login shell (shDataCommand refuses `!`, backslashes, newlines before quoting).
    expect(command.startsWith('sh -c ')).toBe(true)
  })

  it('the daemon deploy\'s stream uses the same check', async () => {
    const DATA = Buffer.alloc(1000, 1)
    respond = () => ({ code: 0, stdout: marked(`${sha256(DATA)}\n${DATA.length}`) })
    const { conn } = setup(DATA)
    const ok = await (conn as unknown as Record<string, (...a: unknown[]) => Promise<boolean>>).pipeSingleStream(DATA, '/tmp/x/daemon.gz', sha256(DATA))
    expect(ok).toBe(true)
    expect(spawned[0].args[spawned[0].args.length - 1]).toContain('|| shasum -a 256')
  })
})

describe('the resumable chunked path', () => {
  // 5 full chunks and a short sixth.
  const DATA = crypto.randomBytes(5 * CHUNK + 1000)
  const SHA = sha256(DATA)
  const DIR = `${REMOTE}.chunks-${SHA.slice(0, 16)}`

  it('sends only the chunks the host lacks or holds at the wrong size', async () => {
    const list = [`${CHUNK} chunk_0000`, `  ${CHUNK} chunk_0001`, '100 chunk_0002', `${CHUNK} chunk_0004`, `${3 * CHUNK + 100} total`].join('\n')
    const { conn, execs } = setup(DATA, { list })
    await expect(conn.uploadFile(REMOTE, DATA)).resolves.toEqual({ skipped: false })
    expect(streamCalls()).toHaveLength(1)
    expect(chunkCalls().map((c) => chunkOf(c.args))).toEqual([2, 3, 5])
    expect(chunkCalls().map((c) => c.bytes)).toEqual([CHUNK, CHUNK, 1000])
    // The dir is keyed by the sha and never emptied at the start.
    expect(chunkCalls()[0].args.at(-1)).toContain(`${DIR}/chunk_0002`)
    const join = execs.findIndex((c) => c.startsWith(`cat '${DIR}'/chunk_* > '${REMOTE}'`))
    expect(join).toBeGreaterThan(-1)
    expect(execs.slice(0, join).some((c) => c.includes(`rm -rf '${DIR}'`))).toBe(false)
    const listing = execs.find((c) => c.includes('wc -c chunk_*'))!
    expect(listing).toContain(`for d in '${REMOTE}'.chunks-*; do`)
    expect(listing).toContain(`[ "$d" = '${DIR}' ] || rm -rf "$d"`)
    // Joined, sha checked (empty answer here: accepted by size), then the chunks removed.
    expect(execs[join + 1]).toContain(`sha256sum '${REMOTE}'`)
    expect(execs[join + 2]).toBe(`rm -rf '${DIR}'`)
  })

  it('a host holding every chunk sends none of them', async () => {
    const list = [0, 1, 2, 3, 4].map((i) => `${CHUNK} chunk_000${i}`).concat('1000 chunk_0005').join('\n')
    const { conn } = setup(DATA, { list, joinedSha: SHA })
    await conn.uploadFile(REMOTE, DATA)
    expect(chunkCalls()).toHaveLength(0)
  })

  it('a joined file whose sha differs is removed with its chunks, and the upload throws', async () => {
    const { conn, execs } = setup(DATA, { joinedSha: 'f'.repeat(64) })
    await expect(conn.uploadFile(REMOTE, DATA)).rejects.toThrow(/sha256 mismatch/)
    expect(execs).toContain(`rm -rf '${DIR}' '${REMOTE}'`)
    expect(execs).not.toContain(`rm -rf '${DIR}'`)
  })

  it('a joined file of the wrong size is removed with its chunks, and the upload throws', async () => {
    const { conn, execs } = setup(DATA, { joinedSize: DATA.length - 1 })
    await expect(conn.uploadFile(REMOTE, DATA)).rejects.toThrow(/size mismatch/)
    expect(execs).toContain(`rm -rf '${DIR}' '${REMOTE}'`)
  })

  it('a refused login stops at once, and a destroyed connection aborts', async () => {
    let n = 0
    respond = (args, stdin) => {
      if (chunkOf(args) === null) return CUT
      return ++n === 2 ? { code: 255, stderr: 'Permission denied (publickey).\n' } : okChunk(stdin)
    }
    const a = setup(DATA)
    await expect(a.conn.uploadFile(REMOTE, DATA)).rejects.toBeInstanceOf(SshLoginRefusedError)
    expect(chunkCalls()).toHaveLength(2)

    spawned.length = 0
    const b = setup(DATA)
    respond = (args, stdin) => {
      if (chunkOf(args) === null) return CUT
      ;(b.conn as unknown as Priv)._destroyed = true
      return okChunk(stdin)
    }
    await expect(b.conn.uploadFile(REMOTE, DATA)).rejects.toThrow(/aborted: connection destroyed/)
    expect(chunkCalls()).toHaveLength(1)
  })
})

describe('the failure cap', () => {
  it('grows with the chunk count for a resumed upload, and stays 30 for the daemon deploy', async () => {
    expect(resumeFailureCap(1)).toBe(30)
    expect(resumeFailureCap(120)).toBe(30)
    expect(resumeFailureCap(121)).toBe(31)
    expect(resumeFailureCap(240)).toBe(60)
  })

  // 160 chunks: cap 40. Each failing chunk fails 5 times (the per-chunk limit) and then goes through.
  const DATA = Buffer.alloc(160 * CHUNK, 9)
  const failing = (chunks: number, last = 0) => {
    const left = new Map<number, number>()
    for (let i = 0; i < chunks; i++) left.set(i * 10, 5)
    if (last) left.set(chunks * 10, last)
    return (args: string[], stdin: Buffer): Reply => {
      const i = chunkOf(args)
      if (i === null) return CUT
      const n = left.get(i) ?? 0
      if (n > 0) { left.set(i, n - 1); return CUT }
      return okChunk(stdin)
    }
  }
  const failures = () => {
    const sent = new Map<number, number>()
    for (const c of chunkCalls()) sent.set(chunkOf(c.args)!, (sent.get(chunkOf(c.args)!) ?? 0) + 1)
    return [...sent.values()].reduce((a, n) => a + n - 1, 0)
  }

  it('40 failures across 160 chunks still finish a resumed upload', async () => {
    respond = failing(8)
    const { conn } = setup(DATA)
    await expect(conn.uploadFile(REMOTE, DATA)).resolves.toEqual({ skipped: false })
    expect(failures()).toBe(40)
  })

  it('the 41st failure ends it', async () => {
    respond = failing(8, 1)
    const { conn } = setup(DATA)
    await expect(conn.uploadFile(REMOTE, DATA)).rejects.toThrow('upload failed: 41 total chunk failures across 160 chunks')
  })

  it('the daemon deploy\'s chunks still stop at 31 failures, from a clean dir', async () => {
    respond = failing(6, 1)
    const { conn, execs } = setup(DATA)
    const run = (conn as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>).pipeChunked(DATA, '/tmp/d/walnut-daemon.gz', '/tmp/d/deploy_chunks', 'binary deploy')
    await expect(run).rejects.toThrow('binary deploy failed: 31 total chunk failures across 160 chunks')
    expect(execs[0]).toBe(`rm -rf '/tmp/d/deploy_chunks' && mkdir -p '/tmp/d/deploy_chunks'`)
  })
})

describe('parsing the host\'s answers', () => {
  it('reads the precheck', () => {
    expect(parseUploadPrecheck('')).toBeNull()
    expect(parseUploadPrecheck('sha=abc\n')).toBeNull()
    expect(parseUploadPrecheck(`sha=${'a'.repeat(64)}\nsize=   42`)).toEqual({ sha: 'a'.repeat(64), size: 42 })
    expect(parseUploadPrecheck('sha=\nsize=42')).toEqual({ sha: '', size: 42 })
  })

  it('reads the chunk list in GNU, BSD and busybox shapes', () => {
    const have = parseChunkList(['262144 chunk_0000', '  262144 chunk_0001', '17 chunk_0012', '   524305 total', 'noise'].join('\n'))
    expect([...have.entries()]).toEqual([[0, 262144], [1, 262144], [12, 17]])
  })
})

describe('pipeChunked: a few chunks at a time, with progress', () => {
  const DATA = Buffer.alloc(10 * CHUNK + 5, 3)

  it('runs at most `parallel` chunks at once, more than one, and reports every byte', async () => {
    const { conn } = setup(DATA, { joinedSha: sha256(DATA) })
    ;(conn as unknown as Priv).chunkPacing = { backoffMs: [0, 0, 0, 0, 0], gapMs: 0, parallel: 3 }
    let inFlight = 0
    let peak = 0
    const seen: number[] = []
    vi.spyOn(conn as unknown as Record<string, (...a: unknown[]) => Promise<boolean>>, 'pipeChunk').mockImplementation(async (...a: unknown[]) => {
      inFlight++; peak = Math.max(peak, inFlight)
      seen.push(a[2] as number)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
      return true
    })
    const progress: number[] = []
    await conn.uploadFile(REMOTE, DATA, { onProgress: (sent, total) => { expect(total).toBe(DATA.length); progress.push(sent) } })
    expect(peak).toBe(3)
    expect([...seen].sort((x, y) => x - y)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(progress[0]).toBe(0)
    expect(progress.at(-1)).toBe(DATA.length)
    expect(progress).toEqual([...progress].sort((x, y) => x - y))
  })

  it('a chunk past its retries fails the upload, whatever the other lanes did', async () => {
    const { conn } = setup(DATA)
    ;(conn as unknown as Priv).chunkPacing = { backoffMs: [0, 0, 0, 0, 0], gapMs: 0, parallel: 3 }
    const calls: number[] = []
    vi.spyOn(conn as unknown as Record<string, (...a: unknown[]) => Promise<boolean>>, 'pipeChunk').mockImplementation(async (...a: unknown[]) => {
      calls.push(a[2] as number)
      await new Promise((r) => setTimeout(r, 1))
      return a[2] !== 1
    })
    await expect(conn.uploadFile(REMOTE, DATA)).rejects.toThrow(/chunk 2\/11 killed 6 times/)
    expect(calls.filter((c) => c === 1)).toHaveLength(6)
  })
})
