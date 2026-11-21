/**
 * The person gate (src/core/router/person-gate.ts): a router letter never repeats a mail the person
 * already has (2026-11-21, the user, on a row of "For you:" letters for a bill, a form, a beta
 * invitation, a password reset and two login codes: "I have the email, you forward it to me again,
 * what is the point"; "even the verification code gets forwarded to me again").
 *
 * The subjects below are the shapes of the letters that reached him, with neutral names.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { neverForPerson, personLetterVerdict, validDeadline, PERSON_DEADLINE_MAX_DAYS } from '../../src/core/router/person-gate.js'

const NOW = Date.parse('2026-11-21T12:00:00Z')
const CARD = {
  ask: 'Sign the dock lease forms before the policy renews?',
  deadline: '2026-11-25',
  onlyPerson: 'The policy is in the person\'s own name; the harbour office needs their signature.',
  options: [{ label: 'I will sign it today' }, { label: 'Not renewing' }],
}

describe('kinds that never become a letter, whatever the router says', () => {
  const cases: Array<[string, string, ReturnType<typeof neverForPerson>]> = [
    ['Verification for Library Member Portal', 'Second one-time login code from the library portal today', 'code'],
    ['Here\'s the code', 'A sign-in code, valid for only 15 minutes', 'code'],
    ['Your sign-in code is 482913', '', 'code'],
    ['123456 is your photo app code', '', 'code'],
    ['Your ride code: 1234', '', 'code'],
    ['Use 482913 to sign in', '', 'code'],
    ['Your login link', '', 'code'],
    ['Two-step verification turned on', '', 'account_security'],
    ['Verify your email address', '', 'code'],
    ['你的验证码', '', 'code'],
    ['Password Reset from Your Library Account', 'The account password was just changed', 'account_security'],
    ['You shared some Google Account data with a game', '', 'account_security'],
    ['New sign-in on your account', '', 'account_security'],
    ['You have a new statement', 'Utility bill: $30.00 due by Dec 6', 'bill'],
    ['Monthly Statement', '', 'bill'],
    ['Alex requests $66.70', '', 'bill'],
    ['Cost Management: Cost anomaly summary for account', '', 'bill'],
    ['Problem during shipping: your order', 'Your receipt and order details', 'bill'],
    ['Invitation: Round 1 - Video Interview', '', 'calendar'],
    ['Join Backstage, a music app\'s Beta Program', 'Invitation to join the confidential beta', 'promotion'],
    ['Time to Order Supplies from a garden shop', '', 'promotion'],
    ['Our November newsletter', '', 'promotion'],
  ]
  it.each(cases)('%s', (subject, brief, kind) => {
    expect(neverForPerson([subject, brief])).toBe(kind)
    // A whole question card does not carry it through.
    const verdict = personLetterVerdict({ subject, preview: brief, reason: 'Only the person can act on it', ...CARD }, NOW)
    expect(verdict).toMatchObject({ send: false, kind })
  })

  it.each([
    'Complete and sign the questionnaire and consent forms',
    'Statement of Work signature needed by Nov 25',
    'Bill of materials for the dock rebuild',
    'Your billion-dollar idea',
    'Code review requested',
    'Your code is ready for review',
    'Invitation to interview',
    'You are invited to sign a document',
    'Promotion to Senior Engineer',
    '一次性付清的报价',
  ])('a plain matter is not one of them: %s', (subject) => {
    expect(neverForPerson([subject])).toBeUndefined()
  })

  it('the router\'s own words count for codes and security notices only, and the sender\'s name never', () => {
    expect(neverForPerson(['Library portal'], ['A second one-time login code'])).toBe('code')
    expect(neverForPerson(['Dock lease'], ['The old receipt does not count'])).toBeUndefined()
    expect(neverForPerson(['Lunch on Friday?'])).toBeUndefined()
  })
})

describe('a letter is a whole question card', () => {
  it('passes with a deadline, why only the person, one question and two to four options', () => {
    const verdict = personLetterVerdict({ subject: 'Quote request: dock slot', reason: 'The harbour office needs the signed forms', ...CARD }, NOW)
    expect(verdict).toEqual({ send: true, card: { ...CARD } })
  })

  it.each([
    ['no deadline', { deadline: undefined }],
    ['a deadline in the past', { deadline: '2026-11-01' }],
    ['a deadline too far ahead', { deadline: '2027-06-01' }],
    ['a date that is no date', { deadline: 'Friday' }],
    ['no reason only the person can act', { onlyPerson: 'Only them.' }],
    ['no question', { ask: '' }],
    ['one option', { options: [{ label: 'OK' }] }],
    ['five options', { options: ['a', 'b', 'c', 'd', 'e'].map((label) => ({ label })) }],
  ])('is left in Mail with %s', (_name, change) => {
    expect(personLetterVerdict({ subject: 'Quote request', reason: 'The harbour office needs it', ...CARD, ...change }, NOW))
      .toMatchObject({ send: false, kind: 'not_a_question' })
  })

  it('takes deadlines from today to the cap', () => {
    expect(validDeadline('2026-11-21', NOW)).toBe('2026-11-21')
    const last = new Date(NOW + (PERSON_DEADLINE_MAX_DAYS - 1) * 86400000).toISOString().slice(0, 10)
    expect(validDeadline(last, NOW)).toBe(last)
  })
})

/**
 * Every place under the router and the mail integrations that sends the person a letter. A new one
 * fails here until it is listed with why it is not a forward of a mail the person already has; the
 * router's own letter is checked to go only through the gate.
 */
describe('source ratchet: every letter path of the router and the mail intake', () => {
  const root = path.resolve(import.meta.dirname, '../..')
  const LETTER_SEND = /\b(sendLetterOnce|sendLetter|sendWalnutLetter)\s*\(|human_inbox_send|letters\.send\s*\(/
  const ALLOWED: Record<string, string> = {
    'src/core/router/service.ts': 'the router\'s question card, sent only with a card the person gate made',
    'src/core/router/account-intake.ts': 'Walnut\'s own notice that a mailbox has no router (no mail in it)',
    'src/integrations/mail/approvals.ts': 'an agent asks to send mail in the person\'s name (an outward send)',
    'src/integrations/mail/digest.ts': 'the daily digest the person turned on',
    'src/integrations/mail/unsubscribe.ts': 'an agent asks to unsubscribe in the person\'s name',
  }
  const walk = (dir: string): string[] => fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = `${dir}/${entry.name}`
    if (entry.isDirectory()) return walk(rel)
    return /\.(ts|tsx|mjs|js)$/.test(entry.name) && !/\.test\./.test(entry.name) ? [rel] : []
  })
  const dirs = ['src/core/router', 'src/integrations/mail', 'src/integrations/mail-imap'].filter((dir) => fs.existsSync(path.join(root, dir)))

  it('no file sends a letter unless it is listed with its reason', () => {
    const senders = dirs.flatMap(walk).filter((file) => LETTER_SEND.test(fs.readFileSync(path.join(root, file), 'utf8')))
    expect(senders.filter((file) => !ALLOWED[file])).toEqual([])
    // A listed file that stopped sending leaves the list.
    expect(Object.keys(ALLOWED).filter((file) => !senders.includes(file))).toEqual([])
  })

  it('the router sends its letter only with the gate\'s card, and the gate runs before any claim', () => {
    const src = fs.readFileSync(path.join(root, 'src/core/router/service.ts'), 'utf8')
    const calls = [...src.matchAll(/\(deps\.letter \?\? routerLetter\)\(([^)]*)\)/g)].map((m) => m[1]!)
    expect(calls.length).toBeGreaterThan(0)
    for (const args of calls) expect(args.trim().endsWith(', card')).toBe(true)
    // Each send sits behind a test that the card exists.
    expect(src).toMatch(/if \(previous && !input\.retry && card && previous\.letterPending\)/)
    expect(src).toMatch(/if \(!\(claimed\.fresh && card\)\)/)
    // The card is made only by the gate.
    expect([...src.matchAll(/\bcard = /g)]).toHaveLength(1)
    expect(src).toMatch(/if \(verdict\.send\) card = verdict\.card;/)
    expect(src.indexOf('personLetterVerdict(')).toBeLessThan(src.indexOf('store.claim('))
  })
})
