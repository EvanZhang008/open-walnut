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

describe('request log: a host replica\'s away write', () => {
  /** One PATCH through `mounts` request loggers in a row (server.ts mounts it twice on a host replica). */
  function write(mounts: number, reqHeaders: Record<string, string>, resHeaders: Record<string, string>) {
    const info = vi.spyOn(log.web, 'info')
    const res = new EventEmitter() as unknown as Response & EventEmitter
    ;(res as unknown as { statusCode: number }).statusCode = 200
    const sent: Record<string, string> = {}
    ;(res as unknown as Record<string, unknown>).setHeader = (name: string, value: string) => { sent[name.toLowerCase()] = value; return res }
    ;(res as unknown as Record<string, unknown>).getHeader = (name: string) => sent[name.toLowerCase()]
    const req = { method: 'PATCH', originalUrl: '/api/tasks/mtaskaaa-0001', path: '/tasks/mtaskaaa-0001', query: {}, headers: reqHeaders } as unknown as Request
    for (let i = 0; i < mounts; i++) requestLogger(req, res, () => {})
    for (const [k, v] of Object.entries(resHeaders)) res.setHeader(k, v)
    res.emit('finish')
    res.emit('close')
    return info.mock.calls.filter(([m]) => String(m).startsWith('PATCH /api/tasks/mtaskaaa-0001')).map(([m, meta]) => ({ line: String(m), meta: (meta ?? {}) as Record<string, unknown> }))
  }

  it('its line names the op id, who answered and the status; mounted twice it is still one line', () => {
    const lines = write(2, { 'x-walnut-op-id': 'op-console-edit-0001' }, { 'X-Walnut-Answered-Via': 'replica' })
    expect(lines).toHaveLength(1)
    expect(lines[0]!.line).toMatch(/^PATCH \/api\/tasks\/mtaskaaa-0001 \u2192 200 \(\d+ms\)$/)
    expect(lines[0]!.meta).toMatchObject({ opId: 'op-console-edit-0001', answeredVia: 'replica', reqId: expect.stringMatching(/^[0-9a-f]{8}$/) })
  })

  it('a write with no op id and an ordinary answer carry neither field', () => {
    const [one] = write(1, {}, {})
    expect(one!.meta).not.toHaveProperty('opId')
    expect(one!.meta).not.toHaveProperty('answeredVia')
  })
})
