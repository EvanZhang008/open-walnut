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

const { mailRouterBlocks, foldersInWords } = await import('../../web/src/apps/mail/MailRouterSettings')
const picker = await import('../../web/src/components/org/RouterFolderPicker')
const { RouterFolderPicker, foldersSkipInbox, sameFolders, ROUTER_NO_INBOX_LINE } = picker
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
      ['r-personal', 'Personal mail router', 'Ready', ['Inbox', 'Receipts'], ['a@example.invalid', 'b@example.invalid']],
      // Its task not loaded yet: named after its area, with no state rather than a guessed one.
      ['r-work', 'Work router', null, [], ['Work box']],
    ])
    const states = (extra: Partial<Task>) => mailRouterBlocks(accounts.slice(0, 1), names.accountAreasOf(AREAS), names.areaRoutersOf(AREAS), {}, {}, [router('r-personal', extra)]).blocks[0]!.state
    expect(states({ router_paused: true })).toBe('Paused')
    expect(states({ router_paused: false, phase: 'COMPLETE' })).toBe('Closed')
    expect(unrouted).toEqual([{ accountId: 'imap:z', label: 'z@example.invalid' }])
  })
})

describe('the folder picker', () => {
  const lists = [
    { account: 'imap:a', label: 'a@example.invalid', mailboxes: [
      { mailboxId: 'INBOX', name: 'INBOX', role: 'inbox' as const },
      { mailboxId: '[Gmail]/Sent Mail', name: 'Sent Mail', role: 'sent' as const },
      { mailboxId: 'Projects/Alpha', name: 'Alpha', role: 'other' as const },
      { mailboxId: 'Projects', name: 'Projects', role: 'other' as const },
      { mailboxId: 'Projects/Alpha/Notes', name: 'Notes', role: 'other' as const },
      { mailboxId: 'Receipts', name: 'Receipts', role: 'other' as const },
    ] },
    { account: 'imap:b', label: 'b@example.invalid', mailboxes: [{ mailboxId: 'inbox', name: 'Inbox', role: 'inbox' as const }, { mailboxId: 'archive', name: 'Archived', role: 'archive' as const }] },
  ]
  const groups = picker.folderGroups(lists)
  const find = (token: string) => groups.flatMap((g) => g.options).find((o) => o.token === token)!

  it('lists the roles of every mailbox once, then each mailbox\'s own folders as a tree', () => {
    expect(groups.map((g) => [g.title, g.options.map((o) => `${'-'.repeat(o.depth)}${o.label}=${o.token}`)])).toEqual([
      ['Every mailbox', ['Inbox=inbox', 'Archive=archive', 'Sent=sent']],
      ['a@example.invalid', ['Projects=Projects', '-Alpha=Projects/Alpha', '--Notes=Projects/Alpha/Notes', 'Receipts=Receipts']],
    ])
    // One mailbox: no "every mailbox" wording.
    expect(picker.folderGroups(lists.slice(1))[0]!.title).toBe('Folders')
  })

  it('ticks a row for its token or a name saved earlier, and unticking drops every entry that names it', () => {
    expect(picker.optionTicked(find('inbox'), ['INBOX'])).toBe(true)
    const alpha = find('Projects/Alpha')
    // A name typed before the picker ("Alpha") still ticks its folder.
    expect(picker.optionTicked(alpha, ['inbox', 'alpha'])).toBe(true)
    expect(picker.toggleFolder(['inbox', 'alpha'], alpha, false)).toEqual(['inbox'])
    expect(picker.toggleFolder(['inbox'], alpha, true)).toEqual(['inbox', 'Projects/Alpha'])
    // An entry no folder answers to now is kept and listed, never dropped unseen.
    expect(picker.unlistedEntries(['inbox', 'Gone folder', 'receipts'], groups)).toEqual(['Gone folder'])
  })

  it('reads the folders first, and warns while the Inbox is left out or nothing is picked', () => {
    const html = (value: string[]) => renderToStaticMarkup(createElement(RouterFolderPicker, { accounts: [{ account: 'imap:a', label: 'a@example.invalid' }], value, onChange: () => {}, testId: 'f' }))
    expect(html(['inbox'])).toContain('Reading the folders…')
    expect(html(['inbox'])).not.toContain('f-no-inbox')
    expect(html(['Receipts'])).toContain('data-testid="f-no-inbox"')
    expect(html(['Receipts'])).toContain(ROUTER_NO_INBOX_LINE)
    expect(html([])).toContain('data-testid="f-none"')
    expect(foldersSkipInbox([' '])).toBe(false)
    expect(sameFolders(['Inbox', 'Receipts'], [' inbox ', 'Receipts', 'INBOX'])).toBe(true)
    expect(sameFolders(['Inbox'], ['Receipts'])).toBe(false)
    expect(foldersInWords([])).toBe('Inbox')
    expect(foldersInWords(['inbox', 'Projects/Alpha', 'Clients/Acme/Invoices'])).toBe('Inbox, Alpha, Invoices')
  })

  it('is one dialog with one picker, opened from Apps › Mail and from Org (no second form or copy of the warning)', () => {
    const mail = code(read('web/src/apps/mail/MailRouterSettings.tsx'))
    const org = code(read('web/src/components/org/OrgRouterSettings.tsx'))
    const dialog = code(read('web/src/components/org/RouterSettingsDialog.tsx'))
    for (const src of [mail, org]) {
      expect(src).toContain('<RouterSettingsDialog')
      expect(src).not.toMatch(/apiPatch|Inbox is not|toLowerCase\(\) === 'inbox'/)
    }
    expect(org).toContain('<RouterFolderPicker')
    expect(mail).not.toContain('<RouterFolderPicker')
    // The one save: the router's own route, read back before the draft clears.
    expect(dialog).toMatch(/apiPatch<[^>]*>\(`\/api\/v1\/org\/routers\//)
    // New folders are read back before the draft clears, and shown as sent if that read fails.
    expect(dialog).toMatch(/setSavedFolders\(sent\);\s*\n\s*await refreshRouterAreas\(\)\.catch\([^\n]*\n\s*\}\s*\n[^\n]*\n\s*form\.clear\(sentKey, sentText\)/)
    expect(dialog).toContain('role="dialog"')
    expect(dialog).toContain('aria-modal="true"')
    // The Mail plugin's page draws it, gated on the plugin running.
    expect(code(read('web/src/components/apps-page/core-plugin-panels.tsx'))).toMatch(/mail: \{ id: 'routers'[^}]*component: MailRouterSettings \}/)
    expect(code(read('web/src/components/apps-page/PluginDetail.tsx'))).toMatch(/row\.installed && on && hasCorePluginPanel\(row\.id\)/)
  })
})

describe('the Org form and a save made in Apps › Mail', () => {
  const saved = { name: 'Personal mail router', links: [], paused: false, folders: ['inbox'] }
  it('an untouched folders field follows the saved value, so an older draft never sends the old folders back', () => {
    // The person changed only the name on Org, then saved new folders in Apps › Mail.
    const draft = settings.editRouterValue(saved, saved, (v) => ({ ...v, name: 'Mail router' }))
    expect(draft.foldersFrom).toBeUndefined()
    const after = { ...saved, folders: ['Receipts', 'inbox'] }
    const shown = settings.shownRouterValue(draft, after)
    expect(shown.folders).toEqual(['Receipts', 'inbox'])
    expect(settings.routerPatch(after, shown)).toEqual({ name: 'Mail router' })
  })
  it('picked folders stay the person\'s and are sent', () => {
    const draft = settings.editRouterValue(saved, saved, (v) => ({ ...v, folders: ['Receipts'] }))
    expect(draft.foldersFrom).toEqual(['inbox'])
    const again = settings.editRouterValue(draft, saved, (v) => ({ ...v, folders: ['Receipts', 'inbox'] }))
    expect(again.foldersFrom).toEqual(['inbox'])
    expect(settings.routerPatch(saved, settings.shownRouterValue(again, { ...saved, folders: ['archive'] }))).toEqual({ folders: ['Receipts', 'inbox'] })
  })
})

describe('the router settings stylesheets stay to themselves', () => {
  const webSrc = path.join(import.meta.dirname, '../../web/src')
  const sheets = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name)
    return e.isDirectory() ? sheets(full) : e.name.endsWith('.css') ? [full] : []
  })
  const selectors = (css: string): string[] => css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@media[^{]*\{/g, '')
    .split('}').map((rule) => rule.split('{')[0]!.trim()).filter(Boolean).flatMap((sel) => sel.split(',').map((one) => one.trim()))
  const classesOf = (sel: string) => [...sel.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]!)

  // 2026-11-14: unscoped `.mail-router-name { white-space: nowrap }` here cut the Mail sidebar's router names once Apps › Mail was opened.
  it('every rule of the Mail routers sheet is scoped to its page, since Mail\'s sidebar uses the same class names', () => {
    const css = fs.readFileSync(path.join(webSrc, 'apps/mail/mail-router-settings.css'), 'utf8')
    const loose = selectors(css).filter((sel) => !/^\.mail-router-settings(?![\w-])/.test(sel))
    expect(loose).toEqual([])
  })

  it('no other stylesheet styles the classes the router settings dialog sheet owns', () => {
    const own = path.join(webSrc, 'styles/router-settings.css')
    const owned = new Set(selectors(fs.readFileSync(own, 'utf8')).flatMap(classesOf).filter((c) => /^(router-|org-router-)/.test(c)))
    expect(owned.size).toBeGreaterThan(10)
    const clashes = sheets(webSrc).filter((file) => file !== own).flatMap((file) =>
      selectors(fs.readFileSync(file, 'utf8')).flatMap(classesOf).filter((c) => owned.has(c)).map((c) => `${path.relative(webSrc, file)}: .${c}`))
    expect([...new Set(clashes)]).toEqual([])
  })
})
