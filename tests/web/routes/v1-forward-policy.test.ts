/**
 * What crosses from the companion to the Mac (src/web/v1-forward/policy.ts):
 * which routes the companion keeps, which paths are acceptable, which headers
 * cross either way. Both boxes read this table, so a mistake here is a mistake
 * on both.
 */
import { describe, expect, it } from 'vitest'
import {
  companionAnswers, forwardRequestHeaders, forwardResponseHeaders, parseForwardUrl,
} from '../../../src/web/v1-forward/policy.js'

describe('companionAnswers: the routes the companion keeps', () => {
  it.each([
    ['GET', '/events', 'stream'],
    ['GET', '/sessions/abc/stream', 'stream'],
    ['GET', '/conversations/c1/stream', 'stream'],
    ['POST', '/sessions/abc/messages', 'send'],
    ['POST', '/conversations/c1/messages', 'send'],
    ['GET', '/sessions/abc/messages/qm-mobile-1', 'send'],
    ['GET', '/sessions/abc/queue', 'send'],
    ['POST', '/sessions/abc/terminate', 'send'],
    ['GET', '/conversations', 'chat'],
    ['POST', '/conversations', 'chat'],
    ['GET', '/conversations/c1/messages', 'chat'],
    ['DELETE', '/conversations/c1', 'chat'],
    ['POST', '/devices/self', 'identity'],
    ['POST', '/devices/adopt', 'identity'],
    ['GET', '/status', 'identity'],
    ['GET', '/canary', 'identity'],
    ['GET', '/me', 'identity'],
    ['GET', '/me/open', 'identity'],
    ['GET', '/instance', 'identity'],
    ['GET', '/routes', 'identity'],
    ['POST', '/client-logs', 'identity'],
    ['GET', '/media', 'bytes'],
    ['POST', '/stt/transcribe', 'bytes'],
    ['GET', '/file-content', 'bytes'],
    ['PUT', '/file-content', 'bytes'],
    ['GET', '/file-raw/devbox/a/b.png', 'bytes'],
    ['GET', '/timeline/images/2026-10-07/a.jpg', 'bytes'],
    ['GET', '/notes/attachment', 'bytes'],
    ['DELETE', '/notes/attachment/a/b.png', 'bytes'],
    ['GET', '/human-inbox/l1/body', 'bytes'],
    ['POST', '/health/sync', 'device-data'],
    ['GET', '/places/status', 'device-data'],
    ['POST', '/time/heartbeats', 'device-data'],
    ['GET', '/tasks', 'task-copy'],
    ['POST', '/tasks', 'task-copy'],
    ['GET', '/tasks/t1', 'task-copy'],
    ['PATCH', '/tasks/t1', 'task-copy'],
    ['POST', '/tasks/t1/complete', 'task-copy'],
    ['GET', '/tasks/meta/tags', 'task-copy'],
    ['PUT', '/focus/reorder', 'task-copy'],
    ['GET', '/sessions', 'paged'],
    ['GET', '/sessions/abc/transcript', 'paged'],
    ['GET', '/sessions/abc/history', 'paged'],
    ['GET', '/sessions/launch-options', 'launch'],
    ['POST', '/sessions', 'launch'],
  ])('%s %s stays on the companion (%s)', (method, rel, why) => {
    expect(companionAnswers(method, rel)).toBe(why)
  })

  it.each([
    ['GET', '/usage/overview'],
    ['GET', '/usage/summary'],
    ['PATCH', '/projects/Acme'],
    ['DELETE', '/projects/Acme'],
    ['GET', '/notes/content/Projects/Release.md'],
    ['PUT', '/notes/content/Projects/Release.md'],
    ['GET', '/search'],
    ['GET', '/routines'],
    ['POST', '/routines/r1/run'],
    ['GET', '/human-inbox'],
    ['POST', '/human-inbox/l1/answer'],
    ['GET', '/human-inbox/l1'],
    ['GET', '/human-inbox/l1/bodyguard'],
    ['GET', '/tasks/t1/board'],
    ['PUT', '/tasks/t1/board'],
    ['POST', '/tasks/t1/board/edits'],
    ['PUT', '/tasks/t1/board/cards/t2'],
    ['GET', '/sessions/abc'],
    ['GET', '/sessions/abc/model-options'],
    ['POST', '/sessions/abc/model'],
    ['PATCH', '/sessions/abc/queue/qm-1'],
    ['DELETE', '/sessions/abc/queue/qm-1'],
    ['POST', '/sessions/abc/restart'],
    ['GET', '/sessions/recent'],
    ['POST', '/actions/invoke'],
    ['GET', '/heartbeat/checklist'],
    ['GET', '/memory/global'],
  ])('%s %s goes to the Mac while it answers', (method, rel) => {
    expect(companionAnswers(method, rel)).toBeNull()
  })

  // The r4d gate's R6: the GET-only kept routes forwarded a HEAD to the Mac.
  it('a HEAD is kept or forwarded exactly as its GET is', () => {
    for (const rel of ['/sessions/abc/messages/qm-mobile-1', '/sessions/abc/queue', '/sessions', '/sessions/abc/transcript', '/me', '/tasks']) {
      expect(companionAnswers('HEAD', rel), rel).toBe(companionAnswers('GET', rel))
      expect(companionAnswers('head', rel), rel).not.toBeNull()
    }
    for (const rel of ['/sessions/abc', '/sessions/abc/model-options', '/usage/overview']) {
      expect(companionAnswers('HEAD', rel), rel).toBeNull()
    }
    // HEAD reads like GET only: it never takes a POST-only route.
    expect(companionAnswers('HEAD', '/sessions/abc/terminate')).toBeNull()
    expect(companionAnswers('HEAD', '/sessions/abc/messages')).toBeNull()
  })

  it('a session path that only begins like a kept one goes to the Mac', () => {
    expect(companionAnswers('GET', '/sessions/abc/streamer')).toBeNull()
    expect(companionAnswers('GET', '/statusboard')).toBeNull()
    expect(companionAnswers('GET', '/mediator')).toBeNull()
    expect(companionAnswers('GET', '/tasksets')).toBeNull()
    expect(companionAnswers('GET', '/conversationsx')).toBeNull()
  })
})

describe('parseForwardUrl', () => {
  it('takes a /api/v1 path with its query', () => {
    expect(parseForwardUrl('/api/v1/usage/daily?days=7&x=%20y')).toEqual({
      rel: '/usage/daily', pathname: '/api/v1/usage/daily', search: '?days=7&x=%20y',
    })
  })

  it.each([
    ['not under /api/v1', '/api/tasks'],
    ['the bare prefix', '/api/v1'],
    ['a sibling prefix', '/api/v10/x'],
    ['a dot segment', '/api/v1/notes/../../config'],
    ['an encoded dot segment', '/api/v1/notes/%2e%2e/config'],
    ['a doubly encoded dot segment', '/api/v1/notes/%252e%252e/config'],
    ['a doubled slash', '/api/v1//etc'],
    ['a backslash', '/api/v1/notes\\x'],
    ['a NUL', '/api/v1/notes\0x'],
    ['a fragment', '/api/v1/notes#x'],
    ['a line break', '/api/v1/notes\r\nX-Evil: 1'],
    ['a bad escape', '/api/v1/notes/%zz'],
    ['an empty string', ''],
    ['a number', 42],
    ['a very long path', `/api/v1/${'a'.repeat(5000)}`],
  ])('refuses %s', (_what, url) => {
    expect(parseForwardUrl(url)).toBeNull()
  })

  it('keeps Unicode in a note path (an accented letter and a CJK character, as escapes)', () => {
    const name = encodeURIComponent('Caf\u00e9 \u4e2d.md')
    expect(parseForwardUrl(`/api/v1/notes/content/${name}`)?.rel).toBe(`/notes/content/${name}`)
  })
})

describe('headers that cross', () => {
  it('a request carries only its content and cache headers, never a credential or a caller', () => {
    expect(forwardRequestHeaders({
      'Content-Type': 'application/json',
      accept: 'application/json',
      'if-none-match': '"abc"',
      authorization: 'Bearer secret',
      cookie: 'a=b',
      host: 'evil.example',
      'x-walnut-caller-sid': 'aaaaaaaa-1111-4111-8111-111111111111',
      'x-walnut-caller-host': 'devbox',
      'x-walnut-origin': '__local__',
      'x-forwarded-for': '1.2.3.4',
    })).toEqual({ 'content-type': 'application/json', accept: 'application/json', 'if-none-match': '"abc"' })
  })

  it('a header value with a line break is dropped', () => {
    expect(forwardRequestHeaders({ accept: 'a\r\nx-walnut-origin: __local__' })).toEqual({})
  })

  it('a reply keeps content, cache and server-written Walnut headers, never framing or cookies', () => {
    expect(forwardResponseHeaders({
      'content-type': 'application/json; charset=utf-8',
      etag: '"v2"',
      'cache-control': 'no-store',
      'x-walnut-api': '1',
      'x-walnut-origin': 'remote-http',
      'set-cookie': 'a=b',
      'content-length': '12',
      'content-encoding': 'gzip',
      'transfer-encoding': 'chunked',
      connection: 'keep-alive',
    })).toEqual({
      'content-type': 'application/json; charset=utf-8', etag: '"v2"', 'cache-control': 'no-store', 'x-walnut-api': '1',
    })
  })
})
