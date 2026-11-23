/**
 * Every kind of thing a task asks of the user is in Action needed (2026-11-19, the user: a task's row
 * shows "approval, action needed … inbox, or ask question, or approval, or whatever", answered right
 * there). Read from the source, so a NEW member of the class fails here until it is wired in:
 *
 * 1. Every place a Needs you comes from (UserStatus.source in src/core/user-status.ts) is mapped to an
 *    Action needed kind, or to null with a reason (ACTION_KIND_OF_SOURCE).
 * 2. Every kind has a live fact behind it (action-needed-facts.ts or the status's own ask), an answer
 *    on the web row (ANSWERS in ActionNeeded.tsx) and an answer on the phone's row
 *    (ActionNeededModel.answer in ActionNeededView.swift).
 * 3. Every record that asks the user something and names its task (an approval's requester.taskId, a
 *    session's pendingPermission, a decision letter's sender.taskId) is read by the status pass.
 * 4. Both task rows (Home's status sections and the list rows) mount the block.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { ACTION_KINDS, ACTION_KIND_OF_SOURCE, type ActionKind } from '../../src/core/action-needed.js'

const ROOT = path.resolve(__dirname, '../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

/** The string members of a union written on one line after `name?:`. */
function unionOf(src: string, name: string): string[] {
  const line = src.split('\n').find((l) => new RegExp(`^\\s*${name}\\?:\\s*'`).test(l))
  expect(line, `${name} union`).toBeTruthy()
  return [...line!.matchAll(/'([a-z_-]+)'/g)].map((m) => m[1]!)
}

describe('Action needed covers every kind of ask', () => {
  it('every UserStatus.source is mapped to a kind or to null', () => {
    const sources = unionOf(read('src/core/user-status.ts'), 'source')
    expect(sources.length).toBeGreaterThanOrEqual(7)
    for (const s of sources) expect(Object.keys(ACTION_KIND_OF_SOURCE), `source '${s}' has no Action needed kind (action-needed.ts ACTION_KIND_OF_SOURCE)`).toContain(s)
    // A null needs its reason written beside it.
    const src = read('src/core/action-needed.ts')
    for (const [s, kind] of Object.entries(ACTION_KIND_OF_SOURCE)) {
      if (kind !== null) continue
      expect(src, `source '${s}' maps to null without a comment saying why`).toMatch(new RegExp(`//[^\\n]*\\n\\s*${s}: null`))
    }
  })

  it('every kind has a fact, a web answer and a phone answer', () => {
    // The kinds an item is made with: the facts file's items, a prompt's two kinds and the status's own.
    const core = read('src/core/action-needed.ts')
    const body = (name: string) => new RegExp(`export function ${name}\\([\\s\\S]*?\\n\\}`).exec(core)?.[0] ?? ''
    const made = new Set([
      ...[...read('src/core/action-needed-facts.ts').matchAll(/kind: '(\w+)'/g)].map((m) => m[1]!),
      ...[...body('promptKind').matchAll(/'(question|permission)'/g)].map((m) => m[1]!),
      ...[...body('ownItemOf').matchAll(/kind: '(\w+)'/g)].map((m) => m[1]!),
    ])
    if (/kind,/.test(read('src/core/action-needed-facts.ts'))) expect(body('promptKind')).toContain("'AskUserQuestion'")
    const web = read('web/src/components/actions/ActionNeeded.tsx')
    const answers = /export const ANSWERS: Record<ActionKind,[^=]*=\s*\{([^}]*)\}/.exec(web)
    expect(answers, 'ANSWERS in ActionNeeded.tsx').toBeTruthy()
    const swift = read('ios-native/Walnut/Views/Tasks/ActionNeededView.swift')
    const phone = /static func answer\(_ item: WalnutActionItem\)[\s\S]*?\n {4}\}/.exec(swift)?.[0] ?? ''
    expect(phone, 'ActionNeededModel.answer in ActionNeededView.swift').toContain('switch item.kind')
    for (const kind of ACTION_KINDS) {
      expect(made.has(kind), `no fact makes a '${kind}' item (action-needed-facts.ts, promptKind or ownItemOf)`).toBe(true)
      expect(answers![1], `the web row has no answer for '${kind}'`).toMatch(new RegExp(`\\b${kind}:`))
      expect(phone, `the phone row has no answer for '${kind}'`).toContain(`"${kind}"`)
    }
    // And no surface answers a kind the core does not know.
    const webKinds = [...answers![1]!.matchAll(/(\w+):/g)].map((m) => m[1]!)
    expect(new Set(webKinds)).toEqual(new Set<ActionKind>(ACTION_KINDS))
  })

  it('the status pass reads every record that asks the user and names its task', () => {
    const sync = read('src/core/user-status-sync.ts')
    // An approval, a live prompt and a decision letter: each read and turned into an item there.
    expect(sync).toMatch(/approvalItemsByTask\(await listApprovals\(/)
    expect(sync).toMatch(/promptItem\(rec\.claudeSessionId, rec\.pendingPermission\)/)
    expect(sync).toMatch(/letterItem\(l\)/)
    expect(sync).toMatch(/'approval:changed'/)
    expect(sync).toMatch(/withActions\(task, facts/)
    // A new store of asks to the user: a types file with a task link and a pending or open state is
    // placed here with where its item is made, or why it holds none. Found by its shape, so a new one fails.
    const KNOWN: Record<string, string> = {
      'src/core/approvals/types.ts': 'an approval: approvalItemsByTask (action-needed-facts.ts)',
      'src/core/human-inbox/types.ts': 'a decision letter: letterItem (action-needed-facts.ts)',
      'src/core/types.ts': "a session's pendingPermission: promptItem (action-needed-facts.ts)",
      'src/core/event-types.ts': 'event payloads, no store of their own',
    }
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`
        if (e.isDirectory()) walk(rel, out)
        else if (/types?\.ts$/.test(e.name)) out.push(rel)
      }
      return out
    }
    const stores = walk('src').filter((f) => { const t = read(f); return /taskId\?: string/.test(t) && /'pending'|'action_required'/.test(t) })
    for (const f of stores) expect(KNOWN[f], `${f} looks like a store of asks to the user: make its Action needed item, or say why not`).toBeTruthy()
    for (const f of Object.keys(KNOWN)) expect(stores, `${f} no longer looks like a store of asks: update the list`).toContain(f)
  })

  it('both kinds of task row mount the block', () => {
    // Through RowAsks (actions/RowThreadAsks.tsx): the block, or one line for a decision a thread holds.
    expect(read('web/src/components/tasks/StatusSections.tsx')).toMatch(/<RowAsks task=\{task\} \/>/)
    expect(read('web/src/components/tasks/TodoPanel.tsx')).toMatch(/<RowAsks task=\{task\} \/>/)
    expect(read('web/src/components/actions/RowThreadAsks.tsx')).toMatch(/<ActionNeeded task=\{task\} \/>/)
    expect(read('ios-native/Walnut/Views/Tasks/TaskBoardRow.swift')).toMatch(/ActionNeededView\(task: task, items: actionItems/)
  })
})
