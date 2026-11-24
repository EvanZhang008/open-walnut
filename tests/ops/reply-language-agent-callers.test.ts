/**
 * Class guard: the reply-language send gate judges only a session agent's own tool call, the one
 * an op call marks with `forAgent` (src/ops/executor.ts). A program's call carries fixed text it
 * wrote itself (2026-11-24: the git push gate's `walnut approve "Push commit ... to ..."` ran in a
 * session's shell, was judged as the session's words and refused, so no push could be approved).
 * So every place that marks a call `forAgent` is pinned here: a new one fails until someone checks
 * that only an agent's own call reaches it, never a program's (`walnut approve`, `walnut pass`, a
 * check script, a plugin job, wn-cli's loops, a replayed write).
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '../..')

/** Each file that marks an op call as an agent's, with why only an agent's own call reaches it. */
const AGENT_SURFACES: Record<string, string> = {
  'src/mcp/tools.ts': 'a session\'s MCP tool call',
  'src/commands/tools.ts': '`walnut tools call` in a session\'s shell, never under a check script\'s token',
  'src/commands/guide.ts': '`walnut guide` in a session\'s shell (a read)',
  'src/core/peers/capability-router.ts': 'a host gateway call whose client is the agent\'s MCP or CLI, never wn-cli\'s own loops (client "program"), a check script or a plugin job',
  'src/core/leader/backup-gateway.ts': 'the same gateway call answered by the backup leader, by the same rule',
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx|mjs|js)$/.test(e.name)) out.push(p)
  }
  return out
}

describe('only an agent\'s own tool call is marked forAgent (guard)', () => {
  it('names every file that marks one, a new one included', () => {
    const marking = walk(path.join(ROOT, 'src'))
      .filter((f) => !f.endsWith(path.join('ops', 'executor.ts')) && !f.endsWith(path.join('ops', 'answer.ts')))
      .filter((f) => /\bforAgent\s*[:,}]/.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(ROOT, f).split(path.sep).join('/'))
      .sort()
    expect(marking, 'a new caller marks forAgent: make sure no program\'s call reaches it, then add it here').toEqual(Object.keys(AGENT_SURFACES).sort())
  })

  it('the executor gates on the mark, never on the session id alone', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/ops/executor.ts'), 'utf8')
    const gate = /if \(([^)]*)\) \{\s*const refusal = await replyLanguageRefusal/.exec(src)
    expect(gate?.[1]).toMatch(/options\.forAgent/)
  })
})
