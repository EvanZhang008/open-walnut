/**
 * src/lib/fetch-error.ts reads a failed fetch the same way on Node and on bun.
 * Each shape below is the one that runtime really throws (captured from Node 25
 * and bun 1.4.4); the last block fails real requests on the runtime running the
 * test, which in this repo is bun.
 */
import http from 'node:http'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { fetchErrorCode, fetchErrorDetail, fetchErrorText, isFetchAbort } from '../../src/lib/fetch-error.js'

/** Node (undici): TypeError "fetch failed", the socket error on `cause`. */
function nodeShape(code: string, message: string): Error {
  return new TypeError('fetch failed', { cause: Object.assign(new Error(message), { code }) })
}
/** Bun: the code on the error itself, no cause. */
function bunShape(code: string, message: string): Error {
  return Object.assign(new TypeError(message), { code, errno: 0 })
}
const BUN_RESET = 'ECONNRESET: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()'

describe('fetchErrorCode', () => {
  it('reads the code from Node\'s cause and from bun\'s error', () => {
    expect(fetchErrorCode(nodeShape('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:9'))).toBe('ECONNREFUSED')
    expect(fetchErrorCode(bunShape('ECONNREFUSED', 'ECONNREFUSED: Unable to connect. Is the computer able to access the url?'))).toBe('ECONNREFUSED')
    expect(fetchErrorCode(nodeShape('UND_ERR_SOCKET', 'other side closed'))).toBe('UND_ERR_SOCKET')
    expect(fetchErrorCode(bunShape('ECONNRESET', BUN_RESET))).toBe('ECONNRESET')
    expect(fetchErrorCode(bunShape('DEPTH_ZERO_SELF_SIGNED_CERT', 'self signed certificate'))).toBe('DEPTH_ZERO_SELF_SIGNED_CERT')
  })

  it('a timeout\'s numeric DOMException code is no socket code; no error, no code', () => {
    expect(fetchErrorCode(new DOMException('The operation timed out.', 'TimeoutError'))).toBe('')
    expect(fetchErrorCode(new Error('plain'))).toBe('')
    expect(fetchErrorCode(undefined)).toBe('')
    expect(fetchErrorCode('text')).toBe('')
  })
})

describe('isFetchAbort', () => {
  it('a timeout or an abort on either runtime, never a socket error', () => {
    expect(isFetchAbort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))).toBe(true)
    expect(isFetchAbort(new DOMException('The operation timed out.', 'TimeoutError'))).toBe(true)
    expect(isFetchAbort(new DOMException('This operation was aborted', 'AbortError'))).toBe(true)
    expect(isFetchAbort(bunShape('ECONNRESET', BUN_RESET))).toBe(false)
    expect(isFetchAbort(null)).toBe(false)
  })
})

describe('fetchErrorText and fetchErrorDetail', () => {
  it('Node: "fetch failed" with the code it hides; the detail is the socket error\'s words', () => {
    const err = nodeShape('ECONNRESET', 'read ECONNRESET')
    expect(fetchErrorText(err)).toBe('fetch failed (ECONNRESET)')
    expect(fetchErrorDetail(err)).toBe('read ECONNRESET')
  })

  it('bun: its own message, which names the code, without the hint about `verbose: true`', () => {
    const err = bunShape('ECONNRESET', BUN_RESET)
    expect(fetchErrorText(err)).toBe('ECONNRESET: The socket connection was closed unexpectedly.')
    expect(fetchErrorDetail(err)).toBe('ECONNRESET: The socket connection was closed unexpectedly.')
  })

  it('a code the message does not name rides along; a plain error is itself', () => {
    expect(fetchErrorText(bunShape('ENOTFOUND', 'no such host'))).toBe('no such host (ENOTFOUND)')
    expect(fetchErrorText(new Error('plain'))).toBe('plain')
    expect(fetchErrorText('text')).toBe('text')
  })
})

describe('real failures on this runtime', () => {
  it('a refused connection, a reset one and a timeout read as such', async () => {
    const closed = http.createServer()
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', () => r()))
    const port = (closed.address() as AddressInfo).port
    await new Promise<void>((r) => closed.close(() => r()))
    const refused = await fetch(`http://127.0.0.1:${port}/`).catch((e: unknown) => e)
    expect(fetchErrorCode(refused)).toBe('ECONNREFUSED')
    expect(isFetchAbort(refused)).toBe(false)

    const resetting = net.createServer((s) => s.destroy())
    const silent = net.createServer(() => { /* never answers */ })
    const held: net.Socket[] = []
    silent.on('connection', (s) => held.push(s))
    await new Promise<void>((r) => resetting.listen(0, '127.0.0.1', () => r()))
    await new Promise<void>((r) => silent.listen(0, '127.0.0.1', () => r()))
    try {
      const reset = await fetch(`http://127.0.0.1:${(resetting.address() as AddressInfo).port}/`).catch((e: unknown) => e)
      expect(['ECONNRESET', 'UND_ERR_SOCKET', 'EPIPE']).toContain(fetchErrorCode(reset))
      expect(fetchErrorText(reset)).not.toBe('fetch failed')
      const timedOut = await fetch(`http://127.0.0.1:${(silent.address() as AddressInfo).port}/`, { signal: AbortSignal.timeout(150) }).catch((e: unknown) => e)
      expect(isFetchAbort(timedOut)).toBe(true)
      expect(fetchErrorCode(timedOut)).toBe('')
    } finally {
      held.forEach((s) => s.destroy())
      await new Promise<void>((r) => resetting.close(() => r()))
      await new Promise<void>((r) => silent.close(() => r()))
    }
  })
})
