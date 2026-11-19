/**
 * Who a host replica's away write acts for (replica/write-actor.ts): a paired device by its
 * token, or one of this host's own `walnut` calls by the replica's in-process credential (a
 * session, a plugin job), and only with the `host-local-calls` capability. A header alone
 * never makes a caller: without the in-process token it is a device's request or nobody's.
 */
import type { IncomingMessage } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getSelfCallToken, setSelfApiRoot } from '../../src/lib/self-api-root.js'
import { isSelfCall, localCallerOf, writeActorOf } from '../../src/replica/write-actor.js'

const req = (headers: Record<string, string>) => ({ headers }) as unknown as IncomingMessage
const devices = { verifyDevice: (t: string) => (t === 'dev-token' ? { id: 'dev-1', name: 'marina-phone' } : t === 'old-token' ? { id: null, name: 'old' } : null) }

describe('write actor', () => {
  let self: string | null = null
  // A listening replica's own root, with its in-process credential on (server.ts on a host replica).
  beforeAll(() => { setSelfApiRoot('http://127.0.0.1:45999', { credential: true }); self = getSelfCallToken() })
  afterAll(() => { setSelfApiRoot(null) })

  it('a device token is its device, by its stable id; a row with no id is nobody', () => {
    const actorOf = writeActorOf({ ...devices, localCalls: () => true })
    expect(actorOf(req({ authorization: 'Bearer dev-token' }))).toEqual({ kind: 'device', deviceId: 'dev-1', name: 'marina-phone' })
    expect(actorOf(req({ authorization: 'Bearer old-token' }))).toBeNull()
    expect(actorOf(req({ authorization: 'Bearer nope' }))).toBeNull()
  })

  it('the in-process credential names the session, else the plugin job', () => {
    expect(self).toBeTruthy()
    const actorOf = writeActorOf({ ...devices, localCalls: () => true })
    const bearer = `Bearer ${self}`
    expect(actorOf(req({ authorization: bearer, 'x-walnut-caller-sid': 'sess-1' }))).toEqual({ kind: 'session', sid: 'sess-1' })
    expect(actorOf(req({ authorization: bearer, 'x-walnut-caller-sid': 'external', 'x-walnut-plugin-id': 'acme', 'x-walnut-plugin-job': 'sync' })))
      .toEqual({ kind: 'plugin-job', plugin: 'acme', job: 'sync' })
    // Neither named: no actor (the replica's own internal calls).
    expect(actorOf(req({ authorization: bearer, 'x-walnut-caller-sid': 'external' }))).toBeNull()
    expect(actorOf(req({ authorization: bearer, 'x-walnut-plugin-id': 'acme' }))).toBeNull()
  })

  it('without the capability the in-process credential is nobody\'s write', () => {
    const actorOf = writeActorOf({ ...devices, localCalls: () => false })
    expect(actorOf(req({ authorization: `Bearer ${self}`, 'x-walnut-caller-sid': 'sess-1' }))).toBeNull()
  })

  it('headers from outside never make a local caller: a device token with a session header is the device', () => {
    const actorOf = writeActorOf({ ...devices, localCalls: () => true })
    expect(actorOf(req({ authorization: 'Bearer dev-token', 'x-walnut-caller-sid': 'sess-1', 'x-walnut-plugin-id': 'acme', 'x-walnut-plugin-job': 'sync' })))
      .toEqual({ kind: 'device', deviceId: 'dev-1', name: 'marina-phone' })
    expect(isSelfCall(req({ authorization: 'Bearer dev-token' }))).toBe(false)
    expect(localCallerOf(req({ 'x-walnut-caller-sid': 'sess-1' }))).toBeNull()
    expect(localCallerOf(req({ authorization: 'Bearer forged-self-token', 'x-walnut-caller-sid': 'sess-1' }))).toBeNull()
  })
})
