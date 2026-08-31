/**
 * The letter size caps, as ONE ordered chain rather than numbers that happen to
 * live in different files.
 *
 * Why this file exists: the original 200KB letter cap was not a policy, it was
 * the smallest number in the chain (the daemon's gateway request line), and
 * raising only the store cap changed nothing — the request still died a layer
 * earlier with "request line too large", an error that says nothing about
 * letters.
 *
 * The chain has since been SPLIT, and that is the invariant now. There are two
 * lanes, and a size only has to fit the lane it uses:
 *
 *   INLINE lane (small letters, one round trip)
 *     plain fields  <  inline body threshold  <  gateway line  ≤  express limit
 *                                                              <  WS maxPayload
 *
 *   BATCHED lane (anything bigger, up to LETTER_HTML_MAX_BYTES = 100MB)
 *     in:  the payload rides a FILE on the sender's host; the hub pulls it in
 *          HUMAN_INBOX_CHUNK_BYTES slices (gateway `argsFile`)
 *     out: GET /:id/body streams it, and a replica serves each Range by looping
 *          the bounded `server.human-inbox.body` pull
 *     the only size that must clear a frame is ONE CHUNK
 *
 * The trap this pins is unchanged in spirit: anything that can cross a WebSocket
 * frame WHOLE must stay under maxPayload, because `ws` answers an oversized frame
 * by CLOSING the socket with 1009 before any handler runs — taking every other
 * in-flight phone request with it. What changed is that a letter body is no
 * longer one of those things.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  HUMAN_INBOX_CHUNK_BYTES,
  LETTER_BODY_MAX_BYTES,
  LETTER_HTML_MAX_BYTES,
  LETTER_INLINE_BODY_MAX_BYTES,
  letterFieldMaxBytes,
} from '../../src/core/human-inbox/types.js'
import { GATEWAY_MAX_LINE_BYTES } from '../../src/providers/gateway-core.js'
import { GATEWAY_INLINE_ARGS_MAX_BYTES } from '../../src/providers/tool-args-source.js'
import { GATEWAY_ARGS_FILE_MAX_BYTES } from '../../src/core/peers/gateway-args-file.js'

const ROOT = path.resolve(__dirname, '../..')
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf-8')

/** The `ws` maxPayload, read from the source of truth rather than duplicated. */
function wsFrameMaxBytes(): number {
  const src = read('src/web/ws/handler.ts')
  const m = src.match(/maxPayload:\s*(\d+)\s*\*\s*1024\s*\*\s*1024/)
  expect(m, 'attachWss must set an explicit maxPayload').not.toBeNull()
  return Number(m![1]) * 1024 * 1024
}

/** The express json limit mounted on the human-inbox write routes. */
function inboxBodyLimitBytes(): number {
  const src = read('src/web/server.ts')
  const m = src.match(
    /human-inbox['"][^\n]*\n?[^\n]*express\.json\(\{\s*limit:\s*'(\d+)mb'/,
  )
  expect(m, 'the human-inbox routes must mount their own express.json limit').not.toBeNull()
  return Number(m![1]) * 1024 * 1024
}

describe('the inline lane still fits every frame it crosses', () => {
  it('a plain field is smaller than the inline body threshold', () => {
    // Consequence worth stating: markdown (200KB) can never be DEFERRED, so a
    // deferred document is by construction html. Both readers rely on that.
    expect(LETTER_BODY_MAX_BYTES).toBeLessThan(LETTER_INLINE_BODY_MAX_BYTES)
  })

  it('an inline body clears the gateway line with room for the JSON wrapper', () => {
    // A small `walnut tools call human_inbox_send` is still ONE line: body +
    // envelope + escaping. Equal is not enough — the wrapper has to fit too.
    expect(GATEWAY_MAX_LINE_BYTES).toBeGreaterThan(GATEWAY_INLINE_ARGS_MAX_BYTES)
    expect(GATEWAY_MAX_LINE_BYTES - GATEWAY_INLINE_ARGS_MAX_BYTES).toBeGreaterThanOrEqual(2 * 1024 * 1024)
  })

  it('everything that can ride ONE frame whole stays under maxPayload', () => {
    // `ws` answers an oversized frame by CLOSING with 1009 before any handler
    // runs, so there is no way to turn this into an error response.
    const frame = wsFrameMaxBytes()
    expect(GATEWAY_MAX_LINE_BYTES).toBeLessThan(frame)
    // A replica relays a whole inline letter JSON to the primary in one frame.
    expect(inboxBodyLimitBytes()).toBeLessThan(frame)
    expect(inboxBodyLimitBytes()).toBeGreaterThan(LETTER_INLINE_BODY_MAX_BYTES)
  })
})

describe('the batched lane is bounded per CHUNK, not per document', () => {
  it('a letter body may be far bigger than any frame on its path', () => {
    // This is the whole point of the split: 100MB > every transport number here,
    // and that is CORRECT because the document is never framed whole.
    const frame = wsFrameMaxBytes()
    expect(LETTER_HTML_MAX_BYTES).toBeGreaterThan(frame)
    expect(LETTER_HTML_MAX_BYTES).toBeGreaterThan(GATEWAY_MAX_LINE_BYTES)
    expect(LETTER_HTML_MAX_BYTES).toBeGreaterThan(LETTER_INLINE_BODY_MAX_BYTES)
  })

  it('one chunk clears the frame with a large margin', () => {
    // The ONLY size in the batched lane that touches a frame. The margin matters
    // as much as the comparison: base64 inflates a slice by 4/3 on the bridge.
    const frame = wsFrameMaxBytes()
    expect(HUMAN_INBOX_CHUNK_BYTES).toBeLessThan(frame / 4)
  })

  it('the gateway payload ceiling clears the biggest letter it must carry', () => {
    // Otherwise a 100MB letter would be refused by the transfer lane rather than
    // by the op, with an error that says nothing about letters — the exact trap
    // the old 200KB cap was.
    expect(GATEWAY_ARGS_FILE_MAX_BYTES).toBeGreaterThan(LETTER_HTML_MAX_BYTES)
  })

  it('a big payload leaves the gateway line entirely', () => {
    expect(GATEWAY_INLINE_ARGS_MAX_BYTES).toBeLessThan(LETTER_HTML_MAX_BYTES)
  })
})

describe('the mechanisms the caps depend on are actually wired', () => {
  it('the oversized-inline error names the staging lane', () => {
    // entity.too.large is raised by the parser BEFORE any router, so the handler
    // has to be mounted at app level next to the parser or the phone gets an
    // error with no `error.code` to key its retry UX off. And the message has to
    // point somewhere: "too large" with no alternative is what made this look
    // like a hard product limit.
    const server = read('src/web/server.ts')
    expect(server).toMatch(/inboxPayloadTooLargeHandler/)
    const route = read('src/web/routes/human-inbox-v1.ts')
    expect(route).toMatch(/entity\.too\.large/)
    expect(route).toMatch(/sendError\(res,\s*413,\s*'too_large'/)
    expect(route).toMatch(/html_ref/)
    expect(route).toMatch(/POST \/api\/v1\/human-inbox\/body/)
  })

  it('the streaming body route and its relay action both exist', () => {
    const route = read('src/web/routes/human-inbox-v1.ts')
    expect(route).toMatch(/human-inbox\/:id\/body/)
    const body = read('src/web/routes/human-inbox-body.ts')
    expect(body).toMatch(/Accept-Ranges/)
    expect(body).toMatch(/server\.human-inbox\.body/)
    // A replica must LOOP the bounded pull, not relay the document in one go.
    expect(body).toMatch(/HUMAN_INBOX_CHUNK_BYTES/)
    const controls = read('src/core/sessions/session-controls.ts')
    expect(controls).toMatch(/'server\.human-inbox\.body'/)
    const relay = read('src/core/human-inbox/relay.ts')
    expect(relay).toMatch(/case 'body'/)
  })

  it('both daemon twins carry the same gateway line cap', () => {
    // The bun twin imports the constant; the JS template cannot import, so it
    // hand-inlines a copy that must agree.
    const template = read('src/providers/daemon-source.ts')
    const mb = GATEWAY_MAX_LINE_BYTES / (1024 * 1024)
    expect(template).toContain(`GATEWAY_MAX_LINE_BYTES = ${mb} * 1024 * 1024`)
  })

  it('both CLI faces agree on when a payload leaves the request', () => {
    // Three implementations of `walnut tools call` exist (wn-cli.ts, the hub CLI,
    // and the hand-inlined twin inside the daemon-source template). The template
    // is the one that gets forgotten — a remote host then keeps inlining a 100MB
    // payload and dies at the gateway line, looking like a server bug.
    const template = read('src/providers/daemon-source.ts')
    const bytes = GATEWAY_INLINE_ARGS_MAX_BYTES / 1024
    expect(template).toContain(`GATEWAY_INLINE_ARGS_MAX_BYTES = ${bytes} * 1024`)
    expect(template).toMatch(/argsFile: wnArgsFile/)
    const cli = read('src/providers/wn-cli.ts')
    expect(cli).toMatch(/GATEWAY_INLINE_ARGS_MAX_BYTES/)
    expect(cli).toMatch(/argsFile/)
  })

  it('only html gets the media cap; every other field gets the plain one', () => {
    expect(letterFieldMaxBytes('html')).toBe(LETTER_HTML_MAX_BYTES)
    for (const field of ['markdown', 'text', 'freeText', 'subject', 'anything-else']) {
      expect(letterFieldMaxBytes(field)).toBe(LETTER_BODY_MAX_BYTES)
    }
  })

  it('types.ts explains why the frame is no longer the ceiling', () => {
    // The number is the thing people reach for when a letter is refused. The
    // comment has to say what changed, or the next person reads 100MB, sees the
    // 32MB frame, and "fixes" the cap back down.
    const types = read('src/core/human-inbox/types.ts')
    expect(types).toMatch(/1009/)
    expect(types).toMatch(/maxPayload/)
    expect(types).toMatch(/batch/i)
  })

  it('the reader frame is ONE module, shared by the console and the server', () => {
    // The server streams a big body pre-wrapped in the reader's frame. A second
    // copy of the CSP would let a 100MB letter render under a weaker policy than
    // a 100KB one — the failure would be silent on both surfaces.
    const frame = read('src/core/human-inbox/letter-frame.ts')
    expect(frame).toMatch(/media-src data: blob:/)
    expect(frame).toMatch(/default-src 'none'/)
    const webRe = read('web/src/components/inbox/letter-html-frame.ts')
    expect(webRe).toMatch(/@open-walnut\/letter-frame/)
    expect(webRe).not.toMatch(/default-src/)
  })
})
