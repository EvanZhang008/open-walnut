/**
 * Ratchet: nothing long-lived carries a person's mark (core/session-channel/person-call.ts; R3-S1 of
 * the C7 revoke review).
 *
 * A person's own `/api` request runs in an AsyncLocalStorage mark, and on a revoked host only work
 * in a live mark sends a command that runs a process there or hands it data (the gate,
 * providers/ephemeral-session-gate.ts assertPersonOnlyReach). AsyncLocalStorage hands the mark to
 * every timer, socket, child process and promise chain made inside it, so two rules keep it the
 * person's own call:
 *   1. The mark ends with its call (`live` goes false on the response's finish/close, or when the
 *      work asPersonCall wraps settles): whatever outlives the request reads "not a person".
 *   2. A link or loop that serves later callers too (the daemon link, its reconnects, the stream
 *      lane, a shared port forward) is made outside any mark (outsidePersonCall), so not even a
 *      callback that runs while the request is still open acts as the person.
 *
 * Scope, and why: the modules that can send such a command or read the mark. These are the files
 * outside the daemon's own twins that name a command of REVOKED_PERSON_ONLY_COMMANDS in quotes, or
 * call inPersonCall / asPersonCall / outsidePersonCall / assertPersonOnlyReach. A callback in one of
 * them is what would send "as the person". Code elsewhere only reaches the gate through their
 * functions, so its own timers are judged at the call it makes. EventEmitter listeners (`.on(`) and
 * bus subscribers are not creators: a listener runs in the context of whoever emits, never in the
 * one it was registered in (tests/core/async-context-bun.test.ts pins that).
 *
 * Every creator found there (a timer, an interval, a socket or server, a child process, a
 * subscription, a daemon dial) is listed below by file, enclosing function and kind, with one class.
 * A new one turns this red until someone classifies it; a class of 'leak' is never allowed.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

/**
 * call:    bounded by the call that makes it (a deadline, a poll's pause, a child or socket it waits
 *          for or clears before it returns): any mark it carries is that call's own and ends with it.
 * link:    made only on a daemon link's dial, reconnect or events, which run outside any mark
 *          (DaemonConnection connect, connectDirect, reconnectNow, scheduleReconnect, ensureLane).
 * outside: the creator itself runs its work under outsidePersonCall.
 * spent:   a follow-up of its own call that fires after that call returned (a later recheck): any
 *          mark it carries has already ended (rule 1).
 * no-send: lives on, but its callbacks send no command the mark lets through (a ping, a clock
 *          sample, a log line, a status file, a pushed copy that is refused on a revoked host for
 *          anyone, a detached process with no handler here).
 * local:   this machine's own daemon (`__local__`, or a host service's runtime in its own process),
 *          which is never a revoked host.
 */
type Class = 'call' | 'link' | 'outside' | 'spent' | 'no-send' | 'local'

/** Not this server: the daemon or the `walnut` CLI process runs it, so no request here makes it. */
const HOST_SIDE: Record<string, string> = {
  'src/providers/daemon-source.ts': 'the daemon twin (Node)',
  'src/providers/daemon-standalone.ts': 'the daemon twin (Bun)',
  'src/providers/acp-daemon.ts': 'the ACP half of the daemon',
  'src/providers/workspace-core.ts': 'the daemon\'s workspace commands (the server imports only its types)',
  'src/providers/wn-cli.ts': 'the on-host `walnut` CLI',
  'src/providers/daemon-service-cli.ts': 'the `walnut net` service CLI',
  'src/providers/transfer-core.ts': 'the daemon twins\' shared transfer half (the server imports only its types)',
  'src/providers/transfer-pack-core.ts': 'the daemon twins\' shared pack half (the server imports only its types)',
  'src/providers/trigger-check-core.ts': 'the daemon twins\' trigger checks (the server imports only its constants)',
  'src/providers/offline-host-core.ts': 'the daemon\'s offline answers (the server imports only its constants)',
}
const HOST_DIRS = ['src/providers/acp-worker/']

const CLASSIFIED: Record<string, Record<string, Class>> = {
  'src/core/daemon-file-reader.ts': { 'readSessionCost dial': 'link', 'readCodexOutside dial': 'link' },
  'src/core/hosts/host-copy.ts': { 'dropStaging timer': 'call', 'runCopy timer': 'call', 'waitFor timer': 'call' },
  'src/core/hosts/host-exec.ts': { 'slotFreed timer': 'call', 'dial timer': 'call' },
  'src/core/hosts/host-mcp-images.ts': { 'saveCallImages timer': 'call' },
  'src/core/hosts/host-script.ts': { 'runScriptOnHost timer': 'call' },
  // A switch job on this machine, detached and unref'd: nothing of it calls back here.
  'src/core/leader/switch/peer.ts': { 'startTargetJob process': 'no-send' },
  // A host service's link to the daemon runtime in its own process.
  'src/core/link/follower-link-direct.ts': { 'createDirectFollowerLink timer': 'local', 'createDirectFollowerLink timer #2': 'local', 'createDirectFollowerLink timer #3': 'local' },
  'src/core/routines/trigger-api.ts': { 'relinkTriggerDaemon timer': 'call' },
  'src/core/session-commit.ts': { 'connection timer': 'call', 'publish timer': 'call', 'askModel timer': 'call' },
  'src/core/sessions/ensure-cwd.ts': { 'ensureCwd timer': 'call' },
  // The standby host's heartbeat into its apply's status file.
  'src/core/standby/apply-status.ts': { 'withStatus interval': 'no-send' },
  'src/core/standby/remote-apply.ts': { 'sleep timer': 'call' },
  'src/core/standby/remote-transport.ts': { 'sleep timer': 'call', 'conn dial': 'link' },
  'src/core/transfer/daemon-transfer-client.ts': { 'defaultResolver timer': 'call', 'call timer': 'call' },
  'src/core/transfer/part-retry.ts': { 'partRetry timer': 'call', 'partRetry timer #2': 'call' },
  'src/core/turn-snapshots/service.ts': { 'dial timer': 'call' },
  'src/core/workspaces/daemon-client.ts': { 'realConnection timer': 'call' },
  // `later`: a workspace's recheck after the call that asked for it (cleanup.ts).
  'src/core/workspaces/manager.ts': { 'later timer': 'spent', 'mergeRecheckOn timer': 'call', 'removalPreview timer': 'call' },
  // The loopback server of a port forward over the link: its only server caller is
  // DaemonConnection.dialLinkPortForward, reached through ensurePortForward, outside the mark.
  'src/lib/link-stream.ts': { 'openFrame timer': 'call', 'listenLoopback socket': 'outside' },
  'src/providers/acp-session.ts': {
    'retireAcpRedirectLater timer': 'no-send', 'autoAllow timer': 'call', 'followEngineDefaultModel timer': 'call',
    'sendAccepted timer': 'call', 'requestTurnCompleteSelfReport timer': 'call', 'runControlPrompt timer': 'call',
  },
  'src/providers/daemon-connection.ts': {
    'drainJournalForMove timer': 'call', 'relinkForServiceSet timer': 'call',
    'setConnected interval': 'no-send', 'pushBridgeConfig timer': 'no-send',
    'pushHostSlice timer': 'no-send', 'pushHostSlice timer #2': 'no-send', 'pushHostSlice timer #3': 'no-send',
    'startBridgeRepush interval': 'no-send', 'connect dial': 'outside',
    // sharedJobVerdict: only drops a kept verdict from its map. opReadsJobNamed: the scanner's name
    // for REAL_CLOCK.setTimeout just below it, a liveness check's own deadline (watchedDeadline).
    // pushTriggersOnce: a retry of the trigger push, which is no person-only command.
    'sharedJobVerdict timer': 'no-send', 'opReadsJobNamed timer': 'call', 'pushTriggersOnce timer': 'no-send',
    'sendOnce timer': 'call', 'sendOnce timer #2': 'call', 'sendOnce timer #3': 'call',
    'drainBeforeAnswering timer': 'call', 'sendGatewayResult timer': 'no-send', 'checkUpstream timer': 'call',
    // A stream the host opened toward this server: made in the link's own events.
    'plugFollowerStream socket': 'link',
    'dialLinkPortForward socket': 'outside', 'dialPortForward process': 'outside',
    'pipeSingleStream process': 'call', 'pipeSingleStream timer': 'call', 'pipeChunk process': 'call', 'pipeChunk timer': 'call',
    'holdUpgradeForFoldPrewarm timer': 'call', 'holdUpgrade timer': 'call',
    'postponeUpgrade timer': 'link', 'startDeferredUpgrade timer': 'link', 'openHandoverWindow timer': 'link',
    'waitOverBusySwap timer': 'call', 'noteLinkDown timer': 'no-send',
    '_sendHandshake timer': 'call', 'announceProbeRole timer': 'call',
    'scheduleStayCheck timer': 'link', 'fetchWalnutFileOnHost timer': 'call', 'pipeChunked timer': 'call', 'pipeChunked timer #2': 'call',
    'createTunnel process': 'link', 'waitForTunnel socket': 'call', 'waitForTunnel timer': 'call', 'connectDirect dial': 'outside',
    'connectWebSocket socket': 'link', 'connectWebSocket timer': 'call',
    'retryBulkOwnLink timer': 'link', 'waitBulkChannel timer': 'call', 'scheduleBulkRedial timer': 'link',
    'openBulkSocket socket': 'link', 'openBulkSocket timer': 'call',
    'scheduleReconnect timer': 'outside', 'attachDuringSwap timer': 'call', 'startPing interval': 'link',
    // The pool: a new DaemonConnection and its connect()/connectDirect(), which dial outside the mark.
    'getDaemonConnectionOrThrow dial': 'link', 'getDaemonConnectionOrThrow dial #2': 'link',
    'getDirectDaemonConnection dial': 'link', 'getDirectDaemonConnection dial #2': 'link',
    'waitDaemonHandover timer': 'call', 'readDaemonLineFate timer': 'call', 'probeDaemonSessionArgs timer': 'call',
  },
  'src/providers/daemon-drain-resend.ts': { 'pause timer': 'call', 'waitHostLink timer': 'call' },
  'src/providers/daemon-net-update-io.ts': { 'runDetachedUpdate timer': 'call' },
  'src/providers/host-script-core.ts': { 'runBoundedScript timer': 'call', 'runBoundedScript timer #2': 'call', 'runBoundedScript timer #3': 'call' },
  'src/providers/in-process-daemon.ts': { 'stopInProcessDaemon timer': 'local' },
  'src/providers/local-daemon.ts': {
    'scheduleUpgradeRecheck timer': 'local', 'rpc timer': 'local', 'rpc socket': 'local', 'ping timer': 'local', 'ping socket': 'local',
    'stopDaemon timer': 'local', 'spawnDaemonWithEnv process': 'local', 'spawnDaemonWithEnv process #2': 'local', 'waitForPortFile timer': 'local',
  },
  'src/providers/remote-session-manager.ts': {
    'ensureCloudLink dial': 'outside', 'connectTransport dial': 'link', 'connectTransport dial #2': 'link', 'confirmSend timer': 'call',
  },
  'src/providers/service-set-hold.ts': { 'admit timer': 'call', 'drained timer': 'call' },
  // The lane: made in DaemonConnection.ensureLane, outside the mark; its redials come from its own events.
  'src/providers/stream-lane.ts': {
    'waitReady timer': 'call', 'connect socket': 'link', 'connect timer': 'call', 'startBeat interval': 'link',
    'teardown timer': 'link', 'dropped timer': 'link', 'freePort socket': 'call', 'accepting timer': 'call',
    'sshLaneForward process': 'link', 'sshLaneForward process #2': 'link', 'sshLaneForward timer': 'call',
  },
  'src/web/terminal/host-shell.ts': { 'runProgram process': 'call' },
  'src/web/v1-forward/stream-door.ts': { 'createCompanionDoor timer': 'call' },
  // The /ws server (it marks a person's terminal open): made at boot and per connection, never inside a call.
  'src/web/ws/handler.ts': { 'attachWss timer': 'no-send', 'attachWss interval': 'no-send' },
}

const KINDS: Array<[string, RegExp]> = [
  ['interval', /(?<![\w.])setInterval\(/g],
  ['timer', /(?<![\w.])setTimeout\(/g],
  ['socket', /new WebSocket\(|(?<![\w])net\.connect\(|(?<![\w.])createConnection\(|net\.createServer\(|(?<![\w.]|function )listenLoopback\(/g],
  ['process', /(?<![\w.])(?:deps\.)?(?:spawn|execFile|fork)\(/g],
  ['subscribe', /(?<![\w])(?:bus\.)?subscribe\(/g],
  ['dial', /new DaemonConnection\(|\.connect\(\)|\.connectDirect\(/g],
]
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'await', 'void', 'super', 'function', 'new', 'typeof'])
const DECLS = [
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\*?\s+([\w$]+)/,
  /^(?:export\s+)?(?:const|let)\s+([\w$]+)\s*=\s*(?:async\s*)?(?:\(|function\b|[\w$]+\s*=>)/,
  // A class member or an object literal's method at two spaces: with a modifier, or a whole
  // signature ending in its body's `{`, or a name whose parameters follow on the next lines.
  /^ {2}(?:(?:private|public|protected|static|async|readonly|override|get|set)\s+)+([\w$]+)\s*(?:<[^>]*>)?\(/,
  /^ {2}([\w$]+)\s*(?:<[^>]*>)?\([^)]*\)\s*(?::\s*[^{]+)?\{\s*$/,
  /^ {2}([\w$]+)\s*\($/,
]

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`
    if (e.isDirectory()) walk(rel, out)
    else if (/\.tsx?$/.test(e.name)) out.push(rel)
  }
  return out
}

/** The commands only a person's own call sends to a revoked host, read from the gate itself. */
function personOnlyCommands(): string[] {
  const src = read('src/providers/ephemeral-session-gate.ts')
  const m = src.match(/export const REVOKED_PERSON_ONLY_COMMANDS[^=]*= new Set\(\[([\s\S]*?)\]\)/)
  if (!m) throw new Error('REVOKED_PERSON_ONLY_COMMANDS not found in the gate')
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
}

const MARK_READERS = /\b(?:inPersonCall|asPersonCall|outsidePersonCall|assertPersonOnlyReach)\(/

function inScope(): string[] {
  const names = personOnlyCommands().map((c) => c.replace(/\./g, '\\.')).join('|')
  const quoted = new RegExp(`['"\`](?:${names})['"\`]`)
  return walk('src').filter((f) => !HOST_SIDE[f] && !HOST_DIRS.some((d) => f.startsWith(d))
    && f !== 'src/core/session-channel/person-call.ts' && f !== 'src/providers/ephemeral-session-gate.ts')
    .filter((f) => { const s = read(f); return quoted.test(s) || MARK_READERS.test(s) })
    .sort()
}

/** Code of a line: a comment line is none, a trailing `// ...` comment is dropped (not `ws://`). */
function code(line: string): string {
  const t = line.trim()
  if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return ''
  return line.replace(/(^|\s)\/\/(\s.*)?$/, '')
}

/** Every creator of a file, keyed `<enclosing function> <kind>` (`#2`, `#3` for more in one function). */
function creators(text: string): string[] {
  const keys: string[] = []
  const seen = new Map<string, number>()
  let fn = '(module)'
  for (const raw of text.split('\n')) {
    const line = code(raw)
    if (!line) continue
    for (const d of DECLS) {
      const m = line.match(d)
      if (m && !KEYWORDS.has(m[1])) { fn = m[1]; break }
    }
    for (const [kind, re] of KINDS) {
      for (const _ of line.matchAll(re)) {
        const base = `${fn} ${kind}`
        const n = (seen.get(base) ?? 0) + 1
        seen.set(base, n)
        keys.push(n === 1 ? base : `${base} #${n}`)
      }
    }
  }
  return keys
}

describe('nothing long-lived carries a person\'s mark', () => {
  const files = inScope()

  it('finds the modules that send what only a person may (the scan is not vacuous)', () => {
    expect(files).toContain('src/providers/daemon-connection.ts')
    expect(files).toContain('src/providers/stream-lane.ts')
    expect(files).toContain('src/core/hosts/host-exec.ts')
  })

  it('every creator in scope is classified, and every classified one still exists', () => {
    const unclassified: string[] = []
    const stale: string[] = []
    for (const f of files) {
      const found = creators(read(f))
      const known = CLASSIFIED[f] ?? {}
      for (const k of found) if (!known[k]) unclassified.push(`${f}: '${k}'`)
      for (const k of Object.keys(known)) if (!found.includes(k)) stale.push(`${f}: '${k}'`)
    }
    for (const f of Object.keys(CLASSIFIED)) if (!files.includes(f)) stale.push(`${f} (no longer in scope)`)
    expect(unclassified, 'A new timer, interval, socket, child process, subscription or daemon dial in a module that sends what only a person may send '
      + 'to a revoked host. Decide whether it can carry a person\'s mark past that person\'s own call, and add it to CLASSIFIED with its class '
      + '(call, link, outside, spent, no-send, local: see the header). A link or loop that serves later callers too must be made under outsidePersonCall '
      + '(core/session-channel/person-call.ts) first.').toEqual([])
    expect(stale, 'A classified creator is gone or renamed: drop or rename its row').toEqual([])
  })

  it('the classes are the known ones, never a leak', () => {
    const allowed = new Set<Class>(['call', 'link', 'outside', 'spent', 'no-send', 'local'])
    for (const [f, rows] of Object.entries(CLASSIFIED)) for (const [k, c] of Object.entries(rows)) expect(allowed.has(c), `${f}: ${k}`).toBe(true)
  })

  it('the links and loops that serve later callers are made outside the mark', () => {
    const dc = read('src/providers/daemon-connection.ts')
    const at = (sig: string) => dc.slice(dc.indexOf(sig), dc.indexOf(sig) + 400)
    for (const [sig, again] of [
      ['  async connect(): Promise<void> {', 'this.connect()'],
      ['  async connectDirect(wsUrl: string): Promise<void> {', 'this.connectDirect(wsUrl)'],
      ['  reconnectNow(): Promise<void> {', 'this.reconnectNow()'],
      ['  ensurePortForward(remotePort: number', 'this.ensurePortForward(remotePort, target, opts)'],
      ['  private ensureLane(): void {', 'this.ensureLane()'],
    ] as const) {
      expect(dc.indexOf(sig), sig).toBeGreaterThan(-1)
      expect(at(sig), sig).toContain(`if (inPersonCall()) return outsidePersonCall(() => ${again})`)
    }
    expect(dc).toMatch(/this\.reconnectTimer = outsidePersonCall\(\(\) => setTimeout\(/)
  })

  it('the scanner sees each kind and its enclosing function (the detector works)', () => {
    const sample = [
      'export function a() {', '  const t = setTimeout(() => {}, 1) // setInterval( in a comment', '  setInterval(() => {}, 1)', '}',
      'class X {', '  private dial(): void {', '    const ws = new WebSocket(`ws://127.0.0.1:1`)', '    spawn(\'ssh\', [])', '    void conn.connect()', '    setTimeout(() => {}, 2)', '  }', '}',
    ].join('\n')
    expect(creators(sample)).toEqual(['a timer', 'a interval', 'dial socket', 'dial process', 'dial dial', 'dial timer'])
  })
})
