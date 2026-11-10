import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { defaultInstructions } from '../../../src/core/sessions/session-context.js'
import { effectiveHints } from '../../../src/core/hints/hint-registry.js'
import { listOps } from '../../../src/ops/index.js'

/** Every agent-facing entry point, including skills added after this guard. */
function agentTexts(): Array<{ where: string; text: string }> {
  const out = ['main', 'lead', undefined].map((org_role) => ({ where: `prompt:${org_role ?? 'worker'}`, text: defaultInstructions({ org_role, project: 'Example' } as never) }))
  for (const h of effectiveHints({ session: {} } as never)) out.push({ where: `hint:${h.kind}`, text: h.description })
  for (const op of listOps({ includeDeprecated: true })) {
    out.push({ where: `op:${op.name}`, text: op.description })
    for (const [key, schema] of Object.entries(op.input ?? {})) {
      const text = (schema as { description?: string }).description
      if (text) out.push({ where: `op:${op.name}.${key}`, text })
    }
  }
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name === 'SKILL.md') out.push({ where: p, text: fs.readFileSync(p, 'utf8') })
    }
  }
  for (const dir of ['src/data/skills', 'src/integrations']) walk(path.resolve(dir))
  return out
}

function queuedClaims(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+/).filter((s) => {
    if (!/\b(start|starts|slot|slots|subtasks)\b/i.test(s) || !/\b(queued?|queues|queueing)\b/i.test(s)) return false
    // Older servers and previously stored queues still need truthful compatibility text.
    return !/\b(older|legacy|previously)\b|\b(?:never|not|no) (?:a )?queued?\b|\b(?:does not|never) queue\b/i.test(s)
  })
}

describe('a full host refuses an automatic start, never promises a queued start', () => {
  it('every prompt, hint, op parameter and built-in skill says what the current server does', () => {
    expect(agentTexts().flatMap(({ where, text }) => queuedClaims(text).map((s) => `${where}: ${s}`))).toEqual([])
  })

  it('catches both old claims and new wording, but allows older-server compatibility', () => {
    for (const text of ['a full slot queues a start', 'the start is queued and Walnut starts it when a slot frees', 'a start past that is queued, not refused']) {
      expect(queuedClaims(text)).toHaveLength(1)
    }
    expect(queuedClaims('An older server queued this start.')).toEqual([])
    expect(queuedClaims('The start fails with 409 hosts_full and is never queued.')).toEqual([])
  })
})
