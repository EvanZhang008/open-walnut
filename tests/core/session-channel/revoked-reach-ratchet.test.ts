/**
 * Every way a host reaches this leader (and this leader reaches it) is classified for a revoke
 * (src/core/session-channel/revoked-reach.ts REVOKED_REACH), enumerated here from the source, so a
 * new way in turns this red until someone decides it:
 *   - each event a daemon sends up its link: daemon-connection.ts (`ev === '...'`, `ev.startsWith`)
 *     and every file that takes a link's events (`.onEvent(`: its `.ev === '...'` and `switch (x.ev)`)
 *   - each such consumer file
 *   - each kind of stream the host opens toward this leader (`info.from === '...'`)
 *   - each kind of journal record a drain applies (offline-handover.ts applyRecord, apply-v2.ts MAC_DRAINS)
 *   - each push of this leader's state (DaemonConnection.push*)
 *   - each command this leader sends a daemon (`.send('<name>'`, outside the daemon's own twins)
 *   - each op that can aim at a host (a `host` input, or a host_* name), from the registry itself
 * A refused row names the entry (file and function) whose body reads the ban, through the one
 * alias-aware function (revoked-hosts.ts revokedAs) or a wrapper of it. No file reads a ban by a
 * bare host key: a new check that does (a revoked mark beside `hostKey ===`, a set of its own), or a
 * new reader the table does not name, fails the last tests.
 */
import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-revoked-reach-ratchet'))

import { REVOKED_REACH, REVOKED_REFUSED, REVOKED_STILL_REACHES } from '../../../src/core/session-channel/revoked-reach.js'
import { MAC_DRAINS } from '../../../src/core/offline-merge/apply-v2.js'
import { listOps } from '../../../src/ops/index.js'

const ROOT = path.resolve(__dirname, '../../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const DAEMON = 'src/providers/daemon-connection.ts'
/** The daemon's own twins: they run on the host and send nothing to it. */
const DAEMON_TWINS = new Set(['src/providers/daemon-source.ts', 'src/providers/daemon-standalone.ts'])
/** A function body reads the ban (revokedAs, or a wrapper that calls it). */
const READS_BAN = /\b(revokedAs|revokedAsIn|hostRevokedNow|assertHostNotRevoked|machineRevokedNow|revokedHostIn|hostDoorRevoked|revokedReach|isRevoked|drainRevoked|revokedHostOfSession|revokedWhy|revokeBridgeTokens)\(/

/** The block from `at` (a `{`) to the brace that closes it. */
function blockEnd(src: string, at: number): number {
  let depth = 0
  for (let i = at; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) return i }
  }
  throw new Error('no end of a block')
}

/** The `{` that opens a function's body, `from` just past the `(` of its parameters (past them and any return type). */
function bodyOpen(src: string, from: number): number {
  let i = from
  for (let paren = 1; i < src.length && paren > 0; i++) { if (src[i] === '(') paren++; else if (src[i] === ')') paren-- }
  let angle = 0
  for (; i < src.length; i++) {
    const c = src[i]
    if (c === '<') angle++
    else if (c === '>' && src[i - 1] !== '=') angle--
    else if (c === '{') {
      const prev = src.slice(0, i).trimEnd().slice(-1)
      // An object type in the return type (`Promise<{ a: 1 }>`, `: { a: 1 }`): not the body.
      if (angle > 0 || prev === ':' || prev === '|' || prev === '&') { i = blockEnd(src, i); continue }
      return i
    }
  }
  return -1
}

/** The body of the function (or block) that starts at `signature`: ending in `(` (its parameters follow) or `{` (the body itself). */
function bodyOf(src: string, signature: string): string {
  const start = src.indexOf(signature)
  expect(start, signature).toBeGreaterThan(-1)
  const end = start + signature.length
  const open = signature.endsWith('{') ? end - 1 : signature.endsWith('(') ? bodyOpen(src, end) : src.indexOf('{', end)
  expect(src[open], signature).toBe('{')
  return src.slice(start, blockEnd(src, open) + 1)
}

/** The source without its comment lines (a doc comment's example is no member). */
const noComments = (src: string) => src.replace(/^\s*(\/\/|\/?\*).*$/gm, '')
/** The commands the daemon's own dispatch takes (daemon-standalone.ts dispatchCommand's switch). */
function daemonCommands(): string[] {
  const src = read('src/providers/daemon-standalone.ts')
  return all(bodyOf(src.slice(src.indexOf('function dispatchCommand(')), 'switch (cmd.cmd) {'), /case '([^']+)':/g)
}

const all = (src: string, re: RegExp): string[] => [...new Set([...src.matchAll(re)].map((m) => m[1]!))].sort()

function files(dir: string): string[] {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? files(`${dir}/${e.name}`) : e.name.endsWith('.ts') ? [`${dir}/${e.name}`] : []))
}
const SRC = files('src')

function members(): Record<string, string[]> {
  const daemon = read(DAEMON)
  const frame = bodyOf(daemon, 'private handleFrame(')
  const consumers = SRC.filter((f) => f !== DAEMON && /\.onEvent\(/.test(read(f)))
  const evNames = (src: string) => all(src, /(?<!typeof\s+[\w.?]*)\bev\s*[!=]==\s*'([^']+)'/g)
    .concat([...src.matchAll(/switch \([\w.]*\bev\) \{/g)].flatMap((m) => all(bodyOf(src.slice(m.index), 'switch'), /case '([^']+)':/g)))
  const events = [...evNames(daemon), ...all(frame, /\bev\.startsWith\('([^']+)'\)/g), ...consumers.flatMap((f) => evNames(read(f)))]
  const applyRecord = bodyOf(read('src/core/offline-handover.ts'), 'async function applyRecord(')
  // Every command the daemon takes (its own switch, so a name sent through a variable is in too),
  // and every literal one this leader sends, comment lines left out.
  const commands = [...daemonCommands(), ...SRC.filter((f) => !DAEMON_TWINS.has(f)).flatMap((f) => all(noComments(read(f)), /\.send\('([a-zA-Z][\w.:-]*)'/g))]
  const ops = listOps({ includeDeprecated: true }).filter((op) => op.name.startsWith('host_') || Object.hasOwn((op.input ?? {}) as object, 'host')).map((op) => op.name)
  return {
    'daemon-event': [...new Set(events)],
    consumer: consumers,
    stream: all(daemon, /\binfo\.from === '([^']+)'/g),
    journal: [...new Set([...all(applyRecord, /case '([^']+)':/g), ...MAC_DRAINS])],
    copy: all(daemon, /^ {2}(push[A-Z]\w*)\(\): (?:void|Promise<void>) \{/gm),
    cmd: [...new Set(commands)],
    op: [...new Set(ops)],
  }
}

/** Rows that are not one member of an enumerated kind. */
const FIXED = ['door', 'issue', 'channel', 'start', 'send', 'expose', 'acp-allow', 'daemon-hello', 'daemon-answer', 'daemon-event:*']

describe('every way a host reaches this leader is classified for a revoke', () => {
  it('finds the members it enumerates (the patterns still match the source)', () => {
    const m = members()
    expect(m['daemon-event']).toEqual(expect.arrayContaining(['gateway-request', 'offline-journal', 'launch-request', 'trigger.fired', 'stream-', 'oneshot.', 'jsonl', 'exit']))
    expect(m.consumer).toEqual(expect.arrayContaining(['src/providers/remote-session-manager.ts', 'src/providers/acp-session.ts']))
    expect(m.stream).toEqual(['companion', 'follower', 'hub'])
    expect(m.journal).toEqual(expect.arrayContaining(['op', 'row', 'task-create', 'session', 'held-op']))
    expect(m.copy).toEqual(expect.arrayContaining(['pushHostSlice', 'pushBridgeConfig', 'pushTriggersNow']))
    expect(m.cmd).toEqual(expect.arrayContaining(['start', 'acpStart', 'oneshot.run', 'exec.run', 'secrets.put', 'host.slice', 'leader.configure']))
    expect(m.op).toEqual(expect.arrayContaining(['host_exec', 'host_copy', 'host_mcp_call', 'subagent_run', 'task_start']))
  })

  it('each member has a row, and each row is a member (none stale)', () => {
    const m = members()
    const wanted = Object.entries(m).flatMap(([kind, names]) => names.map((n) => `${kind}:${n}`))
    const missing = wanted.filter((k) => !REVOKED_REACH[k])
    expect(missing, 'classify each in src/core/session-channel/revoked-reach.ts REVOKED_REACH: refused (and its entry), or stays (and why)').toEqual([])
    const stale = Object.keys(REVOKED_REACH).filter((k) => !FIXED.includes(k) && !wanted.includes(k))
    expect(stale, 'rows for members the source no longer has').toEqual([])
    for (const k of FIXED) expect(REVOKED_REACH[k], k).toBeDefined()
  })

  it('every row says why, and every refused row\'s entry reads the ban in its own body', () => {
    for (const [k, r] of Object.entries(REVOKED_REACH)) {
      expect(r.what.length, k).toBeGreaterThan(10)
      if (r.verdict === 'stays') { expect(r.why.length, k).toBeGreaterThan(10); continue }
      expect(bodyOf(read(r.check.file), r.check.fn), `${k}: ${r.check.file} ${r.check.fn} reads the ban`).toMatch(READS_BAN)
    }
  })

  it('the refusals sit where nothing has run yet', () => {
    const daemon = read(DAEMON)
    // Each relay its daemon brings and each push it would get: the ban is read before the entry does anything else.
    for (const [k, r] of Object.entries(REVOKED_REACH)) {
      if (r.verdict !== 'refused' || r.check.file !== DAEMON || r.check.fn === 'private streamEndpoint(') continue
      const body = bodyOf(daemon, r.check.fn)
      const first = body.search(READS_BAN)
      const work = body.search(/\bawait\b|\bvoid \(async|\bthis\.send\(|\bimport\(/)
      expect(first, k).toBeGreaterThan(-1)
      expect(first, `${k}: the ban is read before any work`).toBeLessThan(work === -1 ? Infinity : work)
    }
    // The gateway: before the switch over its capabilities. The drain: before it reads one record, and each round.
    const gateway = bodyOf(read('src/core/peers/capability-router.ts'), 'export async function handleGatewayCapability(')
    expect(gateway.indexOf('revokedAs(')).toBeGreaterThan(-1)
    expect(gateway.indexOf('revokedAs(')).toBeLessThan(gateway.indexOf('switch (capability)'))
    const handover = bodyOf(read('src/core/offline-handover.ts'), 'async function handover(')
    expect(handover.indexOf('drainRevoked(conn)')).toBeGreaterThan(-1)
    expect(handover.indexOf('drainRevoked(conn)')).toBeLessThan(handover.indexOf('const batch: Batch'))
    expect(bodyOf(read('src/core/offline-handover.ts'), 'async function drainRounds(')).toMatch(/for \(let round[^\n]*\n[^\n]*\n\s*if \(round > 0 && await drainRevoked\(conn\)\)/)
    // A start: the first line of the routing check every start path takes; a new process: the first lines of the command gate.
    expect(bodyOf(read('src/providers/claude-code-session.ts'), 'private async assertStartRouting(')).toMatch(/\{\s*\/\/[^\n]*\n\s*assertHostNotRevoked\(data\.host,/)
    expect(bodyOf(read('src/providers/ephemeral-session-gate.ts'), 'export function gateSessionCommand(')).toMatch(/const canonicalCommand = canonical\(cmd, params\)\n(\s*\/\/[^\n]*\n)*\s*const spawns = !!canonicalCommand && REVOKED_REFUSES_COMMANDS\.has\(canonicalCommand\)\n\s*if \(spawns\) assertHostNotRevoked\(scope\.host,/)
    // A person-only command: right after, in the same gate; the server marks a person's request; an ACP allow before its link.
    expect(bodyOf(read('src/providers/ephemeral-session-gate.ts'), 'export function gateSessionCommand(')).toMatch(/if \(spawns\)[^\n]*\n\s*const personOnly = [^\n]*\n\s*if \(personOnly && !inPersonCall\(\)\) assertHostNotRevoked\(scope\.host,/)
    expect(read('src/web/server.ts')).toMatch(/app\.use\('\/api', \(req, _res, next\) => \{ if \(isPersonCaller\(req\)\) asPersonCall\(next\); else next\(\) \}\)/)
    const acp = bodyOf(read('src/providers/acp-session.ts'), 'async resolvePermissionRequest(')
    expect(acp.indexOf('revokedAs(this.host)')).toBeGreaterThan(-1)
    expect(acp.indexOf('revokedAs(this.host)')).toBeLessThan(acp.indexOf('this.ensureConn()'))
    // A subagent: before its work copy; a task start: before its folder or workspace.
    const sub = bodyOf(read('src/core/subagents/registry.ts'), 'export async function startLightSubagent(')
    expect(sub.indexOf('revokedAs(host)')).toBeGreaterThan(-1)
    expect(sub.indexOf('revokedAs(host)')).toBeLessThan(sub.indexOf('checkEngineOnHost('))
    const launch = bodyOf(read('src/core/sessions/task-start.ts'), 'async function prepareLaunch(')
    expect(launch.indexOf('assertHostNotRevoked(launch.host')).toBeLessThan(launch.indexOf('ensureCwd('))
    expect(launch.indexOf('assertHostNotRevoked(launch.host')).toBeLessThan(launch.lastIndexOf('ensureTaskDirOnHost('))
    // A move: before the old session stops or the work is packed; a transfer: in its plan, before anything moves.
    const sw = bodyOf(read('src/core/sessions/engine-switch.ts'), 'async function switchFrom(')
    expect(sw.indexOf('revokedWhy(host')).toBeGreaterThan(-1)
    for (const work of ['hostGone(', 'switchHostBlocker(', 'runEngineSwitch(']) if (sw.includes(work)) expect(sw.indexOf('revokedWhy(host'), work).toBeLessThan(sw.indexOf(work))
    const plan = bodyOf(read('src/core/transfer/planner.ts'), 'export function planTransfer(')
    expect(plan.indexOf('revokedWhy(host')).toBeGreaterThan(-1)
    const transfer = read('src/core/transfer/transfer.ts')
    expect(transfer.indexOf('planTransfer(task')).toBeLessThan(transfer.indexOf('moveWorkspace({'))
    // A revoke reads the twin snapshot before the ban names the machine's other keys (R2-N1).
    const revoke = bodyOf(read('src/core/session-channel/leader-issue.ts'), 'export async function revokeHostDoorNow(')
    expect(revoke.indexOf('daemonTwinsReady()')).toBeGreaterThan(-1)
    expect(revoke.indexOf('daemonTwinsReady()')).toBeLessThan(revoke.indexOf('revokeHostDoor(hostKey'))
    // The door: before its keys are offered; its recheck too.
    expect(bodyOf(read('src/core/session-channel/host-door.ts'), 'async function stillStands(')).toMatch(READS_BAN)
  })

  it('the command gate refuses exactly the table\'s rows: every spawn for everyone, the person rows unless a person\'s own call', async () => {
    const { REVOKED_REFUSES_COMMANDS, REVOKED_PERSON_ONLY_COMMANDS } = await import('../../../src/providers/ephemeral-session-gate.js')
    const GATE = 'src/providers/ephemeral-session-gate.ts'
    const cmds = (pick: (r: (typeof REVOKED_REACH)[string]) => boolean) => Object.entries(REVOKED_REACH)
      .filter(([k, r]) => k.startsWith('cmd:') && r.verdict === 'refused' && r.check.file === GATE && pick(r)).map(([k]) => k.slice(4)).sort()
    // agent.* names are routed to their canonical command first (agent-command-map.ts), which the gate checks.
    expect(cmds((r) => !/unless a person/.test(r.what)).filter((c) => !c.startsWith('agent.'))).toEqual([...REVOKED_REFUSES_COMMANDS].sort())
    expect(cmds((r) => /unless a person/.test(r.what))).toEqual([...REVOKED_PERSON_ONLY_COMMANDS].sort())
  })

  it('the revoke\'s answer comes from the same table', () => {
    const stays = Object.values(REVOKED_REACH).filter((r) => r.verdict === 'stays')
    for (const r of stays) expect(REVOKED_STILL_REACHES).toContain(`${r.what}: ${r.why}`)
    expect(REVOKED_STILL_REACHES.at(-1)).toMatch(/remove the host from the config or turn it off/)
    for (const r of Object.values(REVOKED_REACH)) if (r.verdict === 'refused') expect(REVOKED_REFUSED).toContain(r.what)
    expect(read('src/web/routes/host-doors.ts')).toMatch(/refused: REVOKED_REFUSED, stillReaches: REVOKED_STILL_REACHES/)
  })
})

describe('a ban is read only through the one alias-aware function', () => {
  it('no file compares a revoked mark against a bare host key, or keeps a set of revoked hosts of its own', () => {
    const bad: string[] = []
    for (const f of SRC) {
      if (f === 'src/core/session-channel/revoked-hosts.ts') continue
      const lines = read(f).split('\n')
      lines.forEach((line, i) => {
        if (/\.revoked\b[^\n]*\bhostKey\s*===|\bhostKey\s*===[^\n]*\.revoked\b/.test(line)) bad.push(`${f}:${i + 1}: ${line.trim()}`)
        if (/\brevoked\w*(Hosts|Keys)?\.has\(/i.test(line) && /host/i.test(line)) bad.push(`${f}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(bad, 'read the ban through revoked-hosts.ts revokedAs / hostRevokedNow (or host-credentials.ts revokedHostIn over records)').toEqual([])
  })

  it('every reader of the ban is an entry the table names, or one of the few that keep or classify the ban', () => {
    const KEEPERS: Record<string, string> = {
      'src/core/session-channel/revoked-hosts.ts': 'the ban itself',
      'src/core/session-channel/revoked-reach.ts': 'the table',
      'src/core/session-channel/leader-issue.ts': 'reads the records into the ban (refreshRevokedHosts), revokes and allows',
      'src/core/session-channel/leader-boot.ts': 'hands the leader side hostRevokedNow and the ban its alias reader',
      'src/core/session-channel/leader-apply.ts': 'the channel\'s apply: the isRevoked the leader side hands it (leader-side.ts)',
      'src/web/routes/host-doors.ts': 'says the ban, and refuses a revoke or allow through a banned host',
      'src/providers/delivery-failure.ts': 'a refusal is a permanent delivery failure (parked with why)',
      'src/providers/remote-session-manager.ts': 'a refusal is an answer: nothing was written',
      'src/integrations/cloud-bridge-config.ts': 'never mints a machine token for a revoked host (copy:pushBridgeConfig)',
    }
    const checks = new Set(Object.values(REVOKED_REACH).flatMap((r) => (r.verdict === 'refused' ? [r.check.file] : [])))
    const readers = SRC.filter((f) => READS_BAN.test(read(f).replace(/^\s*(\/\/|\*).*$/gm, '')) || /revoked-hosts\.js/.test(read(f)))
    const unknown = readers.filter((f) => !checks.has(f) && !KEEPERS[f])
    expect(unknown, 'a new reader of the ban: add its row to revoked-reach.ts (refused, with this file and function as its entry)').toEqual([])
  })
})
