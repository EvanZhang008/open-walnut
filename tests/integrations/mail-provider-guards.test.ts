/**
 * Rules every mail provider this repository ships is held to, found from the source
 * (tests/helpers/mail-provider-sources.ts), so a provider added later fails here until it keeps them.
 *
 * 1. MAIL READ ON ANOTHER DEVICE. A provider whose poll does not list a quiet folder again (IMAP since
 *    its bounded poll: UIDNEXT says nothing is new, so nothing is fetched; Outlook's newest-first walk)
 *    can never carry a read flag flipped elsewhere, so the cached row keeps its old flag for good. The
 *    base corrects that only through `listUnread` or `unreadIds` (types.ts). 2026-11-11: the IMAP
 *    provider had neither, and two mails read in Gmail a day earlier still showed unread in All Inboxes.
 *
 * 2. AN ATTACHMENT CHIP THAT LOOKS CLICKABLE OPENS. The console turns a chip into a button exactly
 *    when the provider declares `attachments: 'download'`, so a provider that declares it without
 *    `getAttachment` shows a click that can only fail (2026-11-13: the reported mail's PDF chip did
 *    nothing). The browser-spec fixtures are held to this one too, since the console renders them the
 *    same way. Checked per provider DIRECTORY: a fixture may keep its methods in a sibling file.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { ImapPool } from '../../src/integrations/mail-imap/client.js'
import { createImapProvider } from '../../src/integrations/mail-imap/provider.js'
import {
  codeOf,
  FIXTURE_ROOTS,
  mailProviderFiles,
  REPO_ROOT,
  SHIPPED_ROOTS,
  sourceFiles,
} from '../helpers/mail-provider-sources.js'

const relative = (file: string) => path.relative(REPO_ROOT, file)

function imapSpec() {
  const log = { debug: () => undefined, info: () => undefined, warn: () => undefined }
  const pool = new ImapPool({ settings: async () => undefined, password: async () => undefined, log })
  return createImapProvider({ store: {} as never, pool, log })
}

describe('mail read on another device', () => {
  const providers = mailProviderFiles(SHIPPED_ROOTS)

  it('finds the providers it is about', () => {
    expect(providers.map(relative)).toContain(path.join('src', 'integrations', 'mail-imap', 'provider.ts'))
  })

  it.each(providers.map((file) => [relative(file), file]))('%s answers listUnread or unreadIds', (_name, file) => {
    const text = codeOf(fs.readFileSync(file, 'utf8'))
    expect(/\b(unreadIds|listUnread)\s*[:(]/.test(text), 'a provider with no read-elsewhere path keeps a flag changed on a phone wrong here forever').toBe(true)
  })

  it('the IMAP provider names the whole unread set', () => {
    expect(typeof imapSpec().unreadIds).toBe('function')
  })
})

describe('an attachment a provider says it can download', () => {
  /** `attachments: 'download'`, also inside a conditional (`flag ? 'download' : 'metadata'`). */
  const DECLARES_DOWNLOAD = /\battachments\s*:[^,\n}]*['"]download['"]/
  const IMPLEMENTS = /\bgetAttachment\s*[:(]/

  const providerDirs = [...new Set(mailProviderFiles([...SHIPPED_ROOTS, ...FIXTURE_ROOTS]).map((file) => path.dirname(file)))]
  const codeOfDir = (dir: string) => sourceFiles(relative(dir))
    .filter((file) => path.dirname(file) === dir)
    .map((file) => codeOf(fs.readFileSync(file, 'utf8')))
    .join('\n')
  const declaring = providerDirs.filter((dir) => DECLARES_DOWNLOAD.test(codeOfDir(dir)))

  it('finds the providers it is about', () => {
    expect(declaring.map(relative)).toEqual(expect.arrayContaining([
      path.join('src', 'integrations', 'mail-imap'),
      path.join('tests', 'e2e', 'browser', 'fixtures', 'mail-fixture-provider'),
    ]))
  })

  it.each(declaring.map((dir) => [relative(dir), dir]))('%s implements getAttachment', (_name, dir) => {
    expect(IMPLEMENTS.test(codeOfDir(dir)), "a chip the console draws as a button must open: declare 'metadata' or implement getAttachment").toBe(true)
  })

  it('the IMAP provider declares the capability and has the method behind it', () => {
    const spec = imapSpec()
    expect(spec.capabilities.attachments).toBe('download')
    expect(typeof spec.getAttachment).toBe('function')
  })
})
