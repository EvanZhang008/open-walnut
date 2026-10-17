/**
 * Both daemon twins speak the leader protocol the same way (CLAUDE.md: keep
 * daemon-standalone.ts and daemon-source.ts in sync), and the bridge can reach
 * only what the cloud companion needs while it leads. Static ratchets over both
 * sources, plus the source twin's rendered template, which must carry working
 * inlined copies of the leader book and the board kit. The behaviour on real
 * daemon processes is tests/integration/leader-takeover-twins.test.ts.
 */
import { describe, it, expect, vi } from 'vitest'
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
import { createFollowerReads } from '../../src/providers/follower-reads-core.js'

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
  it('advertise leader-epoch-v1, leader-settings-v1 and follower-alone-v1 without requiring them (an old daemon just never lets the companion lead)', () => {
    for (const cap of ['leader-epoch-v1', 'leader-settings-v1', 'follower-alone-v1']) {
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

    it(`${name}: leader.control is the bridge's, fenced at the current epoch, for a session of that Walnut, and a stop is journaled before it runs`, () => {
      expect(allowlist(src)).toContain("'leader.control'")
      expect(src).toMatch(/case 'leader\.control': return daemonCommands\.run\(/)
      const body = fnBody(src, 'cmdLeaderControl')
      expect(body).toMatch(/origin !== 'bridge'\) return sendError\(ws, id, 'leader\.control: the cloud bridge only'\)/)
      const fence = body.indexOf('leaderBook.fence(cmd.walnutId, cmd.epoch)')
      const owner = body.indexOf('offlineHost.ownerOf(sid) !== f.home')
      expect(fence).toBeGreaterThan(-1)
      expect(owner).toBeGreaterThan(fence)
      // Every action comes after both checks.
      for (const a of ['permission', 'mode', 'stop']) expect(body.indexOf(`cmd.action === '${a}'`)).toBeGreaterThan(owner)
      // A permission answer is the server's own line, on the server's own write path.
      expect(body).toMatch(/answerPermission\(sid, cmd, 'leader\.control'\)/)
      const answer = fnBody(src, 'answerPermission')
      expect(answer).toMatch(/liveSettings\.permissionAnswer\(/)
      expect(answer).toMatch(/core\.handleSendRawCommand\(sid, answer\.line\)|writeSessionLine\(sid, answer\.line\)/)
      // A retry after a lost reply (a replica's follower.permission): answered once, resolved again.
      expect(answer).toMatch(/liveSettings\.permissionAnswer\(pending, \{[^}]*\}, sid\)/)
      const dup = answer.indexOf('answer.duplicate')
      expect(dup).toBeGreaterThan(-1)
      expect(dup).toBeLessThan(answer.indexOf('answer.line'))
      expect(answer.indexOf('liveSettings.noteAnswered(sid, raw.requestId')).toBeGreaterThan(answer.indexOf('answer.line'))
      // A mode follows the daemon's auto-answer policy and is kept for the primary.
      expect(body.indexOf('applyModePolicy(')).toBeGreaterThan(body.indexOf('liveSettings.setMode('))
      expect(body).toMatch(/offlineHost\.noteSettings\(f\.home, sid, \{ mode: r\.mode \}\)/)
      // A stop: scheduled jobs need force, ownership is checked, then journaled, then run.
      const stop = body.slice(body.indexOf("cmd.action === 'stop'"))
      const cron = stop.indexOf('cronActive')
      const refusal = stop.indexOf('stopOwnerRefusal(sid, stop)')
      const journal = stop.indexOf('offlineHost.noteStop(f.home, sid')
      const run = stop.indexOf('cmdStop(ws, id, stop)')
      expect(cron).toBeGreaterThan(-1)
      expect(refusal).toBeGreaterThan(cron)
      expect(journal).toBeGreaterThan(refusal)
      expect(run).toBeGreaterThan(journal)
      expect(stop).toMatch(/reason: 'user', home: f\.home, initiator: 'human', stopRequestId/)
      // cmdSetMode and leader.control share one policy.
      expect(fnBody(src, 'cmdSetMode')).toMatch(/applyModePolicy\(session, sid, mode/)
    })

    it(`${name}: the follower lists, writes and answers prompts for its own Walnut only, and only while no server answers it`, () => {
      const start = src.indexOf('FOLLOWER_ALLOWED_COMMANDS = new Set([')
      const list = src.slice(start, src.indexOf('])', start)).replace(/\/\/[^\n]*/g, '')
      for (const c of ['follower.sessions', 'follower.send', 'follower.permission']) expect(list).toContain(`'${c}'`)
      expect(src).toMatch(/case 'follower\.sessions': return cmdFollowerSessions\(/)
      expect(src).toMatch(/case 'follower\.send': return daemonCommands\.run\(/)
      expect(src).toMatch(/case 'follower\.permission': return daemonCommands\.run\(/)
      // Its own socket, its own Walnut.
      expect(fnBody(src, 'followerHomeOf')).toMatch(/followerSockets\.get\(home\) === ws/)
      expect(fnBody(src, 'cmdFollowerSessions')).toMatch(/offlineHost\.sessionsOf\(home\)/)
      // A write: the follower's socket, then no server answering, then the session's owner.
      const target = fnBody(src, 'followerWriteTarget')
      const home = target.indexOf('followerHomeOf(ws)')
      const answers = target.indexOf('followerMayWrite(home)')
      const owner = target.indexOf('offlineHost.ownerOf(sid) !== home')
      expect(home).toBeGreaterThan(-1)
      expect(answers).toBeGreaterThan(home)
      expect(owner).toBeGreaterThan(answers)
      expect(target).toMatch(/errorKind: 'leader_answers'/)
      // "Answers" is the window the host server routes by, so the page and the daemon agree;
      // a primary unheard since this daemon started does not answer (D14), and the window
      // is read in one place (followerQuietMs).
      expect(fnBody(src, 'primaryAnswersFollower')).toMatch(/primarySocketOpen\(home\) && leaderBook\.heardSinceBoot\(home\) && leaderBook\.primaryAgeMs\(home\) < followerQuietMs\(\)/)
      expect(fnBody(src, 'followerQuietMs')).toMatch(/return LEADER_QUIET_MS/)
      expect(src).not.toMatch(/FOLLOWER_LEADER_QUIET_MS/)
      // While the Mac is back but still taking the journal, the journal stays the one writer.
      expect(fnBody(src, 'followerMayWrite')).toMatch(/!primaryAnswersFollower\(home\) \|\| offlineHost\.pendingHandover\(home\)/)
      // follower.op (journal v2): its own gate, in this order, then the core.
      for (const c of ['follower.op', 'follower.pending']) expect(list).toContain(`'${c}'`)
      const fop = fnBody(src, 'cmdFollowerOp')
      const order = ['followerHomeOf(ws)', 'followerMayWrite(home)', 'ownsDaemonDir()', 'offlineHost.handleFollower(home,'].map((x) => fop.indexOf(x))
      expect(order.every((x, i) => x > -1 && (i === 0 || x > order[i - 1]))).toBe(true)
      expect(fop).toMatch(/why: 'not_owner'/)
      expect(fnBody(src, 'cmdFollowerPending')).toMatch(/followerHomeOf\(ws\)[\s\S]*offlineHost\.pendingFor\(home, cmd\.sinceSeq\)/)
      expect(fnBody(src, 'cmdOfflineBlob')).toMatch(/origin === 'bridge' \|\| [\w.?]*origin === 'follower'/)
      expect(fnBody(src, 'cmdFollowerSend')).toMatch(/followerWriteTarget\(ws, id, cmd, 'follower\.send'\)[\s\S]*offlineHost\.deliverHuman\(t\.home, t\.sid, cmd\.text, cmd\.messageId\)/)
      expect(fnBody(src, 'cmdFollowerPermission')).toMatch(/followerWriteTarget\(ws, id, cmd, 'follower\.permission'\)[\s\S]*answerPermission\(t\.sid, cmd, 'follower\.permission'\)/)
      // read-history: a session id names a stream file and nothing else; a follower reads its own Walnut's.
      const rh = fnBody(src, 'cmdReadHistory')
      expect(rh).not.toMatch(/canonicalPath/)
      expect(rh).toMatch(/!\/\^\[A-Za-z0-9\]\[A-Za-z0-9_\.-\]\{0,127\}\$\/\.test\(sid\) \|\| sid\.includes\('\.\.'\)/)
      expect(rh).toMatch(/origin === 'follower' && offlineHost\.ownerOf\(sid\) !== [\w.?]*followerHome/)
      expect(rh.indexOf('ownerOf(sid)')).toBeLessThan(rh.indexOf('readTailWindow('))
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
      // A fallback ends only at the first configure of a leader link (the Mac is back), not at a resend.
      expect(fnBody(src, 'cmdServerConfigure')).toMatch(/hostServers\.configure\(home, spec (\?\?|\|\|) null, \{ freshLink: freshServerLink\(ws\) \}\)/)
      expect(fnBody(src, 'freshServerLink')).toMatch(/if \(serverConfiguredBy\.has\(ws\)\) return false;?\s+serverConfiguredBy\.add\(ws\)/)
      expect(fnBody(src, 'cmdFollowerHello')).toMatch(/gatewayClientHomes\.has\(ws\)\) return sendError/)
      // Only the server the daemon started speaks as the follower.
      expect(fnBody(src, 'cmdFollowerHello')).toMatch(/if \(!hostServers\.tokenMatches\(home, cmd\.token\)\)/)
    })

    it(`${name}: streams go only where each link may open them, and end with the link`, () => {
      const bridge = src.slice(src.indexOf('BRIDGE_ALLOWED_COMMANDS = new Set(['), src.indexOf('])', src.indexOf('BRIDGE_ALLOWED_COMMANDS = new Set(['))).replace(/\/\/[^\n]*/g, '')
      for (const c of ['stream.accept', 'stream.data', 'stream.ack', 'stream.end', 'stream.close']) expect(bridge).toContain(`'${c}'`)
      // The bridge opens streams to the primary only ('bridge-stream-v1', WP13), never to a follower.
      expect(bridge).toContain(`'stream.open'`)
      const target = fnBody(src, 'streamTarget')
      const bridgeBranch = target.slice(target.search(/origin === 'bridge'\) \{/))
      expect(bridgeBranch).toMatch(/if \(to !== 'primary'\) return \{ why: 'the companion opens streams to the primary only' \}/)
      expect(bridgeBranch).toMatch(/primaryForBridge\(\)/)
      expect(bridgeBranch).toMatch(/from: 'companion'/)
      // The server socket that named its Walnut (never its bulk channel), heard last, never a quiet one.
      const pick = fnBody(src, 'primaryForBridge')
      expect(pick).toMatch(/!isServerClient\(client\) \|\| !gatewayClientHomes\.has\(client\)\) continue/)
      expect(pick).toMatch(/now - at > TRUSTED_CLIENT_QUIET_MS/)
      // A follower: to the primary of its own Walnut or the companion; the primary: to its follower.
      expect(target).toMatch(/origin === 'follower'/)
      expect(target).toMatch(/followerSockets\.get\(\w+\) !== ws\) return \{ why: 'send follower\.hello first' \}/)
      expect(target).toMatch(/isServerClient\(ws\) \? gatewayClientHomes\.get\(ws\)/)
      expect(fnBody(src, 'primaryClientFor')).toMatch(/!isServerClient\(client\) \|\| gatewayClientHomes\.get\(client\) !== home/)
      expect(src).toMatch(/streamRelay\.dropLink\(ws\)/)
      // The bridge's streams end with it (the standalone twin drops it through handleDisconnect).
      expect(src).toMatch(/streamRelay\.dropLink\(bridgeAdapter\)|try \{ handleDisconnect\(bridgeAdapter\) \}/)
    })

    it(`${name}: a lane carries the leader's streams and nothing else`, () => {
      const start = src.indexOf('LANE_ALLOWED_COMMANDS = new Set([')
      expect(start).toBeGreaterThan(0)
      const list = src.slice(start, src.indexOf('])', start)).replace(/\/\/[^\n]*/g, '')
      expect(list.match(/'[\w.-]+'/g)!.sort()).toEqual(["'hello'", "'ping'", "'stream.accept'", "'stream.ack'", "'stream.close'", "'stream.data'", "'stream.end'", "'stream.lane'", "'stream.open'"])
      expect(src).toMatch(/origin === 'lane' && !LANE_ALLOWED_COMMANDS\.has\(cmd\.cmd( as string)?\)\) \{/)
      // Never the primary: not for relays, gateway calls, triggers, cron notes, nor the leader witness.
      expect(fnBody(src, 'isServerClient')).toMatch(/origin !== 'lane'/)
      // It hears its streams only.
      expect(fnBody(src, 'sendEvent')).toMatch(/origin === 'lane' && !ev\.startsWith\('stream-'\)\) return/)
      // Only for a Walnut whose leader described it here, on a socket that speaks for no one.
      const lane = fnBody(src, 'cmdStreamLane')
      expect(lane).toMatch(/origin === 'bridge' \|\| [\w.?]*origin === 'follower'\) return sendError/)
      expect(lane).toMatch(/gatewayClientHomes\.has\(ws\)\) return sendError/)
      expect(lane).toMatch(/leaderBook\.recordOf\(home\)/)
      expect(lane).toMatch(/walnutId !== cmd\.walnutId/)
      expect(src).toMatch(/case 'stream\.lane': return cmdStreamLane\(ws, id( as number)?, cmd\)/)
      // To its follower only; and the follower's streams to the primary take it first while it answers.
      expect(fnBody(src, 'streamTarget')).toMatch(/origin === 'lane'/)
      expect(fnBody(src, 'streamTarget')).toMatch(/a lane opens streams to the follower only/)
      expect(fnBody(src, 'primaryClientFor')).toMatch(/origin === 'lane' && [\w.?]*laneHome === home && \([\w.?]*missedBeats( \?\? 0| \|\| 0)\) < 2\) return/)
      // A lane that just closed is coming back: the follower's stream to the primary waits for it
      // (LANE_HOLD_MS), is opened on it when it is back, and only then takes the session link.
      expect(src).toMatch(/LANE_BACK_MS = 30_?000/)
      expect(src).toMatch(/LANE_HOLD_MS = 3_?000/)
      const open = fnBody(src, 'cmdStreamOpen')
      expect(open).toMatch(/origin === 'follower' && cmd\.to === 'primary'/)
      expect(open).toMatch(/!liveLaneFor\(home\) && Date\.now\(\) - \(laneClosedAt\.get\(home\) (\?\?|\|\|) 0\) < LANE_BACK_MS/)
      expect(open).toMatch(/releaseLaneOpens\(home, entry\)/)
      expect(fnBody(src, 'cmdStreamLane')).toMatch(/releaseLaneOpens\(home\)/)
      expect(fnBody(src, 'releaseLaneOpens')).toMatch(/if \(wsClients\.has\(e\.ws\)\) openStreamNow\(e\.ws, e\.cmd\)/)
      expect(src).toMatch(/origin === 'lane' && [\w.?]*laneHome\) laneClosedAt\.set\([\w.?]*laneHome, Date\.now\(\)\)/)
    })
  }

  // WP13: the companion's forward on a stream. The bridge set is today's set plus
  // exactly `stream.open`: nothing else a compromised companion could reach.
  const BRIDGE_SET_BEFORE_WP13 = [
    'appendUserMarker', 'attach', 'bridge.peer', 'bridgeResume', 'fs.readBounded', 'fs.readImage', 'gateway-result', 'image.save',
    'leader.claim', 'leader.control', 'leader.deliver', 'leader.settings', 'leader.witness', 'markers.find', 'ping', 'read-history',
    'send', 'session.control', 'session.launch', 'session.message', 'status', 'stream.accept', 'stream.ack', 'stream.close',
    'stream.data', 'stream.end', 'stt',
  ]
  for (const [name, src] of Object.entries(twins)) {
    it(`${name}: the bridge set gains exactly stream.open (bridge-stream-v1) and nothing else`, () => {
      const set = [...new Set(allowlist(src).match(/'[\w.-]+'/g)!.map((x) => x.slice(1, -1)))].sort()
      expect(set).toEqual([...BRIDGE_SET_BEFORE_WP13, 'stream.open'].sort())
    })

    it(`${name}: the bridge hello says what the daemon does for the companion, and a test can hide it`, () => {
      expect(src).toMatch(/BRIDGE_CAPABILITIES = \['bridge-stream-v1'\]\.filter\(/)
      expect(src).toMatch(/WALNUT_BRIDGE_HIDE_CAPS/)
      // The knob is refused for the prod daemon dir (section 10): it is read only off it.
      expect(src).toMatch(/BRIDGE_HIDDEN_CAPS = IS_PROD_DAEMON_DIR \? \[\] : \(process\.env\.WALNUT_BRIDGE_HIDE_CAPS/)
      expect(src.match(/WALNUT_BRIDGE_HIDE_CAPS \|\||WALNUT_BRIDGE_HIDE_CAPS \?\?/g)).toHaveLength(1)
      expect(src).toMatch(/uplink: 1,\s+\/\/[^\n]*\n\s+capabilities: BRIDGE_CAPABILITIES,/)
    })
  }

  it('bridge-stream-v1 is advertised, optional, and documented', () => {
    expect(ADVERTISED_DAEMON_CAPABILITIES).toContain('bridge-stream-v1')
    expect(REQUIRED_DAEMON_CAPABILITIES as readonly string[]).not.toContain('bridge-stream-v1')
  })

  it('both cores are part of the daemon version hash, in the build script', () => {
    const versionSrc = read('src/providers/daemon-version-check.ts')
    const buildSrc = read('scripts/build-daemon.sh')
    for (const f of ['src/providers/leader-core.ts', 'src/providers/offline-journal-core.ts', 'src/providers/offline-board-core.ts', 'src/providers/live-settings-core.ts', 'src/providers/offline-search-core.ts', 'src/providers/host-server-core.ts', 'src/providers/stream-relay-core.ts']) {
      expect(versionSrc).toContain(`'${f}'`)
      expect(buildSrc).toContain(f)
    }
  })
})

/** A `new Set([...])` list's entries, comments stripped, as a set. */
function setEntries(src: string, name: string): Set<string> {
  const start = src.indexOf(`${name} = new Set([`)
  expect(start, name).toBeGreaterThan(0)
  return new Set(src.slice(start, src.indexOf('])', start)).replace(/\/\/[^\n]*/g, '').match(/'[\w.:-]+'/g) ?? [])
}

describe('one quiet window, LEADER_QUIET_MS (replica plan C4, WP2)', () => {
  for (const [name, src] of Object.entries(twins)) {
    it(`${name}: follower writes and gateway routing read the one knob, parsed by envTimerMs (min 500, default 30 s)`, () => {
      expect(src).toMatch(/LEADER_QUIET_MS = envTimerMs\(process\.env\.WALNUT_LEADER_QUIET_MS, 30_?000, 500\)/)
      // The follower view says the window, so the replica's presence counts by the daemon's own.
      expect(fnBody(src, 'followerView')).toMatch(/quietMs: LEADER_QUIET_MS/)
      // Gateway routing: a home with a linked follower calls a quiet primary away by the same window.
      expect(fnBody(src, 'primaryQuietWithFollower')).toMatch(/followerSockets\.has\(home\) && leaderBook\.primaryAgeMs\(home\) >= LEADER_QUIET_MS/)
      const send = fnBody(src, 'sendGatewayRequest')
      const silent = send.indexOf('gateway: primary silent, answering here')
      const quiet = send.indexOf('if (target && home && primaryQuietWithFollower(home))')
      expect(silent).toBeGreaterThan(-1)
      expect(quiet).toBeGreaterThan(silent)
      // Before the offline host decides who answers.
      expect(quiet).toBeLessThan(send.indexOf('offlineHost.hasHome(home)'))
      // The offline host's "a primary answers" check honours it too.
      expect(src).toMatch(/GATEWAY_SILENT_BEATS\) return !primaryQuietWithFollower\(home\)/)
    })
  }

  it('the follower allowlists of both twins are the same set (order may differ)', () => {
    expect(setEntries(twins.source, 'FOLLOWER_ALLOWED_COMMANDS')).toEqual(setEntries(twins.standalone, 'FOLLOWER_ALLOWED_COMMANDS'))
  })

  it('the replica presence, the host server route and both twins default to the same window, and the replica parses the knob with the twins\' own parser', async () => {
    const presence = await import('../../src/replica/presence.js')
    const route = await import('../../src/host-server/route.js')
    expect(presence.LEADER_QUIET_MS).toBe(30_000)
    expect(route.LEADER_QUIET_MS).toBe(presence.LEADER_QUIET_MS)
    const presenceSrc = read('src/replica/presence.ts')
    expect(presenceSrc).toMatch(/LEADER_QUIET_MS = envTimerMs\(process\.env\.WALNUT_LEADER_QUIET_MS, 30_?000, 500\)/)
    expect(presenceSrc).toMatch(/from '\.\.\/providers\/daemon-core\.js'/)
  })

  it.each([['6000', 6_000], ['100', 500], ['', 30_000]])('WALNUT_LEADER_QUIET_MS=%s: the host server route (the daemon\'s fallback) and the replica presence read the same window', async (raw, want) => {
    const before = process.env.WALNUT_LEADER_QUIET_MS
    process.env.WALNUT_LEADER_QUIET_MS = raw
    vi.resetModules()
    try {
      const presence = await import('../../src/replica/presence.js')
      const route = await import('../../src/host-server/route.js')
      expect(route.LEADER_QUIET_MS).toBe(want)
      expect(presence.LEADER_QUIET_MS).toBe(want)
      // The route's away is the window's: heard (want - 1) ms ago answers, want ms ago is away.
      const view = (ago: number) => ({ view: { holder: 'primary', primaryConnected: true, primaryHeardAgoMs: ago, bridge: { connected: false } } as never, at: 1_000 })
      expect(route.leaderAnswers({ view: view(want - 1), now: 1_000, suspect: {} }).answers).toBe(true)
      expect(route.leaderAnswers({ view: view(want), now: 1_000, suspect: {} }).answers).toBe(false)
    } finally {
      if (before === undefined) delete process.env.WALNUT_LEADER_QUIET_MS
      else process.env.WALNUT_LEADER_QUIET_MS = before
      vi.resetModules()
    }
  })
})

describe('the follower\'s "alone" window', () => {
  it('is the host server\'s own route window', async () => {
    const { LEADER_QUIET_MS } = await import('../../src/host-server/route.js')
    expect(LEADER_QUIET_MS).toBe(30_000)
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

describe('owner-scoped follower reads, replica-reads-v1 (replica plan WP6)', () => {
  const reads = createFollowerReads({
    path, homeDir: '/nonexistent', realpath: () => null, sliceOwner: () => undefined, journalOwner: () => undefined,
    liveSessions: () => [], journalSize: () => -1, readJournal: () => '', replica: { list: () => null, read: () => null, readMany: () => null }, log: () => {},
  })
  const WRITES = ['fs.write', 'fs.mkdir', 'fs.rename', 'fs.rm', 'fs.copy', 'git.commitStart', 'git.commitPlan', 'git.ensureExcluded', 'replica.sync', 'replica.put', 'replica.drop', 'start', 'send', 'stop']

  it('adds exactly the reads WP6 names, and no write', () => {
    expect([...reads.COMMANDS].sort()).toEqual([
      'changes.compute', 'changes.file', 'fs.find', 'fs.grep', 'fs.ls', 'fs.read', 'fs.readRange', 'fs.resolvePath', 'fs.stat',
      'git.diff', 'git.fileLog', 'git.fileShow', 'replica.list', 'replica.read', 'replica.readMany',
    ])
    for (const w of WRITES) expect(reads.COMMANDS).not.toContain(w)
  })

  it('both twins: the effective follower allowlist (the literal set plus the core\'s reads) is the same set, and has no write', () => {
    const effective = (src: string) => new Set([...setEntries(src, 'FOLLOWER_ALLOWED_COMMANDS'), ...reads.COMMANDS.map((c) => `'${c}'`)])
    expect(effective(twins.source)).toEqual(effective(twins.standalone))
    for (const w of WRITES) expect(effective(twins.standalone).has(`'${w}'`)).toBe(false)
    expect(twins.standalone).toMatch(/for \(const c of followerReads\.COMMANDS\) FOLLOWER_ALLOWED_COMMANDS\.add\(c\)/)
    expect(twins.source).toMatch(/followerReads\.COMMANDS\.forEach\(function \(c\) \{ FOLLOWER_ALLOWED_COMMANDS\.add\(c\); \}\)/)
  })

  for (const [name, src] of Object.entries(twins)) {
    it(`${name}: the owner scope runs right after the follower allowlist, before any handler, and list keeps the follower's rows`, () => {
      const allow = src.search(/origin === 'follower' && !FOLLOWER_ALLOWED_COMMANDS\.has\(cmd\.cmd( as string)?\)\) \{/)
      const scope = src.search(/origin === 'follower' && followerScope\(ws, id( as number)?, cmd\)\) return/)
      const lane = src.search(/origin === 'lane' && !LANE_ALLOWED_COMMANDS\.has/)
      expect(allow).toBeGreaterThan(0)
      expect(scope).toBeGreaterThan(allow)
      expect(lane).toBeGreaterThan(scope)
      expect(fnBody(src, 'followerScope')).toMatch(/followerReads\.gate\(followerHomeOf\(ws\), cmd\)/)
      expect(fnBody(src, 'followerScope')).toMatch(/errorKind: 'not_found'/)
      expect(fnBody(src, 'cmdList')).toMatch(/origin === 'follower' \? followerReads\.ownRows\(followerHomeOf\(ws\), result\) : result/)
      // Ownership: the slice first, then the spawn journal; cwds from the live map and the journal.
      expect(src).toMatch(/sliceOwner: [^\n]*offlineHost\.ownerOf\(sid\)/)
      expect(src).toMatch(/journalOwner: [^\n]*journaledHome\(sid\)/)
      expect(src).toMatch(/replica: hostReplica,/)
      // The one broadcast every client hears names a session: a follower hears its own Walnut's only.
      expect(src).toMatch(/if \(followerHears\(client, (payload\.)?sid\)\) (\{ try \{ client\.send|sendEvent\(client, 'session_state')/)
      expect(fnBody(src, 'followerHears')).toMatch(/origin !== 'follower' \|\| followerReads\.ownRows\(followerHomeOf\(client\), \[\{ sid(: sid)? \}\]\)\.length === 1/)
      // WP6 fix round: a whole-repository answer is cut on its way out; a refusal is no 'command error'.
      expect(fnBody(src, 'followerScope')).toMatch(/if \(d\.scope\) followerReads\.hold\(ws, id, d\.scope\)/)
      expect(fnBody(src, 'followerScope')).not.toMatch(/sendError\(ws, id, d\.refuse/)
      expect(fnBody(src, 'sendOk')).toMatch(/origin === 'follower'\) data = followerReads\.settle\(ws, id, data\)/)
      expect(fnBody(src, 'sendError')).toMatch(/origin === 'follower'\) followerReads\.settle\(ws, id\)/)
      expect(src).toMatch(/denyRoots: [^\n]*followerDenyRoots\(\)/)
      for (const dir of ['DAEMON_DIR', 'REPLICA_DIR', 'HOST_SERVER_DIR', 'STREAMS_DIR', 'LEGACY_STREAMS_DIR', 'DAEMON_STATE_DIR', 'hostServers.dataDirs()', "'.claude'", "'.open-walnut'", "'.open-walnut-host'"]) {
        expect(fnBody(src, 'followerDenyRoots'), dir).toContain(dir)
      }
      // Cron supervision names a session too: a follower hears its own Walnut's only.
      expect(src).toMatch(/for \(const ws of wsClients\) if \(followerHears\(ws, record\.sid\)\) sendEvent\(ws, 'cron-supervision'/)
    })
  }

  it('advertised by both twins, and the core is part of the version hash and the build script', () => {
    expect(ADVERTISED_DAEMON_CAPABILITIES).toContain('replica-reads-v1')
    expect(REQUIRED_DAEMON_CAPABILITIES).not.toContain('replica-reads-v1')
    expect(read('src/providers/daemon-version-check.ts')).toContain("'src/providers/follower-reads-core.ts'")
    expect(read('scripts/build-daemon.sh')).toContain('src/providers/follower-reads-core.ts')
    const rendered = getDaemonSource()
    expect(rendered).not.toContain('__CREATE_FOLLOWER_READS__')
    const text = createFollowerReads.toString()
    expect(text).not.toMatch(/__name\(|__vite|import\(/)
    expect(rendered).toContain(text)
  })
})
