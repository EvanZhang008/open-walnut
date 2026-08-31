/**
 * A cloud replica serves a letter body from its OWN disk when it has all of it.
 *
 * The body blob rides git-sync, so a replica normally holds a byte-identical copy
 * of every letter document. Relaying it back over the bridge anyway costs a round
 * trip per chunk per Range and, worse, makes a file the box already has depend on
 * the tunnel being up — which is how a phone got a 404/hang on a letter whose
 * bytes were sitting on the replica's disk the whole time.
 *
 * The rule this pins, and the reason the size comparison exists: local-first, but
 * a copy that is SHORT of the size the sender recorded must relay instead. Serving
 * a truncated document (a cut-off page, a half `<audio>`) reads as a corrupt
 * letter, which is worse than a slow one.
 *
 * Real express server on a real socket, real file streaming, real Range parsing.
 * The ONLY mock is the bridge call — this box has no primary to talk to.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { AddressInfo, Server } from 'node:net'
import express from 'express'
import { createMockConstants } from '../helpers/mock-constants.js'

// CLOUD_MODE: this test IS the replica.
vi.mock('../../src/constants.js', () => createMockConstants('walnut-inbox-local-first', { CLOUD_MODE: true }))

/** What the fake primary would hand back, and every pull it was asked for. */
const { relay } = vi.hoisted(() => ({
  relay: {
    /** The primary's copy of the document (Buffer), or null for "not found". */
    content: null as Buffer | null,
    format: 'html' as 'html' | 'markdown',
    calls: [] as Array<{ action: string; start: number; length: number }>,
  },
}))

vi.mock('../../src/web/routes/v1-control-relay.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/web/routes/v1-control-relay.js')>()
  return {
    ...actual,
    callPrimaryControl: async (
      action: string,
      _sid: string,
      params: Record<string, unknown> | undefined,
    ) => {
      const start = Number(params?.start ?? 0)
      const length = Number(params?.length ?? 0)
      relay.calls.push({ action, start, length })
      if (!relay.content) {
        return { ok: false as const, failure: { kind: 'not_found', status: 404, code: 'not_found', message: 'no letter on the primary either' } }
      }
      const slice = relay.content.subarray(start, start + length)
      return {
        ok: true as const,
        result: {
          data: slice.toString('base64'),
          bytesRead: slice.length,
          fileSize: relay.content.length,
          eof: start + slice.length >= relay.content.length,
          format: relay.format,
        },
      }
    },
  }
})

import { humanInboxPaths, sendLetter } from '../../src/core/human-inbox/store.js'
import { serveLetterBody } from '../../src/web/routes/human-inbox-body.js'
import type { LetterSender } from '../../src/core/human-inbox/types.js'

const SENDER: LetterSender = { sessionId: 'sess-replica', host: 'workstation' }

/** Big enough that a Range is meaningful, small enough to stay fast. */
const HTML = `<h1>Rollout report</h1>${'<p>a line of the report</p>'.repeat(400)}<p id="tail">TAIL-7c1</p>`

let server: Server
let port = 0

beforeAll(async () => {
  const app = express()
  app.get('/body/:id', async (req, res) => {
    await serveLetterBody(req, res, String(req.params.id))
  })
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve())
  })
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

beforeEach(() => {
  fs.rmSync(humanInboxPaths.dir, { recursive: true, force: true })
  relay.content = Buffer.from(HTML, 'utf-8')
  relay.format = 'html'
  relay.calls.length = 0
})

async function get(id: string, range?: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/body/${encodeURIComponent(id)}`, {
    headers: range ? { Range: range } : {},
  })
}

/** A letter whose index entry AND body file are both on this box (the synced case). */
async function syncedLetter(): Promise<string> {
  const letter = await sendLetter({
    subject: 'Rollout report',
    type: 'review',
    html: HTML,
    sender: SENDER,
  })
  return letter.id
}

function bodyPath(id: string): string {
  return path.join(humanInboxPaths.bodiesDir, `${id}.html`)
}

describe('the local copy is complete', () => {
  it('serves the whole document off local disk without touching the bridge', async () => {
    const id = await syncedLetter()

    const res = await get(id)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(HTML)
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    expect(res.headers.get('content-length')).toBe(String(Buffer.byteLength(HTML, 'utf-8')))
    expect(res.headers.get('content-type')).toMatch(/text\/html/)
    expect(relay.calls).toEqual([])
  })

  it('answers a Range from local disk, byte-exact, still with no bridge call', async () => {
    const id = await syncedLetter()
    const bytes = Buffer.from(HTML, 'utf-8')

    const res = await get(id, 'bytes=100-199')
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe(`bytes 100-199/${bytes.length}`)
    expect(Buffer.from(await res.arrayBuffer())).toEqual(bytes.subarray(100, 200))
    expect(relay.calls).toEqual([])
  })

  it('still answers 416 for a range past the end (a player must not get a 200)', async () => {
    const id = await syncedLetter()
    const res = await get(id, `bytes=${Buffer.byteLength(HTML, 'utf-8') + 10}-`)
    expect(res.status).toBe(416)
    expect(relay.calls).toEqual([])
  })
})

describe('the local copy is not usable', () => {
  it('relays when the blob has not synced yet, and serves the FULL document', async () => {
    const id = await syncedLetter()
    await fsp.rm(bodyPath(id))

    const res = await get(id)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(HTML)
    expect(relay.calls.length).toBeGreaterThan(0)
    expect(relay.calls[0].action).toBe('server.human-inbox.body')
  })

  it('relays when the local blob is SHORT of the size the sender recorded', async () => {
    const id = await syncedLetter()
    // A half-synced blob. This is the case a naive local-first would serve as the
    // document, handing the reader a truncated page with a 200.
    const truncated = Buffer.from(HTML, 'utf-8').subarray(0, 500)
    await fsp.writeFile(bodyPath(id), truncated)

    const res = await get(id)
    expect(res.status).toBe(200)
    const served = await res.text()
    expect(served).toBe(HTML)
    expect(served.length).toBeGreaterThan(truncated.length)
    expect(relay.calls.length).toBeGreaterThan(0)
  })

  it('relays when the local blob is LONGER than the sender recorded', async () => {
    const id = await syncedLetter()
    // The realistic way a body GROWS on a box that never writes letters: a git
    // merge left conflict markers in it. The sync's marker self-heal only repairs
    // JSON stores, so a markdown or html body keeps them — and a size check that
    // only guarded against SHORT files would happily serve the marker text as the
    // document, which is exactly the corruption the relay used to make impossible.
    const polluted = Buffer.concat([
      Buffer.from(HTML, 'utf-8'),
      Buffer.from('\n<<<<<<< HEAD\n<p>local</p>\n=======\n<p>remote</p>\n>>>>>>> origin/main\n', 'utf-8'),
    ])
    await fsp.writeFile(bodyPath(id), polluted)

    const res = await get(id)
    expect(res.status).toBe(200)
    const served = await res.text()
    expect(served).toBe(HTML)
    expect(served).not.toMatch(/<<<<<<</)
    expect(relay.calls.length).toBeGreaterThan(0)
  })

  it('relays a Range too, and the bridge answer is what the client gets', async () => {
    const id = await syncedLetter()
    await fsp.rm(bodyPath(id))
    const bytes = Buffer.from(HTML, 'utf-8')

    const res = await get(id, 'bytes=50-149')
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe(`bytes 50-149/${bytes.length}`)
    expect(Buffer.from(await res.arrayBuffer())).toEqual(bytes.subarray(50, 150))
    expect(relay.calls[0].start).toBe(50)
  })

  it('reports the primary\'s own failure when neither box has the letter', async () => {
    relay.content = null
    const res = await get('lt-nosuch-999999')
    expect(res.status).toBe(404)
    expect(relay.calls.length).toBeGreaterThan(0)
  })
})

describe('a letter written before bodyBytes existed', () => {
  it('is served locally when the file is present (bodies are write-once)', async () => {
    const id = await syncedLetter()
    // Strip the recorded size, the way an older index.json has it.
    const index = JSON.parse(fs.readFileSync(humanInboxPaths.indexFile, 'utf-8'))
    for (const letter of index.letters) delete letter.bodyBytes
    fs.writeFileSync(humanInboxPaths.indexFile, JSON.stringify(index), 'utf-8')

    const res = await get(id)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(HTML)
    expect(relay.calls).toEqual([])
  })
})
