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
import { createLiveSettings } from '../../src/providers/live-settings-core.js'
import { createOfflineSearch } from '../../src/providers/offline-search-core.js'
import { createHostServerSupervisor } from '../../src/providers/host-server-core.js'
import { createStreamRelay } from '../../src/providers/stream-relay-core.js'
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
  it('advertise leader-epoch-v1 and leader-settings-v1 without requiring them (an old daemon just never lets the companion lead)', () => {
    for (const cap of ['leader-epoch-v1', 'leader-settings-v1']) {
      expect(ADVERTISED_DAEMON_CAPABILITIES).toContain(cap)
      expect(REQUIRED_DAEMON_CAPABILITIES as readonly string[]).not.toContain(cap)
    }
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
      // Neither the bridge nor a follower (the host server) is the primary heard.
      expect(heard).toMatch(/if \(!isServerClient\((ws|client)\)\) return/)
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

    it(`${name}: leader.settings is the bridge's, fenced at the current epoch, for a session of that Walnut, and the CLI's answer settles it`, () => {
      expect(allowlist(src)).toContain("'leader.settings'")
      expect(src).toMatch(/case 'leader\.settings': return daemonCommands\.run\(/)
      const body = fnBody(src, 'cmdLeaderSettings')
      expect(body).toMatch(/origin !== 'bridge'\) return sendError\(ws, id, 'leader\.settings: the cloud bridge only'\)/)
      const fence = body.indexOf('leaderBook.fence(cmd.walnutId, cmd.epoch)')
      const owner = body.indexOf('offlineHost.ownerOf(sid) !== f.home')
      const apply = body.indexOf('liveSettings.apply(')
      expect(fence).toBeGreaterThan(-1)
      expect(owner).toBeGreaterThan(fence)
      expect(apply).toBeGreaterThan(owner)
      // Kept for the primary once applied (or not live): it drains a settings record.
      expect(body.indexOf('offlineHost.noteSettings(f.home, sid')).toBeGreaterThan(apply)
      // Every control_response line reaches it, not only one answering a pending prompt.
      expect(src).toMatch(/if \(parsed\.type === 'control_response'\) liveSettings\.noteResponse\(sid, parsed\);?\n\s*if \(parsed\.type === 'control_request' && parsed\.request_id/)
    })

    it(`${name}: search goes to the companion first while it leads, and is answered from this host's copy when it cannot`, () => {
      expect(src).toMatch(/search: (createOfflineSearch\(\)|\(__CREATE_OFFLINE_SEARCH__\)\(\))/)
      const send = fnBody(src, 'sendGatewayRequest')
      const guard = send.indexOf("payload.name === 'search'")
      const forward = send.indexOf('forwardToBackup(home, capability, callerSid, payload, ', guard)
      const general = send.indexOf("r.error.code === 'hub_unreachable' && !target")
      expect(guard).toBeGreaterThan(-1)
      expect(forward).toBeGreaterThan(guard)
      // Before the general path, and only with no server to ask.
      expect(general).toBeGreaterThan(forward)
      expect(send.slice(guard - 80, guard)).toMatch(/!target && capability === 'tools\.call' && $/)
      // The companion's failure falls back to this host's own answer.
      expect(send.slice(forward, forward + 160)).toMatch(/if \(resp\.ok\) respond\(resp\);? else here\(\)/)
    })

    it(`${name}: the offline host keeps boards and relays answers for another host through the companion`, () => {
      expect(src).toMatch(/boards: (createBoardOffline\(\)|\(__CREATE_BOARD_OFFLINE__\)\(\))/)
      expect(src).toMatch(/forwardToBackup\(home, 'leader\.deliverText'/)
      expect(src).toMatch(/WALNUT_LEADER_TAKEOVER_MS/)
    })
  }

  for (const [name, src] of Object.entries(twins)) {
    it(`${name}: a follower socket reads, and is never taken for the leader`, () => {
      const start = src.indexOf('FOLLOWER_ALLOWED_COMMANDS = new Set([')
      expect(start).toBeGreaterThan(0)
      const list = src.slice(start, src.indexOf('])', start)).replace(/\/\/[^\n]*/g, '')
      for (const c of ['follower.hello', 'follower.status', 'list', 'attach', 'read-history']) expect(list).toContain(`'${c}'`)
      for (const c of ['leader.configure', 'leader.claim', 'host.slice', 'replica.sync', 'hooks.configure', 'triggers.configure', 'bridge.configure', 'server.configure', 'offline.drain', 'stop', 'start', 'send', 'fs.write']) {
        expect(list).not.toContain(`'${c}'`)
      }
      expect(fnBody(src, 'isServerClient')).toMatch(/origin !== 'bridge' && [\w.?]*origin !== 'follower'/)
      // The gate refuses before any handler runs.
      expect(src).toMatch(/origin === 'follower' && !FOLLOWER_ALLOWED_COMMANDS\.has\(cmd\.cmd( as string)?\)\) \{/)
      // Every pick of "the" server skips followers: relays, gateway calls, triggers, cron notes.
      expect(fnBody(src, 'pickTrustedClient')).toMatch(/if \(!isServerClient\(client\)\) continue/)
      expect(fnBody(src, 'sendGatewayRequest')).toMatch(/if \(!isServerClient\(client\) \|\| isQuietTrustedClient\(client\)\) continue/)
      expect(fnBody(src, 'sendTriggerEvent')).toMatch(/if \(isServerClient\(client\)\) \{/)
      expect(src).toMatch(/if \(isServerClient\(client\)\) sendEvent\(client, 'cron-metadata'/)
      // Only the socket the leader's configure tagged may say what server runs here.
      expect(fnBody(src, 'cmdServerConfigure')).toMatch(/gatewayClientHomes\.get\(ws\) !== home\) return sendError/)
      expect(fnBody(src, 'cmdFollowerHello')).toMatch(/gatewayClientHomes\.has\(ws\)\) return sendError/)
      // Only the server the daemon started speaks as the follower.
      expect(fnBody(src, 'cmdFollowerHello')).toMatch(/if \(!hostServers\.tokenMatches\(home, cmd\.token\)\)/)
    })

    it(`${name}: streams go only where each link may open them, and end with the link`, () => {
      const bridge = src.slice(src.indexOf('BRIDGE_ALLOWED_COMMANDS = new Set(['), src.indexOf('])', src.indexOf('BRIDGE_ALLOWED_COMMANDS = new Set(['))).replace(/\/\/[^\n]*/g, '')
      for (const c of ['stream.accept', 'stream.data', 'stream.ack', 'stream.end', 'stream.close']) expect(bridge).toContain(`'${c}'`)
      // The bridge opens no stream to anyone.
      expect(bridge).not.toContain(`'stream.open'`)
      const target = fnBody(src, 'streamTarget')
      // A follower: to the primary of its own Walnut or the companion; the primary: to its follower.
      expect(target).toMatch(/origin === 'follower'/)
      expect(target).toMatch(/followerSockets\.get\(\w+\) !== ws\) return \{ why: 'send follower\.hello first' \}/)
      expect(target).toMatch(/isServerClient\(ws\) \? gatewayClientHomes\.get\(ws\)/)
      expect(fnBody(src, 'primaryClientFor')).toMatch(/!isServerClient\(client\) \|\| gatewayClientHomes\.get\(client\) !== home/)
      expect(src).toMatch(/streamRelay\.dropLink\(ws\)/)
      // The bridge's streams end with it (the standalone twin drops it through handleDisconnect).
      expect(src).toMatch(/streamRelay\.dropLink\(bridgeAdapter\)|try \{ handleDisconnect\(bridgeAdapter\) \}/)
    })
  }

  it('both cores are part of the daemon version hash, in the build script', () => {
    const versionSrc = read('src/providers/daemon-version-check.ts')
    const buildSrc = read('scripts/build-daemon.sh')
    for (const f of ['src/providers/leader-core.ts', 'src/providers/offline-board-core.ts', 'src/providers/live-settings-core.ts', 'src/providers/offline-search-core.ts', 'src/providers/host-server-core.ts', 'src/providers/stream-relay-core.ts']) {
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
    expect(rendered).not.toContain('__CREATE_LIVE_SETTINGS__')
    expect(rendered).not.toContain('__CREATE_OFFLINE_SEARCH__')
    expect(rendered).not.toContain('__CREATE_HOST_SERVER__')
    expect(rendered).not.toContain('__CREATE_STREAM_RELAY__')
    for (const fn of [createLeaderBook, createBoardOffline, createLiveSettings, createOfflineSearch, createHostServerSupervisor, createStreamRelay]) {
      const text = fn.toString()
      expect(text).not.toMatch(/__name\(|__vite|import\(/)
      expect(rendered).toContain(text)
    }
  })
})
