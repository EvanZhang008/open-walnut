/**
 * The rules file on disk (spec 5.6, 6.4): parse, validate, keep the last good rules, `.bak` once
 * per editing session, atomic writes, the commented example, and a file that vanishes briefly.
 *
 * Real files in a temp dir; the meta table is a Map and the clock is a variable, so nothing here
 * waits on a timer.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  LAST_GOOD_META_KEY, MISSING_FILE_REV, MailRulesFile, RULES_CHANGED_ON_DISK, dumpRulesDoc, fileRevOf, parseRulesYaml,
  type RulesFileState,
} from '../../src/integrations/mail/sort-rules-file.js'
import { ruleIsOn } from '../../src/integrations/mail/sort-classify.js'
import {
  PATTERN_BACKREFERENCE, PATTERN_TOO_BIG, RULE_OFF_BACKREFERENCE, RULE_OFF_TOO_BIG, patternTooLong, ruleOffInvalid, ruleOffReason, ruleOffTooLong,
} from '../../src/integrations/mail/sort-regex-safety.js'
import { SKIP_INBOX_NEEDS_GROUP, THEN_REQUIRED, WHEN_EMPTY, validateRulesDoc } from '../../src/integrations/mail/sort-rules-schema.js'

let dir: string
let now: number
let meta: Map<string, string>
let changes: RulesFileState[]

function makeFile(): MailRulesFile {
  return new MailRulesFile({
    dataDir: dir,
    meta: { get: async (key) => meta.get(key), set: async (key, value) => { meta.set(key, value) } },
    watch: false,
    now: () => now,
    onChange: (state) => { changes.push(state) },
  })
}

const file = (): string => path.join(dir, 'sort-rules.yaml')
const write = (text: string): void => fs.writeFileSync(file(), text)

const GOOD = `version: 1
groups:
  - On-call & tickets
rules:
  - id: r-7f3a2c
    when: { from: ["noreply-oncall-notifications@*", "issues@*"] }
    then: On-call & tickets
    source: learned
    note: "Pages and tickets"
    created: 2026-09-28
`

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-sort-rules-'))
  now = new Date('2026-09-28T10:42:00').getTime()
  meta = new Map()
  changes = []
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('reading the file', () => {
  it('no file and no meta copy: built-ins only, no error', async () => {
    const rules = makeFile()
    await rules.start()
    expect(rules.current.exists).toBe(false)
    expect(rules.current.fileRev).toBe(MISSING_FILE_REV)
    expect(rules.current.doc.rules).toEqual([])
    expect(rules.current.error).toBeUndefined()
    expect(rules.path).toBe(path.join(dir, 'sort-rules.yaml'))
  })

  it('a valid file is parsed, hashed by its bytes, and saved as the last good copy', async () => {
    write(GOOD)
    const rules = makeFile()
    await rules.start()
    expect(rules.current.fileRev).toBe(fileRevOf(GOOD))
    expect(rules.current.doc.rules[0]).toMatchObject({ id: 'r-7f3a2c', then: 'On-call & tickets', source: 'learned', created: '2026-09-28' })
    expect(JSON.parse(meta.get(LAST_GOOD_META_KEY)!).doc.rules).toHaveLength(1)
  })

  it('a typo in then is an error, keeps the last good rules, and names the line', async () => {
    write(GOOD)
    const rules = makeFile()
    await rules.start()
    write(GOOD.replace('then: On-call & tickets', 'then: Importnat'))
    await rules.check()
    expect(rules.current.error?.message).toBe('then: Importnat is not a group. Did you mean Important?')
    expect(rules.current.error?.line).toBe(7)
    expect(rules.current.doc.rules[0]!.then).toBe('On-call & tickets')
  })

  it('a YAML syntax error names its line and keeps the last good rules', async () => {
    write(GOOD)
    const rules = makeFile()
    await rules.start()
    write('version: 1\nrules:\n  - when: { from: "a@*"\n    then: Important\n')
    await rules.check()
    expect(rules.current.error?.message).toMatch(/^The file is not valid YAML: /)
    expect(rules.current.error?.line).toBeGreaterThan(0)
    expect(rules.current.doc.rules).toHaveLength(1)
  })

  it('a file already broken at boot uses the meta copy, so learned rules still apply', async () => {
    meta.set(LAST_GOOD_META_KEY, JSON.stringify({ doc: parseRulesYaml(GOOD), at: now - 60_000 }))
    write(GOOD.replace('then: On-call & tickets', 'then: 3'))
    const rules = makeFile()
    await rules.start()
    expect(rules.current.error?.message).toBe(THEN_REQUIRED)
    expect(rules.current.error?.line).toBe(7)
    expect(rules.current.doc.rules[0]!.id).toBe('r-7f3a2c')
  })

  it('one regex Walnut will not run turns that rule off, never the whole file; a new one is still refused', async () => {
    const text = `version: 1\nrules:\n  - when: { from: "a@*" }\n    then: Important\n  - when: { subject: { re: "(a)\\\\1" } }\n    then: Important\n`
    write(text)
    const rules = makeFile()
    await rules.start()
    expect(rules.current.error).toBeUndefined()
    expect(rules.current.doc.rules).toHaveLength(2)
    expect(ruleIsOn(rules.current.doc.rules[0]!)).toBe(true)
    expect(ruleOffReason(rules.current.doc.rules[1]!.when)).toBe(RULE_OFF_BACKREFERENCE)
    // Pasted as a new rule (the current rules do not hold it), it is refused with its line.
    rules.dispose()
    write('version: 1\nrules: []\n')
    const empty = makeFile()
    await empty.start()
    expect(empty.validateText(text)).toEqual([expect.objectContaining({ message: PATTERN_BACKREFERENCE, line: 5 })])
    empty.dispose()
  })
})

describe('saving from the console', () => {
  it('refuses a stale baseRev with the changed-on-disk sentence, and writes nothing', async () => {
    write(GOOD)
    const rules = makeFile()
    await rules.start()
    const outcome = await rules.save({ groups: [], rules: [] }, 'deadbeef0000')
    expect(outcome).toEqual({ ok: false, status: 409, json: { error: 'changed', message: RULES_CHANGED_ON_DISK } })
    expect(fs.readFileSync(file(), 'utf8')).toBe(GOOD)
  })

  it('refuses an invalid body with every error, and writes nothing', async () => {
    const rules = makeFile()
    await rules.start()
    const outcome = await rules.save({ groups: [], rules: [{ when: {}, then: 'Important', source: 'user' }] }, MISSING_FILE_REV)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.status).toBe(400)
    expect(outcome.json.errors).toEqual([{ index: 0, field: 'when', message: WHEN_EMPTY }])
    expect(fs.existsSync(file())).toBe(false)
  })

  it('creates the file on first save, fills missing ids, and leaves no temp file', async () => {
    const rules = makeFile()
    await rules.start()
    const outcome = await rules.save({ groups: [], rules: [{ when: { from: 'issues@*' }, then: 'Notifications', source: 'user' }] }, MISSING_FILE_REV)
    expect(outcome.ok).toBe(true)
    const doc = validateRulesDoc(parseRulesYaml(fs.readFileSync(file(), 'utf8')))
    expect(doc.ok && doc.doc.rules[0]!.id).toMatch(/^r-[0-9a-f]{6}$/)
    expect(fs.readdirSync(dir).filter((name) => name.includes('.tmp-'))).toEqual([])
    expect(fs.existsSync(`${file()}.bak`)).toBe(false)
    expect(rules.current.fileRev).toBe(fileRevOf(fs.readFileSync(file())))
  })

  it('keeps ONE .bak per editing session: the version from before a burst of saves', async () => {
    write(GOOD)
    const rules = makeFile()
    await rules.start()
    const first = await rules.save({ groups: ['A'], rules: [] }, rules.current.fileRev)
    expect(first.ok).toBe(true)
    now += 20_000
    const second = await rules.save({ groups: ['B'], rules: [] }, rules.current.fileRev)
    expect(second.ok).toBe(true)
    expect(fs.readFileSync(`${file()}.bak`, 'utf8')).toBe(GOOD)
    now += 61_000
    const afterFirst = fs.readFileSync(file(), 'utf8')
    await rules.save({ groups: ['C'], rules: [] }, rules.current.fileRev)
    expect(fs.readFileSync(`${file()}.bak`, 'utf8')).toBe(afterFirst)
  })

  it('restore puts the .bak back', async () => {
    write(GOOD)
    const rules = makeFile()
    await rules.start()
    await rules.save({ groups: [], rules: [] }, rules.current.fileRev)
    expect(rules.current.doc.rules).toEqual([])
    const restored = await rules.restore()
    expect(restored.ok).toBe(true)
    expect(fs.readFileSync(file(), 'utf8')).toBe(GOOD)
    expect(rules.current.doc.rules).toHaveLength(1)
    expect(rules.current.error).toBeUndefined()
  })

  it('restore without a backup is a 404', async () => {
    const rules = makeFile()
    await rules.start()
    const outcome = await rules.restore()
    expect(outcome.ok === false && outcome.status).toBe(404)
  })

  it('init writes the commented example once; it parses to zero rules; a second init is 409', async () => {
    const rules = makeFile()
    await rules.start()
    const created = await rules.init()
    expect(created.ok).toBe(true)
    const text = fs.readFileSync(file(), 'utf8')
    expect(text).toMatch(/^# Walnut mail sorting rules/)
    expect(rules.current.exists).toBe(true)
    expect(rules.current.doc).toEqual({ version: 1, groups: [], rules: [] })
    const again = await rules.init()
    expect(again.ok === false && again.status).toBe(409)
    expect(fs.readFileSync(file(), 'utf8')).toBe(text)
  })
})

describe('a file that vanishes', () => {
  it('is only believed gone after staying gone for about 4 s across two checks', async () => {
    write(GOOD)
    const rules = makeFile()
    await rules.start()
    const before = changes.length
    fs.rmSync(file())
    await rules.check()
    now += 2_000
    await rules.check()
    expect(changes.length).toBe(before)
    expect(rules.current.exists).toBe(true)
    now += 3_000
    await rules.check()
    expect(rules.current.exists).toBe(false)
    expect(rules.current.error?.message).toBe('The rules file is missing. Walnut is still using the rules from 10:42.')
    expect(rules.current.doc.rules).toHaveLength(1)
  })

  it('coming back within 3 s changes nothing at all', async () => {
    write(GOOD)
    const rules = makeFile()
    await rules.start()
    const before = changes.length
    fs.rmSync(file())
    await rules.check()
    now += 2_500
    write(GOOD)
    await rules.check()
    now += 5_000
    await rules.check()
    expect(changes.length).toBe(before)
    expect(rules.current.error).toBeUndefined()
  })
})

describe('validation sentences (spec 5.6)', () => {
  const errorsOf = (raw: unknown) => {
    const result = validateRulesDoc(raw)
    return result.ok ? [] : result.errors.map((error) => error.message)
  }
  it('a near miss of a reserved name or of an earlier target is a typo, not a new group', () => {
    expect(errorsOf({ rules: [{ when: { from: 'a@*' }, then: 'Not importnt' }] })).toEqual(['then: Not importnt is not a group. Did you mean Not important?'])
    expect(errorsOf({ rules: [{ when: { from: 'a@*' }, then: 'Pager alerts' }, { when: { from: 'b@*' }, then: 'Pagr alerts' }] }))
      .toEqual(['then: Pagr alerts is not a group. Did you mean Pager alerts?'])
  })
  it('rejects two names with the same group id', () => {
    expect(errorsOf({ groups: ['A&B', 'A B'] })).toEqual(['"A&B" and "A B" are too similar. Rename one of them.'])
    expect(errorsOf({ groups: ['A&B'], rules: [{ when: { from: 'a@*' }, then: 'A B' }] })).toEqual(['"A&B" and "A B" are too similar. Rename one of them.'])
  })
  it('rejects duplicate ids, unknown fields, empty conditions and a non-string then', () => {
    expect(errorsOf({ rules: [{ id: 'r-7f3a2c', when: { from: 'a@*' }, then: 'Important' }, { id: 'r-7f3a2c', when: { from: 'b@*' }, then: 'Important' }] }))
      .toEqual(['Two rules use the id r-7f3a2c.'])
    expect(errorsOf({ rules: [{ when: { from: 'a@*' }, then: 'Important', colour: 'red' }] })).toEqual(['colour is not a rule field.'])
    expect(errorsOf({ rules: [{ when: { frm: 'a@*' }, then: 'Important' }] })).toEqual(['when.frm is not a condition Walnut knows.'])
    expect(errorsOf({ rules: [{ when: {}, then: 'Important' }] })).toEqual([WHEN_EMPTY])
    expect(errorsOf({ rules: [{ when: { from: 'a@*' }, then: 3 }] })).toEqual([THEN_REQUIRED])
  })
  it('accepts a hand-written rule without id or source, and a new group name far from any other', () => {
    const result = validateRulesDoc({ rules: [{ when: { from: 'a@*' }, then: 'Harbour notes' }] })
    expect(result.ok && result.doc.rules[0]).toEqual({ when: { from: 'a@*' }, then: 'Harbour notes', source: 'user' })
  })
  it('matches reserved names case-insensitively', () => {
    expect(errorsOf({ rules: [{ when: { from: 'a@*' }, then: 'important' }, { when: { from: 'b@*' }, then: 'NOT IMPORTANT' }] })).toEqual([])
  })
})

describe('skipInbox ("keep out of the Inbox")', () => {
  it('is kept with a group in then, and survives a dump and a parse', () => {
    const result = validateRulesDoc({
      version: 1, groups: ['Shop news'],
      rules: [{ id: 'r-shop', when: { from: 'news@shop.example.invalid' }, then: 'Shop news', skipInbox: true }],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.doc.rules[0]).toMatchObject({ id: 'r-shop', skipInbox: true })
    const again = validateRulesDoc(parseRulesYaml(dumpRulesDoc(result.doc)))
    expect(again.ok && again.doc.rules[0]!.skipInbox).toBe(true)
    // false is the same as absent, and is not written back.
    const off = validateRulesDoc({ rules: [{ when: { from: 'a@b.example.invalid' }, then: 'Shop news', skipInbox: false }] })
    expect(off.ok && off.doc.rules[0]!.skipInbox).toBeUndefined()
  })

  it('is refused with Important or Not important, and when it is not a boolean', () => {
    for (const then of ['Important', 'Not important']) {
      const result = validateRulesDoc({ rules: [{ id: 'r-x', when: { from: 'a@b.example.invalid' }, then, skipInbox: true }] })
      expect(result.ok).toBe(false)
      if (result.ok) continue
      expect(result.errors).toEqual([{ index: 0, field: 'skipInbox', message: SKIP_INBOX_NEEDS_GROUP, id: 'r-x' }])
    }
    const typed = validateRulesDoc({ rules: [{ when: { from: 'a@b.example.invalid' }, then: 'Shop news', skipInbox: 'yes' }] })
    expect(typed.ok).toBe(false)
    if (!typed.ok) expect(typed.errors[0]).toMatchObject({ field: 'skipInbox', message: 'skipInbox must be true or false.' })
  })
})

describe('a subject pattern Walnut will not run (too big, as an older Walnut accepted, or any a hand edit wrote)', () => {
  // About 12,000 states: refused by this matcher, accepted before it.
  const BIG = '(?:.{0,299}){20}'
  const WITH_BIG = `${GOOD}  - id: r-big001
    when: { subject: { re: "${BIG}" } }
    then: Notifications
    source: user
`

  it('loads switched off with its reason; the rest of the file works and becomes the last good copy', async () => {
    write(WITH_BIG)
    const rules = makeFile()
    await rules.start()
    expect(rules.current.error).toBeUndefined()
    expect(rules.current.doc.rules.map((rule) => rule.id)).toEqual(['r-7f3a2c', 'r-big001'])
    expect(ruleOffReason(rules.current.doc.rules[1]!.when)).toBe(RULE_OFF_TOO_BIG)
    expect(ruleIsOn(rules.current.doc.rules[1]!)).toBe(false)
    expect(ruleIsOn(rules.current.doc.rules[0]!)).toBe(true)
    expect(JSON.parse(meta.get(LAST_GOOD_META_KEY)!).doc.rules).toHaveLength(2)
  })

  it('a last good copy holding one still loads when the file is broken at boot', async () => {
    meta.set(LAST_GOOD_META_KEY, JSON.stringify({ doc: parseRulesYaml(WITH_BIG), at: now - 60_000 }))
    write('version: 1\nrules:\n  - when: { from: "a@*"\n')
    const rules = makeFile()
    await rules.start()
    expect(rules.current.error?.message).toMatch(/^The file is not valid YAML: /)
    expect(rules.current.doc.rules.map((rule) => rule.id)).toEqual(['r-7f3a2c', 'r-big001'])
  })

  it('a save keeps it byte for byte; a new or changed too-big pattern is refused', async () => {
    write(WITH_BIG)
    const rules = makeFile()
    await rules.start()
    const asRead = rules.current.doc.rules.map((rule) => ({ ...rule, ...(ruleOffReason(rule.when) ? { offReason: ruleOffReason(rule.when) } : {}) }))
    const kept = await rules.save({ groups: rules.current.doc.groups, rules: asRead }, rules.current.fileRev)
    expect(kept.ok).toBe(true)
    const text = fs.readFileSync(file(), 'utf8')
    expect((parseRulesYaml(text) as { rules: Array<{ when: { subject?: { re: string } } }> }).rules[1]!.when.subject!.re).toBe(BIG)
    expect(text).not.toContain('offReason')
    expect(rules.validateText(text)).toEqual([])
    for (const re of ['(?:.{0,299}){21}', '(?=(?:\\w{0,299}x){5})']) {
      const added = await rules.save({ groups: [], rules: [...rules.current.doc.rules, { when: { subject: { re } }, then: 'Important', source: 'user' }] }, rules.current.fileRev)
      expect(added.ok, re).toBe(false)
      if (!added.ok) expect(added.json.errors).toEqual([expect.objectContaining({ index: 2, field: 'when.subject', message: PATTERN_TOO_BIG })])
      expect(rules.validateText(`${text}  - when: { subject: { re: "${re.replace(/\\/g, '\\\\')}" } }\n    then: Important\n`)).toEqual([expect.objectContaining({ message: PATTERN_TOO_BIG })])
    }
    const changed = rules.current.doc.rules.map((rule) => (rule.id === 'r-big001' ? { ...rule, when: { subject: { re: '(?:.{0,299}){19}' } } } : rule))
    const refused = await rules.save({ groups: [], rules: changed }, rules.current.fileRev)
    expect(refused.ok).toBe(false)
  })

  // A hand edit may write any of these; each loads switched off with its own line, as a too-big one does.
  it.each([
    ['an invalid one', '(unclosed', ruleOffInvalid('a ( has no matching ). Close it, or write \\( to match a bracket.'), 'This pattern is not a valid regular expression: '],
    ['one over 200 characters', 'a'.repeat(218), ruleOffTooLong(218), patternTooLong(219)],
    // Written for YAML's double quotes: the file holds (a)\1.
    ['a back-reference', '(a)\\\\1', RULE_OFF_BACKREFERENCE, PATTERN_BACKREFERENCE],
  ])('%s loads switched off with its own line; the rest works; a save keeps it byte for byte; a new one is refused', async (_kind, re, line, refusal) => {
    write(`${GOOD}  - id: r-held01\n    when: { subject: { re: "${re}" } }\n    then: Notifications\n    source: user\n`)
    const rules = makeFile()
    await rules.start()
    expect(rules.current.error, re).toBeUndefined()
    const held = rules.current.doc.rules[1]!
    expect(ruleOffReason(held.when)).toBe(line)
    expect(ruleIsOn(held)).toBe(false)
    expect(ruleIsOn(rules.current.doc.rules[0]!)).toBe(true)
    expect(JSON.parse(meta.get(LAST_GOOD_META_KEY)!).doc.rules).toHaveLength(2)
    const stored = (held.when.subject as { re: string }).re
    const kept = await rules.save({ groups: rules.current.doc.groups, rules: rules.current.doc.rules.map((rule) => (rule.id === 'r-held01' ? { ...rule, note: 'kept' } : rule)) }, rules.current.fileRev)
    expect(kept.ok).toBe(true)
    const text = fs.readFileSync(file(), 'utf8')
    expect((parseRulesYaml(text) as { rules: Array<{ when: { subject?: { re: string } }; note?: string }> }).rules[1]).toMatchObject({ when: { subject: { re: stored } }, note: 'kept' })
    const added = await rules.save({ groups: [], rules: [...rules.current.doc.rules, { when: { subject: { re: `${stored}x` } }, then: 'Important', source: 'user' }] }, rules.current.fileRev)
    expect(added.ok).toBe(false)
    if (!added.ok) expect(added.json.errors).toEqual([expect.objectContaining({ index: 2, field: 'when.subject', message: expect.stringContaining(refusal) })])
    rules.dispose()
  })
})
