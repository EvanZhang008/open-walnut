/**
 * The always-loaded prompt stays within its caps (src/core/sessions/prompt-blocks.ts).
 * 2026-11-12, the user: "programmatically restrict the length of the always loading thing".
 * Main carried 90.7 KB on every request, a lead about 31 KB.
 *
 * Fails when:
 * - a block of a composed prompt (Main, a lead, a worker, an ask, on a realistic full load, also
 *   with a USER.md in a three-byte script and with a role's core instructions at their limit) is
 *   over its cap, or a whole prompt over its role's budget;
 * - a named rule (an exported *_RULE / *_LINE constant of the session context, or one it imports:
 *   the thread rules, the charter, where work lives, the routing rules) is missing from a prompt it
 *   belongs to, or ends up in a memory folder file (2026-11-12 review: a head cut moved "one place
 *   per update" and the proof-in-place rule out of Main's and every lead's prompt);
 * - a block other than a `list` block is cut;
 * - a composer adds a block with no registry entry, a registry entry is added by no composer, or
 *   a composer puts text in the prompt outside a block; the spawn joins the parts any way but the
 *   two join functions of prompt-blocks.ts;
 * - a versioned block can grow past its cap at its builder's limit;
 * - the MCP server instructions outgrow their cap or lose their rules;
 * - the rollback switch (WALNUT_PROMPT_CAPS=0) no longer gives the prompt from before the registry.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'
vi.mock('../../../src/constants.js', () => createMockConstants('walnut-prompt-blocks-guard'))
process.env.WALNUT_FLEET_PROMPT_REFRESH = '0'
import { WALNUT_HOME } from '../../../src/constants.js'
import {
  PROMPT_BLOCKS, PROMPT_BUDGETS, TASK_CONTEXT_SEPARATOR, charLength, joinAppendedPrompt, joinCallerAndContext, promptBlock,
} from '../../../src/core/sessions/prompt-blocks.js'
import { composeInstructions } from '../../../src/core/sessions/session-context.js'
import { userProfileLine, refreshUserProfile } from '../../../src/core/sessions/user-profile-context.js'
import { walnutMcpInstructions } from '../../../src/mcp/instructions.js'
import { ORG_INSTRUCTIONS_MAX } from '../../../src/core/org/org-tree.js'
import { USER_CHAR_BUDGET } from '../../../src/core/bounded-memory.js'
import {
  FIXTURE_TASKS, composeRolePrompt, fixtureState, fixtureUserMd, fixtureWideUserMd, seedFixtureHome, type PromptRole,
} from '../../helpers/prompt-size-fixture.js'

const ROOT = path.resolve(__dirname, '../../..')
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8')
/** Every file that composes an always-loaded prompt out of blocks. */
const COMPOSERS = ['src/core/sessions/session-context.ts', 'src/core/sessions/profiles.ts']
const ROLES: PromptRole[] = ['main', 'lead', 'worker', 'ask']

beforeAll(async () => {
  await seedFixtureHome(WALNUT_HOME)
})
afterEach(async () => {
  delete process.env.WALNUT_PROMPT_CAPS
  fs.writeFileSync(path.join(WALNUT_HOME, 'memory', 'USER.md'), fixtureUserMd())
  await refreshUserProfile()
})

/** Every named rule the session context carries, by name: its own exports and what it imports. */
async function namedRules(): Promise<Array<[string, string]>> {
  const src = read('src/core/sessions/session-context.ts')
  const own = [...src.matchAll(/^export const ([A-Z][A-Z_]*_(?:RULE|LINE))\b/gm)].map((m) => m[1]!)
  const imported = [...src.matchAll(/^import \{([^}]+)\} from '([^']+)'/gm)].flatMap((m) =>
    m[1]!.split(',').map((n) => n.trim()).filter((n) => /^[A-Z][A-Z_]*_(?:RULE|LINE|CONTRACT)$|^TEAM_CHARTER$/.test(n)).map((n) => [n, m[2]!] as const))
  const ctx = await import('../../../src/core/sessions/session-context.js') as Record<string, unknown>
  const out: Array<[string, string]> = own.map((n) => [n, String(ctx[n])])
  for (const [name, from] of imported) {
    const mod = await import(path.join(ROOT, 'src/core/sessions', from.replace(/\.js$/, '.ts'))) as Record<string, unknown>
    out.push([name, String(mod[name])])
  }
  return out.filter(([, text]) => text.trim().length > 40)
}

describe('every block of a composed prompt is within its cap, every prompt within its budget', () => {
  const loads = [
    ['the full load', fixtureUserMd()],
    ['a USER.md in a three-byte script', fixtureWideUserMd()],
  ] as const
  for (const [load, userMd] of loads) {
    for (const role of ROLES) {
      it(`${role}, ${load}`, async () => {
        fs.writeFileSync(path.join(WALNUT_HOME, 'memory', 'USER.md'), userMd)
        await refreshUserProfile()
        const p = await composeRolePrompt(role)
        for (const b of p.blocks) expect(b.chars, `${role}: block ${b.id}`).toBeLessThanOrEqual(promptBlock(b.id).cap)
        expect(p.chars, `${role}: whole prompt`).toBeLessThanOrEqual(PROMPT_BUDGETS[role])
        // Nothing outside a block: the blocks add up to the prompt (plus the persona/context join).
        const sum = p.blocks.reduce((n, b) => n + b.chars, 0)
        expect(p.chars - sum).toBeLessThanOrEqual(2)
      })
    }
  }

  it('Main and a lead with their core instructions at the limit an agent may write', async () => {
    const text = Array.from({ length: ORG_INSTRUCTIONS_MAX / 50 }, (_, i) => `Instruction ${i}: keep this line about this long.`).join('\n').slice(0, ORG_INSTRUCTIONS_MAX)
    const org_instructions = { text, at: '2026-11-12T00:00:00.000Z', by: 'task:other' }
    for (const role of ['main', 'lead'] as const) {
      const p = await composeRolePrompt(role, { task: { org_instructions } })
      expect(p.text, role).toContain(text.split('\n')[3])
      expect(p.chars, role).toBeLessThanOrEqual(PROMPT_BUDGETS[role])
    }
  })

  it('only a list block is ever cut, and on the full load that is the standing memory alone', async () => {
    const all = await Promise.all(ROLES.map((r) => composeRolePrompt(r)))
    const moved = new Set(all.flatMap((p) => p.overflows.map((o) => o.id)))
    for (const id of moved) expect(promptBlock(id).kind, id).toBe('list')
    expect([...moved].sort()).toEqual(['standing-memory'])
  })

  it('is far below the prompts measured before the caps', async () => {
    const [main, ask] = await Promise.all([composeRolePrompt('main'), composeRolePrompt('ask')])
    expect(main.chars).toBeLessThan(90_745 / 2 + 2_000)
    expect(ask.chars).toBeLessThan(66_030 / 2)
  })
})

describe('a named rule never leaves the prompt it belongs to', () => {
  it('finds the rules (the scan reads them)', async () => {
    const names = (await namedRules()).map(([n]) => n)
    for (const n of ['THREAD_ONE_PLACE_RULE', 'PROOF_IN_PLACE_RULE', 'AWAY_INBOX_LINE', 'BRIEF_LINE', 'THREADS_LINE', 'TEAM_CHARTER', 'WORK_PLACE_RULE', 'TASK_ROUTING_CONTRACT']) {
      expect(names, n).toContain(n)
    }
  })

  for (const role of ROLES) {
    it(role, async () => {
      const rules = await namedRules()
      const whole = await composeRolePrompt(role, { uncapped: true })
      const p = await composeRolePrompt(role)
      const moved = p.overflows.map((o) => o.text).join('\n')
      for (const [name, text] of rules) {
        const t = text.trim()
        if (!whole.text.includes(t)) continue
        expect(p.text.includes(t), `${role}: ${name} is in the prompt`).toBe(true)
        expect(moved.includes(t.slice(0, 120)), `${role}: ${name} is in no memory folder file`).toBe(false)
      }
    })
  }
})

describe('the composers build only out of registered blocks', () => {
  const sources = COMPOSERS.map(read)
  const added = new Set(sources.flatMap((s) => [...s.matchAll(/\.add\('([a-z-]+)'/g)].map((m) => m[1]!)))
  // orgRoleParts names its blocks in tuples: ['org-role', head]
  for (const s of sources) for (const m of s.matchAll(/\['(org-[a-z-]+|task-routing)', /g)) added.add(m[1]!)

  it('every block a composer adds has a registry entry', () => {
    for (const id of added) expect(() => promptBlock(id), id).not.toThrow()
  })

  it('every registry entry of the prompt is added by a composer (no dead entry)', () => {
    for (const def of PROMPT_BLOCKS.filter((d) => d.part !== 'mcp')) expect(added.has(def.id), def.id).toBe(true)
  })

  it('composePrompt and the personas return only their composer\'s text', () => {
    const ctx = sources[0]!
    expect(ctx).toMatch(/function composePrompt\([^)]*\): string \{\n\s+return composeInstructions\(task, state\)\.text\(\)\n\}/)
    const body = ctx.slice(ctx.indexOf('export function composeInstructions('), ctx.indexOf('/** What describes this task right now'))
    expect(body.match(/\breturn\b/g)?.length, 'composeInstructions returns only its composer').toBe(1)
    expect(body).toMatch(/\n {2}return c\n\}/)
    expect(ctx).toContain('return { systemPrompt: composed.text() }')
    const profiles = sources[1]!
    expect(profiles.match(/systemPrompt: c\.text\(\)\.trimEnd\(\)/g)?.length).toBe(2)
  })

  it('the spawn joins persona, a caller\'s prompt and the session context only through the two join functions', () => {
    const spawn = read('src/providers/claude-code-session.ts')
    expect(spawn).not.toContain('## Task Context')
    expect(spawn).not.toMatch(/appendParts\.join\(/)
    expect(spawn).toContain("args.push('--append-system-prompt', joinAppendedPrompt(appendParts))")
    expect(spawn.match(/joinCallerAndContext\(/g)?.length).toBe(2)
    // Walnut adds only the separators.
    expect(joinCallerAndContext('caller', 'ctx')).toBe(`caller${TASK_CONTEXT_SEPARATOR}ctx`)
    expect(joinCallerAndContext(undefined, 'ctx')).toBe('ctx')
    expect(joinAppendedPrompt(['a', '', undefined, 'b'])).toBe('a\n\nb')
    expect(TASK_CONTEXT_SEPARATOR.length).toBeLessThan(30)
  })

  it('every registry entry is complete: a kind, a cap, why; a list block says what moves', () => {
    for (const def of PROMPT_BLOCKS) {
      expect(['rules', 'user', 'list'], def.id).toContain(def.kind)
      expect(def.cap, def.id).toBeGreaterThan(0)
      expect(def.why.length, def.id).toBeGreaterThan(10)
      if (def.kind === 'list') expect(def.holds.length, def.id).toBeGreaterThan(5)
    }
  })
})

describe('a versioned block cannot outgrow its cap at its builder\'s own limit', () => {
  it('the user profile at USER_CHAR_BUDGET, in ASCII and in a three-byte script', () => {
    // Short lines carry the most version tags per character: the worst case for the block.
    const ascii = Array.from({ length: USER_CHAR_BUDGET / 40 }, (_, i) => `- Rule ${String(i).padStart(3, '0')}: short words here.`).join('\n').slice(0, USER_CHAR_BUDGET)
    const wide = fixtureWideUserMd()
    for (const words of [ascii, wide]) {
      const block = `\n\n${userProfileLine({ text: words, savedAt: '2026-11-12T00:00:00.000Z', exists: true }).trimEnd()}`
      expect(charLength(block)).toBeLessThanOrEqual(promptBlock('user-profile').cap)
    }
  })

  it('a role\'s core instructions an agent wrote at ORG_INSTRUCTIONS_MAX, after Walnut\'s default', () => {
    const text = Array.from({ length: ORG_INSTRUCTIONS_MAX / 50 }, (_, i) => `Instruction ${i}: keep this line about this long.`).join('\n').slice(0, ORG_INSTRUCTIONS_MAX)
    const c = composeInstructions({ id: 'fx', org_role: 'lead', project: 'P', org_instructions: { text, at: '2026-11-12T00:00:00.000Z', by: 'task:other' } }, { taskLine: '', taskDir: '', fleet: '' })
    const core = c.blocks.find((b) => b.id === 'core-instructions')!
    expect(core.chars).toBeLessThanOrEqual(promptBlock('core-instructions').cap)
  })
})

describe('MCP server instructions', () => {
  it('fit their cap, with and without the core-tools note', () => {
    expect(charLength(walnutMcpInstructions())).toBeLessThanOrEqual(promptBlock('mcp-instructions').cap)
    expect(charLength(walnutMcpInstructions({ core: true }))).toBeLessThanOrEqual(promptBlock('mcp-instructions').cap)
  })

  it('say how the tools load on demand, which is for what, and keep the lifecycle rules', () => {
    const text = walnutMcpInstructions()
    expect(text).toContain('ToolSearch "select:mcp__walnut__<tool>"')
    expect(text).toContain('An independent goal or explicit new-task request needs task_create')
    expect(text).toContain('An accepted start is not a finished task')
    expect(text).toContain('scope=folder, then project, then all')
    expect(text).toContain('Which tool for what')
    expect(text).toContain('agent_memory_read')
  })
})

describe('the rollback switch gives the prompt from before the registry', () => {
  it('no cut, the persona\'s own copy of the rules, the XML skills index, the MCP text without the on-demand line', async () => {
    process.env.WALNUT_PROMPT_CAPS = '0'
    const { TEAM_CHARTER } = await import('../../../src/core/team-charter.js')
    const { TASK_ROUTING_CONTRACT } = await import('../../../src/core/task-routing-contract.js')
    const { laneMemoryContextOf } = await import('../../../src/core/sessions/personal-ai-lane.js')
    for (const role of ROLES) expect((await composeRolePrompt(role)).overflows, role).toEqual([])
    const main = await composeRolePrompt('main')
    expect(main.text).toContain('<available_skills>')
    expect(main.text).toContain('## Walnut skills (mandatory)')
    // The persona carries the charter again, so Main reads it twice, as before.
    expect(main.text.split(TEAM_CHARTER.split('\n').find((l) => l.length > 40)!).length - 1).toBe(2)
    // An ask's routing rules ride its persona, not its session context.
    const askContext = composeInstructions(FIXTURE_TASKS.ask as never, fixtureState('ask')).text()
    expect(askContext).not.toContain(TASK_ROUTING_CONTRACT.trim())
    // MEMORY.md before USER.md, as the standing memory read then.
    const memory = laneMemoryContextOf('MEMORY TEXT', 'USER TEXT')
    expect(memory.indexOf('MEMORY TEXT')).toBeLessThan(memory.indexOf('USER TEXT'))
    expect(walnutMcpInstructions()).not.toContain('ToolSearch')
    expect(walnutMcpInstructions()).not.toContain('agent_memory_read')
  })

  it('switched off, the prompt is the new one again', async () => {
    const main = await composeRolePrompt('main')
    expect(main.text).not.toContain('<available_skills>')
    expect(main.text).toContain('## Walnut skills')
  })
})
