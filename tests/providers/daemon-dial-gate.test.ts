/**
 * A stopping server dials no daemon link (src/providers/daemon-dial-gate.ts).
 *
 * 2026-11-10: a deploy's outgoing server dropped every link, then re-dialled
 * clouddev 3 s later from a request still being served, redelivered its queue
 * and resumed a session's CLI next to the new server. With the gate closed every
 * way into a link refuses before it spawns anything: the pool getters, a pooled
 * or private instance's connect / connectDirect, and the reconnect loop.
 *
 * The ratchet below reads daemon-connection.ts: every method that brings a link
 * up (calls setConnected(true)) is a gated entry or a helper only gated entries
 * call, so a new way to bring a link up fails here until it is gated too.
 * No ssh, no socket: child_process.spawn is a stub that fails the test if called.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

const spawned = vi.hoisted(() => ({ n: 0 }))
vi.mock('../../src/constants.js', () => createMockConstants())
vi.mock('node:child_process', async (orig) => {
  const real = await orig<typeof import('node:child_process')>()
  return {
    ...real,
    spawn: (...args: unknown[]) => { spawned.n++; throw new Error(`spawn called under a closed gate: ${String(args[0])}`) },
  }
})

import {
  DaemonConnection, getDaemonConnection, getDirectDaemonConnection, peekDaemonConnection,
} from '../../src/providers/daemon-connection.js'
import { closeDaemonDials, reopenDaemonDials, daemonDialsClosed } from '../../src/providers/daemon-dial-gate.js'
import { linkFailureKind } from '../../src/providers/link-failure.js'

afterEach(() => { reopenDaemonDials(); spawned.n = 0 })

describe('daemon dial gate', () => {
  it('refuses a new ssh dial, a direct dial and an instance connect while the server stops', async () => {
    closeDaemonDials()
    expect(daemonDialsClosed()).toBe(true)
    const viaPool = await getDaemonConnection('gate-host', { hostname: 'gate-host.invalid' }).catch((e: unknown) => e)
    expect(String(viaPool)).toMatch(/shutting down/)
    expect(linkFailureKind(viaPool)).toBe('no-link')
    // Refused before the pool: no entry the next server's code could find half-made.
    expect(peekDaemonConnection('gate-host')).toBeNull()

    const direct = await getDirectDaemonConnection('gate-direct', 'ws://127.0.0.1:9/').catch((e: unknown) => e)
    expect(String(direct)).toMatch(/shutting down/)

    const own = new DaemonConnection('gate-private', { hostname: 'gate-private.invalid' })
    await expect(own.connect()).rejects.toThrow(/shutting down/)
    await expect(own.connectDirect('ws://127.0.0.1:9/')).rejects.toThrow(/shutting down/)
    expect(spawned.n).toBe(0)
  })

  it('a stopping server never calls a host lost: it cannot tell', async () => {
    const { probeHost } = await import('../../src/core/sessions/host-lost.js')
    closeDaemonDials()
    expect(await probeHost('gate-probe')).toEqual({ reachable: true })
    expect(spawned.n).toBe(0)
  })

  it('the refusal reads as a link that is down, so a message waits instead of failing', async () => {
    const { isHostLinkFailure } = await import('../../src/providers/delivery-failure.js')
    closeDaemonDials()
    const err = await getDaemonConnection('gate-host2', { hostname: 'gate-host2.invalid' }).catch((e: unknown) => e)
    expect(isHostLinkFailure(err)).toBe(true)
  })

  it('opens again for the next server in this process', () => {
    closeDaemonDials()
    reopenDaemonDials()
    expect(daemonDialsClosed()).toBe(false)
  })
})

describe('every way a link comes up passes the gate (ratchet)', () => {
  const src = readFileSync(path.join(__dirname, '../../src/providers/daemon-connection.ts'), 'utf-8')
  const lines = src.split('\n')
  // A class member starts at 2-space indent (its body is deeper), its signature on one line
  // or several; a top-level function or const ends the class member before it.
  const member = /^ {2}(?:(?:private|protected|public|static|readonly|override)\s+)*(?:async\s+)?(?:get\s+|set\s+)?([A-Za-z_]\w*)\s*[(<]/
  const topLevel = /^(?:export\s+)?(?:async\s+)?(?:function\s+([A-Za-z_]\w*)|(?:const|let|class)\s+([A-Za-z_]\w*))/
  /** The class method (or top-level function) each line sits in. */
  const methodAt: string[] = []
  let current = ''
  for (const line of lines) {
    const top = topLevel.exec(line)
    const m = member.exec(line)
    if (top) current = `top:${top[1] ?? top[2]}`
    else if (m && !['if', 'for', 'while', 'switch', 'catch', 'return'].includes(m[1])) current = m[1]
    methodAt.push(current)
  }
  const bodyOf = (name: string): string => lines.filter((_, i) => methodAt[i] === name).join('\n')
  const callersOf = (name: string): Set<string> => {
    const out = new Set<string>()
    lines.forEach((l, i) => { if (new RegExp(`this\\.${name}\\(`).test(l) && methodAt[i] !== name) out.add(methodAt[i]) })
    return out
  }

  /** The entries that check the gate themselves. */
  const GATED = ['connect', 'connectDirect', 'reconnect']

  it('the header reader finds the methods it relies on', () => {
    for (const name of ['connect', 'connectDirect', 'reconnect', 'setConnected', 'scheduleReconnect', 'dialDirect', 'forceRedeployAndReconnect']) {
      expect(bodyOf(name).length, name).toBeGreaterThan(0)
    }
  })

  it('the connected edge itself refuses while the gate is closed (a dial that began before the stop)', () => {
    const body = bodyOf('setConnected')
    expect(body).toMatch(/daemonDialsClosed\(\)/)
    expect(body).toMatch(/assertDaemonDialsOpen\(/)
    // Before the edge's state change, so nothing of the connected edge runs.
    expect(body.indexOf('assertDaemonDialsOpen(')).toBeLessThan(body.indexOf('this._connected = value'))
  })
  /** Helpers that bring a link up but are only ever called from a gated entry. */
  const ONLY_FROM_GATED = ['dialDirect', 'forceRedeployAndReconnect']

  it('each gated entry checks the gate', () => {
    for (const name of GATED) expect(bodyOf(name), name).toMatch(/assertDaemonDialsOpen\(/)
  })

  it('each helper that brings a link up is called only from a gated entry', () => {
    for (const name of ONLY_FROM_GATED) {
      const callers = callersOf(name)
      expect(callers.size, name).toBeGreaterThan(0)
      for (const c of callers) expect(GATED, `${name} is called from ${c}`).toContain(c)
    }
  })

  it('no other method brings a link up', () => {
    const up = new Set<string>()
    lines.forEach((l, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(l)) return
      if (/\bsetConnected\(\s*true\s*\)/.test(l)) up.add(methodAt[i])
    })
    expect(up.size).toBeGreaterThan(0)
    for (const m of up) expect([...GATED, ...ONLY_FROM_GATED], `setConnected(true) in ${m}`).toContain(m)
  })

  it('the pool getters check the gate before they join or make a dial', () => {
    for (const fn of ['getDaemonConnectionOrThrow', 'getDirectDaemonConnection']) {
      const at = src.indexOf(`function ${fn}(`)
      expect(at, fn).toBeGreaterThan(0)
      const body = src.slice(at, src.indexOf('\n}\n', at))
      const gate = body.indexOf('assertDaemonDialsOpen(')
      expect(gate, fn).toBeGreaterThan(0)
      for (const step of ['reconnectNow(', 'new DaemonConnection(', '.connect()', '.connectDirect(']) {
        const s = body.indexOf(step)
        if (s >= 0) expect(gate < s, `${fn}: the gate before ${step}`).toBe(true)
      }
    }
  })

  it('the reconnect loop starts no timer while the gate is closed', () => {
    expect(bodyOf('scheduleReconnect')).toMatch(/daemonDialsClosed\(\)/)
  })
})
