/**
 * GUARD: every "@" source follows the same rules, whoever registers it (2026-10-31, the user:
 * All must search everything, tasks first, the remote sources below and never blocking, and
 * "AI知道我在说什么吗": what is sent must say what each reference is, like a URI).
 *
 *   - it is listed with a lane (`top` only for core's own sources; a plugin is `below`) and
 *     marked `inAll`, so the picker asks it in All;
 *   - a picked row's card opens with core's head: the source's label, the row's kind, its
 *     title and its ref, whatever the source's own resolve text says (or when it says
 *     nothing at all).
 *
 * The ratchet at the end lists every place in src/ that registers a source; a new one
 * fails here until it is added to REGISTRATION_SITES and checked by the contract below.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('mention-sources-contract-test'))

import { clearMentionSources, registerMentionSource, type MentionSourceSpec } from '../../src/core/mention-sources/registry.js'
import { __resetMentionSourceCaches, describeSourceRef, mentionSourcesNow, resolveSourceRefs, searchMentionSource } from '../../src/core/mention-sources/run.js'
import { __resetCoreMentionSources } from '../../src/core/mention-sources/notes-source.js'
import { createMailMentionSource } from '../../src/integrations/mail/mention-source.js'
import type { MailService } from '../../src/integrations/mail/service.js'
import { buildReferenceCards } from '../../src/core/sessions/reference-cards.js'
import { sourceRefTag } from '../../src/utils/entity-refs.js'

const SRC = path.resolve(__dirname, '../../src')

/** Every file in src/ that registers an "@" source, and how. */
const REGISTRATION_SITES: Record<string, string> = {
  'core/mention-sources/notes-source.ts': 'core Notes (lane top)',
  'core/plugins/server-api.ts': 'the plugin API: walnut.registry.mentionSource (lane below)',
  'integrations/mail/index.ts': 'Mail, through the plugin API (lane below)',
}

const mailMessage = {
  accountId: 'acct-1', messageId: 'msg-42', subject: 'Quarterly plan', snippet: 'see attached',
  from: { name: 'Dana', address: 'dana@example.com' }, sentAt: Date.UTC(2026, 9, 30), mailboxId: 'INBOX',
}
const fakeMail = {
  listAccounts: async () => [{ accountId: 'acct-1', provider: 'imap', address: 'me@example.com' }],
  listMessages: async () => ({ messages: [mailMessage] }),
  search: async () => ({ messages: [mailMessage] }),
  readEnvelope: async () => mailMessage,
} as unknown as MailService

/** Sources of every shape a plugin may write: several kinds, one kind, none, a silent resolve. */
const PLUGIN_SOURCES: MentionSourceSpec[] = [
  {
    id: 'chat', label: 'Chat', keyword: 'chat', kinds: ['person', 'channel'],
    search: async () => [
      { ref: 'user:U1', title: 'Alice Chen', kind: 'person' },
      { ref: 'channel:C9', title: '#deploys', kind: 'channel' },
    ],
    resolve: async (ref) => `chat says ${ref}`,
  },
  {
    id: 'wiki', label: 'Wiki', keyword: 'wiki', kinds: ['page'], lane: 'top',
    search: async () => [{ ref: 'p/1', title: 'Runbook' }],
    resolve: async () => null,
  },
  {
    id: 'bare', label: 'Bare', keyword: 'bare',
    search: async () => [{ ref: 'x1', title: 'Something' }],
    resolve: async () => '',
  },
]

const loaders = {
  loadTasks: async () => [], loadSession: async () => null, loadProjects: async () => [],
  loadSourceRefs: (ids: string[]) => resolveSourceRefs(ids, 500),
  describeSourceRefs: async (ids: string[]) => new Map(ids.map((id) => [id, describeSourceRef(id)])),
}

beforeEach(() => {
  clearMentionSources()
  __resetMentionSourceCaches()
  __resetCoreMentionSources()
})
afterEach(() => clearMentionSources())

describe('every "@" source follows the same rules', () => {
  it('each is asked in All, in a lane only core can make top', () => {
    for (const spec of PLUGIN_SOURCES) registerMentionSource('some-plugin', spec)
    registerMentionSource('mail', createMailMentionSource(fakeMail))
    const listed = mentionSourcesNow()
    expect(listed.map((s) => s.spec.id)).toEqual(expect.arrayContaining(['notes', 'mail', 'chat', 'wiki', 'bare']))
    for (const s of listed) {
      expect(s.inAll, s.spec.id).toBe(true)
      expect(s.lane, s.spec.id).toBe(s.spec.id === 'notes' ? 'top' : 'below')
    }
  })

  it('a picked row of each one reaches the model under core\'s head: source, kind, title, ref', async () => {
    for (const spec of PLUGIN_SOURCES) registerMentionSource('some-plugin', spec)
    registerMentionSource('mail', createMailMentionSource(fakeMail))
    const picked: Array<{ sourceId: string; ref: string; title: string; head: string }> = []
    for (const s of mentionSourcesNow()) {
      if (s.spec.id === 'notes') continue // no vault in this test; its card is checked in e2e
      const { items } = await searchMentionSource(s.spec.id, '')
      expect(items.length, s.spec.id).toBeGreaterThan(0)
      for (const item of items) {
        const kind = item.kind ?? (s.spec.kinds?.length === 1 ? s.spec.kinds[0] : undefined)
        picked.push({
          sourceId: s.spec.id, ref: item.ref, title: item.title,
          head: `- ${s.spec.label}${kind ? ` ${kind}` : ''} "${item.title}" (ref ${s.spec.id}:${item.ref}`,
        })
      }
    }
    const text = picked.map((p) => sourceRefTag(p.sourceId, p.ref, p.title)).join(' and ')
    const cards = await buildReferenceCards(`look at ${text}`, loaders)
    for (const p of picked) expect(cards, p.sourceId).toContain(p.head)
    expect(cards).toContain('- Chat channel "#deploys" (ref chat:channel:C9): chat says channel:C9')
    expect(cards).toContain('- Wiki page "Runbook" (ref wiki:p/1; no details could be read just now)')
    expect(cards).toContain('- Mail message "Quarterly plan" (ref mail:acct-1:msg-42): Mail message msg-42 in account acct-1')
  })

  it('a kind a row was never searched for comes from kindOf, else the one kind, else none', () => {
    registerMentionSource('p', { ...PLUGIN_SOURCES[0], kindOf: (ref) => (ref.startsWith('user:') ? 'person' : undefined) })
    registerMentionSource('p', PLUGIN_SOURCES[1])
    expect(describeSourceRef('chat:user:U77')).toEqual({ source: 'Chat', kind: 'person' })
    expect(describeSourceRef('chat:channel:C1')).toEqual({ source: 'Chat' })
    expect(describeSourceRef('wiki:p/9')).toEqual({ source: 'Wiki', kind: 'page' })
    expect(describeSourceRef('gone:x')).toEqual({ source: 'gone' })
  })
})

describe('ratchet: every place that registers a source is covered here', () => {
  it('lists the registration sites found in src/', () => {
    const found: string[] = []
    const walk = (dir: string) => {
      for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name)
        if (fs.statSync(p).isDirectory()) walk(p)
        else if (/\.(ts|tsx)$/.test(name)) {
          const rel = path.relative(SRC, p)
          if (rel === 'core/mention-sources/registry.ts') continue
          const text = fs.readFileSync(p, 'utf8')
          if (/registerMentionSource\(\s*['"\w]/.test(text) || /\.mentionSource\??\.?\(/.test(text) || /\bmentionSource\(spec/.test(text)) found.push(rel)
        }
      }
    }
    walk(SRC)
    expect(found.sort(), 'a new "@" source: add it to REGISTRATION_SITES and to the contract above').toEqual(Object.keys(REGISTRATION_SITES).sort())
  })
})
