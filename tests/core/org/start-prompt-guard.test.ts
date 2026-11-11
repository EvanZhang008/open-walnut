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

function falseClaims(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+/).filter((s) => {
    if (!/\b(start|starts|slot|slots)\b/i.test(s)) return false
    if (/\b(older|legacy|previously|explicit|named|names|naming|constraint)\b/i.test(s)) return false
    return /automatic starts fail[^.]*hosts_full|no host[^.]*room[^.]*409 hosts_full|never queued/i.test(s)
  })
}

describe('automatic starts tell the truth about waiting and explicit constraints', () => {
  it('every prompt, hint, op parameter and built-in skill avoids a blanket full-host refusal', () => {
    expect(agentTexts().flatMap(({ where, text }) => falseClaims(text).map((s) => `${where}: ${s}`))).toEqual([])
  })

  it('catches an old blanket rule while allowing explicit-host failures and older compatibility', () => {
    expect(falseClaims('Automatic starts fail with 409 hosts_full, never queued.')).toHaveLength(1)
    expect(falseClaims('No host with room means 409 hosts_full, not a queued start.')).toHaveLength(1)
    expect(falseClaims('An explicit host or folder start fails with 409 hosts_full.')).toEqual([])
    expect(falseClaims('An older server queued this start.')).toEqual([])
    for (const role of ['main', 'lead'] as const) {
      const prompt = defaultInstructions({ org_role: role, project: 'Example' } as never)
      expect(prompt).toContain('waits for a free slot')
      expect(prompt).toContain('Explicit host or folder constraints still fail with 409 hosts_full')
    }
  })
})
