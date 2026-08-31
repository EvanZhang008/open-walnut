/**
 * A letter body bigger than any frame on its path, end to end through the store.
 *
 * The claim under test is the one the caps file states abstractly: a document is
 * no longer bounded by what can cross a WebSocket frame, because it never crosses
 * one whole. Concretely:
 *
 *   - bytes arrive by STAGING (streamed to a file), then the letter carries a ref
 *   - the letter-detail JSON DEFERS a big document instead of embedding it
 *   - the document is readable in bounded slices, byte-exact across boundaries
 *
 * The last one is the subtle assertion. A slice boundary can land inside a
 * multi-byte character, so the reassembly has to concatenate BYTES and decode
 * once — decoding per slice is exactly how the daemon's old gateway listener
 * corrupted large payloads into replacement characters.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { Readable } from 'node:stream'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants())

import * as store from '../../src/core/human-inbox/store.js'
import * as staged from '../../src/core/human-inbox/staged-body.js'
import type { LetterSender } from '../../src/core/human-inbox/types.js'

const SENDER: LetterSender = { sessionId: 'sess-big', host: 'workstation' }

beforeEach(() => {
  fs.rmSync(store.humanInboxPaths.dir, { recursive: true, force: true })
  fs.rmSync(staged.stagingPaths.dir, { recursive: true, force: true })
})

/**
 * A body over the inline threshold that also exercises multi-byte decoding at
 * arbitrary offsets. The tail marker proves nothing was dropped.
 */
function bigHtml(): string {
  // Two-byte (é), three-byte (中) and four-byte (emoji) sequences, so a 2MB slice
  // boundary lands mid-character somewhere with near certainty.
  const unit = '<p>digest é 中 🎧 line</p>'
  const filler = unit.repeat(70_000)
  return `<h1>Big digest</h1>${filler}<p id="tail">TAIL-MARKER-9f3c</p>`
}

describe('a letter body past the inline threshold', () => {
  it('arrives by staging and is stored byte-identical', async () => {
    const html = bigHtml()
    const bytes = Buffer.byteLength(html, 'utf-8')
    expect(bytes).toBeGreaterThan(1024 * 1024)

    const { ref, bytes: stagedBytes } = await staged.stageBodyFromStream(
      Readable.from([Buffer.from(html, 'utf-8')]),
      100 * 1024 * 1024,
    )
    expect(stagedBytes).toBe(bytes)

    const letter = await store.sendLetter({
      subject: 'Big digest', type: 'info', htmlRef: ref, sender: SENDER,
    })
    // The staged file MOVED: a ref is single-use, so a retry can't double-write.
    await expect(staged.statStagedBody(ref)).rejects.toThrow(/is gone/)

    const stat = await store.statLetterBody(letter.id)
    expect(stat?.bytes).toBe(bytes)
    const onDisk = await fsp.readFile(stat!.path, 'utf-8')
    expect(onDisk).toBe(html)
  })

  it('is DEFERRED out of the letter-detail JSON, with a url instead', async () => {
    const html = bigHtml()
    const { ref } = await staged.stageBodyFromStream(
      Readable.from([Buffer.from(html, 'utf-8')]), 100 * 1024 * 1024,
    )
    const sent = await store.sendLetter({
      subject: 'Big digest', type: 'info', htmlRef: ref, sender: SENDER,
    })

    const detail = await store.getLetter(sent.id)
    expect(detail?.bodyDeferred).toBe(true)
    expect(detail?.body).toBeUndefined()
    expect(detail?.bodyBytes).toBe(Buffer.byteLength(html, 'utf-8'))
    expect(detail?.bodyUrl).toBe(`/api/v1/human-inbox/${sent.id}/body`)

    // The envelope still carries a usable preview — the point of peeking the
    // staged file rather than skipping the preview for big bodies.
    expect(sent.textPreview).toContain('Big digest')
  })

  it('an explicit caller can still ask for the bytes in process', async () => {
    const html = bigHtml()
    const { ref } = await staged.stageBodyFromStream(
      Readable.from([Buffer.from(html, 'utf-8')]), 100 * 1024 * 1024,
    )
    const sent = await store.sendLetter({
      subject: 'Big digest', type: 'info', htmlRef: ref, sender: SENDER,
    })
    const detail = await store.getLetter(sent.id, { inlineMaxBytes: Infinity })
    expect(detail?.bodyDeferred).toBeUndefined()
    expect(detail?.body).toBe(html)
  })

  it('reassembles byte-exactly from bounded slices across UTF-8 boundaries', async () => {
    const html = bigHtml()
    const { ref } = await staged.stageBodyFromStream(
      Readable.from([Buffer.from(html, 'utf-8')]), 100 * 1024 * 1024,
    )
    const sent = await store.sendLetter({
      subject: 'Big digest', type: 'info', htmlRef: ref, sender: SENDER,
    })

    // A deliberately awkward slice size: not a power of two, so boundaries land
    // inside multi-byte sequences rather than politely between them.
    const SLICE = 100_003
    const parts: Buffer[] = []
    let cursor = 0
    for (;;) {
      const slice = await store.readLetterBodyRange(sent.id, { start: cursor, length: SLICE })
      expect(slice).not.toBeNull()
      if (slice!.bytesRead === 0) break
      parts.push(slice!.data)
      cursor += slice!.bytesRead
      if (slice!.eof) break
    }
    expect(parts.length).toBeGreaterThan(10)
    // Bytes concatenated, THEN decoded — the whole point.
    expect(Buffer.concat(parts).toString('utf-8')).toBe(html)
    expect(cursor).toBe(Buffer.byteLength(html, 'utf-8'))
  })

  it('a small body is still inlined exactly as before', async () => {
    const sent = await store.sendLetter({
      subject: 'Small', type: 'info', html: '<p>hello</p>', sender: SENDER,
    })
    const detail = await store.getLetter(sent.id)
    expect(detail?.body).toBe('<p>hello</p>')
    expect(detail?.bodyDeferred).toBeUndefined()
    expect(detail?.bodyUrl).toBeUndefined()
    expect(detail?.bodyBytes).toBe(12)
  })

  it('refuses a staged body over the letter cap while streaming it', async () => {
    // Enforced as the bytes go past, not from a declared length: a sender can lie
    // about Content-Length, and the point of the lane is that nothing counted first.
    const tiny = 4096
    await expect(staged.stageBodyFromStream(
      Readable.from([Buffer.alloc(tiny * 4, 0x61)]), tiny,
    )).rejects.toThrow(/over the 4096-byte letter cap/)
    // Nothing half-written is left behind for a later ref to pick up.
    const names = fs.existsSync(staged.stagingPaths.dir)
      ? await fsp.readdir(staged.stagingPaths.dir) : []
    expect(names.filter(n => staged.STAGED_REF_RE.test(n))).toEqual([])
  })

  it('rejects a ref that is really a path', async () => {
    // The ref arrives from a caller and gets joined onto a directory, so this is
    // the traversal hole the shape check exists to close.
    for (const bad of ['../../config.yaml', '/etc/passwd', 'sb-../x', '']) {
      expect(() => staged.stagedBodyPath(bad)).toThrow(/not a staged body ref/)
    }
  })

  it('sweeps an upload that never became a letter', async () => {
    const { ref } = await staged.stageBodyFromBuffer(Buffer.from('<p>orphan</p>'))
    const p = staged.stagedBodyPath(ref)
    expect(fs.existsSync(p)).toBe(true)
    // Not yet: inside the TTL a concurrent send may still be about to claim it.
    expect(await staged.sweepStagedBodies(Date.now())).toBe(0)
    expect(await staged.sweepStagedBodies(Date.now() + staged.STAGED_BODY_TTL_MS + 1)).toBe(1)
    expect(fs.existsSync(p)).toBe(false)
  })

  it('rejects two body lanes at once rather than silently picking one', async () => {
    const { ref } = await staged.stageBodyFromBuffer(Buffer.from('<p>a</p>'))
    await expect(store.sendLetter({
      subject: 'Both', type: 'info', html: '<p>b</p>', htmlRef: ref, sender: SENDER,
    })).rejects.toThrow(/exactly one of html \| html_ref \| markdown/)
  })

  it('accepts the snake_case spelling the route and op use', async () => {
    const { ref } = await staged.stageBodyFromBuffer(Buffer.from('<p>snake</p>'))
    const sent = await store.sendLetter({
      subject: 'Snake', type: 'info', html_ref: ref, sender: SENDER,
    })
    const detail = await store.getLetter(sent.id)
    expect(detail?.body).toBe('<p>snake</p>')
  })

  it('defers a big THREAD turn body too, per turn', async () => {
    const sent = await store.sendLetter({
      subject: 'Threaded', type: 'info', html: '<p>opening</p>', sender: SENDER,
    })
    const html = bigHtml()
    const { ref } = await staged.stageBodyFromStream(
      Readable.from([Buffer.from(html, 'utf-8')]), 100 * 1024 * 1024,
    )
    await store.agentReply(sent.id, { text: 'the recording', htmlRef: ref })

    const detail = await store.getLetter(sent.id)
    // The letter's own small body is untouched; only the turn deferred.
    expect(detail?.body).toBe('<p>opening</p>')
    const turn = detail!.thread[0]
    expect(turn.bodyDeferred).toBe(true)
    expect(turn.body).toBeUndefined()
    expect(turn.bodyUrl).toBe(`/api/v1/human-inbox/${sent.id}/body?turn=0`)

    const slice = await store.readLetterBodyRange(sent.id, { turn: 0, start: 0, length: 64 })
    expect(slice?.fileSize).toBe(Buffer.byteLength(html, 'utf-8'))
  })
})
