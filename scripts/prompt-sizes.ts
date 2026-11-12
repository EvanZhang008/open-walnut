/**
 * Print the always-loaded prompt of Main, a lead, a worker and an ask, block by block, against
 * the caps and budgets of src/core/sessions/prompt-blocks.ts, on the invented full load of
 * tests/helpers/prompt-size-fixture.ts (no personal data). Sizes in characters (what caps and
 * budgets measure) and UTF-8 bytes. `--rollback` measures the prompt the rollback switch
 * (WALNUT_PROMPT_CAPS=0) gives, which is the prompt from before the registry; `--wide` uses a
 * 4,000-character USER.md in a three-byte script.
 *
 *   bun scripts/prompt-sizes.ts [--rollback] [--wide] [--json]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-prompt-sizes-'))
process.env.OPEN_WALNUT_HOME = home
process.env.WALNUT_FLEET_PROMPT_REFRESH = '0'
if (process.argv.includes('--rollback')) process.env.WALNUT_PROMPT_CAPS = '0'
const wide = process.argv.includes('--wide')
const json = process.argv.includes('--json')

const fx = await import('../tests/helpers/prompt-size-fixture.ts')
const { PROMPT_BUDGETS, promptBlock } = await import('../src/core/sessions/prompt-blocks.ts')
const { walnutMcpInstructions } = await import('../src/mcp/instructions.ts')
try {
  await fx.seedFixtureHome(home, wide ? { userMd: fx.fixtureWideUserMd() } : {})
  const out: Record<string, unknown> = {}
  for (const role of ['main', 'lead', 'worker', 'ask'] as const) {
    const p = await fx.composeRolePrompt(role)
    out[role] = { chars: p.chars, bytes: p.bytes, budget: PROMPT_BUDGETS[role], blocks: p.blocks, moved: p.overflows.map((o) => ({ id: o.id, chars: o.chars })) }
    if (json) continue
    console.log(`\n${role}: ${p.chars.toLocaleString('en-US')} characters, ${p.bytes.toLocaleString('en-US')} bytes (budget ${PROMPT_BUDGETS[role].toLocaleString('en-US')} characters)`)
    for (const b of p.blocks) {
      console.log(`  ${b.id.padEnd(20)} ${String(b.chars).padStart(6)} / ${String(promptBlock(b.id).cap).padStart(6)}${b.capped ? '  (rest moved)' : ''}`)
    }
  }
  const mcp = walnutMcpInstructions({ core: true }).length
  out.mcp = { chars: mcp, cap: promptBlock('mcp-instructions').cap }
  if (json) console.log(JSON.stringify(out, null, 2))
  else console.log(`\nmcp-instructions: ${mcp} / ${promptBlock('mcp-instructions').cap}`)
} finally {
  fs.rmSync(home, { recursive: true, force: true })
}
