/**
 * A route whose work an outward door refused (leader switch: this server does not hold the write
 * permission) answers 503 with a sentence a person can act on, and logs no error: the refusal is
 * neither the caller's mistake nor a crash. The mail routes share `errorReply` (contract.ts); the
 * calendar routes have their own.
 */
import { describe, expect, it, vi } from 'vitest'
import { errorReply } from '../../../../src/integrations/mail/contract.js'
import { registerCalendarRoutes } from '../../../../src/integrations/calendar/routes.js'
import {
  holdUntilDoorsOpen, knownOpState, NOT_LEADER_MESSAGE, notifyOutwardDoorsOpened, setOutwardDoorChecker,
} from '../../../../src/core/leader/switch/doors.js'
import type { PluginRouteReply, PluginRouteRequest } from '../../../../src/core/plugins/plugin-route-adapter.js'

const refusal = () => Object.assign(new Error('this machine does not hold the write permission'), { name: 'PermitNotHeld' })

describe('a refused door at a route', () => {
  it('mail: 503 not_leader, no error logged', () => {
    const log = { error: vi.fn() }
    expect(errorReply({ log }, refusal())).toEqual({ status: 503, json: { error: 'not_leader', message: NOT_LEADER_MESSAGE } })
    expect(log.error).not.toHaveBeenCalled()
    // Any other error is still a 500 and logged.
    expect(errorReply({ log }, new Error('boom')).status).toBe(500)
    expect(log.error).toHaveBeenCalledTimes(1)
  })

  it('calendar: a create the door refuses is 503 not-leader, no error logged', async () => {
    const routes = new Map<string, (request: PluginRouteRequest) => Promise<PluginRouteReply>>()
    const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }
    const walnut = { log, http: { route: (method: string, p: string, fn: (r: PluginRouteRequest) => Promise<PluginRouteReply>) => routes.set(`${method} ${p}`, fn) } }
    const service = { createEvent: vi.fn(async () => { throw refusal() }) }
    registerCalendarRoutes(walnut as never, () => service as never)
    const request: PluginRouteRequest = {
      method: 'POST', path: '/events', query: {}, headers: {}, signal: new AbortController().signal,
      json: async <T,>() => ({ title: 'Planning sync', start: '2030-01-07T09:00:00', end: '2030-01-07T10:00:00' }) as T,
      text: async () => '',
    }
    const reply = await routes.get('post /events')!(request)
    expect(service.createEvent).toHaveBeenCalledTimes(1)
    expect(reply).toEqual({ status: 503, json: { error: NOT_LEADER_MESSAGE, code: 'not-leader' } })
    expect(log.error).not.toHaveBeenCalled()
  })
})

describe('the doors helpers', () => {
  it('knownOpState: only a refusal for a known op, by its opState (an unnamed state reads unknown)', () => {
    const known = (opState?: string) => Object.assign(refusal(), { opKnown: true, ...(opState ? { opState } : {}) })
    expect(knownOpState(known('sent'))).toBe('sent')
    expect(knownOpState(known('not-sent'))).toBe('not-sent')
    expect(knownOpState(known('sending'))).toBe('sending')
    expect(knownOpState(known('unknown'))).toBe('unknown')
    expect(knownOpState(known('registered'))).toBe('unknown')
    expect(knownOpState(known())).toBe('unknown')
    // A refusal for want of the permission, whatever its words, is not a known op.
    expect(knownOpState(Object.assign(refusal(), { message: 'never sent again' }))).toBeNull()
    expect(knownOpState(Object.assign(new Error('x'), { opKnown: true }))).toBeNull()
  })

  it('holdUntilDoorsOpen: one line per closed period, the work once when the doors open, then a new period', () => {
    setOutwardDoorChecker(() => {}, () => false)
    try {
      const said = vi.fn()
      const ran = vi.fn()
      for (let i = 0; i < 3; i++) holdUntilDoorsOpen('k', ran, said)
      expect(said).toHaveBeenCalledTimes(1)
      expect(ran).not.toHaveBeenCalled()
      notifyOutwardDoorsOpened()
      expect(ran).toHaveBeenCalledTimes(1)
      notifyOutwardDoorsOpened()
      expect(ran).toHaveBeenCalledTimes(1)
      holdUntilDoorsOpen('k', ran, said)
      expect(said).toHaveBeenCalledTimes(2)
      // Another key is its own period.
      holdUntilDoorsOpen('other', () => {}, said)
      expect(said).toHaveBeenCalledTimes(3)
    } finally {
      setOutwardDoorChecker(null)
      notifyOutwardDoorsOpened()
    }
  })
})
