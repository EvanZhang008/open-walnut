/**
 * The always-loaded prompt stays within its caps (src/core/sessions/prompt-blocks.ts).
 * 2026-11-12, the user: "programmatically restrict the length of the always loading thing".
 * Main carried 90.7 KB on every request, a lead about 31 KB.
 *
 * Fails when:
 * - a block of a composed prompt (Main, a lead, a worker, an ask, on a realistic full load)
 *   is over its cap, or a whole prompt over its role's budget;
 * - a composer adds a block with no registry entry, a registry entry is added by no composer,
 *   or a composer puts text in the prompt outside a block;
 * - a versioned block (never cut, its builder caps it) can grow past its cap at its builder's limit;
 * - the MCP server instructions outgrow their cap.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'
vi.mock('../../../src/constants.js', () => createMockConstants('walnut-prompt-blocks-guard'))
process.env.WALNUT_FLEET_PROMPT_REFRESH = '0'
import { WALNUT_HOME } from '../../../src/constants.js'
import { PROMPT_BLOCKS, PROMPT_BUDGETS, byteLength, promptBlock } from '../../../src/core/sessions/prompt-blocks.js'
import { composeInstructions } from '../../../src/core/sessions/session-context.js'
import { userProfileLine } from '../../../src/core/sessions/user-profile-context.js'
import { walnutMcpInstructions } from '../../../src/mcp/instructions.js'
import { ORG_INSTRUCTIONS_MAX } from '../../../src/core/org/org-tree.js'
import { USER_CHAR_BUDGET } from '../../../src/core/bounded-memory.js'
import { composeRolePrompt, seedFixtureHome, type PromptRole } from '../../helpers/prompt-size-fixture.js'

const ROOT = path.resolve(__dirname, '../../..')
/** Every file that composes an always-loaded prompt out of blocks. */
const COMPOSERS = ['src/core/sessions/session-context.ts', 'src/core/sessions/profiles.ts']
const ROLES: PromptRole[] = ['main', 'lead', 'worker', 'ask']

beforeAll(async () => {
  await seedFixtureHome(WALNUT_HOME)
})

describe('every block of a composed prompt is within its cap, every prompt within its budget', () => {
  for (const role of ROLES) {
    it(role, async () => {
      const p = await composeRolePrompt(role)
      for (const b of p.blocks) expect(b.bytes, `${role}: block ${b.id}`).toBeLessThanOrEqual(promptBlock(b.id).cap)
      expect(p.bytes, `${role}: whole prompt`).toBeLessThanOrEqual(PROMPT_BUDGETS[role])
      // Nothing outside a block: the blocks add up to the prompt (plus the persona/context join).
      const sum = p.blocks.reduce((n, b) => n + b.bytes, 0)
      expect(p.bytes - sum).toBeLessThanOrEqual(2)
    })
  }

  it('the caps move only what they are meant to: the org manuals and the standing memory, never a rule block whole', async () => {
    const moved = new Set((await Promise.all(ROLES.map((r) => composeRolePrompt(r)))).flatMap((p) => p.overflows.map((o) => o.id)))
    expect([...moved].sort()).toEqual(['org-away', 'org-brief', 'org-threads', 'standing-memory'])
  })

  it('is far below the prompts measured before the caps', async () => {
    const [main, lead] = await Promise.all([composeRolePrompt('main'), composeRolePrompt('lead')])
    expect(main.bytes).toBeLessThan(90_745 / 2)
    expect(lead.bytes).toBeLessThan(31_000)
  })
})

describe('the composers build only out of registered blocks', () => {
  const sources = COMPOSERS.map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8'))
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

  it('every registry entry is complete: a cap, what moves, why', () => {
    for (const def of PROMPT_BLOCKS) {
      expect(def.cap, def.id).toBeGreaterThan(0)
      expect(def.why.length, def.id).toBeGreaterThan(10)
      if (def.part !== 'mcp') expect(def.holds.length, def.id).toBeGreaterThan(5)
    }
  })
})

describe('a versioned block cannot outgrow its cap at its builder\'s own limit', () => {
  it('the user profile at USER_CHAR_BUDGET', () => {
    // Short lines carry the most version tags per character: the worst case for the block.
    const words = Array.from({ length: USER_CHAR_BUDGET / 40 }, (_, i) => `- Rule ${String(i).padStart(3, '0')}: short words here.`).join('\n').slice(0, USER_CHAR_BUDGET)
    const block = `\n\n${userProfileLine({ text: words, savedAt: '2026-11-12T00:00:00.000Z', exists: true }).trimEnd()}`
    expect(byteLength(block)).toBeLessThanOrEqual(promptBlock('user-profile').cap)
  })

  it('a role\'s core instructions an agent wrote at ORG_INSTRUCTIONS_MAX, after Walnut\'s default', () => {
    const text = Array.from({ length: ORG_INSTRUCTIONS_MAX / 50 }, (_, i) => `Instruction ${i}: keep this line about this long.`).join('\n').slice(0, ORG_INSTRUCTIONS_MAX)
    const c = composeInstructions({ id: 'fx', org_role: 'lead', project: 'P', org_instructions: { text, at: '2026-11-12T00:00:00.000Z', by: 'task:other' } }, { taskLine: '', taskDir: '', fleet: '' })
    const core = c.blocks.find((b) => b.id === 'core-instructions')!
    expect(core.bytes).toBeLessThanOrEqual(promptBlock('core-instructions').cap)
  })
})

describe('MCP server instructions', () => {
  it('fit their cap, with and without the core-tools note', () => {
    expect(byteLength(walnutMcpInstructions())).toBeLessThanOrEqual(promptBlock('mcp-instructions').cap)
    expect(byteLength(walnutMcpInstructions({ core: true }))).toBeLessThanOrEqual(promptBlock('mcp-instructions').cap)
  })

  it('say how the deferred tools load and which is for what', () => {
    const text = walnutMcpInstructions()
    expect(text).toContain('ToolSearch "select:mcp__walnut__<tool>"')
    expect(text).toContain('an independent goal or an explicit new-task request needs task_create')
    expect(text).toContain('Which tool for what')
  })
})
