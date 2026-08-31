/**
 * The gateway's big-payload lane: the request carries a PATH, the hub pulls the
 * file back in batches.
 *
 * Why this exists. A `walnut tools call` is ONE NDJSON line on a unix socket and
 * then ONE WebSocket frame to the hub, so inlining a 100MB letter body made the
 * biggest thing an agent could send a property of the framing — and `ws` answers
 * an oversized frame by closing the socket with 1009, which is not an error a
 * caller can read. This is the "just batch it" answer: over
 * GATEWAY_INLINE_ARGS_MAX_BYTES the CLI sends only `argsFile`, and the hub reads
 * it through the same bounded `fs.readRange` primitive whale session files use.
 *
 * The assertions worth having here are the two failure modes that would be
 * invisible otherwise: a slice boundary landing inside a multi-byte character
 * (decode per chunk and the JSON silently breaks), and a file bigger than the
 * ceiling (read it and the hub allocates it).
 */
import { describe, it, expect } from 'vitest'
import {
  GATEWAY_ARGS_FILE_MAX_BYTES,
  GatewayArgsFileError,
  pullArgsFile,
  type ArgsFilePullDeps,
} from '../../../src/core/peers/gateway-args-file.js'
import { HUMAN_INBOX_CHUNK_BYTES } from '../../../src/core/human-inbox/types.js'

/** A daemon stand-in that serves one in-memory file and records every read. */
function fakeHost(content: Buffer, opts: { reportedSize?: number } = {}) {
  const reads: Array<{ start: number; length: number }> = []
  const deps: ArgsFilePullDeps = {
    async readRange(_host, _path, start, length) {
      reads.push({ start, length })
      if (start >= content.length) {
        return { buf: Buffer.alloc(0), fileSize: opts.reportedSize ?? content.length, eof: true }
      }
      const buf = content.subarray(start, Math.min(start + length, content.length))
      return {
        buf,
        fileSize: opts.reportedSize ?? content.length,
        eof: start + buf.length >= content.length,
      }
    },
  }
  return { deps, reads }
}

describe('pullArgsFile', () => {
  it('reassembles a multi-MB payload in bounded slices', async () => {
    // Multi-byte characters throughout, so slice boundaries land mid-character.
    const html = `<h1>Digest</h1>${'<p>é 中 🎧</p>'.repeat(600_000)}<p>TAIL-9f3c</p>`
    const payload = { subject: 'Digest', type: 'info', html }
    const content = Buffer.from(JSON.stringify(payload), 'utf-8')
    expect(content.length).toBeGreaterThan(4 * HUMAN_INBOX_CHUNK_BYTES)

    const { deps, reads } = fakeHost(content)
    const args = await pullArgsFile('clouddev', '/tmp/payload.json', deps)

    // Byte-exact after reassembly — the whole point. Decoding per slice would
    // leave replacement characters and JSON.parse would have thrown above.
    expect(args.html).toBe(html)
    expect(args.subject).toBe('Digest')

    // Batched, and every batch bounded.
    expect(reads.length).toBeGreaterThan(3)
    for (const r of reads) expect(r.length).toBeLessThanOrEqual(HUMAN_INBOX_CHUNK_BYTES)
    // Contiguous, no gaps and no re-reads.
    let expected = 0
    for (const r of reads) {
      expect(r.start).toBe(expected)
      expected += Math.min(r.length, content.length - r.start)
    }
  })

  it('reads a small payload in one slice', async () => {
    const content = Buffer.from(JSON.stringify({ id: 'abc' }), 'utf-8')
    const { deps, reads } = fakeHost(content)
    expect(await pullArgsFile('h', '/tmp/a.json', deps)).toEqual({ id: 'abc' })
    expect(reads).toHaveLength(1)
  })

  it('treats an empty file as empty args, not a parse error', async () => {
    const { deps } = fakeHost(Buffer.alloc(0))
    expect(await pullArgsFile('h', '/tmp/empty.json', deps)).toEqual({})
  })

  it('refuses a file over the payload ceiling WITHOUT reading it', async () => {
    // The size is known from the first slice's fileSize, so the refusal costs one
    // round trip rather than a 40GB read.
    const { deps, reads } = fakeHost(Buffer.from('{"a":1}'), {
      reportedSize: GATEWAY_ARGS_FILE_MAX_BYTES + 1,
    })
    await expect(pullArgsFile('h', '/tmp/huge.json', deps))
      .rejects.toThrow(/over the \d+-byte gateway payload ceiling/)
    expect(reads).toHaveLength(1)
  })

  it('reports a missing file as a gateway error naming the host', async () => {
    const deps: ArgsFilePullDeps = { async readRange() { return null } }
    await expect(pullArgsFile('clouddev', '/tmp/gone.json', deps))
      .rejects.toThrow(/argsFile not found on clouddev: \/tmp\/gone\.json/)
  })

  it('rejects a relative path — the hub must not guess a working directory', async () => {
    const { deps } = fakeHost(Buffer.from('{}'))
    await expect(pullArgsFile('h', 'payload.json', deps))
      .rejects.toThrow(/must be an absolute path/)
    await expect(pullArgsFile('h', '~/payload.json', deps))
      .rejects.toThrow(/must be an absolute path/)
  })

  it('names the file when its contents are not JSON, or not an object', async () => {
    const broken = fakeHost(Buffer.from('{not json'))
    await expect(pullArgsFile('h', '/tmp/x.json', broken.deps))
      .rejects.toThrow(/not valid JSON \(\/tmp\/x\.json on h\)/)

    const arrayish = fakeHost(Buffer.from('[1,2,3]'))
    await expect(pullArgsFile('h', '/tmp/y.json', arrayish.deps))
      .rejects.toThrow(/must contain a JSON object/)
  })

  it('every failure is a GatewayArgsFileError, so the router can answer bad_request', async () => {
    const deps: ArgsFilePullDeps = { async readRange() { return null } }
    await expect(pullArgsFile('h', '/tmp/gone.json', deps)).rejects.toBeInstanceOf(GatewayArgsFileError)
  })
})
