/**
 * Guard: with the experiment `switchable_leader` on, only the machine holding the write
 * permission may send anything outward or fire a timer or trigger. Each way out passes one door
 * function (src/core/leader/switch/doors.ts OUTWARD_DOORS) that checks the permission first. A
 * new way out that skips the door would let two machines send the same mail, push or fire, so:
 *  - each primitive behind a door (a provider send, a push URL, a daemon configure, a cron run,
 *    a calendar write, a tracker request, a git push) is pinned to its files with an exact
 *    count of call sites: a new one fails here until it is behind a door and counted;
 *  - each door function in OUTWARD_DOORS must check the door in its own body, BEFORE the first
 *    call of the primitive it guards (PRIMITIVE_OF below);
 *  - every IntegrationSync method is classified write / read / local for the task-sync door, and
 *    every write one is refused through the guard.
 * Backups (src/core/backup/backup-scheduler.ts) are deliberately not a door: every machine keeps
 * its own copy.
 */
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { OUTWARD_DOORS, setOutwardDoorChecker } from '../../../../src/core/leader/switch/doors.js'
import { guardSync, SYNC_METHOD_DOORS } from '../../../../src/core/private-tasks/sync-guard.js'
import type { IntegrationSync } from '../../../../src/core/integration-types.js'

const ROOT = path.resolve(__dirname, '../../../..')
const SRC = path.join(ROOT, 'src')

function sources(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) sources(p, out)
    else if (/\.(ts|tsx|mts)$/.test(e.name) && !/\.d\.ts$/.test(e.name)) out.push(p)
  }
  return out
}

/**
 * A file's code without its comments (a comment naming a call is not a call): whole comment lines,
 * and a `//` comment at the end of a line of code (outside a string on that line).
 */
function code(file: string): string {
  return fs.readFileSync(file, 'utf-8')
    .replace(/^\s*(\/\/|\*|\/\*).*$/gm, '')
    .split('\n').map(withoutEndComment).join('\n')
}

/** `line` up to a `//` that is not inside a quoted string on it. */
function withoutEndComment(line: string): string {
  let quote: string | null = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = null
      continue
    }
    if (c === "'" || c === '"' || c === '`') quote = c
    else if (c === '/' && line[i + 1] === '/' && (i === 0 || /[\s;,)}\]]/.test(line[i - 1]!))) return line.slice(0, i)
  }
  return line
}

const ALL = sources(SRC).map((file) => ({ rel: path.relative(SRC, file), text: code(file) }))

/** Matches of `pattern` per file (relative to src/), files with none left out. */
function sites(pattern: RegExp, only?: (rel: string) => boolean): Record<string, number> {
  const out: Record<string, number> = {}
  for (const { rel, text } of ALL) {
    if (only && !only(rel)) continue
    const n = text.match(new RegExp(pattern.source, 'g'))?.length ?? 0
    if (n > 0) out[rel] = n
  }
  return out
}

/** A call of `name(` or `name?.(` (generic arguments allowed), not a method of something else. */
function callPattern(name: string): RegExp {
  return new RegExp(`(?<![\\w.$])${name}(?:<[^>()]*>)?(?:\\?\\.)?\\(`, 'g')
}

/** Call sites of `name` (callPattern), its own definition not counted. */
function callSites(name: string): Record<string, number> {
  const call = callPattern(name)
  const def = new RegExp(`function\\s+${name}(?:<[^>()]*>)?\\(`, 'g')
  const out: Record<string, number> = {}
  for (const { rel, text } of ALL) {
    const n = (text.match(call)?.length ?? 0) - (text.match(def)?.length ?? 0)
    if (n > 0) out[rel] = n
  }
  return out
}

const NEW_SITE = 'a new call site of an outward primitive: put it behind a door check'
  + ' (if (leaderPermitActive()) assertOutwardDoor(kind, opId), src/core/leader/switch/doors.ts),'
  + ' list the door function in OUTWARD_DOORS, then update the count here'

describe('every outward primitive is called only where a door guards it (source)', () => {
  it('the mail provider sends only from MailSends.execute', () => {
    expect(sites(/provider\([^()]*\)\s*\.send(?:\?\.)?\(/), NEW_SITE).toEqual({ 'integrations/mail/sends.ts': 1 })
  })

  it('the unsubscribe request leaves only from the ladder behind MailUnsubscribe.run', () => {
    expect(callSites('fetchUnsubscribe'), NEW_SITE).toEqual({ 'integrations/mail/unsubscribe.ts': 1 })
  })

  it('APNs is reached only through sendApns, whose own body checks the door', () => {
    expect(callSites('sendApns'), NEW_SITE).toEqual({ 'core/push/deliver.ts': 1, 'core/push/work-card.ts': 2 })
  })

  it('the Expo push URL is posted to only by sendExpo', () => {
    expect(sites(/exp\.host\/--\/api\/v2\/push\/send/), NEW_SITE).toEqual({ 'core/push/deliver.ts': 1 })
    expect(sites(/fetch\(EXPO_PUSH_URL/), NEW_SITE).toEqual({ 'core/push/deliver.ts': 1 })
  })

  it('a daemon is armed with triggers and plugin jobs only from the guarded passes', () => {
    // service-set-move-checks.ts dropWalnutScope: a service set move empties this Walnut's sets on the shared daemon.
    // host-follow.ts sends only the EMPTY set (the old leader's own daemon disarms before the switch's
    // stop, also once this machine may no longer act): it arms nothing, so it passes no door.
    expect(sites(/\.send(?:\?\.)?\('triggers\.configure'/), NEW_SITE).toEqual({ 'providers/daemon-connection.ts': 3, 'providers/service-set-move-checks.ts': 1, 'core/leader/switch/host-follow.ts': 1 })
    expect(code(path.join(SRC, 'core/leader/switch/host-follow.ts'))).toMatch(/\.send\('triggers\.configure', \{ home, config: \{ version: 1, triggers: \[\] \} \}/)
    expect(sites(/\.send(?:\?\.)?\('jobs\.configure'/), NEW_SITE).toEqual({ 'core/plugin-jobs/manager.ts': 1, 'providers/service-set-move-checks.ts': 1 })
  })

  it('a routine runs only through executeJob, from the guarded entries', () => {
    expect(callSites('executeJob'), NEW_SITE).toEqual({ 'core/cron/timer.ts': 1, 'core/cron/ops.ts': 2 })
  })

  it('a trigger fire is claimed only through claimFire', () => {
    expect(callSites('claimFire'), NEW_SITE).toEqual({ 'core/routines/trigger-events.ts': 1 })
  })

  it('a daemon is told to run a check only from relayCheckRun', () => {
    expect(sites(/\.send(?:\?\.)?\('triggers\.run'/), NEW_SITE).toEqual({ 'core/cron/ops.ts': 1 })
  })

  it('the calendar source is written only by CalendarService', () => {
    expect(sites(/source\.(createEvent|updateEvent|deleteEvent)(?:\?\.|!)?\(/), NEW_SITE)
      .toEqual({ 'integrations/calendar/service.ts': 3 })
  })

  it('the task trackers request only through their clients (reached through the guarded plugin sync)', () => {
    const msTodo = (rel: string) => rel === 'integrations/microsoft-todo.ts'
    expect(sites(/https\.request\(/, msTodo), NEW_SITE).toEqual({ 'integrations/microsoft-todo.ts': 1 })
    expect(callSites('graphRequest'), NEW_SITE).toEqual({ 'integrations/microsoft-todo.ts': 10 })
    const jira = (rel: string) => rel === 'integrations/jira/jira-client.ts'
    expect(sites(/transport\.request\(/, jira), NEW_SITE).toEqual({ 'integrations/jira/jira-client.ts': 1 })
    expect(sites(/this\.request(?:<[^>()]*>)?\(/, jira), NEW_SITE).toEqual({ 'integrations/jira/jira-client.ts': 9 })
  })

  it('the data repo is pushed only by the guarded sync and the compaction', () => {
    // Any git command string that pushes to origin, with options between (a force-with-lease).
    // The compaction's delivery lives in git-compaction-deliver.ts, reached only from
    // compactGitHistory in the worker that compactionDoorRefusal() gates (test below).
    expect(sites(/['"`]push\b[^'"`]*\borigin\b/), NEW_SITE)
      .toEqual({ 'integrations/git-sync.ts': 1, 'integrations/git-compaction-deliver.ts': 1 })
    expect(callSites('pushViaBundle'), NEW_SITE)
      .toEqual({ 'integrations/git-sync.ts': 1, 'integrations/git-compaction-deliver.ts': 1 })
    expect(callSites('deliverCompactedChain'), 'only the compaction delivers a rewritten chain')
      .toEqual({ 'integrations/git-compaction.ts': 1 })
  })

  it('the compaction worker is forked only after its door (it ends in a force push, and the worker holds no permission)', () => {
    // The fork lives in src/web/server.ts attemptCompaction: it must ask compactionDoorRefusal()
    // first and skip the run when it answers a refusal.
    expect(callSites('compactionDoorRefusal'), 'web/server.ts attemptCompaction must call compactionDoorRefusal() before it forks the worker')
      .toEqual({ 'web/server.ts': 1 })
    const body = bodyOf(code(path.join(SRC, 'web/server.ts')), 'attemptCompaction') ?? ''
    const door = body.indexOf('compactionDoorRefusal(')
    expect(door, 'attemptCompaction asks compactionDoorRefusal()').toBeGreaterThan(-1)
    expect(door, 'compactionDoorRefusal() comes before the fork').toBeLessThan(body.search(/\bfork\(/))
  })

  it('the mail server is changed (read flags, moves, invite answers) only behind the mail-write doors', () => {
    expect(sites(/spec\.(markRead|markReadMany|moveMany|archiveMany|respondToInvite)(?:!|\?\.)\(/), NEW_SITE).toEqual({
      'integrations/mail/service.ts': 2, 'integrations/mail/mail-filter-moves.ts': 2, 'integrations/mail/invites.ts': 1,
    })
    // The IMAP provider's writes, reached only through those calls.
    expect(sites(/client\.(messageMove|messageFlagsAdd|messageFlagsRemove|mailboxCreate)(?:\?\.)?\(/), NEW_SITE)
      .toEqual({ 'integrations/mail-imap/provider.ts': 6 })
  })

  it('the cloud companion is written only through the guarded uploads', () => {
    // cloud-ingest.ts: ingest, replica, journal and host-replica are doors; the fifth is
    // postCloudSession, a person's own send to a session, answered to them.
    expect(sites(/\bfetch\(/, (rel) => rel === 'core/cloud-ingest.ts'), NEW_SITE).toEqual({ 'core/cloud-ingest.ts': 5 })
    expect(sites(/\.send(?:\?\.)?\('mobile-event'/), NEW_SITE)
      .toEqual({ 'core/projection-cache.ts': 1, 'web/routes/events-v1.ts': 1 })
    // The companion's devices (a machine token's create and revoke, the owner adoption, and the
    // tokens of a host the person revoked: revokeBridgeTokens).
    expect(sites(/\bfetch\(/, (rel) => rel === 'integrations/cloud-bridge-config.ts'), NEW_SITE)
      .toEqual({ 'integrations/cloud-bridge-config.ts': 4 })
    expect(callSites('mintMachineToken'), NEW_SITE).toEqual({ 'integrations/cloud-bridge-config.ts': 1 })
    expect(callSites('adoptOnce'), NEW_SITE).toEqual({ 'integrations/cloud-bridge-config.ts': 1 })
  })

  it('a host is issued its door credential only from issueOnce, and the old leader\'s machine only from prepareOldMachineAsHost', () => {
    // The credential is minted and sent to the host only after the door (session-channel/leader-issue.ts);
    // the leader switch mints the old machine's own after the same door (leader/switch/host-follow.ts).
    expect(callSites('mintHostCredential'), NEW_SITE).toEqual({ 'core/session-channel/leader-issue.ts': 1, 'core/leader/switch/host-follow.ts': 1 })
    expect(callSites('sendCredential'), NEW_SITE).toEqual({ 'core/session-channel/leader-issue.ts': 1 })
  })
})

describe('every IntegrationSync method is classified for the task-sync door', () => {
  afterEach(() => { setOutwardDoorChecker(null) })

  function interfaceMembers(): string[] {
    const src = fs.readFileSync(path.join(SRC, 'core/integration-types.ts'), 'utf-8')
    const start = src.indexOf('export interface IntegrationSync')
    expect(start).toBeGreaterThan(-1)
    let depth = 0
    let body = ''
    for (let i = src.indexOf('{', start); i < src.length; i++) {
      if (src[i] === '{') depth++
      else if (src[i] === '}' && --depth === 0) { body = src.slice(start, i); break }
    }
    // Members sit at two spaces; nested parameter types and doc lines sit deeper.
    return [...body.matchAll(/^ {2}(\w+)\??\s*[(:<]/gm)].map((m) => m[1]!)
  }

  it('names every method of the interface, and no other', () => {
    const members = interfaceMembers()
    expect(members.length).toBeGreaterThan(20)
    const classified = Object.keys(SYNC_METHOD_DOORS)
    expect(members.filter((m) => !classified.includes(m)), 'classify these in SYNC_METHOD_DOORS (sync-guard.ts): write, read or local').toEqual([])
    expect(classified.filter((m) => !members.includes(m)), 'SYNC_METHOD_DOORS names a method the interface no longer has').toEqual([])
  })

  it('refuses every write method through the guard without reaching the plugin, and lets reads through', async () => {
    const calls: string[] = []
    const raw = new Proxy({}, {
      get: (_t, prop) => typeof prop === 'symbol' ? undefined : async () => { calls.push(String(prop)); return null },
    }) as IntegrationSync
    const guarded = guardSync('svc', raw) as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>
    const asked: string[] = []
    setOutwardDoorChecker((kind, opId) => {
      asked.push(`${kind} ${opId}`)
      throw Object.assign(new Error('not the leader'), { name: 'PermitNotHeld' })
    }, () => false)
    const synced = { id: 't-sync', source: 'svc', title: 'y' }
    for (const [method, what] of Object.entries(SYNC_METHOD_DOORS)) {
      const arg = method === 'deleteProjectRemote' ? { project: 'P', tasks: [synced] } : synced
      const out = await Promise.resolve().then(() => guarded[method]!(arg, synced)).then(() => 'went', (e: unknown) => (e as Error).name)
      if (what === 'write') expect(out, `${method} is a write: the door refuses it`).toBe('PermitNotHeld')
      else expect(out, `${method} is a ${what}: no door`).toBe('went')
    }
    const writes = Object.entries(SYNC_METHOD_DOORS).filter(([, w]) => w === 'write').map(([m]) => m)
    expect(asked).toHaveLength(writes.length)
    expect(calls.filter((c) => writes.includes(c))).toEqual([])
  })
})

/**
 * The body of `fn` in `text`: a function, a method or an arrow bound to a const. From the first
 * `{` after its parameter list and return type to the brace that closes it.
 */
function bodyOf(text: string, fn: string): string | null {
  const def = new RegExp(
    `^[ \\t]*(?:export\\s+)?(?:(?:private|public|protected|static)\\s+)*(?:async\\s+)?`
    + `(?:function\\s+${fn}\\b|${fn}\\s*(?=[(<])|const\\s+${fn}\\s*=\\s*(?:async\\s*)?(?=\\())`,
    'gm',
  )
  for (let m = def.exec(text); m; m = def.exec(text)) {
    let i = m.index + m[0].length
    // The parameter list.
    while (i < text.length && text[i] !== '(') i++
    let depth = 0
    for (; i < text.length; i++) {
      if (text[i] === '(') depth++
      else if (text[i] === ')' && --depth === 0) { i++; break }
    }
    // A definition goes on to its body or its return type; a call statement (`  name(a, b)`
    // at the start of a line) goes on to anything else, and is skipped.
    const next = text.slice(i).match(/^\s*(\S)/)?.[1]
    if (next !== '{' && next !== ':' && !(next === '=' && /^\s*=>/.test(text.slice(i)))) continue
    return bodyFrom(text, i)
  }
  return null
}

/** From after a parameter list: past the return type to the body's `{`, then to its close. */
function bodyFrom(text: string, from: number): string | null {
  let i = from
  let depth = 0
  // The return type (it may hold braces inside <> or ()), up to the body's `{`.
  let angle = 0
  let paren = 0
  for (; i < text.length; i++) {
    const c = text[i]
    if (c === '=' && text[i + 1] === '>') { i++; continue }
    if (c === '<') angle++
    else if (c === '>') angle--
    else if (c === '(') paren++
    else if (c === ')') paren--
    else if (c === '{' && angle === 0 && paren === 0) break
  }
  const start = i
  depth = 0
  for (; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}' && --depth === 0) return text.slice(start, i + 1)
  }
  return null
}

/**
 * The call each door function guards: its door (an act call) must come before the first one in
 * its body. Null for a door that only holds work back with a query (a timer, a pass) while the act
 * itself passes another door: a board reminder's fire, a topic mail's send (sends.execute).
 */
const PRIMITIVE_OF: Record<string, RegExp | null> = {
  'integrations/mail/approvals.ts#consoleSend': /freezeDraft\(|this\.mintAndSend\(/,
  'integrations/mail/approvals.ts#mintAndSend': /approveDraft\(/,
  'integrations/mail/sends.ts#execute': /claimSendAttempt\(/,
  'core/topics/topic-mail.ts#passOnce': null,
  'integrations/mail/unsubscribe.ts#run': /claimUnsubscribe\(/,
  'integrations/mail/service.ts#markRead': /spec\.markRead!\(/,
  'integrations/mail/service.ts#markReadMany': /spec\.markReadMany!\(/,
  'integrations/mail/invites.ts#respond': /respondToInvite!\(/,
  'integrations/mail/mail-filter-moves.ts#move': /\bcall\(rows/,
  'core/push/apns.ts#sendApns': /loadCredential\(/,
  'core/push/deliver.ts#sendExpo': /fetch\(EXPO_PUSH_URL/,
  'core/push/quiet-hold.ts#holdPushForQuiet': null,
  'core/push/quiet-hold.ts#releaseHeld': /held\.clear\(\)/,
  'core/cron/timer.ts#findDueJobs': null,
  'core/cron/jobs.ts#wakeAtMsOf': null,
  'core/cron/timer.ts#armTimer': null,
  'core/cron/ops.ts#run': /runningAtMs = now|executeJob\(/,
  'core/cron/timer.ts#executeJob': /runningAtMs = startedAt/,
  'core/cron/ops.ts#relayCheckRun': /\.send\('triggers\.run'/,
  'core/routines/trigger-events.ts#claimFire': /claimBatched\(/,
  'core/routines/trigger-events.ts#deliverFires': /applyTriggerFired\(/,
  'core/routines/trigger-events.ts#sweepOwedFires': /applyTriggerFired\(/,
  'providers/daemon-connection.ts#pushTriggersOnce': /\.send\('triggers\.configure'/,
  'core/plugin-jobs/manager.ts#reconcileOnce': /handle\.send\(|uploadFile\(/,
  'providers/service-set-move-checks.ts#dropWalnutScope': /\.send\('(triggers|jobs)\.configure'/,
  'integrations/calendar/service.ts#updateEvent': /source\.updateEvent\(/,
  'integrations/calendar/service.ts#createEvent': /source\.createEvent\(/,
  'integrations/calendar/service.ts#deleteEvent': /source\.deleteEvent\(/,
  'core/task-wait-until.ts#sweepWaitUntil': /deadlines\.delete\(/,
  'core/task-wait-until.ts#arm': null,
  'core/sessions/promise-alarm.ts#firePromiseAlarms': /alarms\.delete\(/,
  'core/sessions/promise-alarm.ts#arm': null,
  'core/boards/board-reminders.ts#sweepBoardReminders': null,
  'core/boards/board-reminders.ts#fire': /patchBoardReminder/,
  'core/boards/board-reminders.ts#arm': null,
  'core/org/lead-waits.ts#tellLead': /deliverToSession\(/,
  'core/private-tasks/sync-guard.ts#guardSync': /\.apply\(target/,
  'core/plugins/server-api.ts#fetch': /await fetch\(url/,
  'integrations/git-sync.ts#syncInner': /gitSafeAsync\(`push/,
  'integrations/git-compaction.ts#compactionDoorRefusal': null,
  'core/cloud-ingest.ts#postToCloudIngest': /\bfetch\(/,
  'core/cloud-ingest.ts#postToCloudReplica': /\bfetch\(/,
  'core/cloud-ingest.ts#postToCloudJournal': /\bfetch\(/,
  'core/cloud-ingest.ts#postToCloudHostReplica': /\bfetch\(/,
  'core/projection-cache.ts#pushViaBridge': /\.send\('mobile-event'/,
  'web/routes/events-v1.ts#forwardMobileEventToBridge': /\.send\('mobile-event'/,
  'integrations/cloud-bridge-config.ts#mintMachineToken': /\bfetch\(/,
  'integrations/cloud-bridge-config.ts#adoptOnce': /\bfetch\(/,
  'integrations/cloud-bridge-config.ts#revokeBridgeTokens': /\bfetch\(/,
  'core/session-channel/leader-issue.ts#issueOnce': /mintHostCredential\(/,
  'core/leader/switch/host-follow.ts#prepareOldMachineAsHost': /mintHostCredential\(/,
}

/** A door call that acts: it asks the permission under a kind, and refuses. */
const ACT_CALL = /assertOutwardDoor\(|outwardDoorRefusal\(|beginOutwardSend\(/
/**
 * A query a timer asks (whether the doors are open): it refuses nothing, so it counts only for a
 * door whose PRIMITIVE_OF is null, never as the door before an act.
 */
const QUERY_CALL = /outwardDoorsOpen\(|doorsClosed\(|doorTimerFloorMs\(/
/** A send that registers its op id with the witnesses (OutwardDoor.opIds). */
const OP_ID_CALL = /beginOutwardSend\(/

describe('every door function checks the door (source)', () => {
  it('names files that exist and functions found in them', () => {
    for (const door of OUTWARD_DOORS) {
      const file = path.join(SRC, door.file)
      expect(fs.existsSync(file), `${door.file} is gone: update OUTWARD_DOORS`).toBe(true)
      expect(bodyOf(code(file), door.fn), `${door.file} has no function ${door.fn}: update OUTWARD_DOORS`).not.toBeNull()
    }
  })

  it.each(OUTWARD_DOORS.map((d) => [`${d.file} ${d.fn} (${d.kind})`, d] as const))('%s', (_name, door) => {
    const body = bodyOf(code(path.join(SRC, door.file)), door.fn) ?? ''
    const key = `${door.file}#${door.fn}`
    expect(key in PRIMITIVE_OF, `${key}: name the call its door must come before in PRIMITIVE_OF (null for a timer's query)`).toBe(true)
    const primitive = PRIMITIVE_OF[key]
    // A door before an act refuses; a timer's query (no act of its own) may only ask.
    if (primitive) expect(body, `${door.fn} in ${door.file} must check the door before it acts (${door.onRefusal})`).toMatch(ACT_CALL)
    else expect(`${body.match(ACT_CALL) ?? ''}${body.match(QUERY_CALL) ?? ''}`, `${door.fn} in ${door.file} must ask the door (${door.onRefusal})`).not.toBe('')
    // These ask whether a permit guards this process themselves.
    if (!/doorsClosed\(|doorTimerFloorMs\(|beginOutwardSend\(/.test(body)) {
      expect(body, `${door.fn} checks the door only while a permit guards this process`).toMatch(/leaderPermitActive\(\)/)
    }
    // A door that acts names its kind (the permit records it); a timer's query names none.
    if (ACT_CALL.test(body)) {
      expect(body, `${door.fn} checks the door under another kind than ${door.kind}`).toContain(`'${door.kind}'`)
    }
    // A send with op ids registers its op (OutwardDoor.opIds); any other door does not.
    if (door.opIds) expect(body, `${door.fn} sends with op ids: it begins its op (beginOutwardSend)`).toMatch(OP_ID_CALL)
    else expect(body, `${door.fn} begins an op: mark its OUTWARD_DOORS row opIds: true`).not.toMatch(OP_ID_CALL)
    // Before the act, not merely somewhere in the body (by text position, not control flow: a
    // door in another branch still passes, which review reads for).
    if (primitive) {
      const at = body.search(primitive)
      expect(at, `${key}: ${primitive} is not in its body any more: update PRIMITIVE_OF`).toBeGreaterThan(-1)
      expect(body.search(door.opIds ? OP_ID_CALL : ACT_CALL), `${key}: the door must come before ${primitive}`).toBeLessThan(at)
    }
  })

  it('an op is begun only by the op-id doors', () => {
    const files = new Set(OUTWARD_DOORS.filter((d) => d.opIds).map((d) => d.file))
    const begun = callSites('beginOutwardSend')
    delete begun['core/leader/switch/doors.ts']
    expect(Object.keys(begun).filter((f) => !files.has(f)), 'a new op-id send: list its door with opIds: true').toEqual([])
    expect(begun).toEqual({ 'integrations/mail/sends.ts': 1 })
  })

  it('reads code the way the checks above need it', () => {
    expect(withoutEndComment("  x() // assertOutwardDoor('push', 'y')")).toBe('  x() ')
    expect(withoutEndComment("  fetch('https://exp.host/--/api') // a note")).toBe("  fetch('https://exp.host/--/api') ")
    expect(withoutEndComment('  const a = `//not-a-comment`')).toBe('  const a = `//not-a-comment`')
    expect('sendApns?.(a); sendApns(b); push.sendApns(c); deps.sendApns?.(d)'.match(callPattern('sendApns'))).toHaveLength(2)
  })

  it('PRIMITIVE_OF names only door functions', () => {
    const doors = new Set(OUTWARD_DOORS.map((d) => `${d.file}#${d.fn}`))
    expect(Object.keys(PRIMITIVE_OF).filter((k) => !doors.has(k))).toEqual([])
  })

  it('every kind names at least one door', () => {
    const src = fs.readFileSync(path.join(SRC, 'core/leader/switch/doors.ts'), 'utf-8')
    const union = src.match(/export type OutwardDoorKind =([\s\S]*?)\n\n/)?.[1] ?? ''
    const kinds = [...union.matchAll(/'([a-z-]+)'/g)].map((m) => m[1])
    expect(kinds.length).toBeGreaterThan(0)
    for (const kind of kinds) {
      expect(OUTWARD_DOORS.some((d) => d.kind === kind), `kind ${kind} has no door in OUTWARD_DOORS`).toBe(true)
    }
  })
})
