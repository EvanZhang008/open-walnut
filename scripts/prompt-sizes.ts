/**
 * Print the always-loaded prompt of Main, a lead, a worker and an ask, block by block, against
 * the caps and budgets of src/core/sessions/prompt-blocks.ts, on the invented full load of
 * tests/helpers/prompt-size-fixture.ts (no personal data). `--uncapped` shows the same text with
 * no cap applied, which is what the blocks held before they had caps.
 *
 *   bun scripts/prompt-sizes.ts [--uncapped] [--json]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-prompt-sizes-'))
process.env.OPEN_WALNUT_HOME = home
process.env.WALNUT_FLEET_PROMPT_REFRESH = '0'
const uncapped = process.argv.includes('--uncapped')
const json = process.argv.includes('--json')

const fx = await import('../tests/helpers/prompt-size-fixture.ts')
const { PROMPT_BUDGETS, promptBlock } = await import('../src/core/sessions/prompt-blocks.ts')
const { walnutMcpInstructions } = await import('../src/mcp/instructions.ts')
try {
  await fx.seedFixtureHome(home)
  const out: Record<string, unknown> = {}
  for (const role of ['main', 'lead', 'worker', 'ask'] as const) {
    const p = await fx.composeRolePrompt(role, { uncapped })
    out[role] = { bytes: p.bytes, budget: PROMPT_BUDGETS[role], blocks: p.blocks, moved: p.overflows }
    if (json) continue
    console.log(`\n${role}: ${p.bytes.toLocaleString('en-US')} bytes (budget ${PROMPT_BUDGETS[role].toLocaleString('en-US')})`)
    for (const b of p.blocks) {
      console.log(`  ${b.id.padEnd(20)} ${String(b.bytes).padStart(6)} / ${String(promptBlock(b.id).cap).padStart(6)}${b.capped ? '  (rest moved)' : ''}`)
    }
  }
  const mcp = Buffer.byteLength(walnutMcpInstructions({ core: true }), 'utf8')
  out.mcp = { bytes: mcp, cap: promptBlock('mcp-instructions').cap }
  if (json) console.log(JSON.stringify(out, null, 2))
  else console.log(`\nmcp-instructions: ${mcp} / ${promptBlock('mcp-instructions').cap}`)
} finally {
  fs.rmSync(home, { recursive: true, force: true })
}
