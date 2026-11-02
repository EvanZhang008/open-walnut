/**
 * Every plugin that syncs tasks says what its service is and who can see it (2026-11-01: the
 * service picker of a new project showed bare plugin names, so neither the user nor an agent
 * could tell a personal list from a tracker the user's team reads, and private tasks were filed
 * into the tracker). The manifest's `description` is the sentence the picker and agents show;
 * `syncAudience` is who reads the service. A new sync plugin without both fails here.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { sourceExplanation } from '../../web/src/components/tasks/source-explanation.js'

const ROOT = path.resolve(__dirname, '../..')
const DIRS = ['src/integrations', 'examples/plugins', 'plugin-store', 'tests/e2e/browser/fixtures']

interface Manifest {
  id: string; description?: string; syncAudience?: string; category?: string; phases?: unknown
  capabilities?: Record<string, unknown>
}

function manifests(): Array<{ file: string; m: Manifest }> {
  return DIRS.flatMap((dir) => fs.existsSync(path.join(ROOT, dir))
    ? fs.readdirSync(path.join(ROOT, dir)).map((d) => path.join(dir, d, 'manifest.json'))
    : [])
    .filter((f) => fs.existsSync(path.join(ROOT, f)))
    .map((file) => ({ file, m: JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8')) as Manifest }))
}

/** A plugin a project can sync tasks to (the local fallback is not a service). */
function syncsTasks(m: Manifest): boolean {
  if (m.id === 'local') return false
  return m.category === 'tasks' || m.phases !== undefined || !!m.capabilities?.sync || m.syncAudience !== undefined
}

describe('every task sync plugin says what it is and who can see it', () => {
  const all = manifests()
  const sync = all.filter(({ m }) => syncsTasks(m))

  it('finds the shipped sync plugins (so an empty scan cannot pass)', () => {
    expect(sync.map(({ m }) => m.id).sort()).toEqual(expect.arrayContaining(['jira', 'ms-todo']))
  })

  for (const { file, m } of sync) {
    it(`${m.id} (${file})`, () => {
      expect(m.syncAudience, 'syncAudience: "self" (only the user reads it) or "shared"').toMatch(/^(self|shared)$/)
      expect(m.description?.trim(), 'description: what the service is and who can see it').toBeTruthy()
      expect(m.description, 'the description names who can see what syncs there').toMatch(/\b(only you|can see|everyone|your team)\b/i)
      // The audience the words state matches the field.
      if (m.syncAudience === 'self') expect(m.description).toMatch(/only you/i)
      else expect(m.description).not.toMatch(/only you/i)
    })
  }
})

describe('the new project picker explains the chosen service', () => {
  it('says Local keeps tasks in Walnut', () => {
    expect(sourceExplanation('local', undefined)).toMatch(/never sent to another service/)
  })
  it('uses the plugin\'s own sentence when it already says who can see it', () => {
    expect(sourceExplanation('ms-todo', { name: 'Microsoft To-Do', description: 'Your lists. Only you can see them.', audience: 'self' }))
      .toBe('Your lists. Only you can see them.')
  })
  it('adds who can see it when the plugin\'s sentence does not, and treats unknown as shared', () => {
    expect(sourceExplanation('x', { name: 'X', description: 'Two-way sync with X.', audience: undefined }))
      .toBe('Two-way sync with X. Other people can see what syncs there.')
    expect(sourceExplanation('y', { name: 'Y', audience: 'self' })).toBe('Tasks sync to Y. Only you can see what syncs there.')
  })
})
