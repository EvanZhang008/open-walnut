/**
 * The letter size caps, as ONE ordered chain rather than four numbers that
 * happen to be in different files.
 *
 * Why this file exists: the original 200KB letter cap was not a policy, it was
 * the smallest number in the chain (the daemon's gateway request line), and
 * raising only the store cap changed nothing — the request still died a layer
 * earlier with "request line too large", an error that says nothing about
 * letters. The same trap is waiting in the other direction: raise the letter cap
 * past the WebSocket frame the phone's letter JSON crosses and a big letter stops
 * being a clean 413 and becomes a socket the peer CLOSES with 1009, taking every
 * other in-flight phone request with it.
 *
 * So the invariant is the ordering, and it is asserted here in one place:
 *
 *   plain fields  <  html body  <  gateway request line  <  WS frame maxPayload
 *                                                       ≤  express body limit
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  LETTER_BODY_MAX_BYTES,
  LETTER_HTML_MAX_BYTES,
  letterFieldMaxBytes,
} from '../../src/core/human-inbox/types.js'
import { GATEWAY_MAX_LINE_BYTES } from '../../src/providers/gateway-core.js'

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

describe('letter size caps form one ordered chain', () => {
  it('a plain field is smaller than an html body', () => {
    // The plain fields live in index.json and are re-read on every list, so they
    // stay small on purpose; html is the only field that carries media.
    expect(LETTER_BODY_MAX_BYTES).toBeLessThan(LETTER_HTML_MAX_BYTES)
  })

  it('the gateway request line clears the html body with room for the JSON wrapper', () => {
    // One `walnut tools call human_inbox_send` is ONE line: body + envelope +
    // escaping. Equal is not enough — the wrapper has to fit too.
    expect(GATEWAY_MAX_LINE_BYTES).toBeGreaterThan(LETTER_HTML_MAX_BYTES)
    const headroom = GATEWAY_MAX_LINE_BYTES - LETTER_HTML_MAX_BYTES
    expect(headroom).toBeGreaterThanOrEqual(2 * 1024 * 1024)
  })

  it('the whole write path stays under the WS frame that closes the socket', () => {
    // `ws` answers an oversized frame by CLOSING with 1009 before any handler
    // runs, so there is no way to turn this into an error response. Everything
    // that can ride one frame must be strictly smaller.
    const frame = wsFrameMaxBytes()
    expect(LETTER_HTML_MAX_BYTES).toBeLessThan(frame)
    expect(GATEWAY_MAX_LINE_BYTES).toBeLessThan(frame)
  })

  it('the express body limit can actually carry a maximum-size letter', () => {
    // Otherwise the store's 413 is unreachable and the caller gets Express's
    // bare HTML 413 instead of a contract-shaped one.
    expect(inboxBodyLimitBytes()).toBeGreaterThan(LETTER_HTML_MAX_BYTES)
  })

  it('the oversized-body error is contract-shaped, not Express default', () => {
    // entity.too.large is raised by the parser BEFORE any router, so the handler
    // has to be mounted at app level next to the parser or the phone gets an
    // error with no `error.code` to key its retry UX off.
    const server = read('src/web/server.ts')
    expect(server).toMatch(/inboxPayloadTooLargeHandler/)
    const route = read('src/web/routes/human-inbox-v1.ts')
    expect(route).toMatch(/entity\.too\.large/)
    expect(route).toMatch(/sendError\(res,\s*413,\s*'too_large'/)
  })

  it('both daemon twins carry the same gateway line cap', () => {
    // The bun twin imports the constant; the JS template cannot import, so it
    // hand-inlines a copy that must agree.
    const template = read('src/providers/daemon-source.ts')
    const mb = GATEWAY_MAX_LINE_BYTES / (1024 * 1024)
    expect(template).toContain(`GATEWAY_MAX_LINE_BYTES = ${mb} * 1024 * 1024`)
  })

  it('only html gets the media cap; every other field gets the plain one', () => {
    expect(letterFieldMaxBytes('html')).toBe(LETTER_HTML_MAX_BYTES)
    for (const field of ['markdown', 'text', 'freeText', 'subject', 'anything-else']) {
      expect(letterFieldMaxBytes(field)).toBe(LETTER_BODY_MAX_BYTES)
    }
  })

  it('the html cap is documented as a transport ceiling, not a policy', () => {
    // The number is the thing people reach for when a letter is refused. The
    // comment has to say WHY it cannot simply be removed, or the next person
    // raises it past the frame and turns a 413 into a dropped socket.
    const types = read('src/core/human-inbox/types.ts')
    expect(types).toMatch(/1009/)
    expect(types).toMatch(/maxPayload/)
  })
})
