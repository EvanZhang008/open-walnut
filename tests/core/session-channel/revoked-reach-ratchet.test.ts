/**
 * Every way a host reaches this leader (and this leader reaches it) is classified for a revoke
 * (src/core/session-channel/revoked-reach.ts REVOKED_REACH), enumerated here from the source, so a
 * new way in turns this red until someone decides it:
 *   - each event its daemon sends up its link (daemon-connection.ts: `ev === '...'`, `ev.startsWith`)
 *   - each kind of stream the host opens toward this leader (`info.from === '...'`)
 *   - each kind of journal record a drain applies (offline-handover.ts applyRecord, apply-v2.ts MAC_DRAINS)
 *   - each copy this leader pushes to its daemon (daemon-connection.ts repushCopy)
 *   - each `host_*` op (src/ops)
 * A refused row names the file whose check refuses it, and that file reads the ban through the one
 * alias-aware function (revoked-hosts.ts revokedAs). No file reads a ban by a bare host key: a new
 * check that does (a revoked mark beside `hostKey ===`, a set of its own) fails the last test.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { REVOKED_REACH, REVOKED_REFUSED, REVOKED_STILL_REACHES } from '../../../src/core/session-channel/revoked-reach.js'
import { MAC_DRAINS } from '../../../src/core/offline-merge/apply-v2.js'

const ROOT = path.resolve(__dirname, '../../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const DAEMON = 'src/providers/daemon-connection.ts'

/** The body of the function that starts at `signature`, from the first `opener` after it (the text ending in its `{`) to the brace that closes it. */
function bodyOf(src: string, signature: string, opener = signature): string {
  const start = src.indexOf(signature)
  expect(start, signature).toBeGreaterThan(-1)
  const open = src.indexOf(opener, start) + opener.length - 1
  expect(src[open], `${signature}: ${opener}`).toBe('{')
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1) }
  }
  throw new Error(`no end of ${signature}`)
}

const all = (src: string, re: RegExp): string[] => [...new Set([...src.matchAll(re)].map((m) => m[1]!))].sort()

function members(): Record<string, string[]> {
  const daemon = read(DAEMON)
  const frame = bodyOf(daemon, 'private handleFrame(msg: Record<string, unknown>)', 'Promise<void> | void {')
  const events = all(daemon, /(?<!typeof\s+[\w.]*)\bev === '([^']+)'/g).concat(all(frame, /\bev\.startsWith\('([^']+)'\)/g))
  const applyRecord = bodyOf(read('src/core/offline-handover.ts'), 'async function applyRecord(', '): Promise<void> {')
  const ops = fs.readdirSync(path.join(ROOT, 'src/ops')).filter((f) => f.endsWith('.ts'))
    .flatMap((f) => all(read(`src/ops/${f}`), /\bname: '(host_[a-z_]+)'/g))
  return {
    'daemon-event': events,
    stream: all(daemon, /\binfo\.from === '([^']+)'/g),
    journal: [...all(applyRecord, /case '([^']+)':/g), ...MAC_DRAINS],
    copy: all(bodyOf(daemon, 'private repushCopy(cmd: string): void {'), /case '([^']+)':/g),
    op: ops,
  }
}

/** Rows that are not one member of an enumerated kind. */
const FIXED = ['door', 'issue', 'channel', 'start', 'send', 'daemon-hello', 'daemon-answer', 'daemon-event:*']

describe('every way a host reaches this leader is classified for a revoke', () => {
  it('finds the members it enumerates (the patterns still match the source)', () => {
    const m = members()
    expect(m['daemon-event']).toEqual(expect.arrayContaining(['gateway-request', 'offline-journal', 'launch-request', 'trigger.fired', 'stream-', 'oneshot.']))
    expect(m.stream).toEqual(['companion', 'follower', 'hub'])
    expect(m.journal).toEqual(expect.arrayContaining(['op', 'row', 'task-create', 'session', 'held-op']))
    expect(m.copy).toEqual(expect.arrayContaining(['host.slice', 'triggers.configure']))
    expect(m.op).toEqual(expect.arrayContaining(['host_exec', 'host_copy', 'host_mcp_call']))
  })

  it('each member has a row, and each row is a member (none stale)', () => {
    const m = members()
    const wanted = Object.entries(m).flatMap(([kind, names]) => names.map((n) => `${kind}:${n}`))
    const missing = wanted.filter((k) => !REVOKED_REACH[k])
    expect(missing, 'classify each in src/core/session-channel/revoked-reach.ts REVOKED_REACH: refused (and where), or stays (and why)').toEqual([])
    const stale = Object.keys(REVOKED_REACH).filter((k) => !FIXED.includes(k) && !wanted.includes(k))
    expect(stale, 'rows for members the source no longer has').toEqual([])
    for (const k of FIXED) expect(REVOKED_REACH[k], k).toBeDefined()
  })

  it('every row says why, and every refused row names a file whose check reads the ban through revokedAs', () => {
    for (const [k, r] of Object.entries(REVOKED_REACH)) {
      expect(r.what.length, k).toBeGreaterThan(10)
      if (r.verdict === 'stays') { expect(r.why.length, k).toBeGreaterThan(10); continue }
      const src = read(r.check)
      expect(src, `${k}: ${r.check} reads the ban`).toMatch(/\b(revokedAs|revokedAsIn|hostRevokedNow|assertHostNotRevoked|revokedHostIn|hostDoorRevoked|revokedRelay)\(|\brevoked: hostRevokedNow\b|deps\.revoked\?\.\(/)
    }
  })

  it('the refusals sit where nothing has run yet', () => {
    const daemon = read(DAEMON)
    // Each relay its daemon brings is refused by name before its handler does anything.
    for (const [k, r] of Object.entries(REVOKED_REACH)) {
      if (r.verdict !== 'refused' || r.check !== DAEMON) continue
      const name = k.slice(k.indexOf(':') + 1)
      const literal = k.startsWith('stream:') ? `revokedRelay('${k}')` : `revokedRelay('${name}')`
      if (name.startsWith('trigger.')) expect(bodyOf(daemon, 'private dispatchTriggerEvent(event: DaemonEvent): Promise<void> {'), k).toMatch(/^\s*if \(this\.revokedRelay\(event\.ev\)\) return/m)
      else expect(daemon, k).toContain(literal)
    }
    // The gateway: before the switch over its capabilities. The drain: before it reads one record.
    const gateway = bodyOf(read('src/core/peers/capability-router.ts'), 'export async function handleGatewayCapability(', '): Promise<CapabilityOutcome> {')
    expect(gateway.indexOf('revokedAs(')).toBeGreaterThan(-1)
    expect(gateway.indexOf('revokedAs(')).toBeLessThan(gateway.indexOf('switch (capability)'))
    const handover = bodyOf(read('src/core/offline-handover.ts'), 'async function handover(conn: HandoverConnection): Promise<HandoverResult> {')
    expect(handover.indexOf('hostRevokedNow(conn.hostKey)')).toBeGreaterThan(-1)
    expect(handover.indexOf('hostRevokedNow(conn.hostKey)')).toBeLessThan(handover.indexOf('const batch: Batch'))
    // A start: the first line of the routing check every start path takes.
    expect(bodyOf(read('src/providers/claude-code-session.ts'), 'private async assertStartRouting(', '): Promise<void> {')).toMatch(/\): Promise<void> \{\s*\/\/[^\n]*\n\s*assertHostNotRevoked\(data\.host,/)
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
  const files = (dir: string): string[] => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? files(`${dir}/${e.name}`) : e.name.endsWith('.ts') ? [`${dir}/${e.name}`] : []))
  const SRC = files('src')

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

  it('every reader of the ban is a check the table names, or one of the few that keep the ban itself', () => {
    const KEEPERS: Record<string, string> = {
      'src/core/session-channel/revoked-hosts.ts': 'the ban itself',
      'src/core/session-channel/revoked-reach.ts': 'the table',
      'src/core/session-channel/leader-issue.ts': 'reads the records into the ban (refreshRevokedHosts), revokes and allows',
      'src/core/session-channel/leader-boot.ts': 'hands the leader side hostRevokedNow and the ban its alias reader',
      'src/core/session-channel/leader-apply.ts': 'the channel\'s apply: the isRevoked the leader side hands it (leader-side.ts)',
      'src/web/routes/host-doors.ts': 'says the ban (revokedHostIn over the records)',
    }
    const checks = new Set(Object.values(REVOKED_REACH).flatMap((r) => (r.verdict === 'refused' ? [r.check] : [])))
    const readers = SRC.filter((f) => /\b(revokedAs|revokedAsIn|hostRevokedNow|assertHostNotRevoked|revokedHostIn|hostDoorRevoked|isRevoked)\(|revoked-hosts\.js/.test(read(f)))
    const unknown = readers.filter((f) => !checks.has(f) && !KEEPERS[f])
    expect(unknown, 'a new reader of the ban: add its row to revoked-reach.ts (refused, with this file as its check)').toEqual([])
  })
})
