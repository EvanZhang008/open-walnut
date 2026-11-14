/**
 * Every mail provider this repository ships has a way to learn about mail read on another device.
 *
 * The class of bug: a provider whose poll does not list a quiet folder again (IMAP since its bounded poll:
 * UIDNEXT says nothing is new, so nothing is fetched; Outlook's newest-first walk) can never carry a read
 * flag flipped elsewhere, so the cached row keeps its old flag for good. The base corrects that only
 * through `listUnread` or `unreadIds` (types.ts). 2026-11-11: the IMAP provider had neither, and two mails
 * read in Gmail a day earlier still showed unread in All Inboxes. A new provider without either fails here.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ImapPool } from '../../src/integrations/mail-imap/client.js'
import { createImapProvider } from '../../src/integrations/mail-imap/provider.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
/** Where a provider can live in this repository: built-in integrations and the shipped plugin store. */
const SEARCHED = ['src/integrations', 'plugin-store', 'examples']
/** The base itself declares the contract; it is not a provider. */
const BASE = path.join('src', 'integrations', 'mail') + path.sep

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (at: string) => {
    if (!fs.existsSync(at)) return
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue
      const full = path.join(at, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.(ts|mts|js|mjs)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(full)
    }
  }
  walk(path.join(ROOT, dir))
  return out
}

/** The source without its comments, so a provider that only MENTIONS a method does not pass. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
}

/** A file that builds a mail provider: it answers a folder list, a poll and a body. */
function buildsProvider(text: string): boolean {
  return /\blistMailboxes\s*[:(]/.test(text) && /\bpoll\s*[:(]/.test(text) && /\bgetBody\s*[:(]/.test(text)
}

describe('mail read on another device', () => {
  const providers = SEARCHED.flatMap(sourceFiles)
    .filter((file) => !path.relative(ROOT, file).startsWith(BASE))
    .filter((file) => buildsProvider(code(fs.readFileSync(file, 'utf8'))))

  it('finds the providers it is about', () => {
    expect(providers.map((file) => path.relative(ROOT, file))).toContain(path.join('src', 'integrations', 'mail-imap', 'provider.ts'))
  })

  it.each(providers.map((file) => [path.relative(ROOT, file), file]))('%s answers listUnread or unreadIds', (_name, file) => {
    const text = code(fs.readFileSync(file, 'utf8'))
    expect(/\b(unreadIds|listUnread)\s*[:(]/.test(text), 'a provider with no read-elsewhere path keeps a flag changed on a phone wrong here forever').toBe(true)
  })

  it('the IMAP provider names the whole unread set', () => {
    const log = { debug: () => undefined, info: () => undefined, warn: () => undefined }
    const pool = new ImapPool({ settings: async () => undefined, password: async () => undefined, log })
    const spec = createImapProvider({ store: {} as never, pool, log })
    expect(typeof spec.unreadIds).toBe('function')
  })
})
