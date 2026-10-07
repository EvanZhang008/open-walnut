/**
 * Both daemon twins speak the leader protocol the same way (CLAUDE.md: keep
 * daemon-standalone.ts and daemon-source.ts in sync), and the bridge can reach
 * only what the cloud companion needs while it leads. Static ratchets over both
 * sources, plus the source twin's rendered template, which must carry working
 * inlined copies of the leader book and the board kit. The behaviour on real
 * daemon processes is tests/integration/leader-takeover-twins.test.ts.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { createLeaderBook } from '../../src/providers/leader-core.js'
import { createBoardOffline } from '../../src/providers/offline-board-core.js'
import { ADVERTISED_DAEMON_CAPABILITIES, REQUIRED_DAEMON_CAPABILITIES } from '../../src/providers/daemon-capabilities.js'

const root = path.join(import.meta.dirname, '..', '..')
const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf-8')
const twins = { standalone: read('src/providers/daemon-standalone.ts'), source: read('src/providers/daemon-source.ts') }

/** The allowlist's entries, comments stripped (they name commands that are NOT allowed). */
function allowlist(src: string): string {
  const start = src.indexOf('BRIDGE_ALLOWED_COMMANDS = new Set([')
  expect(start).toBeGreaterThan(0)
  return src.slice(start, src.indexOf('])', start)).replace(/\/\/[^\n]*/g, '')
}

function fnBody(src: string, name: string): string {
  const start = src.search(new RegExp(`(async )?function ${name}\\(`))
  expect(start, name).toBeGreaterThan(-1)
  return src.slice(start, src.indexOf('\n}', start))
}

describe('leader protocol: both twins', () => {
  it('advertise leader-epoch-v1 without requiring it (an old daemon just never lets the companion lead)', () => {
    expect(ADVERTISED_DAEMON_CAPABILITIES).toContain('leader-epoch-v1')
    expect(REQUIRED_DAEMON_CAPABILITIES as readonly string[]).not.toContain('leader-epoch-v1')
  })

  for (const [name, src] of Object.entries(twins)) {
    it(`${name}: the bridge reaches witness, claim, deliver and gateway-result, never configure`, () => {
      const list = allowlist(src)
      for (const c of ['leader.witness', 'leader.claim', 'leader.deliver', 'gateway-result']) expect(list).toContain(`'${c}'`)
      expect(list).not.toContain("'leader.configure'")
      // Containment around it is unchanged.
      for (const c of ['start', 'stop', 'host.slice', 'offline.drain', 'offline.ack', 'fs.write']) expect(list).not.toContain(`'${c}'`)
    })

    it(`${name}: each command checks who sent it`, () => {
      expect(fnBody(src, 'cmdLeaderConfigure')).toMatch(/origin === 'bridge'\) return sendError\(ws, id, 'leader\.configure: trusted clients only'\)/)
      expect(fnBody(src, 'cmdLeaderDeliver')).toMatch(/origin !== 'bridge'\) return sendError\(ws, id, 'leader\.deliver: the cloud bridge only'\)/)
      // The fence comes before anything is delivered.
      const deliver = fnBody(src, 'cmdLeaderDeliver')
      expect(deliver.indexOf('leaderBook.fence(')).toBeGreaterThan(-1)
      expect(deliver.indexOf('leaderBook.fence(')).toBeLessThan(deliver.indexOf('deliverFromLeader('))
      // A bridge claim asks the book with the companion's own epoch; a trusted one takes the lead back.
      const claim = fnBody(src, 'cmdLeaderClaim')
      expect(claim).toMatch(/backupClaim\(cmd\.walnutId, cmd\.epoch\)/)
      expect(claim).toMatch(/primaryClaim\(cmd\.home\)/)
      // A gateway result is answered only by the socket the relay went to.
      expect(fnBody(src, 'cmdGatewayResult')).toMatch(/\(ws(\.data\?)?\.origin === 'bridge'\) !== \(pending\.via === 'bridge'\)/)
    })

    it(`${name}: dispatches the four commands, and leader.deliver goes through the shutdown drain`, () => {
      expect(src).toMatch(/case 'leader\.configure': return cmdLeaderConfigure\(/)
      expect(src).toMatch(/case 'leader\.claim': return cmdLeaderClaim\(/)
      expect(src).toMatch(/case 'leader\.witness': return cmdLeaderWitness\(/)
      expect(src).toMatch(/case 'leader\.deliver': return daemonCommands\.run\(/)
    })

    it(`${name}: a trusted frame is a witness of the primary, and while the companion leads it tells the primary`, () => {
      const heard = fnBody(src, 'heardFrom')
      expect(heard).toMatch(/origin === 'bridge'\) return/)
      expect(heard).toMatch(/leaderBook\.noteHeard\(home\)/)
      expect(heard).toMatch(/leaderBook\.backupLead\(home\)/)
      expect(heard).toMatch(/sendEvent\((ws|client), 'leader-lost'/)
      expect(heard).toMatch(/LEADER_NUDGE_MS/)
    })

    it(`${name}: while the companion leads, a silent primary socket is no target, and what the host cannot answer goes to the companion`, () => {
      const send = fnBody(src, 'sendGatewayRequest')
      expect(send).toMatch(/if \(home && leaderBook\.backupLead\(home\)\) target = null/)
      expect(send).toMatch(/r\.error\.code === 'hub_unreachable' && !target\s*&& forwardToBackup\(home, capability, callerSid, payload, respond\)/)
      const fwd = fnBody(src, 'forwardToBackup')
      expect(fwd).toMatch(/leaderBook\.backupLead\(home\)/)
      expect(fwd).toMatch(/via: 'bridge'/)
      expect(fwd).toMatch(/sendEvent\(adapter, 'gateway-request'/)
      expect(fwd).toMatch(/walnutId: lead\.walnutId, epoch: lead\.epoch/)
      // An open primary socket must not block it: a sleeping Mac keeps its sockets.
      expect(fwd).not.toMatch(/primarySocketOpen/)
    })

    it(`${name}: the offline host keeps boards and relays answers for another host through the companion`, () => {
      expect(src).toMatch(/boards: (createBoardOffline\(\)|\(__CREATE_BOARD_OFFLINE__\)\(\))/)
      expect(src).toMatch(/forwardToBackup\(home, 'leader\.deliverText'/)
      expect(src).toMatch(/WALNUT_LEADER_TAKEOVER_MS/)
    })
  }

  it('both cores are part of the daemon version hash, in the build script', () => {
    const versionSrc = read('src/providers/daemon-version-check.ts')
    const buildSrc = read('scripts/build-daemon.sh')
    for (const f of ['src/providers/leader-core.ts', 'src/providers/offline-board-core.ts']) {
      expect(versionSrc).toContain(`'${f}'`)
      expect(buildSrc).toContain(f)
    }
  })
})

describe('the source twin template', () => {
  it('inlines working copies of the leader book and the board kit', () => {
    const rendered = getDaemonSource() // throws if an injected function fails its smoke check
    expect(rendered).not.toContain('__CREATE_LEADER_BOOK__')
    expect(rendered).not.toContain('__CREATE_BOARD_OFFLINE__')
    for (const fn of [createLeaderBook, createBoardOffline]) {
      const text = fn.toString()
      expect(text).not.toMatch(/__name\(|__vite|import\(/)
      expect(rendered).toContain(text)
    }
  })
})
