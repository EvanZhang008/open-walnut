/**
 * `walnut-plugin validate` warns on a plugin that makes a task itself (2026-11-02, the user: every
 * plugin offers Talk to CEO and New task, never its own "make a task" from a message). The matcher
 * is the one tests/core/content-to-task-ratchet.test.ts holds Walnut's own plugins to
 * (packages/plugin-cli/src/content-task-scan.ts).
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { validatePlugin } from '../../packages/plugin-cli/src/manifest.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true })))
})

async function plugin(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-plugin-content-'))
  roots.push(root)
  await fs.writeFile(path.join(root, 'manifest.json'), JSON.stringify({
    id: 'content-fixture', name: 'Content fixture', version: '0.1.0', apiVersion: 1,
    engines: { walnut: '>=0.3.2' }, server: 'index.ts',
  }))
  for (const [rel, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true })
    await fs.writeFile(path.join(root, rel), text)
  }
  return root
}

describe('walnut-plugin validate: a plugin making a task itself', () => {
  it('warns on tasks.create and the task_create op, naming the line and the way instead', async () => {
    const root = await plugin({
      'index.ts': [
        'export default { async activate(walnut) {',
        '  // walnut.tasks.create in a comment is not a call',
        '  const make = (m) => walnut.tasks.create({ title: m.subject })',
        "  const op = (m) => walnut.ops.call('task_create', { title: m.text })",
        '} }',
      ].join('\n'),
    })
    const result = await validatePlugin(root)
    const found = result.warnings.filter((w) => w.includes('makes a Walnut task itself'))
    expect(found).toHaveLength(2)
    expect(found[0]).toMatch(/^index\.ts:3 makes a Walnut task itself \(tasks\.create\)/)
    expect(found[1]).toMatch(/^index\.ts:4 .*\(task_create op\)/)
    expect(found[0]).toContain('walnut.content.actions(item)')
  })

  it('says nothing for a plugin that hands content to walnut.content, or pushes a sync task', async () => {
    const root = await plugin({
      'index.ts': 'export default { activate() {} }',
      'src/web.tsx': 'export const items = (walnut, m) => walnut.content?.actions({ source: "Chat", title: m.text })',
      'src/sync.ts': 'export const adapter = { async createTask(task) { return null } }\nexport const push = (a, t) => a.createTask(t)',
    })
    const result = await validatePlugin(root)
    expect(result.warnings.filter((w) => w.includes('makes a Walnut task itself'))).toEqual([])
  })
})
