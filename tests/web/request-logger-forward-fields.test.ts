/**
 * The companion's forward shows in each box's request log
 * (src/web/middleware/request-logger.ts): on the Mac, a forwarded call carries
 * the lowered origin it runs under; on the companion, which box answered.
 * Neither field appears on an ordinary request.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import type { Request, Response } from 'express'
import { EventEmitter } from 'node:events'
import { requestLogger } from '../../src/web/middleware/request-logger.js'
import { log } from '../../src/logging/index.js'

function fire(reqHeaders: Record<string, string>, resHeaders: Record<string, string> = {}): Record<string, unknown> {
  const info = vi.spyOn(log.web, 'info')
  const res = new EventEmitter() as unknown as Response & EventEmitter
  ;(res as unknown as { statusCode: number }).statusCode = 200
  const sent: Record<string, string> = {}
  ;(res as unknown as Record<string, unknown>).setHeader = (name: string, value: string) => { sent[name.toLowerCase()] = value; return res }
  ;(res as unknown as Record<string, unknown>).getHeader = (name: string) => sent[name.toLowerCase()]
  const req = { method: 'GET', originalUrl: '/api/v1/usage/overview', path: '/api/v1/usage/overview', query: {}, headers: reqHeaders } as unknown as Request
  requestLogger(req, res, () => {})
  for (const [k, v] of Object.entries(resHeaders)) res.setHeader(k, v)
  res.emit('finish')
  const call = info.mock.calls.find(([m]) => String(m).startsWith('GET /api/v1/usage/overview'))
  return (call?.[1] ?? {}) as Record<string, unknown>
}

afterEach(() => { vi.restoreAllMocks() })

describe('request log: the forward', () => {
  it('on the Mac: the origin a forwarded call runs under', () => {
    expect(fire({ 'x-walnut-origin': 'remote-http' }).origin).toBe('remote-http')
  })

  it('on the companion: which box answered', () => {
    expect(fire({}, { 'X-Walnut-Answered-By': 'primary' }).answeredBy).toBe('primary')
    expect(fire({}, { 'X-Walnut-Answered-By': 'companion' }).answeredBy).toBe('companion')
  })

  it('an ordinary request has neither', () => {
    const meta = fire({})
    expect(meta).not.toHaveProperty('origin')
    expect(meta).not.toHaveProperty('answeredBy')
  })

  it('a long origin is cut', () => {
    expect(String(fire({ 'x-walnut-origin': 'host:' + 'x'.repeat(200) }).origin)).toHaveLength(64)
  })
})
