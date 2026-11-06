/**
 * The extension views pass Walnut's `vault:changed` (and a reconnect, after which one may have been
 * missed) on to the extension page as `{ type: 'vault-changed' }` with nothing else, and stop when
 * the view goes (web/src/popout/vault-changed-relay.ts).
 */
import { describe, expect, it } from 'vitest'
import { relayVaultChanged } from '../../web/src/popout/vault-changed-relay'

function fakeWs() {
  const subs = new Map<string, Set<(d: unknown) => void>>()
  return {
    onEvent: (name: string, cb: (d: unknown) => void) => { if (!subs.has(name)) subs.set(name, new Set()); subs.get(name)!.add(cb) },
    offEvent: (name: string, cb: (d: unknown) => void) => { subs.get(name)?.delete(cb) },
    emit: (name: string, d?: unknown) => { for (const cb of subs.get(name) ?? []) cb(d) },
    count: () => [...subs.values()].reduce((n, s) => n + s.size, 0),
  }
}

describe('vault-changed relay', () => {
  it('a vault change and a reconnect each reach the extension page, without the event payload', () => {
    const ws = fakeWs()
    const sent: unknown[] = []
    relayVaultChanged(ws as never, (m) => sent.push(m))
    ws.emit('vault:changed', { locked: true, secret: 'never forwarded' })
    ws.emit('_ws:reconnected')
    ws.emit('task:updated', {})
    expect(sent).toEqual([{ type: 'vault-changed' }, { type: 'vault-changed' }])
  })

  it('stops when the view goes', () => {
    const ws = fakeWs()
    const sent: unknown[] = []
    const off = relayVaultChanged(ws as never, (m) => sent.push(m))
    expect(ws.count()).toBe(2)
    off()
    expect(ws.count()).toBe(0)
    ws.emit('vault:changed')
    expect(sent).toEqual([])
  })
})
