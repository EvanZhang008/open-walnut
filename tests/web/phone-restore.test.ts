/**
 * Back where you were after a reload on a phone (spec 4.5 "R", C80): the
 * saved record is read strictly, a deep link's base drops only the session
 * params, and the open session comes from the layer stack.
 */
import { describe, it, expect } from 'vitest'
import {
  deepLinkBaseUrl, parsePhoneRestore, sessionFromLayerIds, PHONE_RESTORE_KEY, PHONE_RESTORE_MAX_AGE_MS,
} from '../../web/src/hooks/usePhoneRestore'

const NOW = Date.parse('2026-10-14T09:00:00.000Z')

describe('parsePhoneRestore', () => {
  it('reads a fresh record', () => {
    const raw = JSON.stringify({ v: 1, at: NOW - 5000, sessionId: 'sess-a', anchorMessageId: 'msg-7', homeScrollTop: 612.4 })
    expect(parsePhoneRestore(raw, NOW)).toEqual({
      v: 1, at: NOW - 5000, sessionId: 'sess-a', anchorMessageId: 'msg-7', homeScrollTop: 612,
    })
  })

  it('drops a stale, a future, a foreign and a broken record', () => {
    const old = JSON.stringify({ v: 1, at: NOW - PHONE_RESTORE_MAX_AGE_MS - 1, sessionId: 'x', anchorMessageId: null, homeScrollTop: 0 })
    expect(parsePhoneRestore(old, NOW)).toBeNull()
    const future = JSON.stringify({ v: 1, at: NOW + 120_000, sessionId: 'x', anchorMessageId: null, homeScrollTop: 0 })
    expect(parsePhoneRestore(future, NOW)).toBeNull()
    expect(parsePhoneRestore(JSON.stringify({ v: 2, at: NOW }), NOW)).toBeNull()
    expect(parsePhoneRestore('{not json', NOW)).toBeNull()
    expect(parsePhoneRestore(null, NOW)).toBeNull()
  })

  it('normalizes empty and bad fields', () => {
    const raw = JSON.stringify({ v: 1, at: NOW, sessionId: '', anchorMessageId: 3, homeScrollTop: -40 })
    expect(parsePhoneRestore(raw, NOW)).toEqual({ v: 1, at: NOW, sessionId: null, anchorMessageId: null, homeScrollTop: 0 })
  })

  it('uses the key the spec names', () => {
    expect(PHONE_RESTORE_KEY).toBe('walnut.phoneRestore')
  })
})

describe('sessionFromLayerIds', () => {
  it('takes the top-most session layer', () => {
    expect(sessionFromLayerIds(['drawer', 'session:a', 'task-detail:t', 'session:b', 'sheet:x'])).toBe('b')
    expect(sessionFromLayerIds(['chat', 'asks'])).toBeNull()
    expect(sessionFromLayerIds([])).toBeNull()
  })
})

describe('deepLinkBaseUrl', () => {
  it('drops the session columns and their thread params, keeps the rest', () => {
    expect(deepLinkBaseUrl('https://walnut.example/?s1=abc')).toBe('/')
    expect(deepLinkBaseUrl('https://walnut.example/?s1=abc&s2=def&t1=head&proj=Garden')).toBe('/?proj=Garden')
    expect(deepLinkBaseUrl('https://walnut.example/?task=t1&s1=abc')).toBe('/?task=t1')
  })

  it('is undefined when the URL opens no session, or is not home', () => {
    expect(deepLinkBaseUrl('https://walnut.example/')).toBeUndefined()
    expect(deepLinkBaseUrl('https://walnut.example/?proj=Garden')).toBeUndefined()
    expect(deepLinkBaseUrl('https://walnut.example/notes?s1=abc')).toBeUndefined()
    expect(deepLinkBaseUrl('not a url')).toBeUndefined()
  })
})
