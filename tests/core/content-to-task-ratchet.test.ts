/**
 * No plugin, and no surface that shows a plugin's content, makes a task out of that content
 * itself. 2026-11-02, the user, on a mail reminder that became a task titled with the subject and
 * the raw mail pasted in, in the Inbox: every plugin offers the same two choices, "talk to ceo, and
 * create a new task ... I can put init promot". Those two are Walnut's (web
 * utils/content-actions.ts, `walnut.content` for plugins); the task itself is written by the
 * person in the new-task draft.
 *
 * The class is every call that creates a task from that code: `walnut.tasks.create`, the
 * `task_create` op, a POST to the task routes, the console's `createTask`, and the retired letter
 * item task intents. The members are read from the source with the same matcher
 * `walnut-plugin validate` warns with (packages/plugin-cli/src/content-task-scan.ts), so a new one
 * fails here until it is removed or listed below with why it does not come from content.
 *
 * Inbox letters are Walnut's own surface and are held by their data instead: a new item never
 * keeps a task intent (below), and the item's button row never shows one
 * (tests/web/inbox-item-content-actions.test.ts). An older letter's receipts stay readable.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { contentTaskCalls } from '../../packages/plugin-cli/src/content-task-scan.js'
import { LEGACY_TASK_INTENTS, validateNewItems } from '../../src/core/human-inbox/item-schema.js'
import { digestLetterItem } from '../../src/integrations/mail/digest-items.js'

const ROOT = path.resolve(import.meta.dirname, '../..')

/** Where plugin code and the surfaces that show plugin content live. */
const SCOPES = [
  'src/integrations',
  'plugin-store',
  'examples/plugins',
  'web/src/apps',
  'web/src/components/content',
  'web/src/plugins',
  'web/src/utils/content-actions.ts',
]

/**
 * `file:kind` → why it is not content becoming a task. Keep this short: each entry is a place
 * where a task is made without the person writing it.
 */
const ALLOWED: Record<string, string> = {
  'examples/plugins/walnut-demo/src/server/actions.ts:tasks.create':
    'The demo plugin\'s own "Create demo task" button shows the SDK task API on a fixed sample task; no content is involved.',
}

function files(rel: string): string[] {
  const full = path.join(ROOT, rel)
  if (!fs.existsSync(full)) return []
  if (fs.statSync(full).isFile()) return [rel]
  const out: string[] = []
  for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
    if (['node_modules', 'dist', '.git'].includes(entry.name)) continue
    const child = `${rel}/${entry.name}`
    if (entry.isDirectory()) out.push(...files(child))
    else if (/\.(?:tsx?|jsx?|mjs)$/.test(entry.name) && !/\.(?:test|spec|d)\.[jt]sx?$/.test(entry.name)) out.push(child)
  }
  return out
}

describe('content never becomes a task on its own', () => {
  it('no plugin or content surface makes a task itself', () => {
    const found = new Map<string, string[]>()
    for (const scope of SCOPES) {
      for (const rel of files(scope)) {
        for (const call of contentTaskCalls(fs.readFileSync(path.join(ROOT, rel), 'utf8'))) {
          const key = `${rel}:${call.kind}`
          found.set(key, [...(found.get(key) ?? []), `${rel}:${call.line} ${call.text}`])
        }
      }
    }
    const unlisted = [...found.entries()].filter(([key]) => !ALLOWED[key]).flatMap(([, lines]) => lines)
    expect(unlisted, 'Hand the content to walnut.content (Talk to CEO, New task) instead, or list it in ALLOWED with why it is not content').toEqual([])
    // An entry whose call is gone is stale: the list must say what is true.
    expect(Object.keys(ALLOWED).filter((key) => !found.has(key))).toEqual([])
  })

  it('the matcher sees each member of the class and skips a sync push', () => {
    const cases: Array<[string, boolean]> = [
      ['const task = await walnut.tasks.create({ title })', true],
      ["await walnut.ops.call('task_create', { title })", true],
      ["await apiPost('/api/v1/tasks', body)", true],
      ["const r = await call('POST', '/api/tasks', body)", true],
      ["await createTask({ title: subject })", true],
      ["actions: [{ id, kind: 'op', intent: 'create_task' }]", true],
      ['  async createTask(task: Task) {', false],
      ['await adapter.createTask(parent)', false],
      ['// walnut.tasks.create is not used here', false],
    ]
    for (const [line, member] of cases) expect(contentTaskCalls(line).length > 0, line).toBe(member)
  })

  it('a new letter item never keeps a task intent, whoever sends it', () => {
    const item = (intent: string) => ({
      id: `m-${intent}`, subject: 'Benefits enrollment', summary: 'Closes Friday.',
      source: { kind: 'mail', account: 'a1', message: `m-${intent}` },
      actions: [{ id: `m-${intent}:read`, kind: 'op', intent: 'mark_read' }, { id: `m-${intent}:${intent}`, kind: 'op', intent }],
    })
    const kept = validateNewItems(LEGACY_TASK_INTENTS.map(item))!
    for (const one of kept) expect(one.actions.map((a) => a.kind === 'op' ? a.intent : a.kind)).toEqual(['mark_read'])
  })

  it('only a vitest process may write an old letter, and no product code asks to', () => {
    const readers = ['src', 'web/src', 'packages', 'scripts'].flatMap((dir) => files(dir))
      .filter((rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').includes('WALNUT_TEST_LEGACY_TASK_INTENTS'))
    expect(readers).toEqual(['src/core/human-inbox/item-schema.ts'])
    expect(fs.readFileSync(path.join(ROOT, readers[0]), 'utf8')).toMatch(/process\.env\.VITEST && process\.env\.WALNUT_TEST_LEGACY_TASK_INTENTS === '1'/)
  })

  it('the mail digest offers no task action', () => {
    const letterItem = digestLetterItem({ sender: 'HR', subject: 'Benefits', sentAt: Date.now(), account: 'a1', message: 'm1' })!
    expect(letterItem.actions.filter((a) => a.kind === 'op' && LEGACY_TASK_INTENTS.includes(a.intent))).toEqual([])
  })
})
