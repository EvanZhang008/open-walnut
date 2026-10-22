/**
 * A session's letter to the user (human_inbox_send) while its Walnut server is away:
 * the daemon's offline host (src/providers/offline-host-core.ts opLetter) checks it the
 * way the op and the store do (letter-check.ts), saves its body as a blob and journals a
 * v2 `letter` record, but only for a leading Mac that drains `letter`. An older Mac keeps
 * today's answer (the op needs the server). Real files in temp dirs, a fake clock.
 */
import { describe, it, expect, afterEach } from 'vitest'
import {
  JHOME, SID_A, SID_B, journalTmpDir, cleanupJournalDirs, journalHost, jslice, gatewayCall,
} from '../helpers/offline-journal-harness.js'
import { JOURNAL_V2_DRAINS } from '../../src/providers/offline-journal-core.js'
import { LETTER_ID_RE } from '../../src/core/human-inbox/normalize.js'
import { LETTER_BODY_MAX_BYTES } from '../../src/core/human-inbox/types.js'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { createLetterCheck } from '../../src/core/human-inbox/letter-check.js'

const T0 = Date.parse('2026-10-22T08:00:00Z')
// Accents, CJK and an astral emoji: the blob keeps every byte.
const BODY = '## Two layouts\n\nPick one: café 中文 🚀.\n'
const LETTER = { subject: 'Pick a layout for the marina page', type: 'review', markdown: BODY, text: 'Two layouts, need a pick', task_refs: ['mtaskaaa-0001'] }
const WITHOUT_LETTER = JOURNAL_V2_DRAINS.filter((k) => k !== 'letter')

afterEach(() => cleanupJournalDirs())

function host(opts: { drains?: string[] | null; letters?: boolean } = {}) {
  const clock = { now: T0 }
  const h = journalHost(journalTmpDir(), clock, { letters: opts.letters ?? true, ...(opts.drains !== undefined ? { drains: opts.drains } : {}) })
  h.host.configure(jslice())
  return { ...h, clock }
}

function blobText(journal: ReturnType<typeof host>['journal'], sha: string): string {
  const r = journal.readBlob(sha, 0)
  if (!r.ok) throw new Error(`blob ${sha}: ${JSON.stringify(r)}`)
  return Buffer.from(r.data, 'base64').toString('utf8')
}

const names = (r: Awaited<ReturnType<typeof gatewayCall>>): string[] =>
  r.ok ? (r.result.ops as Array<{ name: string }>).map((o) => o.name) : []

describe('offline letter: a Mac that drains letters', () => {
  it('saves the letter and answers queued, with the id the Mac will send it under', async () => {
    const h = host()
    const r = await gatewayCall(h.host, SID_A, 'human_inbox_send', LETTER)
    expect(r).toMatchObject({ ok: true, result: { queued: true, offline: true, kind: 'letter', seq: 1 } })
    if (!r.ok) return
    const id = r.result.letterId as string
    expect(id).toMatch(LETTER_ID_RE)
    expect(String(r.result.outcome)).toContain(`not in the user's inbox yet: Walnut sends letter ${id} when the server is back`)
    expect(String(r.result.next)).toMatch(/^Do not send it again\./)

    const recs = h.journal.records(JHOME) as unknown as Array<Record<string, unknown>>
    expect(recs).toHaveLength(1)
    const rec = recs[0]
    expect(rec).toMatchObject({
      kind: 'letter', letterId: id, format: 'markdown', at: T0,
      actor: { kind: 'session', sid: SID_A },
      args: { subject: LETTER.subject, type: 'review', text: LETTER.text, task_refs: LETTER.task_refs },
    })
    // The body rides as a blob only, never inline in the record.
    expect(rec.args).not.toHaveProperty('markdown')
    expect(String(rec.bodyBlob)).toMatch(/^[0-9a-f]{64}$/)
    expect(rec.blobs).toEqual([rec.bodyBlob])
    expect(blobText(h.journal, String(rec.bodyBlob))).toBe(BODY)
  })

  it('takes an html letter and a decision letter as the op does', async () => {
    const h = host()
    const html = await gatewayCall(h.host, SID_A, 'human_inbox_send', { subject: 'Done', type: 'completion', html: '<p>All <b>green</b></p>', pin: true })
    const ask = await gatewayCall(h.host, SID_B, 'human_inbox_send', {
      subject: 'Which cache?', type: 'action_required', markdown: 'A or B',
      actions: [{ id: 'a', label: 'Cache A', description: 'faster' }, { id: 'b', label: 'Cache B' }],
    })
    expect(html.ok && ask.ok).toBe(true)
    const recs = h.journal.records(JHOME) as unknown as Array<Record<string, unknown>>
    expect(recs.map((r) => [r.format, (r.actor as { sid: string }).sid])).toEqual([['html', SID_A], ['markdown', SID_B]])
    expect(recs[0].args).toEqual({ subject: 'Done', type: 'completion', pin: true })
    expect(blobText(h.journal, String(recs[0].bodyBlob))).toBe('<p>All <b>green</b></p>')
    expect((recs[1].args as { actions: unknown[] }).actions).toHaveLength(2)
  })

  const REFUSED: Array<[string, Record<string, unknown>, RegExp]> = [
    ['an unknown key', { ...LETTER, urgent: true }, /Unrecognized key\(s\) in object: 'urgent'/],
    ['html_ref (staging needs the server)', { subject: 's', type: 'info', html_ref: 'ref-1' }, /Unrecognized key\(s\) in object: 'html_ref'/],
    ['no subject', { type: 'info', markdown: 'm' }, /subject: a non-empty string is required/],
    ['an unknown type', { subject: 's', type: 'urgent', markdown: 'm' }, /type: must be one of/],
    ['two bodies', { subject: 's', type: 'info', markdown: 'm', html: '<p>m</p>' }, /^exactly one of html \| html_ref \| markdown is required$/],
    ['no body', { subject: 's', type: 'info' }, /^exactly one of html \| html_ref \| markdown is required$/],
    ['a decision with no options', { subject: 's', type: 'action_required', markdown: 'm' }, /^action_required needs at least one action/],
    ['options on a review', { subject: 's', type: 'review', markdown: 'm', actions: [{ id: 'a', label: 'A' }] }, /^actions are only allowed when type is action_required$/],
    ['two options with one id', { subject: 's', type: 'action_required', markdown: 'm', actions: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }] }, /^action ids must be unique$/],
    ['a body over the cap', { subject: 's', type: 'info', markdown: 'x'.repeat(LETTER_BODY_MAX_BYTES + 1) }, /^markdown is \d+ bytes, over the 204800-byte letter cap/],
    ['a preview over the cap', { subject: 's', type: 'info', markdown: 'm', text: 'x'.repeat(LETTER_BODY_MAX_BYTES + 1) }, /^text is \d+ bytes, over the 204800-byte letter cap/],
    ['other fields over the record cap', { subject: 's'.repeat(300 * 1024), type: 'info', markdown: 'm' }, /too large to save on this host/],
  ]

  it.each(REFUSED)('refuses %s with the server\'s words, and journals nothing', async (_label, args, words) => {
    const h = host()
    const r = await gatewayCall(h.host, SID_A, 'human_inbox_send', args)
    expect(r).toMatchObject({ ok: false, error: { code: 'bad_request' } })
    if (!r.ok) expect(r.error.message).toMatch(words)
    expect(h.journal.records(JHOME)).toEqual([])
  })

  it('a refusal on the host is one the store would give online', async () => {
    const check = createLetterCheck()
    for (const [, args] of REFUSED.slice(4, 9)) {
      const online = check.shape(args)
      const r = await gatewayCall(host().host, SID_A, 'human_inbox_send', args)
      expect(online.ok).toBe(false)
      if (!online.ok && !r.ok) expect(r.error.message).toBe(online.message)
    }
  })

  it('a letter whose arguments ride in a file (over 1 MB) still needs the server', async () => {
    const h = host()
    const r = await h.host.handle(JHOME, SID_A, 'tools.call', { name: 'human_inbox_send', argsFile: '/fixture/payload.json' })
    expect(r).toMatchObject({ ok: false, error: { code: 'hub_unreachable', message: expect.stringMatching(/^A letter over 1 MB .*needs the Walnut server/) } })
    expect(h.journal.records(JHOME)).toEqual([])
  })

  it('counts against the session\'s write budget like every queued write', async () => {
    const h = host()
    const out = []
    for (let i = 0; i < 31; i++) out.push(await gatewayCall(h.host, SID_A, 'human_inbox_send', { ...LETTER, subject: `Letter ${i}` }))
    expect(out.slice(0, 30).every((r) => r.ok)).toBe(true)
    expect(out[30]).toMatchObject({ ok: false, error: { code: 'throttled' } })
    expect(h.journal.records(JHOME)).toHaveLength(30)
    // Another session has its own budget.
    expect((await gatewayCall(h.host, SID_B, 'human_inbox_send', LETTER)).ok).toBe(true)
  })

  it('every letter gets its own id, also two in the same millisecond', async () => {
    const h = host()
    const ids = new Set<string>()
    for (let i = 0; i < 10; i++) {
      const r = await gatewayCall(h.host, SID_A, 'human_inbox_send', LETTER)
      if (r.ok) ids.add(r.result.letterId as string)
    }
    expect(ids.size).toBe(10)
  })

  it('lists the op and names it in walnut_status', async () => {
    const h = host()
    expect(names(await h.host.handle(JHOME, SID_A, 'tools.list', {}))).toContain('human_inbox_send')
    const one = await h.host.handle(JHOME, SID_A, 'tools.list', { name: 'human_inbox_send' })
    expect(one).toMatchObject({ ok: true, result: { ops: [{ name: 'human_inbox_send', readonly: false, remote: 'allow' }] } })
    const status = await gatewayCall(h.host, SID_A, 'walnut_status', {})
    expect(status.ok && status.result.answersHere).toContain('human_inbox_send')
    // An op this host cannot answer names the letter among the ones it can.
    const other = await gatewayCall(h.host, SID_A, 'task_create', { title: 'x' })
    expect(other).toMatchObject({ ok: false, error: { code: 'hub_unreachable', message: expect.stringMatching(/still answers: .*human_inbox_send/) } })
  })

  it('hands the record to the Mac that drains it, holds the gateway until then, and frees the body at ack', async () => {
    const h = host()
    const r = await gatewayCall(h.host, SID_A, 'human_inbox_send', LETTER)
    expect(r.ok).toBe(true)
    expect(h.host.pendingHandover(JHOME)).toBe(true)
    const batch = h.host.drain(JHOME, JOURNAL_V2_DRAINS)
    expect(batch.records.map((x) => x.kind)).toEqual(['letter'])
    const sha = String((batch.records[0] as unknown as { bodyBlob: string }).bodyBlob)
    // A Mac that does not apply letters is not handed one, and an old Mac (no kinds) neither.
    expect(h.host.drain(JHOME, WITHOUT_LETTER).records).toEqual([])
    expect(h.host.drain(JHOME, null).records).toEqual([])
    expect(h.host.ack(JHOME, { seqs: [batch.records[0].seq] })).toMatchObject({ remaining: 0 })
    expect(h.host.pendingHandover(JHOME)).toBe(false)
    expect(h.journal.readBlob(sha, 0)).toMatchObject({ ok: false, code: 'not_found' })
  })

  it('a letter saved for a newer Mac never pins the gateway away from an older one that leads next', async () => {
    const h = host()
    expect((await gatewayCall(h.host, SID_A, 'human_inbox_send', LETTER)).ok).toBe(true)
    h.drains.kinds = WITHOUT_LETTER
    expect(h.host.pendingHandover(JHOME)).toBe(false)
    // It stays on the host for a Mac that drains it.
    expect(h.journal.records(JHOME)).toHaveLength(1)
  })
})

describe('offline letter: an older Mac keeps today\'s answer', () => {
  it.each([
    ['a Mac that drains v2 kinds but not letters', WITHOUT_LETTER],
    ['a Mac that sent no kinds', null],
  ] as Array<[string, string[] | null]>)('%s: needs the server, not listed, nothing journaled', async (_label, drains) => {
    const h = host({ drains })
    const r = await gatewayCall(h.host, SID_A, 'human_inbox_send', LETTER)
    expect(r).toMatchObject({ ok: false, error: { code: 'hub_unreachable', message: expect.stringMatching(/^"human_inbox_send" needs the Walnut server/) } })
    expect(h.journal.records(JHOME)).toEqual([])
    expect(names(await h.host.handle(JHOME, SID_A, 'tools.list', {}))).not.toContain('human_inbox_send')
    const status = await gatewayCall(h.host, SID_A, 'walnut_status', {})
    expect(status.ok && status.result.answersHere).not.toContain('human_inbox_send')
    expect(r.ok ? '' : r.error.message).not.toMatch(/still answers: .*human_inbox_send/)
    const file = await h.host.handle(JHOME, SID_A, 'tools.call', { name: 'human_inbox_send', argsFile: '/fixture/payload.json' })
    expect(file).toMatchObject({ ok: false, error: { message: expect.stringMatching(/^A call whose arguments ride in a file/) } })
  })

  it('a daemon without the letter rules answers as before, whatever the Mac drains', async () => {
    const h = host({ letters: false })
    expect(await gatewayCall(h.host, SID_A, 'human_inbox_send', LETTER)).toMatchObject({ ok: false, error: { code: 'hub_unreachable' } })
    expect(names(await h.host.handle(JHOME, SID_A, 'tools.list', {}))).not.toContain('human_inbox_send')
    expect(h.journal.records(JHOME)).toEqual([])
  })
})

describe('offline letter: the source twin', () => {
  it('inlines the letter rules into the offline host', () => {
    const rendered = getDaemonSource()
    expect(rendered).not.toContain('__CREATE_LETTER_CHECK__')
    expect(rendered).toContain(createLetterCheck.toString())
    expect(rendered).toMatch(/letters: \(function createLetterCheck\(\)/)
  })
})
