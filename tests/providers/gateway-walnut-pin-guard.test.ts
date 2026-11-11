/**
 * Guard: every path that sends a session's call (a `gateway-request` frame) to a
 * Walnut server picks that server through the Walnut-pinned rules
 * (gateway-identity-core.ts), in both daemon twins.
 *
 * 2026-11-10: `gatewayTargetFor` fell back to "any trusted client that never
 * identified itself", and a link that dropped three times in ten minutes sent one
 * person's sessions' calls to another person's Walnut on the same host. This test
 * lists, from the source, every function that sends the frame and every caller of
 * the send, so a new path (a new resend, a new fallback) fails here until it goes
 * through the pinned pick. The behaviour itself is pinned on the real twins by
 * daemon-gateway-walnut-pin-twins-e2e.test.ts.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const root = path.join(import.meta.dirname, '..', '..')
const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf-8')
const twins = { standalone: read('src/providers/daemon-standalone.ts'), source: read('src/providers/daemon-source.ts') }

function fnBody(src: string, name: string): string {
  const start = src.search(new RegExp(`\\n(async )?function ${name}\\(`))
  expect(start, name).toBeGreaterThan(-1)
  return src.slice(start, src.indexOf('\n}', start + 1))
}

/** The top-level function each match of `re` sits in. */
function enclosing(src: string, re: RegExp): string[] {
  const out: string[] = []
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')
  for (const m of src.matchAll(g)) {
    const before = src.slice(0, m.index)
    const fns = [...before.matchAll(/\n(?:async )?function (\w+)\(/g)]
    out.push(fns.length ? fns[fns.length - 1]![1]! : '<top>')
  }
  return out
}

/** Why each function may send a relay frame, and where its target comes from. */
const SENDERS: Record<string, string> = {
  sendRelayAttempt: 'sends to the target its callers picked (listed below)',
  forwardToBackup: 'sends to the cloud bridge link of the call\'s own Walnut while its companion leads',
}
/** Every caller of sendRelayAttempt, and how its target was picked. */
const RESEND_CALLERS: Record<string, string> = {
  relayToPrimary: 'the target its callers picked (listed below)',
  wakeGatewayCalls: 'relayResendTarget',
  gatewayRelaysSocketGone: 'relayResendTarget',
  relayAttemptEnded: 'relayResendTarget',
  busyAskAgain: 'gatewayTargetFor(call.home), as a new relay of the same call',
}
/** Every caller of relayToPrimary, and how its target was picked. */
const RELAY_CALLERS: Record<string, string> = {
  sendGatewayRequest: 'gatewayTargetFor',
  sendPluginJobGatewayRequest: 'a socket bound to the job\'s own Walnut only',
  fetchRemoteHistory: 'historyFetchTarget: the session\'s own Walnut through gatewayTargetFor',
}

describe('a session\'s call goes only to a server of its own Walnut, both twins', () => {
  for (const [name, src] of Object.entries(twins)) {
    it(`${name}: only the listed functions send a gateway-request frame`, () => {
      const senders = enclosing(src, /sendEvent\([^,]+, 'gateway-request'/)
      expect(senders.length).toBeGreaterThan(0)
      for (const fn of senders) expect(SENDERS, `${fn} sends a gateway-request frame: route its target through gatewayTargetFor`).toHaveProperty(fn)
    })

    it(`${name}: every send and resend takes its target from the pinned pick`, () => {
      const resends = enclosing(src, /(?<!function )\bsendRelayAttempt\(/).filter((fn) => fn !== 'sendRelayAttempt')
      for (const fn of resends) expect(RESEND_CALLERS, `${fn} calls sendRelayAttempt`).toHaveProperty(fn)
      for (const fn of ['wakeGatewayCalls', 'gatewayRelaysSocketGone', 'relayAttemptEnded']) {
        expect(fnBody(src, fn)).toMatch(/relayResendTarget\((entry\.)?call\)/)
      }
      expect(fnBody(src, 'relayResendTarget')).toMatch(/gatewayTargetFor\(call\.home\)/)
      const busy = fnBody(src, 'busyAskAgain')
      expect(busy).toMatch(/(const|var) target = gatewayTargetFor\(call\.home\)/)
      expect(busy).toMatch(/pinned: call\.pinned/)
      expect(fnBody(src, 'historyFetchTarget')).toMatch(/home \? gatewayTargetFor\(home\) : pickTrustedClient\(''\)\.client/)
      const relays = enclosing(src, /(?<!function )\brelayToPrimary\(/).filter((fn) => fn !== 'relayToPrimary')
      for (const fn of relays) expect(RELAY_CALLERS, `${fn} calls relayToPrimary`).toHaveProperty(fn)
      // The send's targets: gatewayTargetFor's pick, or the copy of it handed on (primary).
      const send = fnBody(src, 'sendGatewayRequest')
      expect(send).toMatch(/target = gatewayTargetFor\(home, \{ callerSid/)
      for (const m of send.matchAll(/relayToPrimary\((\w+),/g)) expect(['target', 'primary']).toContain(m[1])
      expect(send).toMatch(/(const|var) primary = target/)
      // A plugin job's call: a socket bound to its Walnut, nothing else.
      expect(fnBody(src, 'sendPluginJobGatewayRequest')).toMatch(/if \(gatewayClientHomes\.get\(client\) === home\) target = client/)
    })

    it(`${name}: the pick is the Walnut-pinned one, with no fallback to a socket that names no Walnut`, () => {
      const pick = fnBody(src, 'gatewayTargetFor')
      expect(pick).toMatch(/gatewayIdentity\.pick\(candidates, home, \{ pinned(: pinned)?, allowUnidentified: !home \|\| !offlineHost\.pendingHandover\(home\) \}\)/)
      expect(pick).not.toMatch(/untagged/)
      // The only assignments of target: the pick, or null.
      for (const m of pick.matchAll(/\btarget = ([^;\n]+)/g)) expect(['picked.target', 'null']).toContain(m[1]!.trim())
      // Every socket a run of a bound Walnut opened speaks for it (the bulk channel).
      expect(fnBody(src, 'bindGatewayClientHome')).toMatch(/gatewayIdentity\.noteRun\(ws(\.data\?)?\.serverRun, home\)/)
      // A session is pinned to the Walnut that asked for it, copy or not.
      expect(fnBody(src, 'gatewayOwnerHome')).toMatch(/offlineHost\.ownerOf\(callerSid\) \|\| sessionHomeOf\(callerSid\) \|\| undefined/)
      expect(fnBody(src, 'walnutPinned')).toMatch(/offlineHost\.hasHome\(home\) \|\| servedWalnuts\.knows\(home\) \|\| gatewayIdentity\.knowsHome\(home\)/)
    })

    it(`${name}: another Walnut's server cannot settle a call`, () => {
      const result = fnBody(src, 'cmdGatewayResult')
      const check = result.indexOf('gatewayIdentity.mayAnswer(')
      expect(check).toBeGreaterThan(-1)
      // Before the call is settled.
      expect(check).toBeLessThan(result.indexOf('gatewayRelayPending.delete('))
      expect(fnBody(src, 'relayToPrimary')).toMatch(/pinned: walnutPinned\(home\)/)
    })
  }

  it('the source twin inlines the same core', () => {
    expect(twins.source).toMatch(/\['__CREATE_GATEWAY_IDENTITY__', createGatewayIdentity\.toString\(\)\]/)
    expect(twins.source).toMatch(/var gatewayIdentity = \(__CREATE_GATEWAY_IDENTITY__\)\(\);/)
    expect(twins.standalone).toMatch(/const gatewayIdentity = createGatewayIdentity\(\)/)
  })
})
