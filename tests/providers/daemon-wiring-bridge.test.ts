/**
 * Text ratchets on the session daemon: what a cloud bridge socket may call and what stays off it, the bridge link's liveness rules, the gateway line cap, and the session relay.
 *
 * Source text is checked where no behavior test reaches the line (the guard names which
 * test covers the behavior when one does). The daemon is one program: nothing here
 * compares two copies.
 */
import { describe, it, expect } from 'vitest'
import ts from 'typescript'
import fs from 'node:fs'
import path from 'node:path'
import { BRIDGE_WATCHDOG } from '../../src/providers/daemon-core.js'
import { readTwinText } from '../helpers/standalone-twin-text.js'

const ROOT = path.resolve(__dirname, '../..')
const corePath = path.join(ROOT, 'src/providers/daemon-core.ts')

// daemon-standalone.ts reads as the whole runtime, its area modules included (readTwinText).
const readFile = readTwinText

describe('daemon wiring: bridge-reachable commands and what stays off the bridge', () => {
  const coreSrc = readFile(corePath)
  const standaloneSrc = readFile(path.join(ROOT, 'src/providers/daemon-standalone.ts'))

  // Bridge image save (phone → cloud → daemon): the ONLY write command a
  // bridge socket may invoke. Lock the containment shape on the daemon:
  // allowlist membership, dispatch case, mediaType allowlist, decoded-size
  // cap, magic-byte gate, fixed daemon-owned dir, generated filename (no
  // caller path components), and that fs.write stays OFF the bridge.
  it('daemon: allowlist image.save on the bridge and dispatch it', () => {
    const allowStart = standaloneSrc.indexOf('BRIDGE_ALLOWED_COMMANDS = new Set([')
    expect(allowStart).toBeGreaterThan(-1)
    const allowBody = standaloneSrc.slice(allowStart, standaloneSrc.indexOf('])', allowStart))
    expect(allowBody).toContain("'image.save'")
    // Containment intact: no generic write escapes onto the bridge.
    expect(allowBody).not.toContain("'fs.write'")
    // Through the drain like every file write: a swap waits for it (daemon-update-behind.ts).
    expect(standaloneSrc).toMatch(/'image\.save': cmdImageSave\b/)
    expect(standaloneSrc).toMatch(/const DRAINED_ANSWERS = new Set\(\[[^\]]*'image\.save'/)
    expect(standaloneSrc).toMatch(/function cmdImageSave/)
  })
  // The r4d gate's R5: the per-command checks below each look for one entry, so
  // the list as a whole is checked too: no command twice, and not a stub.
  it('daemon: lists every bridge command once', () => {
    const allowed = (src: string, label: string): string[] => {
      const start = src.indexOf('BRIDGE_ALLOWED_COMMANDS = new Set([')
      expect(start, `${label}: no BRIDGE_ALLOWED_COMMANDS list`).toBeGreaterThan(-1)
      const body = src.slice(start, src.indexOf('])', start))
        .split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n')
      const names = [...body.matchAll(/'([^']+)'/g)].map((m) => m[1])
      expect(new Set(names).size, `${label}: a command listed twice`).toBe(names.length)
      return names.sort()
    }
    const standalone = allowed(readFile(path.join(ROOT, 'src/providers/daemon-standalone.ts')), 'daemon-standalone')
    expect(standalone.length).toBeGreaterThan(10)
  })
  it('daemon: validate image.save with the same mediaType allowlist, caps, and magic-byte gate', () => {
    for (const mt of ["'image/png'", "'image/jpeg'", "'image/gif'", "'image/webp'", "'image/heic'"]) {
      const allowStart = standaloneSrc.indexOf('IMAGE_SAVE_MEDIA_TO_EXT')
      expect(allowStart).toBeGreaterThan(-1)
      expect(standaloneSrc.slice(allowStart, allowStart + 400)).toContain(mt)
    }
    expect(standaloneSrc).toMatch(/IMAGE_SAVE_MAX_BYTES = 10 \* 1024 \* 1024/)
    expect(standaloneSrc).toMatch(/IMAGE_SAVE_MAX_BASE64_LENGTH = 14[_]?000[_]?000/)
    // Non-image bytes must be refused (reuses fs.readImage's magic check).
    expect(standaloneSrc).toMatch(/mediaType === 'image\/heic' \? looksLikeHeic\(buf\) : looksLikeImage\(buf\)/)
    expect(standaloneSrc).toMatch(/image\.save: not an image \(ENOTIMAGE\)/)
    expect(standaloneSrc).toMatch(/image\.save: too large \(EFBIG\)/)
    expect(standaloneSrc).toMatch(/image\.save: unsupported mediaType \(ENOTIMAGE\)/)
  })
  it('daemon: write image.save output ONLY into the fixed daemon-owned dir with a generated name', () => {
    // The dir is `<the server's images dir>/mobile` (serverImagesDir: the dir the server named, else
    // one derived from the daemon's own fixed dirs), asked at each save, never from the command.
    expect(standaloneSrc).toMatch(/const imageSaveDir = \(\): string => path\.join\(serverImagesDir\(\{ env: [\w.]+, daemonDir: DAEMON_DIR, homeDaemonDir: FALLBACK_DAEMON_DIR, sharedDir: PROD_DAEMON_DIR, ownsShared \}\), 'mobile'\)/)
    expect(standaloneSrc).toMatch(/const IMAGE_SAVE_DIR = imageSaveDir\(\)/)
    // Filename = timestamp + random + allowlist-derived extension.
    expect(standaloneSrc).toMatch(/Date\.now\(\) \+ '-' \+ crypto\.randomBytes\(4\)\.toString\('hex'\) \+ '\.' \+ ext/)
    // The handler must never join caller input into the path: inside
    // cmdImageSave the only path.join is IMAGE_SAVE_DIR + filename.
    const start = standaloneSrc.search(/function cmdImageSave/)
    expect(start).toBeGreaterThan(-1)
    const body = standaloneSrc.slice(start, standaloneSrc.indexOf('\n}', start))
    const joins = body.match(/path\.join\([^)]*\)/g) ?? []
    expect(joins).toEqual(['path.join(IMAGE_SAVE_DIR, filename)'])
    expect(body).not.toMatch(/cmd\.path|cmd\.filename|cmd\.name|cmd\.ext/)
  })

  // Bridge launch relay (phone → cloud → daemon → connected walnut server):
  // the daemon spawns NOTHING — it forwards the request UP as a launch-request
  // event (same relay shape as stt) and the walnut server runs the full
  // quick-start validation chain. Lock the containment shape on the daemon:
  // allowlist membership, dispatch cases, no-trusted-client fail-fast, the
  // relayId round trip, and that 'start' stays OFF the bridge.
  it('daemon: allowlist session.launch on the bridge and dispatch it + launch-result', () => {
    const allowStart = standaloneSrc.indexOf('BRIDGE_ALLOWED_COMMANDS = new Set([')
    expect(allowStart).toBeGreaterThan(-1)
    const allowBody = standaloneSrc.slice(allowStart, standaloneSrc.indexOf('])', allowStart))
    expect(allowBody).toContain("'session.launch'")
    // Containment intact: arbitrary-argv spawn stays off the bridge.
    expect(allowBody).not.toContain("'start'")
    expect(standaloneSrc).toMatch(/case 'session\.launch': return cmdLaunchRelay/)
    expect(standaloneSrc).toMatch(/case 'launch-result': return cmdLaunchResult/)
    expect(standaloneSrc).toMatch(/function cmdLaunchRelay/)
    expect(standaloneSrc).toMatch(/function cmdLaunchResult/)
  })
  it('daemon: relay session.launch to a TRUSTED client and never spawn from it', () => {
    const start = standaloneSrc.search(/function cmdLaunchRelay/)
    expect(start).toBeGreaterThan(-1)
    const body = standaloneSrc.slice(start, standaloneSrc.indexOf('\n}', start))
    // Fail fast when the walnut server isn't connected (bridge sockets excluded).
    expect(body).toContain("'session.launch: no primary server connected'")
    // The relay event carries relayId + action + params to the trusted client.
    expect(body).toMatch(/sendEvent\(target, 'launch-request',/)
    // The daemon must NOT build argv / call cmdStart from a bridge launch.
    expect(body).not.toMatch(/cmdStart\(/)
    expect(body).not.toMatch(/spawn/)
    // Shared timeout so a hung primary can't leak pending entries forever.
    expect(standaloneSrc).toMatch(/LAUNCH_RELAY_TIMEOUT_MS = 45[_]?000/)
  })

  // Session-changes host-local compute (changes.compute / changes.file):
  // the pipeline lives in session-changes-core.ts, which the daemon bundles.
  // Without 'changes-v1' the server falls back to its reader-based compute.
  it("daemon: dispatch changes.compute/changes.file; 'changes-v1' advertised but NOT required", () => {
    expect(standaloneSrc).toMatch(/'changes\.compute': cmdChangesCompute, 'changes\.file': cmdChangesFile\b/)
    expect(standaloneSrc).toContain('sessionChanges.answers]')
    expect(standaloneSrc).toMatch(/function cmdChangesCompute/)
    expect(standaloneSrc).toMatch(/function cmdChangesFile/)
    const capsSrc = readFile(path.join(ROOT, 'src/providers/daemon-capabilities.ts'))
    const reqStart = capsSrc.indexOf('REQUIRED_DAEMON_CAPABILITIES = [')
    const reqEnd = capsSrc.indexOf('] as const', reqStart)
    expect(reqStart).toBeGreaterThan(-1)
    expect(capsSrc.slice(reqStart, reqEnd)).not.toMatch(/'changes-v1'/)
    const advStart = capsSrc.indexOf('ADVERTISED_DAEMON_CAPABILITIES = [')
    const advEnd = capsSrc.indexOf('] as const', advStart)
    expect(capsSrc.slice(advStart, advEnd)).toMatch(/'changes-v1'/)
  })
  // turns.* (turn-snapshot-core.ts + turn-guard-core.ts): the daemon imports
  // both factories and snapshots at every result line and at spawn. A daemon without it keeps working (no Turns view, no guard).
  it("daemon: dispatch turns.*; 'turn-snapshot-v1' advertised but NOT required, not bridge-reachable", () => {
    for (const c of ['turns.list', 'turns.diff', 'turns.restore', 'turns.guard', 'turns.configure']) {
      expect(standaloneSrc).toContain(`'${c}': cmdTurns`)
    }
    expect(standaloneSrc).toContain('transcripts.answers]')
    expect(standaloneSrc).toMatch(/async function cmdTurns\(/)
    // The two hooks the tailer and the spawn path call.
    expect(standaloneSrc).toMatch(/turnSnapshots\.onTurnEnd\(sid, s\.cwd, v\)/)
    expect(standaloneSrc).toMatch(/turnSnapshots\.onTurnStart\(sid, cwd\)/)
    // The kill switch and the guard's transcript facts.
    expect(standaloneSrc).toMatch(/forceDisabled: process\.env\.WALNUT_TURN_SNAPSHOTS === '0'/)
    expect(standaloneSrc).toMatch(/computeChangesCached\(sid, cwd\)/)
    const start = standaloneSrc.indexOf('BRIDGE_ALLOWED_COMMANDS = new Set([')
    const end = standaloneSrc.indexOf('])', start)
    expect(standaloneSrc.slice(start, end)).not.toMatch(/turns\./)
    expect(standaloneSrc).toMatch(/createTurnSnapshots\(\{/)
    expect(standaloneSrc).toMatch(/createTurnGuard\(\{/)
    const capsSrc = readFile(path.join(ROOT, 'src/providers/daemon-capabilities.ts'))
    const reqStart = capsSrc.indexOf('REQUIRED_DAEMON_CAPABILITIES = [')
    const reqEnd = capsSrc.indexOf('] as const', reqStart)
    expect(capsSrc.slice(reqStart, reqEnd)).not.toMatch(/'turn-snapshot-v1'/)
    const advStart = capsSrc.indexOf('ADVERTISED_DAEMON_CAPABILITIES = [')
    const advEnd = capsSrc.indexOf('] as const', advStart)
    expect(capsSrc.slice(advStart, advEnd)).toMatch(/'turn-snapshot-v1'/)
    // Both cores are part of the daemon version hash, in the build script's order.
    const versionSrc = readFile(path.join(ROOT, 'src/providers/daemon-version-check.ts'))
    const buildSrc = readFile(path.join(ROOT, 'scripts/build-daemon.sh'))
    for (const f of ['src/providers/turn-snapshot-core.ts', 'src/providers/turn-guard-core.ts']) {
      expect(versionSrc).toContain(`'${f}'`)
      expect(buildSrc).toContain(f)
    }
  })
  // workspace.* (workspace-core.ts): the daemon imports the factory and
  // answers through ONE handler that sends the core's
  // error fields (code, probe) on a refusal. Optional and never bridge-reachable.
  it("daemon: dispatch workspace.*; 'workspace-v1' advertised but NOT required, not bridge-reachable", () => {
    for (const c of ['workspace.configure', 'workspace.detect', 'workspace.create', 'workspace.job', 'workspace.status', 'workspace.repos', 'workspace.remove']) {
      expect(standaloneSrc).toContain(`'${c}': cmdWorkspace`)
    }
    expect(standaloneSrc).toContain('hostServices.answers]')
    expect(standaloneSrc).toMatch(/function cmdWorkspace\(/)
    expect(standaloneSrc).toMatch(/workspaceCore\.handle\(/)
    // A refusal carries the core's code to the server (providers_stale drives the re-push).
    expect(standaloneSrc).toMatch(/\(r\) => \(r\.ok \? ok\(r\) : fail\(r\.error, r\)\)/)
    // The adapter scripts live in a service daemon's state dir, else in the runtime
    // dir (under /tmp, where a cleaner may remove them: the core writes a missing
    // adapter again before each run).
    expect(standaloneSrc).toMatch(/stateDir: (SERVICE_MODE && DAEMON_STATE_DIR \? DAEMON_STATE_DIR : DAEMON_DIR|STATE_DIR_OR_RUNTIME|WORKSPACE_STATE_DIR)/)
    // One allowlist per Walnut: its adapters under that Walnut's dir, the command's home resolved against the socket.
    expect(standaloneSrc).toMatch(/scopeDir: .*walnutScope\.dirFor\((STATE_DIR_OR_RUNTIME|WORKSPACE_STATE_DIR), home\)/)
    expect(standaloneSrc).toMatch(/walnutScope\.resolve\(cmd, gatewayClientHomes\.get\(from\), (name|String\(cmd\.cmd\))\)/)
    // A job poll answers during a shutdown; new provider runs go through the drain.
    expect(standaloneSrc).toMatch(/=== 'workspace\.job'\) return work\(\)/)
    const start = standaloneSrc.indexOf('BRIDGE_ALLOWED_COMMANDS = new Set([')
    expect(start).toBeGreaterThanOrEqual(0)
    const end = standaloneSrc.indexOf('])', start)
    expect(end).toBeGreaterThan(start)
    expect(standaloneSrc.slice(start, end)).not.toMatch(/workspace\./)
    expect(standaloneSrc).toMatch(/createWorkspaceCore\(\{/)
    const capsSrc = readFile(path.join(ROOT, 'src/providers/daemon-capabilities.ts'))
    const reqStart = capsSrc.indexOf('REQUIRED_DAEMON_CAPABILITIES = [')
    expect(reqStart).toBeGreaterThanOrEqual(0)
    const reqEnd = capsSrc.indexOf('] as const', reqStart)
    expect(reqEnd).toBeGreaterThan(reqStart)
    expect(capsSrc.slice(reqStart, reqEnd)).not.toMatch(/'workspace-v1'/)
    const advStart = capsSrc.indexOf('ADVERTISED_DAEMON_CAPABILITIES = [')
    expect(advStart).toBeGreaterThanOrEqual(0)
    const advEnd = capsSrc.indexOf('] as const', advStart)
    expect(advEnd).toBeGreaterThan(advStart)
    expect(capsSrc.slice(advStart, advEnd)).toMatch(/'workspace-v1'/)
    const versionSrc = readFile(path.join(ROOT, 'src/providers/daemon-version-check.ts'))
    const buildSrc = readFile(path.join(ROOT, 'scripts/build-daemon.sh'))
    expect(versionSrc).toContain("'src/providers/workspace-core.ts'")
    expect(buildSrc).toContain('src/providers/workspace-core.ts')
  })

})

describe('cloud bridge', () => {
  const standaloneSrc = readFile(path.join(ROOT, 'src/providers/daemon-standalone.ts'))

  it('daemon: dispatch the bridge.configure command', () => {
    expect(standaloneSrc).toMatch(/case 'bridge\.configure': return cmdBridgeConfigure/)
  })
  it('daemon: persist bridge.json (0600) and restart via the shared decision', () => {
    expect(standaloneSrc).toMatch(/BRIDGE_FILE = path\.join\(DAEMON_DIR, 'bridge\.json'\)/)
    expect(standaloneSrc).toMatch(/mode: 0o600/)
    // configure-time reconcile: the restart decision goes through
    // decideBridgeRestart (daemon-core.ts is the source of truth).
    expect(standaloneSrc).toMatch(/decideBridgeRestart\(\{/)
    expect(standaloneSrc).toMatch(/if \(decision\.restart\) startBridge\(link, decision\.reason\)/)
  })
  it('daemon: enforce a dial timeout so a wedged CONNECTING socket gets redialed', () => {
    expect(standaloneSrc).toMatch(/BRIDGE_DIAL_TIMEOUT_MS = envTimerMs\(process\.env\.WALNUT_BRIDGE_DIAL_TIMEOUT_MS, 20[_]?000, 500\)/)
    expect(standaloneSrc).toMatch(/bridge: dial timeout — abandoning socket/)
    // The timeout handler must schedule the redial itself (a wedged socket
    // may never fire onclose).
    const idx = standaloneSrc.indexOf('bridge: dial timeout')
    expect(standaloneSrc.slice(idx, idx + 600)).toMatch(/scheduleBridgeRedial\(link, gen\)/)
  })
  it('daemon: dedupe pending redial timers (dial-timeout + late onclose must not stack)', () => {
    expect(standaloneSrc).toMatch(/if \(link\.redialTimer\) return/)
  })
  it('daemon: carry the generation guard against stale dials', () => {
    expect(standaloneSrc).toMatch(/link\.generation\+\+/)
    expect(standaloneSrc).toMatch(/gen !== link\.generation/)
  })
  it('daemon: send hello with hostAlias/version/instanceId/sids as the first frame', () => {
    expect(standaloneSrc).toMatch(/ev: 'hello',\s*hostAlias: cfg\.hostAlias,\s*version: DAEMON_VERSION,\s*instanceId: DAEMON_INSTANCE_ID,\s*sids: \[\.\.\.sessions\.keys\(\)\]/)
  })
  it('daemon: share the ping interval, the silence watchdog, and the redial caps', () => {
    // The daemon reads BRIDGE_WATCHDOG (daemon-core.ts).
    expect(standaloneSrc).toMatch(/BRIDGE_PING_INTERVAL_MS = envTimerMs\(process\.env\.WALNUT_BRIDGE_PING_MS, BRIDGE_WATCHDOG\.pingIntervalMs, 150\)/)
    expect(standaloneSrc).toMatch(/BRIDGE_CHECKS_PER_PING = BRIDGE_WATCHDOG\.checksPerPing\n/)
    expect(standaloneSrc).toMatch(/BRIDGE_SILENT_PINGS = BRIDGE_WATCHDOG\.silentPings\n/)
    expect(standaloneSrc).not.toMatch(/BRIDGE_SILENCE_MS/)
    expect(standaloneSrc).toMatch(/BRIDGE_BACKOFF_MAX_MS = 60[_]?000/)
    expect(standaloneSrc).toMatch(/BRIDGE_FAST_REDIAL_MAX_MS = 5[_]?000/)
    expect(standaloneSrc).toMatch(/BRIDGE_FAST_WINDOW_MS = 180[_]?000/)
    expect(standaloneSrc).toMatch(/BRIDGE_FAST_ARM_UPTIME_MS = 120[_]?000/)
  })
  // Matrix B7/H7 (2026-10-02): the watchdog only called close() and the redial
  // hung off onclose, which Node's WebSocket never fires on a link that drops
  // every byte. The teardown must redial by itself, like the dial timeout.
  it('daemon: tear down and redial from the silence watchdog itself (no wait for onclose)', () => {
    const idx = standaloneSrc.indexOf("'bridge: inbound silence")
    expect(idx).toBeGreaterThan(-1)
    const branch = standaloneSrc.slice(idx, standaloneSrc.indexOf('return', idx))
    expect(branch).toMatch(/onClose\(\{ code: null, reason: 'inbound silence', wasClean: false \}\)/)
    // The bridge monitor reads this to tell the counted watchdog from the old one.
    expect(branch).toMatch(/limitMs: BRIDGE_CHECKS_PER_PING \* BRIDGE_SILENT_PINGS \* Math\.round\(BRIDGE_PING_INTERVAL_MS \/ BRIDGE_CHECKS_PER_PING\),/)
    // onClose ends in the redial and runs once per socket.
    expect(standaloneSrc).toMatch(/if \(gen !== link\.generation \|\| closeHandled\) return/)
    expect(standaloneSrc).toMatch(/closeHandled = true/)
    const body = standaloneSrc.slice(standaloneSrc.indexOf('const onClose = '), standaloneSrc.indexOf('const onClose = ') + 2500)
    expect(body).toMatch(/scheduleBridgeRedial\(link, gen\)/)
  })
  // The behavior is pinned in daemon-link-liveness-twins-e2e.test.ts; this keeps the daemon's text in step.
  it('daemon: count silent checks, ping only on a silent interval, and give up when the third ping is due', () => {
    const start = standaloneSrc.indexOf('// The silence watchdog: see BRIDGE_SILENT_PINGS.')
    expect(start).toBeGreaterThan(-1)
    const w = standaloneSrc.slice(start, standaloneSrc.indexOf('Math.round(BRIDGE_PING_INTERVAL_MS / BRIDGE_CHECKS_PER_PING))', start) + 70)
    expect(w).toMatch(/if \(link\.lastInbound !== heardAt\) \{ heardAt = link\.lastInbound; silentChecks = 0; return;? \}/)
    expect(w).toMatch(/if \(silentChecks % BRIDGE_CHECKS_PER_PING !== 0\) return/)
    expect(w).toMatch(/if \(silentChecks >= BRIDGE_CHECKS_PER_PING \* BRIDGE_SILENT_PINGS\) \{/)
    expect(w).toMatch(/uplink\.ping\(\)/)
  })
  // A socket the daemon gave up on (torn down by the watchdog, abandoned by the
  // dial timeout) can sit in CLOSING for minutes on Node: its late frames and
  // errors must not reach the live link's state or its close line.
  it('daemon: ignore frames and errors from a socket they already gave up on', () => {
    expect(standaloneSrc).toMatch(/if \(gen !== link\.generation \|\| !link\.adapter \|\| link\.client !== client\) return/)
    const err = standaloneSrc.slice(standaloneSrc.search(/(const onError = function\(e\) \{|client\.onerror = \(e: Event\) => \{)/), standaloneSrc.search(/(const onError = function\(e\) \{|client\.onerror = \(e: Event\) => \{)/) + 200)
    expect(err).toMatch(/if \(gen !== link\.generation \|\| link\.client !== client\) return/)
  })
  it('daemon: size every redial with bridgeRedialStep and arm the fast window only from a healthy drop', () => {
    const sched = standaloneSrc.slice(standaloneSrc.indexOf('function scheduleBridgeRedial('), standaloneSrc.indexOf('function scheduleBridgeRedial(') + 1200)
    expect(sched).toMatch(/bridgeRedialStep\(\{/)
    expect(sched).toMatch(/sinceDropMs: link\.droppedAt != null \? Date\.now\(\) - link\.droppedAt : null/)
    expect(sched).toMatch(/link\.backoffMs = step\.nextBackoffMs/)
    // Only where an open adapter is torn down (an established link).
    expect(standaloneSrc).toMatch(/link\.adapter = null;?\s*\n\s*link\.droppedAt = armsBridgeFastWindow\(\{ uptimeMs: Date\.now\(\) - link\.connOpenedAt, firstDrop: !link\.hasDropped, armUptimeMs: BRIDGE_FAST_ARM_UPTIME_MS \}\) \? Date\.now\(\) : null;?\s*\n\s*link\.hasDropped = true/)
  })
  // Gate P5 (2026-10-03): an SSH forward that died on the far side while sshd
  // keeps this end open ACKs and never resets. A client like that stayed first in
  // wsClients and every relay went into it. The daemon now pings every trusted
  // client each beat and closes one silent for 8 beats.
  it('daemon: ping every trusted client each beat and close one that stays silent for 8 beats', () => {
    // The beat is parsed once, with the floor (gate 2026-10-04: a second
    // parse without one gave the two readers different beats).
    expect(standaloneSrc).toMatch(/(const|var) TRUSTED_CLIENT_BEAT_MS = envTimerMs\(process\.env\.WALNUT_TRUSTED_CLIENT_BEAT_MS, 15[_]?000, 100\)/)
    expect(standaloneSrc.match(/WALNUT_TRUSTED_CLIENT_BEAT_MS/g)).toHaveLength(1)
    expect(standaloneSrc).toMatch(/const CLIENT_KEEPALIVE_MISSED = 8\b/)
    const fnStart = standaloneSrc.search(/clientKeepaliveExpired(\(ws\)|) ?(=|\{|\()/)
    const fn = standaloneSrc.slice(standaloneSrc.indexOf('clientKeepaliveExpired'), standaloneSrc.indexOf('clientKeepaliveExpired') + 900)
    expect(fnStart).toBeGreaterThan(-1)
    expect(fn).toMatch(/const missed = prev && prev\.heardAt === heardAt \? prev\.missed \+ 1 : 0/)
    expect(fn).toMatch(/if \(missed < CLIENT_KEEPALIVE_MISSED\) \{/)
    expect(fn).toMatch(/ws\.terminate\(\)/)
    // JS: the per-connection timer asks before it pings; its socket wrapper can destroy.
    // bun: one loop over every client, the bridge adapter skipped.
    const loop = standaloneSrc.slice(standaloneSrc.indexOf('const clientKeepaliveExpired'), standaloneSrc.indexOf('}, TRUSTED_CLIENT_BEAT_MS).unref?.()') + 40)
    expect(loop).toMatch(/if \(ws\.data\?\.origin === 'bridge'\) continue\s*\n\s*if \(clientKeepaliveExpired\(ws\)\) continue\s*\n\s*(?:\/\/[^\n]*\n\s*)?try \{ ws\.ping\(String\(Date\.now\(\)\)\) \} catch \{\}/)
    // Every inbound frame counts as an answer, on the daemon.
    // bun: the door (daemon-door.ts) hands every frame to the runtime's handlers, which hear it first.
    for (const h of [/open\(ws\) \{\s*\n\s*heardFrom\(ws\)/, /message\(ws, text\) \{\s*\n\s*heardFrom\(ws\)/, /heard: \(ws, pong\) => heardFrom\(ws, /]) {
      expect(standaloneSrc).toMatch(h)
    }
    const doorSrc = fs.readFileSync(path.join(ROOT, 'src/providers/daemon-door.ts'), 'utf-8')
    for (const h of [/ping: \(ws\) => handlers\.heard\(ws\)/, /pong: \(ws, data\) => handlers\.heard\(ws, data\)/, /message: \(ws, msg\) => handlers\.message\(/]) {
      expect(doorSrc).toMatch(h)
    }
    for (const h of [/wss\.on\('connection', \(ws\) => \{\s*\n\s*heardFrom\(ws\);/, /ws\.on\('pong', \(\) => heardFrom\(ws\)\);/, /ws\.on\('ping', \(\) => heardFrom\(ws\)\);/, /ws\.on\('message', \(msg\) => \{\s*\n\s*heardFrom\(ws\);/, /\/\/ pong\s*\n\s*ws\.emit\('ping'\);/]) {
    }
  })
  // Gate 2026-10-04: a link given up on that was only close()d (Node's
  // global WebSocket has no terminate()) stayed CLOSING and went on
  // draining what it had buffered; behind one slow bottleneck those streams
  // starved every later link. Every site that gives a socket up terminates it.
  it('daemon: terminate a bridge socket they give up on (dial timeout, overflow, silence)', () => {
    const helper = standaloneSrc.slice(standaloneSrc.indexOf('function abandonBridgeSocket('), standaloneSrc.indexOf('function abandonBridgeSocket(') + 300)
    expect(helper).toMatch(/terminate/)
    for (const site of ["'bridge: dial timeout", "'bridge: uplink queue overflow, closing the socket'", "'bridge: inbound silence"]) {
      const idx = standaloneSrc.indexOf(site)
      expect(idx).toBeGreaterThan(-1)
      expect(standaloneSrc.slice(idx, idx + 900)).toMatch(/abandonBridgeSocket\(client\)/)
    }
  })
  // Gate M7 (2026-10-05): the daemon's terminate branch had no test. On Bun
  // 1.3.9 no run can tell close() from terminate(): on ws:// both reset the
  // socket (the slow-link e2e pins that reset), and on wss:// neither ends it
  // (gate 2026-10-06, see abandonBridgeSocket). So this pins the call.
  it('the daemon terminates a socket it gives up on, closing it only when it cannot terminate', () => {
    const helper = standaloneSrc.slice(standaloneSrc.indexOf('function abandonBridgeSocket('), standaloneSrc.indexOf('// Adapter: presents the outbound client WebSocket'))
    expect(helper).toMatch(/const t = \(client as unknown as \{ terminate\?: \(\) => void \}\)\.terminate\s*\n\s*if \(typeof t === 'function'\) t\.call\(client\); else client\.close\(\)/)
    expect(helper.match(/client\.close\(\)/g)).toHaveLength(1)
  })
  // 2026-10-23: Bun 1.4.4's WebSocket terminate() ends a ws:// socket with a
  // FIN (oven-sh/bun#45223), so CI on the latest Bun saw the flow given up on
  // drain. From 1.4.4 the daemon dials ws:// over its own TCP socket through
  // Bun's ws, and resets that socket first.
  it('the daemon resets its own TCP socket under a ws:// bridge on Bun 1.4.4 and later', () => {
    expect(standaloneSrc).toContain("const BRIDGE_OWN_TCP = Bun.semver.satisfies(Bun.version, '>=1.4.4')")
    const open = standaloneSrc.slice(standaloneSrc.indexOf('function openBridgeClient('), standaloneSrc.indexOf('function abandonBridgeSocket('))
    expect(open).toMatch(/if \(!BRIDGE_OWN_TCP \|\| !\/\^ws:\/i\.test\(url\)\) return new WebSocket\(url\)/)
    expect(open).toMatch(/createConnection: [\s\S]*net\.connect\([\s\S]*tcp\.on\('error', \(\) => \{\}\)[\s\S]*holder\.tcp = tcp/)
    const helper = standaloneSrc.slice(standaloneSrc.indexOf('function abandonBridgeSocket('), standaloneSrc.indexOf('// Adapter: presents the outbound client WebSocket'))
    expect(helper).toMatch(/if \(tcp && !tcp\.destroyed && !tcp\.connecting\) \{\s*\n\s*try \{ tcp\.resetAndDestroy\(\); return \} catch \{\}/)
    expect(helper.indexOf('resetAndDestroy')).toBeLessThan(helper.indexOf('.terminate'))
    expect(standaloneSrc).toContain('client = openBridgeClient(dialUrl)')
    expect(standaloneSrc).not.toContain('client = new WebSocket(dialUrl)')
  })
  it('daemon: route inbound bridge frames through handleCommand (no second dispatch)', () => {
    expect(standaloneSrc).toMatch(/handleCommand\(link\.adapter,/)
  })
  it('daemon: put the token on the query string (browser-style clients cannot set headers)', () => {
    expect(standaloneSrc).toMatch(/searchParams\.set\('token', cfg\.token\)/)
  })
  it('daemon: stop the bridge first in cleanup() and self-heal at startup', () => {
    expect(standaloneSrc).toMatch(/try \{ stopBridges\(\);? \} catch \{\}/)
    expect(standaloneSrc).toMatch(/loadBridgeConfig\(\);?\s*\n\s*startBridges\('startup'\)/)
  })
})

describe('agent gateway listener', () => {
  const standaloneSrc = readFile(path.join(ROOT, 'src/providers/daemon-standalone.ts'));

  it('daemon: cap a request line at the shared size', async () => {
    // The daemon imports the shared constant. DERIVED from
    // the constant, never hardcoded: a literal here just goes stale the next time
    // the cap moves and fails a correct change (which is what it did when the cap
    // went 12MB → 28MB for inline video).
    const { GATEWAY_MAX_LINE_BYTES } = await import('../../src/providers/gateway-core.js');
    expect(GATEWAY_MAX_LINE_BYTES % (1024 * 1024)).toBe(0);
    const mb = GATEWAY_MAX_LINE_BYTES / (1024 * 1024);
    expect(standaloneSrc).toMatch(/GATEWAY_MAX_LINE_BYTES/);
    expect(standaloneSrc).not.toMatch(/GATEWAY_MAX_LINE_BYTES\s*=/);
    // It bounds the INLINE lane only. It used to have to clear the whole letter
    // body cap, which is what made the body cap a transport number; a payload over
    // GATEWAY_INLINE_ARGS_MAX_BYTES now travels as a path the hub range-reads, so
    // the line only has to clear what still rides it — with room for the envelope.
    const { GATEWAY_INLINE_ARGS_MAX_BYTES } = await import('../../src/providers/tool-args-source.js');
    expect(GATEWAY_MAX_LINE_BYTES).toBeGreaterThan(GATEWAY_INLINE_ARGS_MAX_BYTES);
  });

  /**
   * The daemon must count bytes from the CHUNK and decode once at the newline.
   * Decoding per chunk splits a multi-byte character across a boundary into
   * replacement characters (corrupt JSON), and re-measuring the accumulated
   * buffer per chunk is O(line²) — invisible at 256KB, ~1.6GB of rescanning at
   * 10MB.
   */
  it('daemon: never decodes or re-measures per chunk', () => {
    // The newline scan is over raw bytes, and the decode happens once.
    expect(standaloneSrc).toMatch(/indexOf\(0x0a\)/);
    expect(standaloneSrc).toMatch(/Buffer\.concat\(chunks\)\.toString\('utf-8'\)|Buffer\.concat\(d\.chunks\)\.toString\('utf-8'\)/);
    // The old quadratic shape is gone from both.
    expect(standaloneSrc).not.toMatch(/Buffer\.byteLength\((?:d\.)?buf/);
  });


});

describe('session.message relay', () => {
  const standaloneSrc = readFile(path.join(ROOT, 'src/providers/daemon-standalone.ts'))

  it('daemon: allowlist session.message on the bridge and dispatch it + message-result', () => {
    const allowStart = standaloneSrc.indexOf('BRIDGE_ALLOWED_COMMANDS = new Set([')
    expect(allowStart).toBeGreaterThan(-1)
    const allowBody = standaloneSrc.slice(allowStart, standaloneSrc.indexOf('])', allowStart))
    expect(allowBody).toContain("'session.message'")
    // Containment intact: the trusted-answer verb stays off the bridge.
    expect(allowBody).not.toContain("'message-result'")
    expect(standaloneSrc).toMatch(/case 'session\.message': return cmdMessageRelay/)
    expect(standaloneSrc).toMatch(/case 'message-result': return cmdMessageResult/)
    expect(standaloneSrc).toMatch(/function cmdMessageRelay/)
    expect(standaloneSrc).toMatch(/function cmdMessageResult/)
  })

  it('daemon: relay session.message to a TRUSTED client and never touch the FIFO/jsonl themselves', () => {
    const start = standaloneSrc.search(/function cmdMessageRelay/)
    expect(start).toBeGreaterThan(-1)
    const body = standaloneSrc.slice(start, standaloneSrc.indexOf('\n}', start))
    expect(body).toContain("'session.message: no primary server connected'")
    expect(body).toMatch(/sendEvent\(target, 'message-request',/)
    // The stable messageId must ride the relay (idempotence anchor).
    expect(body).toMatch(/messageId/)
    // The daemon must NOT deliver anything itself from this command.
    expect(body).not.toMatch(/writeFifo|appendFileSync|cmdSend\(|cmdStart\(/)
    expect(standaloneSrc).toMatch(/MESSAGE_RELAY_TIMEOUT_MS = 45[_]?000/)
  })

  // FIFO wedge guard (2026-08-15): fs.read/fs.readRange on a writer-less FIFO
  // blocked a fs-pool thread FOREVER inside open(); 14 wedged threads killed
  // every local fs RPC for hours. The daemon must stat-before-open and refuse
  // non-regular files with ENOTFILE (which DaemonFileReader maps to null).
  it('daemon: fs.read and fs.readRange stat-before-open and refuse non-regular files (ENOTFILE)', () => {
    const standaloneSrc = readFile(path.join(ROOT, 'src/providers/daemon-standalone.ts'))
    for (const fn of ['cmdFsRead', 'cmdFsReadRange']) {
      const start = standaloneSrc.search(new RegExp(`async function ${fn}\\b`))
      expect(start, `${fn} missing`).toBeGreaterThan(-1)
      const body = standaloneSrc.slice(start, standaloneSrc.indexOf('\n}', start))
      expect(body, `${fn} lost the ENOTFILE guard`).toContain('ENOTFILE')
      expect(body, `${fn} must reject via isFile()`).toMatch(/\.isFile\(\)/)
      // The guard must run BEFORE any open()/readFile() — stat first.
      const statIdx = body.search(/fs\.promises\.stat\(/)
      const openIdx = body.search(/fs\.promises\.(open|readFile)\(/)
      expect(statIdx, `${fn} has no pre-open stat`).toBeGreaterThan(-1)
      expect(statIdx, `${fn} stats AFTER opening — the wedge is back`).toBeLessThan(openIdx)
    }
  })

})

describe('read-only ACP model catalog', () => {
  it('daemon: dispatch the read-only catalog and keep it off the public bridge', () => {
    const standalone = readFile(path.join(ROOT, 'src/providers/daemon-standalone.ts'))
    for (const text of [standalone]) {
      expect(text).toContain("case 'acpModelCatalog':")
      expect(text).toContain('acp.modelCatalog(cmd.binary,')
      const allowlist = /BRIDGE_ALLOWED_COMMANDS = new Set\(\[([\s\S]*?)\]\)/.exec(text)
      expect(allowlist).not.toBeNull()
      expect(allowlist![1]).not.toContain('acpModelCatalog')
    }
  })
})
