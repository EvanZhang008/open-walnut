/**
 * Every router finds an item's owner by one process, written once (src/core/router/decision-rules.ts):
 * search all tasks alike, check each candidate, keep looking, and only then write to the person.
 * No VP tier: no list of VPs to pick from, no "else the VP of its project, else Main".
 *
 * Why (2026-11-17, the user: "don't add the work with VP, I think this concept is confusing, every
 * router can route to any task, just need to search it up ... need to check first if it is this
 * message, right if not keep looking"): a DoorDash interview invitation went to the person as a
 * letter while an ordinary "Interview" task owned it, because the router was handed only the VPs.
 *
 * The class guard reads every router source file and every op a router uses: a new text that
 * brings back a VP tier fails here. All names below are invented.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { routerContext } from '../../src/core/router/context.js'
import { ROUTER_DECISION_RULES, ROUTER_OWNER_NOTE } from '../../src/core/router/decision-rules.js'
import { ROUTER_SYSTEM_PROMPT } from '../../src/core/router/session-policy.js'
import { routerKey } from '../../src/core/router/store.js'
import { ROUTER_WAKE_OWNER_NOTE } from '../../src/core/router/wake.js'
import type { RouterAreasFile } from '../../src/core/router/areas.js'
import { getOp } from '../../src/ops/index.js'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8')

/** Wording that hands a router a VP tier or a list to pick from instead of a search. */
const VP_TIER = [
  /router_context owners/i,
  /VP of (?:its|the matching|their) project/i,
  /preferred (?:when it fits|VP)/i,
  /owners: open VPs/i,
  /task or VP\b/i,
  /\bor the VP\b/i,
  /\belse Main\b/i,
  /\bVPs \(owners\)/i,
  /a VP \(or Main\)/i,
]

/** Every file a router's words or rules come from (its own code, the ops it is shown) and every page that describes it. */
function routerSourceFiles(): string[] {
  const dir = path.join(ROOT, 'src/core/router')
  const own = fs.readdirSync(dir).filter((f) => f.endsWith('.ts')).map((f) => `src/core/router/${f}`)
  // The pages that tell the person what a router does say the same.
  const pages = ['web/src/components/org', 'web/src/apps/mail', 'web/src/components/router'].flatMap((d) =>
    fs.readdirSync(path.join(ROOT, d)).filter((f) => /router/i.test(f) && /\.tsx?$/.test(f)).map((f) => `${d}/${f}`))
  return [...own, 'src/ops/router.ts', 'src/web/routes/router-v1.ts', ...pages]
}

describe('one way to find an owner, for every router', () => {
  it('no router source and no router op describes a VP tier', () => {
    const hits: string[] = []
    for (const file of routerSourceFiles()) {
      const text = read(file)
      for (const pattern of VP_TIER) if (pattern.test(text)) hits.push(`${file}: ${pattern}`)
    }
    for (const op of ['router_context', 'router_route', 'router_create', 'router_update']) {
      const def = getOp(op)
      expect(def, op).toBeDefined()
      const text = JSON.stringify({ description: def!.description, input: Object.fromEntries(Object.entries(def!.input ?? {}).map(([k, v]) => [k, (v as { description?: string }).description ?? ''])) })
      for (const pattern of VP_TIER) if (pattern.test(text)) hits.push(`op ${op}: ${pattern}`)
    }
    expect(hits).toEqual([])
  })

  it('the system prompt, every wake and the routing tool carry the same process', () => {
    expect(ROUTER_SYSTEM_PROMPT('cafe')).toContain(ROUTER_DECISION_RULES)
    expect(ROUTER_WAKE_OWNER_NOTE).toContain(ROUTER_OWNER_NOTE)
    expect(getOp('router_route')!.description).toContain(ROUTER_OWNER_NOTE)
    // The process: search all tasks alike, check each candidate, keep looking, the person last.
    for (const step of ['search (types "task")', 'Every task counts alike', 'open or finished', 'task_get', 'check the next candidate', 'search again with other words', 'Only when no task is this item\'s matter']) {
      expect(ROUTER_DECISION_RULES, step).toContain(step)
    }
  })

  it('router_context hands no list of owners: the router searches', async () => {
    const source = { kind: 'mail' as const, account: 'desk@maple-cafe.example.invalid', message: 'INBOX:1:5', version: 'v1' }
    const areas: RouterAreasFile = {
      version: 1,
      areas: [{ id: 'cafe-one-process', name: 'Cafe', host: '__local__', taskIds: ['router'], sources: [{ kind: 'mail', account: source.account }] }],
      routers: [{ taskId: 'router', areaId: 'cafe-one-process', paused: false }],
      items: [], openItems: [{ source, areaId: 'cafe-one-process' }],
    }
    const context = await routerContext({ source, key: routerKey(source), sender: 'robin@maple-cafe.example.invalid', subject: 'Round 1 interview' }, areas, true)
    expect(context).not.toHaveProperty('owners')
    expect(String(context.instructions)).toContain(ROUTER_DECISION_RULES)
  })

})
