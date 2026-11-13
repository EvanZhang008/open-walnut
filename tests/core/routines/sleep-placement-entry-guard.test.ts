/** Every executor must name its offline scheduling policy, including executors added later. */
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-sleep-entry-guard'))
import { offlinePortability } from '../../../src/core/routines/offline-run.js'
import { portableClaudeConfigOf } from '../../../src/core/routines/clock-portable.js'
import type { CronJob } from '../../../src/core/cron/types.js'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const POLICY: Record<string, 'portable-start' | 'owner-work' | 'original-clock'> = {
  'claude-code': 'portable-start',
  session: 'owner-work',
  'main-agent': 'owner-work',
  'walnut-agent': 'original-clock',
  watcher: 'original-clock',
}

function registeredTypes(): string[] {
  const dir = path.join(ROOT, 'src/core/routines/executors')
  const found: string[] = []
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith('.ts')) continue
    const file = path.join(dir, entry)
    const ast = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
    const visit = (node: ts.Node) => {
      if (ts.isReturnStatement(node) && node.expression && ts.isObjectLiteralExpression(node.expression)) {
        const type = node.expression.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText(ast) === 'type')
        if (type && ts.isPropertyAssignment(type) && ts.isStringLiteral(type.initializer)) found.push(type.initializer.text)
      }
      ts.forEachChild(node, visit)
    }
    visit(ast)
  }
  return [...new Set(found)].sort()
}

const job = (type: string): CronJob => ({
  id: 'sleep-policy', name: 'Daily report', enabled: true, createdAtMs: 1, updatedAtMs: 1,
  schedule: { kind: 'every', everyMs: 60_000 }, sessionTarget: 'isolated', wakeMode: 'now',
  payload: { kind: 'agentTurn', message: 'Read the server notes.' }, state: {},
  executor: { type, config: { target: 'owner-task', instructions: 'Read the server notes.', prompt: 'Read the server notes.', cwd: '/home/me/.open-walnut', placement: { portable: true } } },
})

describe('sleep scheduling covers every registered executor', () => {
  it('a new executor fails until its scheduling policy is classified and tested', () => {
    expect(registeredTypes()).toEqual(Object.keys(POLICY).sort())
  })

  it.each(Object.entries(POLICY))('%s uses its declared offline path', (type, policy) => {
    const one = job(type)
    expect(!!portableClaudeConfigOf(one)).toBe(policy === 'portable-start')
    expect(offlinePortability(one, { id: 'owner-task', title: 'Owner', phase: 'IN_PROGRESS', org_role: 'lead' }).ok).toBe(policy === 'owner-work')
    for (const blocker of [{ check: { run: 'true' } }, { wake: { every: 1 } }, { initProcessor: { actionId: 'batch' } }]) {
      expect(offlinePortability({ ...one, ...blocker } as CronJob).ok).toBe(false)
    }
  })

  it('all autonomous starts retain the common daemon capability and admission gates', () => {
    const clock = fs.readFileSync(path.join(ROOT, 'src/core/routines/clock-placement.ts'), 'utf8')
    const seat = fs.readFileSync(path.join(ROOT, 'src/core/routines/clock-portable.ts'), 'utf8')
    const start = fs.readFileSync(path.join(ROOT, 'src/providers/clock-host-start-core.ts'), 'utf8')
    expect(clock).toMatch(/portableSeatOf\(job, kind, host/)
    expect(seat).toMatch(/hostBlocker\(host/)
    expect(seat).toContain('WALNUT_MCP_CAPABILITY')
    expect(start).toContain('deps.primaryAnswers(home)')
    expect(start).toContain('deps.hostStart.planRoutine(home')
    expect(start).toContain('deps.hostStart.holdPending(home')
  })
})
