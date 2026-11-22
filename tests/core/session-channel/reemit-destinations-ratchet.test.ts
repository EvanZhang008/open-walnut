/**
 * A host picks no subscriber on the leader (src/core/session-channel/event-classes.ts
 * reemitDestinations): its records reach only the readers in REEMIT_ALLOWED. Every named
 * (non-global) bus subscriber of src/ is classified, allowed or refused, so a new command
 * subscriber cannot be reached by a host's record until someone decides it may.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { REEMIT_ALLOWED, REEMIT_ALLOWED_PREFIXES, REEMIT_REFUSED, reemitDestinations } from '../../../src/core/session-channel/event-classes.js'
import { EventBus } from '../../../src/core/event-bus.js'
import { RETRY_OVER_SUBSCRIBER } from '../../../src/core/sessions/held-error.js'

const SRC = path.resolve(__dirname, '../../../src')
/** Subscribers named by a value this scan cannot read; each resolved or explained. */
const RESOLVED: Record<string, string | null> = {
  RETRY_OVER_SUBSCRIBER,
  // A lane's turn relay (web/routes/lane-turn-sse.ts): a name per request, reached only by '*'.
  subName: null,
}

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    return e.isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : []
  })
}

function namedSubscribers(): Map<string, string> {
  const out = new Map<string, string>()
  for (const f of files(SRC)) {
    const s = fs.readFileSync(f, 'utf8')
    const re = /\bbus\.subscribe\(\s*([^,]+?)\s*,/g
    let m: RegExpExecArray | null
    while ((m = re.exec(s))) {
      const rest = s.slice(m.index + m[0].length)
      const next = rest.indexOf('bus.subscribe(')
      const call = (next < 0 ? rest : rest.slice(0, next)).slice(0, 3000)
      if (/global:\s*true/.test(call)) continue
      const arg = m[1]
      let name: string | null
      if (/^'[^']+'$/.test(arg)) name = arg.slice(1, -1)
      else {
        const local = new RegExp(`(?:const|let)\\s+${arg}\\s*=\\s*'([^']+)'`).exec(s)
        if (local) name = local[1]
        else if (arg in RESOLVED) name = RESOLVED[arg]
        else throw new Error(`${path.relative(SRC, f)}: a named subscriber this ratchet cannot read (${arg}): add it to RESOLVED`)
      }
      if (name) out.set(name, path.relative(SRC, f))
    }
  }
  return out
}

describe('the leader subscribers a host record may reach', () => {
  it('every named subscriber is allowed or refused', () => {
    const subs = namedSubscribers()
    expect(subs.size).toBeGreaterThan(8)
    const unclassified = [...subs].filter(([n]) => !REEMIT_ALLOWED.includes(n) && !REEMIT_REFUSED.includes(n)).map(([n, f]) => `${n} (${f})`)
    expect(unclassified).toEqual([])
  })

  it('no command subscriber is allowed', () => {
    for (const n of ['session-runner', 'subagent-runner', 'task-outbox', 'push-notifications']) expect(REEMIT_ALLOWED).not.toContain(n)
    expect(REEMIT_ALLOWED).toContain(RETRY_OVER_SUBSCRIBER)
  })

  it('a host naming a refused or unknown destination reaches only the allowed ones', () => {
    expect(reemitDestinations(['session-runner'])).toEqual(['main-ai'])
    expect(reemitDestinations(['session-runner', 'web-ui', 'anything-else'])).toEqual(['web-ui'])
    expect(reemitDestinations(undefined)).toEqual(['main-ai'])
  })

  it('a host\'s \'*\' is never passed on: it stands for the allowed readers and the per-request readers registered now (R2-M2)', () => {
    expect(REEMIT_ALLOWED).not.toContain('*')
    const dest = reemitDestinations(['*', 'main-ai'], ['push-notifications', 'approvals', 'api-v1-lane-relay-t1', 'cloud-fallback-relay-t2', 'task-outbox'])
    expect(dest).not.toContain('*')
    expect(dest.sort()).toEqual([...REEMIT_ALLOWED, 'api-v1-lane-relay-t1', 'cloud-fallback-relay-t2'].sort())
    for (const p of REEMIT_ALLOWED_PREFIXES) expect(REEMIT_REFUSED.some((r) => r.startsWith(p))).toBe(false)
  })

  it('on a real bus, a host fact naming \'*\' reaches no refused subscriber (R2-M2)', () => {
    const bus = new EventBus()
    const heard: string[] = []
    for (const name of [...REEMIT_REFUSED, ...REEMIT_ALLOWED, 'api-v1-lane-relay-turn-1']) bus.subscribe(name, () => { heard.push(name) })
    bus.emit('session:result', { sessionId: 'sess-acme-1' }, reemitDestinations(['*'], bus.subscriberNames()), { source: 'host-channel' })
    for (const refused of REEMIT_REFUSED) expect(heard, refused).not.toContain(refused)
    expect(heard.sort()).toEqual([...REEMIT_ALLOWED, 'api-v1-lane-relay-turn-1'].sort())
  })
})
