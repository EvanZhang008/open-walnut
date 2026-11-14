/**
 * Mail's routers on its page in Apps (web/src/apps/mail/MailRouterSettings.tsx, 2026-11-14, the user:
 * the router is something the Mail plugin provides, so its folders are set there too). Each router
 * that reads a mailbox is one block with its mailboxes; the folders field is the same component and
 * the same saved value as the router's Org settings, never a second copy.
 *
 * Model, render and source checks; the real page is checked by tests/e2e/browser/router-folders.spec.ts.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { createElement } from '../../web/node_modules/react/index.js'
import { renderToStaticMarkup } from '../../web/node_modules/react-dom/server.node.js'
import type { Task } from '../../src/core/types.js'

const { mailRouterBlocks } = await import('../../web/src/apps/mail/MailRouterSettings')
const { RouterFoldersField, foldersSkipInbox, sameFolders, ROUTER_NO_INBOX_LINE } = await import('../../web/src/components/org/RouterFoldersField')
const names = await import('../../web/src/components/org/router-area-names')
const settings = await import('../../web/src/components/org/OrgRouterSettings')

const ROOT = path.resolve(import.meta.dirname, '../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

const router = (id: string, extra: Partial<Task> = {}): Task => ({
  id, title: id, status: 'todo', phase: 'IN_PROGRESS', priority: 'none', category: '', project: '', source: 'local',
  session_ids: [], description: '', summary: '', note: '', created_at: '', updated_at: '', org_role: 'router', ...extra,
} as Task)

const AREAS = {
  areas: [
    { id: 'personal', name: 'Personal', taskIds: ['r-personal'], sources: [{ kind: 'mail', account: 'imap:a' }, { kind: 'mail', account: 'imap:b' }], folders: ['Inbox', 'Receipts'] },
    { id: 'work', name: 'Work', taskIds: ['r-work'], sources: [{ kind: 'slack', account: 'T1' }] },
  ],
  routers: [{ taskId: 'r-personal', areaId: 'personal', paused: false }, { taskId: 'r-work', areaId: 'work', paused: true }],
  // The binding wins over the sources: imap:c is bound to work although no area lists it yet.
  accountBindings: [{ kind: 'mail', account: 'imap:c', areaId: 'work', boundAt: 1 }],
}

describe('which router reads each mailbox', () => {
  it('joins bindings, sources and routers from the one areas read', () => {
    const areas = names.accountAreasOf(AREAS)
    expect(areas[names.accountAreaKey('mail', 'imap:a')]).toBe('personal')
    expect(areas[names.accountAreaKey('mail', 'imap:c')]).toBe('work')
    expect(areas[names.accountAreaKey('slack', 'T1')]).toBe('work')
    expect(names.areaRoutersOf(AREAS)).toEqual({ personal: 'r-personal', work: 'r-work' })
    expect(names.accountAreasOf({ accountBindings: [{ kind: 'mail' }, 'x'] })).toEqual({})
  })

  it('makes one block per router with its mailboxes, and lists a mailbox no router reads', () => {
    const accounts = [
      { accountId: 'imap:a', address: 'a@example.invalid', displayName: 'A' },
      { accountId: 'imap:c', address: '', displayName: 'Work box' },
      { accountId: 'imap:b', address: 'b@example.invalid', displayName: '' },
      { accountId: 'imap:z', address: 'z@example.invalid', displayName: '' },
    ]
    const tasks = [router('r-personal', { org_name: 'Personal mail router', router_paused: false })]
    const { blocks, unrouted } = mailRouterBlocks(accounts, names.accountAreasOf(AREAS), names.areaRoutersOf(AREAS), names.areaFoldersOf(AREAS), names.areaNamesOf(AREAS), tasks)
    expect(blocks.map((b) => [b.routerId, b.name, b.state, b.folders, b.accounts.map((a) => a.label)])).toEqual([
      ['r-personal', 'Personal mail router', 'Ready', 'Inbox, Receipts', ['a@example.invalid', 'b@example.invalid']],
      // Its task not loaded yet: named after its area, with no state rather than a guessed one.
      ['r-work', 'Work router', null, '', ['Work box']],
    ])
    const states = (extra: Partial<Task>) => mailRouterBlocks(accounts.slice(0, 1), names.accountAreasOf(AREAS), names.areaRoutersOf(AREAS), {}, {}, [router('r-personal', extra)]).blocks[0]!.state
    expect(states({ router_paused: true })).toBe('Paused')
    expect(states({ router_paused: false, phase: 'COMPLETE' })).toBe('Closed')
    expect(unrouted).toEqual([{ accountId: 'imap:z', label: 'z@example.invalid' }])
  })
})

describe('the folders field', () => {
  it('warns while the Inbox is left out, and an empty list means the Inbox', () => {
    const field = (value: string) => renderToStaticMarkup(createElement(RouterFoldersField, { value, onChange: () => {}, testId: 'mail-router-folders' }))
    expect(field('')).toContain('placeholder="Inbox"')
    expect(field('')).not.toContain('mail-router-folders-no-inbox')
    expect(field('Receipts')).toContain('data-testid="mail-router-folders-no-inbox"')
    expect(field('Receipts')).toContain(ROUTER_NO_INBOX_LINE)
    expect(field('Receipts')).toContain('aria-invalid="true"')
    expect(field('Receipts, inbox')).not.toContain('no-inbox')
    expect(foldersSkipInbox(' , ')).toBe(false)
    expect(sameFolders('Inbox, Receipts', ' Inbox ,Receipts, Inbox')).toBe(true)
    expect(sameFolders('Inbox', 'Receipts')).toBe(false)
  })

  it('is one component and one saved value on both pages (no second copy of the field or its warning)', () => {
    const mail = code(read('web/src/apps/mail/MailRouterSettings.tsx'))
    const org = code(read('web/src/components/org/OrgRouterSettings.tsx'))
    for (const src of [mail, org]) {
      expect(src).toContain('<RouterFoldersField')
      // The warning and the Inbox rule live only in RouterFoldersField.
      expect(src).not.toMatch(/Inbox is not in this list|toLowerCase\(\) === 'inbox'/)
      // Both save through the router's own route and read back from the areas read.
      expect(src).toMatch(/apiPatch[^\n]*\/api\/v1\/org\/routers\//)
      expect(src).toContain('refreshRouterAreas()')
    }
    // Mail saves folders only: never the name, links or Paused the Org form owns.
    expect(mail).toMatch(/apiPatch\(.*\{ folders: folderList\(value\) \}\)/)
    // The Mail plugin's page draws it, gated on the plugin running.
    expect(code(read('web/src/components/apps-page/core-plugin-panels.tsx'))).toMatch(/mail: \{ id: 'routers'[^}]*component: MailRouterSettings \}/)
    expect(code(read('web/src/components/apps-page/PluginDetail.tsx'))).toMatch(/row\.installed && on && hasCorePluginPanel\(row\.id\)/)
  })
})

describe('the Org form and a save made in Apps › Mail', () => {
  const saved = { name: 'Personal mail router', links: [], paused: false, folders: '' }
  it('an untouched folders field follows the saved value, so an older draft never sends the old folders back', () => {
    // The person changed only the name on Org, then saved new folders in Apps › Mail.
    const draft = settings.editRouterValue(saved, saved, (v) => ({ ...v, name: 'Mail router' }))
    expect(draft.foldersFrom).toBeUndefined()
    const after = { ...saved, folders: 'Receipts, Inbox' }
    const shown = settings.shownRouterValue(draft, after)
    expect(shown.folders).toBe('Receipts, Inbox')
    expect(settings.routerPatch(after, shown)).toEqual({ name: 'Mail router' })
  })
  it('typed folders stay the person\'s and are sent', () => {
    const draft = settings.editRouterValue(saved, saved, (v) => ({ ...v, folders: 'Receipts' }))
    expect(draft.foldersFrom).toBe('')
    const again = settings.editRouterValue(draft, saved, (v) => ({ ...v, folders: 'Receipts, Inbox' }))
    expect(again.foldersFrom).toBe('')
    expect(settings.routerPatch(saved, settings.shownRouterValue(again, { ...saved, folders: 'Archive' }))).toEqual({ folders: ['Receipts', 'Inbox'] })
  })
})
