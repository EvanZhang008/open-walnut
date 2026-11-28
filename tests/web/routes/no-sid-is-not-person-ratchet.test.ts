/**
 * Ratchet: "no session id" is never the person by itself (2026-11-28 review). A request that names no
 * session (`x-walnut-caller-sid`) is the person only when the one rule says so
 * (src/web/routes/person-caller.ts isPersonCaller: no automation mark, and this computer with a proof
 * of his client, or a paired device). Before, many routes read "no sid" alone as him, so a plain
 * `curl localhost:3456` or a script marked `x-walnut-caller-kind: automation` was framed
 * `sentBy: person`, answered his inbox, and was recorded `by: 'human'`.
 *
 * The class, enumerated from the source: every file that reads the caller's session id header and
 * makes a person decision from it (a `human` / `person` / `user` label, or a core rule that reads a
 * missing sid as the person: resolveCaller, resolveCallerPlacement, resolveBoardCaller,
 * answeredByCaller, the start-mode ceiling, ...) must also apply the rule (isPersonCaller,
 * isPersonNotAutomation, changedBy, callerSidOrOutside), or be listed in ALLOWED
 * with the reason its decision is not "this is the person". A new member fails here until it does.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, SRC, walk } from '../../helpers/send-call-sites.js'

/** Reading the caller's session id from a request. */
const READS_SID = /x-walnut-caller-sid|\bCALLER_SID_HEADER\b|\bcallerSid\(req\)/

/** A decision that a caller with no session is the person. */
const PERSON_DECISIONS: Array<[string, RegExp]> = [
  ['a human label', /\bby:\s*'human'|\bkind:\s*'human'|\bhuman:\s*true\b|return\s+'human'|[?:]\s*'human'\s*[:)}]|=\s*'human'/],
  ['a person frame', /\bsentBy:\s*'person'/],
  ['the user as author', /'user'\s+as\s+const|\bauthor:\s*'user'/],
  ['a person source when no sid', /\b(?:callerSid|sid)\s*\?\s*'[a-z-]+'\s*:\s*'(?:ui|web-ui-retry|mobile|cli|web-api|api-v1|chat)'/],
  ['a core rule that reads no sid as the person',
    /\b(resolveCaller|resolveCallerPlacement|resolveBoardCaller|resolveThreadCaller|answeredByCaller|startCallerOf|capStartMode|modeChangeRefusal|projectSourceRefusal|stopperOf|performMobileLaunch)\(/],
]

/** The one rule, in any of its forms. */
const APPLIES_RULE = /\b(isPersonCaller|isPersonNotAutomation|isPersonInOwnWindow|changedBy|callerSidOrOutside)\(|=\s*callerSidOrOutside\b/

/**
 * Files that read the sid and make one of those decisions, but whose decision is not "this caller is
 * the person". Each says why. A file leaves this list once it applies the rule.
 */
const ALLOWED: Record<string, string> = {
  // The rule itself and the helpers that implement it.
  'src/web/routes/person-caller.ts': 'the rule itself',
  'src/web/routes/local-person-proof.ts': 'the proof the rule reads',
  'src/core/sessions/session-send-core.ts': 'core: resolveCaller is handed callerSidOrOutside by every route (this test checks the routes)',
  'src/core/sessions/caller-placement.ts': 'core: handed callerSidOrOutside by every route that decides a person from it',
  'src/core/boards/board-team.ts': 'core: resolveBoardCaller is handed callerSidOrOutside by board-v1.ts and brief-v1.ts',
  'src/core/org/thread-caller.ts': 'core: handed callerSidOrOutside by org-threads-v1.ts; topics-v1.ts refuses a non-person itself',
  'src/core/sessions/outside-wait.ts': 'core: a session id from the op, a session check only',
  // Routes whose sid decides something other than "the person did it".
  'src/web/routes/hosts-fleet-v1.ts': 'prefers the calling session\'s host; no sid only means no preference',
  'src/web/routes/task-watch-v1.ts': 'whom a watch reports to: a caller with no task falls back to the node that follows the task',
  'src/web/routes/api-v1.ts': 'caller placement of created work and the calling session\'s own task; its person labels go through routeSource',
  'src/web/routes/tasks.ts': 'caller placement of created work; its person labels go through routeSource',
  'src/ops/executor.ts': 'the client side: it sets the header; its human mode is the terminal rule (lib/cli-sender.ts)',
  'src/replica/away-reads.ts': 'a phone\'s own Board post shown as the user\'s on a host replica; the sid only hides a status read',
  'src/web/routes/task-start-check-v1.ts': 'its caller is requestCaller\'s (core/sessions/request-caller.ts), which applies callerSidOrOutside (checked below)',
  'src/web/routes/approvals-v1.ts': 'person-only: refuses with isPersonCaller before it reads the sid',
}

function code(file: string): string {
  // Comments name the header and the labels in prose; only code decides.
  return fs.readFileSync(path.join(ROOT, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
}

/** Why a file's code is a member of the class with no rule applied, or null. */
function unguardedPersonDecision(src: string): string | null {
  if (!READS_SID.test(src)) return null
  if (APPLIES_RULE.test(src)) return null
  const hit = PERSON_DECISIONS.find(([, re]) => re.test(src))
  return hit ? hit[0] : null
}

const files = walk(SRC).map((f) => path.relative(ROOT, f).split(path.sep).join('/')).filter((f) => f.endsWith('.ts'))

describe('a missing caller session id is never the person by itself', () => {
  it('every file that reads the sid and decides a person from it applies the one rule', () => {
    const offenders = files
      .filter((f) => !(f in ALLOWED))
      .map((f) => ({ f, why: unguardedPersonDecision(code(f)) }))
      .filter((x) => x.why)
      .map((x) => `${x.f}: ${x.why}`)
    expect(offenders, 'apply isPersonCaller / changedBy / callerSidOrOutside (src/web/routes/changed-by.ts), or list the file in ALLOWED with why').toEqual([])
  })

  it('every ALLOWED entry still exists and still reads the sid (a stale entry goes)', () => {
    for (const f of Object.keys(ALLOWED)) {
      expect(fs.existsSync(path.join(ROOT, f)), f).toBe(true)
      expect(READS_SID.test(code(f)) || /callerSid/.test(code(f)), f).toBe(true)
    }
  })

  it('flags the shapes the review found (the detector itself)', () => {
    const header = "const sid = header(req, 'x-walnut-caller-sid')\n"
    // task-v1.ts callerBy, agent-memory-v1.ts, triage-rules-v1.ts, router-v1.ts, sessions.ts
    expect(unguardedPersonDecision(`${header}if (!sid) return { by: 'human' }`)).toBe('a human label')
    expect(unguardedPersonDecision(`${header}let by = 'human'`)).toBe('a human label')
    expect(unguardedPersonDecision(`${header}by: callerSid ? \`session:\${callerSid}\` : 'human' }`)).toBe('a human label')
    // org-v1.ts nodeCaller
    expect(unguardedPersonDecision(`${header}if (!sid) return { human: true, writer: { by: 'human' } }`)).toBe('a human label')
    // board-v1.ts
    expect(unguardedPersonDecision(`${header}const caller = await resolveBoardCaller(sid)`)).toBe('a core rule that reads no sid as the person')
    // human-inbox-v1.ts
    expect(unguardedPersonDecision(`${header}const by = await answeredByCaller(sid)`)).toBe('a core rule that reads no sid as the person')
    // messages-v1.ts Send now
    expect(unguardedPersonDecision(`${header}source: callerSid ? 'peer' : 'web-ui-retry'`)).toBe('a person source when no sid')
    // session-chat.ts style framing
    expect(unguardedPersonDecision(`${header}prepareHintedSend(id, r, t, { sentBy: 'person' })`)).toBe('a person frame')
    // The same code with the rule applied passes.
    expect(unguardedPersonDecision(`const sid = callerSidOrOutside(req)\nif (!sid) return { by: 'human' }`)).toBeNull()
    expect(unguardedPersonDecision(`${header}if (!sid) return isPersonCaller(req) ? 'human' : 'agent'`)).toBeNull()
    // A file that never reads the sid is not a member.
    expect(unguardedPersonDecision("return { by: 'human' }")).toBeNull()
  })

  it('the shared request reader applies the rule', () => {
    expect(code('src/core/sessions/request-caller.ts')).toMatch(/const callerSid = callerSidOrOutside\(req\)/)
  })

  it('routes hand routeSource and startRouteSource the request, never its headers alone', () => {
    const bad = files.filter((f) => /\b(?:startRouteSource|routeSource)\([^)]*\breq\.headers\b/.test(code(f)))
    expect(bad).toEqual([])
    const src = code('src/core/sessions/send-sent-by.ts')
    const body = (name: string) => src.slice(src.indexOf(`export function ${name}(`), src.indexOf('\n}\n', src.indexOf(`export function ${name}(`)))
    expect(body('routeSource')).toMatch(/isPersonCaller\(req\)/)
    expect(body('startRouteSource')).toMatch(/isPersonCaller\(req\)/)
  })

  it('a socket call frames words as the person only from the person\'s own socket', () => {
    const handler = code('src/web/ws/handler.ts')
    expect(handler).toMatch(/withRpcCaller\(client\.person === true,/)
    const chat = code('src/web/routes/session-chat.ts')
    expect(chat).toMatch(/rpcCallerIsPerson\(\)/)
    // No literal person frame or person source: each comes from the socket's flag.
    expect(chat).not.toMatch(/sentBy:\s*'person'/)
    expect(chat).not.toMatch(/source:\s*'ui'/)
    expect(chat).not.toMatch(/\.\.\.attributedUnlessAutomated\('ui:typed-message'\),/)
  })
})
