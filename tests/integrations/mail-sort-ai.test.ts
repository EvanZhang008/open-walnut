/**
 * The model labels unread inbox mail (sort-ai.ts) and the engine composes its verdicts with the
 * person's rules (sort-engine.ts). Real worker-thread database, real engine, a FAKE model: every test
 * says exactly what the model answers, and counts what it was asked.
 *
 * What is pinned here:
 * - the answer is data, not trust (parseLabels / cleanLabel, one bad entry costs one mail);
 * - unread inbox mail waits in Important as `ai:pending` until the model has answered, then moves;
 * - a failed call goes DOWN: the waiting mail falls back to the simple rules at once (by sender);
 * - a mail a rule decides is never asked about; a `group` rule reads the model's group;
 * - a rename wins over the model's name, and the model's later answers in the new name land there;
 * - one batch at a time, at most AI_HOURLY_CALLS an hour;
 * - each group of two or more unread gets ONE model line, written again only when new mail arrives
 *   (or the set changed and the line is 30 minutes old); a failed summary never takes labeling down.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PluginDatabaseClient } from '../../src/core/plugins/plugin-storage.js'
import { MAIL_MIGRATIONS, MailDatabase } from '../../src/integrations/mail/db.js'
import {
  AI_BATCH, AI_DOWN_MS, AI_HOURLY_CALLS, LABEL_SYSTEM, MailSortLabeler, cleanLabel, labelPrompt, parseLabels,
  type LabelContext, type LabelModel,
} from '../../src/integrations/mail/sort-ai.js'
import { MailSortEngine } from '../../src/integrations/mail/sort-engine.js'
import {
  MAX_SUMMARY_CHARS, SUMMARY_BATCH, SUMMARY_MAILS, SUMMARY_REFRESH_MS, SUMMARY_SYSTEM, cleanSummary, parseSummaries,
  staleGroups, summaryPrompt, type GroupDigest, type StoredSummary,
} from '../../src/integrations/mail/sort-group-summary.js'
import type { ScanRow } from '../../src/integrations/mail/sort-store.js'
import { MailStore } from '../../src/integrations/mail/store.js'

const MARINA = 'imap:marina'
const ME = 'robin@marina.example.invalid'
const PAIRS = [{ accountId: MARINA, mailboxId: 'INBOX' }]

// -- pure: the answer is data --

describe('parseLabels', () => {
  it('reads one entry per mail and checks each on its own', () => {
    const text = 'Sure! {"mails":[{"i":0,"important":false,"group":"Ticket updates","why":"Automated"},'
      + '{"i":1,"important":true,"group":"Ignored","why":"A person asked you"},'
      + '{"i":2,"important":"yes"},{"i":7,"important":false},{"i":0,"important":true},{"i":3,"important":false,"group":"Misc"}]}'
    const out = parseLabels(text, 4, [])!
    expect([...out.keys()]).toEqual([0, 1, 3])
    expect(out.get(0)).toEqual({ important: false, label: 'Ticket updates', why: 'Automated' })
    // Important mail carries no group, whatever the model said.
    expect(out.get(1)).toEqual({ important: true, label: null, why: 'A person asked you' })
    // A name that says nothing is dropped (the sender stands in).
    expect(out.get(3)).toEqual({ important: false, label: null, why: null })
  })

  it('refuses a whole answer that is not one JSON object with a mails list', () => {
    expect(parseLabels('mostly notifications', 3, [])).toBeNull()
    expect(parseLabels('{"groups":[]}', 3, [])).toBeNull()
    expect(parseLabels('{"mails": "none"}', 3, [])).toBeNull()
    expect(parseLabels('{"mails":[', 3, [])).toBeNull()
  })

  it('cleans a label, and keeps the spelling of a name already in use', () => {
    expect(cleanLabel('"ticket updates."', [])).toBe('Ticket updates')
    expect(cleanLabel('TICKET UPDATES', ['Ticket updates'])).toBe('Ticket updates')
    expect(cleanLabel('Important', [])).toBeNull()
    expect(cleanLabel('Not important', [])).toBeNull()
    expect(cleanLabel('one two three four five', [])).toBeNull()
    expect(cleanLabel('x'.repeat(33), [])).toBeNull()
    expect(cleanLabel(42, [])).toBeNull()
    // Test data: a label in another script survives as written (first letter upper-cased only).
    expect(cleanLabel('\u5de5\u5355\u66f4\u65b0', [])).toBe('\u5de5\u5355\u66f4\u65b0')
  })
})

describe('labelPrompt', () => {
  it('says how each mail reached the person and carries the notes and the names in use', () => {
    const row = (i: number, payload: Record<string, unknown>, extra: Partial<ScanRow> = {}): ScanRow => ({
      rowid: i, account_id: MARINA, mailbox_id: 'INBOX', message_id: `m${i}`, rfc_message_id: '', from_addr: '',
      subject: `Subject ${i} ${'long '.repeat(60)}`, snippet: 'First words of the mail', payload: JSON.stringify(payload),
      sort_group: null, sort_reason: null, sender_key: null, seen: 0, sent_at: 1, received_at: 1,
      gmail_category: null, list_headers_json: null, ai_label: null, ai_important: null, ai_why: null, ai_rev: null,
      sort_label: null, mailbox_role: 'inbox', ...extra,
    } as ScanRow)
    const features = (r: ScanRow) => {
      const payload = JSON.parse(r.payload) as { to?: unknown }
      return {
        fromAddr: 'a@b.example.invalid', fromName: 'A', senderKind: 'person' as const,
        addressedToMe: r.rowid === 3 ? 'unknown' as const : r.rowid !== 1,
        onlyCc: r.rowid === 2, hasListUnsubscribe: r.rowid === 1, listId: undefined, correspondent: false,
        ...(payload.to ? {} : {}),
      }
    }
    const context: LabelContext = {
      rev: 'a1-x', me: [{ name: 'Robin', address: ME }], notes: ['Mail to a group alias is not important'],
      groups: ['Ticket updates'], decides: () => false, features: features as never,
    }
    const prompt = JSON.parse(labelPrompt([row(0, {}), row(1, {}), row(2, {}), row(3, {}, { ai_label: 'Ticket updates' })], context))
    expect(prompt.me).toEqual([{ name: 'Robin', address: ME }])
    expect(prompt.notes).toEqual(['Mail to a group alias is not important'])
    expect(prompt.groups).toEqual(['Ticket updates'])
    expect(prompt.mails.map((one: { to: string }) => one.to)).toEqual(['you', 'group', 'cc', 'unknown'])
    expect(prompt.mails[1].list).toBe(true)
    expect(prompt.mails[3].was).toBe('Ticket updates')
    expect(prompt.mails[0].subject.length).toBeLessThanOrEqual(201)
    expect(prompt.mails[0].text).toBe('First words of the mail')
  })
})

// -- the engine, on a real database --

let dir: string
let client: PluginDatabaseClient
let db: MailDatabase
let store: MailStore
let engine: MailSortEngine | null = null
let now = Date.now()
let asked: Array<Array<{ i: number; from: string; subject: string; to: string }>> = []
let groupsSeen: string[][] = []

type Answer = (mail: { i: number; from: string; subject: string; to: string; sender: string }) =>
  { important: boolean; group?: string; why?: string } | null

/** One group summary request as the model saw it. */
let summaryAsked: Array<Array<{ g: number; name: string; mails: Array<{ from: string; subject: string }> }>> = []
/** How the fake answers a summary request: a line per group (default), nothing, or not JSON. */
let summaryMode: 'lines' | 'none' | 'invalid' | 'first-only' = 'lines'

/**
 * A model that answers per mail with `answer`, or throws `down`. Records every batch it was asked.
 * The group summaries share it (sort-group-summary.ts): those are answered from `summaryMode` and
 * recorded apart, so `asked` stays the labeling calls alone.
 */
function fakeModel(answer: Answer | 'down' | 'invalid'): LabelModel {
  return async (request) => {
    if (request.system === SUMMARY_SYSTEM) {
      const prompt = JSON.parse(request.messages[0]!.content) as { groups: Array<{ g: number; name: string; mails: Array<{ from: string; subject: string }> }> }
      summaryAsked.push(prompt.groups)
      if (answer === 'down') throw new Error('The model is down.')
      if (summaryMode === 'invalid') return 'These are mostly tickets.'
      const groups = summaryMode === 'none' ? [] : prompt.groups
        .filter((group) => summaryMode !== 'first-only' || group.g === 0)
        .map((group) => ({ g: group.g, summary: `"${group.mails.slice(0, 2).map((mail) => mail.subject).join(' and ')}."` }))
      return JSON.stringify({ groups })
    }
    expect(request.system).toBe(LABEL_SYSTEM)
    const prompt = JSON.parse(request.messages[0]!.content) as { mails: Array<{ i: number; from: string; subject: string; to: string; sender: string }>; groups: string[] }
    asked.push(prompt.mails)
    groupsSeen.push(prompt.groups)
    if (answer === 'down') throw new Error('The model is down.')
    if (answer === 'invalid') return 'I would group these as notifications.'
    const mails = prompt.mails.flatMap((mail) => {
      const one = answer(mail)
      return one ? [{ i: mail.i, ...one }] : []
    })
    return JSON.stringify({ mails })
  }
}

const byKind: Answer = (mail) => {
  if (/ticket/i.test(mail.subject)) return { important: false, group: 'Ticket updates', why: 'Automated ticket change' }
  if (/build/i.test(mail.subject)) return { important: false, group: 'Build results', why: 'Automated build' }
  return { important: true, why: 'A person wrote to you' }
}

async function seed(): Promise<void> {
  await client.run('DELETE FROM messages')
  const rows: unknown[][] = []
  const add = (id: string, from: string, name: string, subject: string, opts: { to?: string; seen?: number; age?: number } = {}) => {
    const payload = { from: { address: from, name }, to: [{ address: opts.to ?? ME }] }
    const at = now - (opts.age ?? 60_000) - rows.length
    rows.push([MARINA, id, `<${id}@example.invalid>`, 'INBOX', from, subject, at, JSON.stringify(payload), opts.seen ?? 0, at])
  }
  for (let i = 0; i < 6; i += 1) add(`t${i}`, 'issues@tickets.example.invalid', 'Ticket Board', `Ticket ${8800 + i} was updated`)
  for (let i = 0; i < 4; i += 1) add(`b${i}`, 'noreply@builds.example.invalid', 'Build Robot', `Build ${i} passed`)
  add('p0', 'carol.pier@friend.example.invalid', 'Carol Pier', 'Lunch on the quay?')
  add('p1', 'bo.tiller@marina.example.invalid', 'Bo Tiller', 'Crew rota', { to: 'crew@marina.example.invalid' })
  // Read mail and old unread mail are never asked about.
  add('r0', 'issues@tickets.example.invalid', 'Ticket Board', 'Ticket 7000 closed', { seen: 1 })
  add('o0', 'issues@tickets.example.invalid', 'Ticket Board', 'Ticket 6000 closed', { age: 30 * 24 * 3600_000 })
  await client.run(
    'INSERT INTO messages (account_id, message_id, rfc_message_id, mailbox_id, from_addr, subject, sent_at, payload, seen, received_at, flags_json, updated_at)'
    + " SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]'),"
    + " json_extract(value, '$[4]'), json_extract(value, '$[5]'), json_extract(value, '$[6]'), json_extract(value, '$[7]'),"
    + " json_extract(value, '$[8]'), json_extract(value, '$[9]'), '[]', 0 FROM json_each(?)",
    [JSON.stringify(rows)],
  )
}

/** An engine whose labeler runs only when the test says so (its debounce timer never fires). */
async function startEngine(model?: LabelModel, extra: { now?: () => number } = {}): Promise<MailSortEngine> {
  const made = new MailSortEngine({
    store, dataDir: dir, watch: false,
    ...(model ? { model } : {}),
    timeout: () => ({ dispose: () => undefined }),
    now: extra.now ?? (() => now),
  })
  engine = made
  await made.start()
  await made.idle()
  return made
}

async function groupOf(messageId: string): Promise<{ group: string; reason: string; label: string | null }> {
  const row = await client.get<{ sort_group: string; sort_reason: string; sort_label: string | null }>(
    'SELECT sort_group, sort_reason, sort_label FROM messages WHERE message_id = ?', [messageId],
  )
  return { group: row!.sort_group, reason: row!.sort_reason, label: row!.sort_label }
}

/** Unread recent mail per group, Important included (`unreadGroups` leaves Important out). */
async function unreadGroups(): Promise<Record<string, number>> {
  const rows = await client.all<{ grp: string; n: number }>(
    "SELECT sort_group AS grp, COUNT(*) AS n FROM messages WHERE seen = 0 AND message_id <> 'o0' GROUP BY sort_group",
  )
  return Object.fromEntries(rows.map((row) => [row.grp, row.n]))
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-sort-ai-'))
  client = new PluginDatabaseClient(path.join(dir, 'plugin.sqlite'))
  await client.migrate(MAIL_MIGRATIONS)
  await client.run("INSERT INTO accounts (account_id, provider_id, display_name, address) VALUES (?, 'imap', 'Harbour, Robin', ?)", [MARINA, ME])
  await client.run("INSERT INTO mailboxes (account_id, mailbox_id, name, role) VALUES (?, 'INBOX', 'Inbox', 'inbox')", [MARINA])
  db = new MailDatabase({ storage: { database: client } } as unknown as ConstructorParameters<typeof MailDatabase>[0])
  store = new MailStore(db)
})

afterAll(async () => {
  await db?.dispose()
  fs.rmSync(dir, { recursive: true, force: true })
})

beforeEach(async () => {
  now = Date.now()
  asked = []
  groupsSeen = []
  summaryAsked = []
  summaryMode = 'lines'
  await client.run('DELETE FROM mail_group_summaries')
  fs.rmSync(path.join(dir, 'sort-rules.yaml'), { force: true })
  // The engine keeps the last good rules in `meta` and uses them when the file is missing, so a rule
  // an earlier test saved would otherwise still sort this test's mail.
  await client.run('DELETE FROM meta')
  await client.run('DELETE FROM mail_sort_labels')
  await seed()
})

afterEach(() => {
  engine?.dispose()
  engine = null
})

describe('labeling unread inbox mail', () => {
  it('waits in Important as ai:pending, then lands in the model\'s groups', async () => {
    const sort = await startEngine(fakeModel(byKind))
    expect(await groupOf('t0')).toMatchObject({ group: 'important', reason: 'ai:pending' })
    expect(await store.sort.pendingCount(PAIRS)).toBe(12)
    expect(await sort.aiStatus(PAIRS)).toEqual({ state: 'on', pending: 12 })

    await sort.labelNow()
    expect(asked).toHaveLength(1)
    // Only the twelve unread, recent inbox mails were asked about: not the read one, not the old one.
    expect(asked[0]!.map((one) => one.subject).some((one) => /7000|6000/.test(one))).toBe(false)
    expect(asked[0]).toHaveLength(12)
    expect(await groupOf('t0')).toEqual({ group: 'u:ticket-updates', reason: 'ai', label: 'Ticket updates' })
    expect(await groupOf('p0')).toMatchObject({ group: 'important', reason: 'ai' })
    expect(await unreadGroups()).toEqual({ important: 2, 'u:ticket-updates': 6, 'u:build-results': 4 })
    expect(await sort.aiStatus(PAIRS)).toEqual({ state: 'on', pending: 0 })
    // The read and the old unread mail went by the simple rules, not the model.
    expect((await groupOf('r0')).reason).not.toMatch(/^ai/)
    expect((await groupOf('o0')).reason).not.toMatch(/^ai/)
    // The DTO says what the group is called and why.
    const row = await client.get<{ sort_group: string; sort_reason: string; sort_label: string; ai_why: string }>(
      "SELECT sort_group, sort_reason, sort_label, ai_why FROM messages WHERE message_id = 't1'",
    )
    expect(sort.sortDtoOf(row!)).toMatchObject({ group: 'u:ticket-updates', label: 'Ticket updates', why: 'Automated ticket change' })
  })

  it('asks once: a second pass with nothing new calls nothing', async () => {
    const sort = await startEngine(fakeModel(byKind))
    await sort.labelNow()
    await sort.labelNow()
    expect(asked).toHaveLength(1)
  })

  it('in batches of AI_BATCH, newest first', async () => {
    const extra: unknown[][] = []
    for (let i = 0; i < AI_BATCH + 5; i += 1) {
      const at = now - 10_000 - i
      extra.push([MARINA, `x${i}`, '', 'INBOX', 'noreply@builds.example.invalid', `Build x${i}`, at, JSON.stringify({ from: { address: 'noreply@builds.example.invalid' } }), 0, at])
    }
    await client.run(
      'INSERT INTO messages (account_id, message_id, rfc_message_id, mailbox_id, from_addr, subject, sent_at, payload, seen, received_at, flags_json, updated_at)'
      + " SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]'),"
      + " json_extract(value, '$[4]'), json_extract(value, '$[5]'), json_extract(value, '$[6]'), json_extract(value, '$[7]'),"
      + " json_extract(value, '$[8]'), json_extract(value, '$[9]'), '[]', 0 FROM json_each(?)",
      [JSON.stringify(extra)],
    )
    const sort = await startEngine(fakeModel(byKind))
    await sort.labelNow()
    expect(asked.map((batch) => batch.length)).toEqual([AI_BATCH, 12 + 5])
    expect(asked[0]![0]!.subject).toBe('Build x0')
    // Names in use ride the next batch, so the model keeps to them.
    expect(groupsSeen[1]).toEqual(expect.arrayContaining(['Build results']))
  })

  it('a partial answer labels what it answered; the rest falls back to the simple rules, not pending for ever', async () => {
    const sort = await startEngine(fakeModel((mail) => (mail.i % 2 === 0 ? byKind(mail) : null)))
    await sort.labelNow()
    const rows = await client.all<{ sort_reason: string }>("SELECT sort_reason FROM messages WHERE seen = 0 AND message_id NOT LIKE 'o%'")
    expect(rows.filter((one) => one.sort_reason === 'ai').length).toBe(6)
    expect(rows.filter((one) => one.sort_reason === 'ai:pending').length).toBe(0)
    expect(await store.sort.pendingCount(PAIRS)).toBe(0)
  })
})

describe('when the model fails', () => {
  for (const mode of ['down', 'invalid'] as const) {
    it(`${mode}: the waiting mail is grouped by sender at once, and the labeler says down`, async () => {
      const sort = await startEngine(fakeModel(mode))
      expect(await store.sort.pendingCount(PAIRS)).toBe(12)
      await sort.labelNow()
      expect(await store.sort.pendingCount(PAIRS)).toBe(0)
      expect(await sort.aiStatus(PAIRS)).toEqual({ state: 'down', pending: 0 })
      const ticket = await groupOf('t0')
      expect(ticket.group).toBe('s:issues@tickets.example.invalid')
      expect(ticket.label).toBe('Ticket Board')
      // A person writing to Robin is still Important by the simple rules; a group alias is not.
      expect((await groupOf('p0')).group).toBe('important')
      expect((await groupOf('p1')).group).toBe('s:bo.tiller@marina.example.invalid')
      // While down, new unread mail is not held back as pending either.
      await sort.labelNow()
      expect(asked).toHaveLength(1)
    })
  }

  it('comes back after AI_DOWN_MS and labels the mail it skipped', async () => {
    let answer: Answer | 'down' = 'down'
    const sort = await startEngine(async (request) => fakeModel(answer)(request))
    await sort.labelNow()
    expect((await sort.aiStatus(PAIRS)).state).toBe('down')
    answer = byKind
    now += AI_DOWN_MS + 1
    expect((await sort.aiStatus(PAIRS)).state).toBe('on')
    await sort.labelNow()
    expect(await groupOf('t0')).toMatchObject({ group: 'u:ticket-updates', reason: 'ai' })
  })

  it('without a model at all nothing waits: state off, simple rules', async () => {
    const sort = await startEngine()
    expect(await sort.aiStatus(PAIRS)).toEqual({ state: 'off', pending: 0 })
    expect((await groupOf('t0')).group).toBe('s:issues@tickets.example.invalid')
  })
})

describe('rules and the model', () => {
  it('a mail a rule decides is never asked about; a Not important rule still takes the model\'s group', async () => {
    const sort = await startEngine(fakeModel(byKind))
    await sort.saveRules({
      groups: [],
      rules: [
        { id: 'r-000001', when: { from: 'carol.pier@friend.example.invalid' }, then: 'Pager alerts', source: 'user' },
        { id: 'r-000002', when: { from: 'noreply@builds.example.invalid' }, then: 'Not important', source: 'learned', note: 'Builds never need me' },
      ],
    }, 'missing')
    await sort.idle()
    await sort.labelNow()
    const subjects = asked.flat().map((one) => one.subject)
    expect(subjects).not.toContain('Lunch on the quay?')
    expect(subjects).toContain('Build 0 passed')
    expect(await groupOf('p0')).toMatchObject({ group: 'u:pager-alerts', reason: 'rule:r-000001' })
    expect(await groupOf('b0')).toMatchObject({ group: 'u:build-results', reason: 'rule:r-000002' })
  })

  it('a rule\'s note rides the prompt, and a new rule relabels every unread mail', async () => {
    const sort = await startEngine(fakeModel(byKind))
    await sort.labelNow()
    expect(asked).toHaveLength(1)
    await sort.saveRules({
      groups: [],
      rules: [{ id: 'r-000003', when: { from: '@tickets.example.invalid' }, then: 'Not important', source: 'learned', note: 'Ticket mail is noise' }],
    }, 'missing')
    await sort.idle()
    await sort.labelNow()
    expect(asked).toHaveLength(2)
  })

  it('a group rule moves what the model grouped, and never skips the model it depends on', async () => {
    const sort = await startEngine(fakeModel(byKind))
    await sort.saveRules({
      groups: [],
      rules: [{ id: 'r-000004', when: { group: 'Ticket updates' }, then: 'Important', source: 'learned', note: 'Tickets need me' }],
    }, 'missing')
    await sort.idle()
    await sort.labelNow()
    expect(asked.flat().some((one) => /Ticket/.test(one.subject))).toBe(true)
    expect(await groupOf('t0')).toMatchObject({ group: 'important', reason: 'rule:r-000004' })
    expect(await groupOf('b0')).toMatchObject({ group: 'u:build-results' })
  })
})

describe('renaming a group', () => {
  it('the new name wins, the model is told it, and its answers in the new name land in the same group', async () => {
    let name = 'Ticket updates'
    const sort = await startEngine(fakeModel((mail) => (/ticket/i.test(mail.subject)
      ? { important: false, group: name, why: 'Automated' } : byKind(mail))))
    await sort.labelNow()
    expect(await sort.renameGroup('u:ticket-updates', 'Tickets')).toEqual({ ok: true, label: 'Tickets' })
    expect(sort.labelOf('u:ticket-updates')).toBe('Tickets')
    expect(sort.idForLabel('tickets')).toBe('u:ticket-updates')
    // The model now answers in the new name for a new mail: it lands in the renamed group.
    name = 'Tickets'
    await client.run(
      "INSERT INTO messages (account_id, message_id, rfc_message_id, mailbox_id, from_addr, subject, sent_at, payload, seen, received_at, flags_json, updated_at) VALUES (?, 't9', '', 'INBOX', 'issues@tickets.example.invalid', 'Ticket 9999 was updated', ?, ?, 0, ?, '[]', 0)",
      [MARINA, now, JSON.stringify({ from: { address: 'issues@tickets.example.invalid' } }), now],
    )
    await sort.labelNow()
    expect(groupsSeen.at(-1)).toContain('Tickets')
    expect((await groupOf('t9')).group).toBe('u:ticket-updates')
    const catalog = await sort.catalog(PAIRS)
    expect(catalog.find((one) => one.id === 'u:ticket-updates')?.label).toBe('Tickets')
  })

  it('refuses a reserved name, an empty one, and a name another group already has', async () => {
    const sort = await startEngine(fakeModel(byKind))
    await sort.labelNow()
    expect(await sort.renameGroup('u:ticket-updates', 'Important')).toMatchObject({ ok: false })
    expect(await sort.renameGroup('u:ticket-updates', '   ')).toMatchObject({ ok: false })
    expect(await sort.renameGroup('important', 'Mine')).toMatchObject({ ok: false })
    // A name the model gave another group on screen is taken too, not only another rename.
    expect(await sort.renameGroup('u:ticket-updates', 'BUILD RESULTS')).toEqual({ ok: false, message: 'Another group is already called Build results.' })
    await sort.renameGroup('u:build-results', 'Robots')
    expect(await sort.renameGroup('u:ticket-updates', 'robots')).toMatchObject({ ok: false })
  })
})

describe('the budget', () => {
  it('stops at AI_HOURLY_CALLS calls an hour and waits, never loops', async () => {
    let calls = 0
    const scheduled: number[] = []
    const rows = Array.from({ length: 3 }, (_, i) => ({ rowid: i + 1 }) as ScanRow)
    const labeler = new MailSortLabeler({
      store: {
        // Never runs dry: the only brake is the budget.
        aiCandidates: async () => rows,
        applyAiVerdicts: async () => rows.length,
      },
      model: async () => { calls += 1; return JSON.stringify({ mails: [] }) },
      context: async () => ({
        rev: 'r', me: [], notes: [], groups: [], decides: () => false,
        features: () => ({ fromAddr: 'a@b.example.invalid', fromName: '', senderKind: 'transactional', addressedToMe: true, onlyCc: false, hasListUnsubscribe: false, correspondent: false }) as never,
      }),
      reclassify: async () => undefined,
      onDown: async () => undefined,
      timeout: (_fn, ms) => { scheduled.push(ms); return { dispose: () => undefined } },
      now: () => now,
    })
    await labeler.runNow()
    expect(calls).toBe(AI_HOURLY_CALLS)
    expect(scheduled.at(-1)).toBeGreaterThan(0)
    await labeler.runNow()
    expect(calls).toBe(AI_HOURLY_CALLS)
    now += 60 * 60 * 1000 + 1
    await labeler.runNow()
    expect(calls).toBe(AI_HOURLY_CALLS * 2)
    labeler.dispose()
  })
})

// -- the one line under each group --

describe('group summaries: the pure half', () => {
  const digest = (id: string, unread: number, newestRowid: number, basis = `${unread}:${newestRowid}:0`): GroupDigest =>
    ({ id, label: id, unread, newestRowid, basis })
  const stored = (newestRowid: number, basis: string, updatedAt: number): StoredSummary =>
    ({ summary: 'x', basis, newestRowid, updatedAt })

  it('asks for groups of two or more that are new, got new mail, or changed and went stale; newest first', () => {
    const t = 10 * SUMMARY_REFRESH_MS
    const due = staleGroups([
      digest('u:one', 1, 90),
      digest('u:new', 3, 50),
      digest('u:arrived', 4, 80),
      digest('u:read-fresh', 2, 70, '2:70:1'),
      digest('u:read-stale', 2, 60, '2:60:1'),
      digest('u:same', 5, 40, 'b'),
    ], new Map([
      ['u:arrived', stored(79, '3:79:0', t)],
      ['u:read-fresh', stored(70, '3:70:0', t - 1)],
      ['u:read-stale', stored(60, '3:60:0', t - SUMMARY_REFRESH_MS)],
      ['u:same', stored(40, 'b', 0)],
    ]), t)
    expect(due.map((one) => one.id)).toEqual(['u:arrived', 'u:read-stale', 'u:new'])
    expect(staleGroups(Array.from({ length: 20 }, (_, i) => digest(`u:g${i}`, 2, i)), new Map(), 0)).toHaveLength(SUMMARY_BATCH)
  })

  it('the prompt carries at most SUMMARY_MAILS mails per group, clipped', () => {
    const prompt = JSON.parse(summaryPrompt([{
      label: 'Ticket updates',
      mails: Array.from({ length: 14 }, (_, i) => ({ from: 'Ticket Board', subject: `Ticket ${i} ${'long '.repeat(60)}`, text: 'first words' })),
    }]))
    expect(prompt.groups).toHaveLength(1)
    expect(prompt.groups[0].name).toBe('Ticket updates')
    expect(prompt.groups[0].mails).toHaveLength(SUMMARY_MAILS)
    expect(prompt.groups[0].mails[0].subject.length).toBeLessThanOrEqual(141)
    expect(prompt.groups[0].mails[0].text).toBe('first words')
  })

  it('a line is cleaned: one line, no quotes, no trailing period, clipped', () => {
    expect(cleanSummary('  "Storage tickets\nand a DNS rollout."  ')).toBe('Storage tickets and a DNS rollout')
    expect(cleanSummary('   ')).toBeNull()
    expect(cleanSummary(42)).toBeNull()
    expect(cleanSummary('word '.repeat(60))!.length).toBeLessThanOrEqual(MAX_SUMMARY_CHARS + 1)
    // Test data: a line in another script keeps its own full stop rule.
    expect(cleanSummary('\u5de5\u5355\u66f4\u65b0\u3002')).toBe('\u5de5\u5355\u66f4\u65b0')
  })

  it('the answer is data: out-of-range, repeated and empty entries are dropped; non-JSON is null', () => {
    const out = parseSummaries('Here: {"groups":[{"g":0,"summary":"A"},{"g":0,"summary":"B"},{"g":5,"summary":"C"},{"g":1,"summary":""},{"g":"1","summary":"D"}]}', 2)!
    expect([...out.entries()]).toEqual([[0, 'A'], [1, 'D']])
    expect(parseSummaries('mostly tickets', 2)).toBeNull()
    expect(parseSummaries('{"mails":[]}', 2)).toBeNull()
  })
})

describe('group summaries: the labeler writes them', () => {
  const lines = async () => Object.fromEntries([...(await store.summaries.stored()).entries()].map(([id, one]) => [id, one.summary]))

  it('after labeling, ONE call writes a line for every group of two or more, and a second pass asks nothing', async () => {
    const sort = await startEngine(fakeModel(byKind))
    await sort.labelNow()
    expect(asked).toHaveLength(1)
    expect(summaryAsked).toHaveLength(1)
    expect(summaryAsked[0]!.map((one) => one.name).sort()).toEqual(['Build results', 'Ticket updates'])
    // Newest first, and never more than SUMMARY_MAILS each.
    const tickets = summaryAsked[0]!.find((one) => one.name === 'Ticket updates')!
    expect(tickets.mails[0]!.subject).toBe('Ticket 8800 was updated')
    expect(await lines()).toEqual({
      'u:ticket-updates': 'Ticket 8800 was updated and Ticket 8801 was updated',
      'u:build-results': 'Build 0 passed and Build 1 passed',
    })
    await sort.labelNow()
    expect(summaryAsked).toHaveLength(1)
  })

  it('reading a mail does not cost a call until the line is 30 minutes old; a new arrival always does', async () => {
    const sort = await startEngine(fakeModel(byKind))
    await sort.labelNow()
    await client.run("UPDATE messages SET seen = 1 WHERE message_id = 't0'")
    await sort.labelNow()
    expect(summaryAsked).toHaveLength(1)
    now += SUMMARY_REFRESH_MS + 1
    await sort.labelNow()
    expect(summaryAsked).toHaveLength(2)
    expect(summaryAsked[1]!.map((one) => one.name)).toEqual(['Ticket updates'])

    await client.run(
      "INSERT INTO messages (account_id, message_id, rfc_message_id, mailbox_id, from_addr, subject, sent_at, payload, seen, received_at, flags_json, updated_at) VALUES (?, 'b9', '', 'INBOX', 'noreply@builds.example.invalid', 'Build 9 failed', ?, ?, 0, ?, '[]', 0)",
      [MARINA, now, JSON.stringify({ from: { address: 'noreply@builds.example.invalid', name: 'Build Robot' } }), now],
    )
    await sort.labelNow()
    expect(summaryAsked).toHaveLength(3)
    expect(summaryAsked[2]!.map((one) => one.name)).toEqual(['Build results'])
    expect((await lines())['u:build-results']).toBe('Build 9 failed and Build 0 passed')
  })

  it('a group the model skipped is stamped empty and not asked about again until it changes', async () => {
    summaryMode = 'first-only'
    const sort = await startEngine(fakeModel(byKind))
    await sort.labelNow()
    const written = await lines()
    expect(Object.values(written).filter((one) => one === '')).toHaveLength(1)
    expect(Object.values(written).filter((one) => one !== '')).toHaveLength(1)
    await sort.labelNow()
    expect(summaryAsked).toHaveLength(1)
  })

  it('an unreadable summary answer stamps the batch and leaves labeling up', async () => {
    summaryMode = 'invalid'
    const sort = await startEngine(fakeModel(byKind))
    await sort.labelNow()
    expect(summaryAsked).toHaveLength(1)
    expect(await lines()).toEqual({ 'u:ticket-updates': '', 'u:build-results': '' })
    expect((await sort.aiStatus(PAIRS)).state).toBe('on')
    await sort.labelNow()
    expect(summaryAsked).toHaveLength(1)
  })

  it('a group with one unread mail is never asked about (its subject is the line)', async () => {
    await client.run("UPDATE messages SET seen = 1 WHERE message_id IN ('b1', 'b2', 'b3')")
    const sort = await startEngine(fakeModel(byKind))
    await sort.labelNow()
    expect(summaryAsked).toHaveLength(1)
    expect(summaryAsked[0]!.map((one) => one.name)).toEqual(['Ticket updates'])
  })

  it('a model that is down writes no line and labels nothing', async () => {
    const sort = await startEngine(fakeModel('down'))
    await sort.labelNow()
    expect(summaryAsked).toEqual([])
    expect(await lines()).toEqual({})
  })
})
