/**
 * A letter never carries a credential (src/core/human-inbox/letter-credentials.ts).
 *
 * The 2026-11-12 case: a task wrote a Google OAuth client secret into its letter, the
 * letter was accepted, and the data-folder sync held its body file back (it scans for
 * credentials). Now sending runs the sync's own scan and refuses, and a letter written
 * before that can have the lines taken out. The class guard: for every kind of fake
 * credential below, a letter is refused exactly when the sync's scan flags its text, so
 * a rule added to the scan is refused at send time with no change here.
 *
 * Every fake is assembled at run time (the repo's own commit scan would refuse a literal).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants())

import {
  LetterError,
  agentReply,
  getLetter,
  humanInboxPaths,
  listLetters,
  redactLetterCredentials,
  sendLetter,
} from '../../src/core/human-inbox/store.js'
import { REDACTED_LINE, redactLetterLines } from '../../src/core/human-inbox/letter-credentials.js'
import { findSecretsInText } from '../../src/integrations/git-sync-secrets.js'
import type { LetterSender, NewLetter } from '../../src/core/human-inbox/types.js'

const SENDER: LetterSender = { sessionId: 'sess-cred1', sessionTitle: 'Backup', taskId: 'task-cred', taskTitle: 'Backup to Drive', host: 'workstation' }

let seed = 7
const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
const pick = (alphabet: string, n: number) => Array.from({ length: n }, () => alphabet[Math.floor(rand() * alphabet.length)]).join('')
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
const B64URL = ALNUM + '-_'

/** One fake per rule of the sync's scan, each shaped like the real thing. */
const FAKES: Record<string, () => string> = {
  'google-oauth-secret': () => ['GOC', 'SPX-', pick(B64URL, 28)].join(''),
  'google-api-key': () => ['AI', 'za', pick(B64URL, 35)].join(''),
  'github-token': () => ['gh', 'p_', pick(ALNUM, 36)].join(''),
  'aws-access-key': () => ['AK', 'IA', pick('ABCDEFGHIJKLMNOPQRSTUVWXYZ234567', 16)].join(''),
  'private-key': () => ['-----BEGIN ', 'RSA PRIVATE', ' KEY-----\n', pick(ALNUM + '+/', 64), '\n-----END RSA PRIVATE KEY-----'].join(''),
  jwt: () => ['ey', 'J', pick(B64URL, 30), '.ey', 'J', pick(B64URL, 60), '.', pick(B64URL, 43)].join(''),
  'oauth-token-field': () => `"client_${'secret'}": "${pick(ALNUM, 40)}"`,
  'url-credentials': () => `https://bot:${pick(ALNUM, 24)}@git.example-host.org/repo.git`,
}

/** Mentions that are not credentials: these letters go out. */
const CLEAN = [
  'The client ID and secret are in /home/me/.state/google-oauth-client.json (0600).',
  ['Set ', 'GOC', 'SPX-', '... in Settings'].join(''),
  'Client ID: 652270390918-abcdefghijklmnopqrstuvwxyz012345.apps.googleusercontent.com',
  `"refresh_token": "${'a'.repeat(60)}"`,
]

function letter(over: Partial<NewLetter> = {}): NewLetter {
  return { subject: 'Connect Google Drive', type: 'review', markdown: 'Press Connect, then Allow.', sender: SENDER, ...over }
}

async function refusal(p: Promise<unknown>): Promise<LetterError> {
  const err = await p.then(() => null, (e: unknown) => e)
  expect(err, 'the letter was accepted').toBeInstanceOf(LetterError)
  return err as LetterError
}

beforeEach(() => {
  fs.rmSync(humanInboxPaths.dir, { recursive: true, force: true })
})

describe('a letter with a credential is refused when it is sent', () => {
  it('the 2026-11-12 letter: a client secret in the body is refused, and nothing is written', async () => {
    const body = ['Fill in:', `- Client ID: \`652270390918-x.apps.googleusercontent.com\``, `- Client secret: \`${FAKES['google-oauth-secret']()}\``].join('\n')
    const err = await refusal(sendLetter(letter({ markdown: body })))
    expect(err.code).toBe('credential')
    expect(err.status).toBe(400)
    expect(err.message).toContain('google-oauth-secret in markdown, line 3')
    expect(err.message).toContain('say where it is kept instead')
    // The value itself is never echoed back.
    expect(err.message).not.toMatch(/GOC.?SPX-[A-Za-z0-9_-]{8}/)
    expect((await listLetters()).letters).toHaveLength(0)
    expect(fs.existsSync(humanInboxPaths.bodiesDir) ? fs.readdirSync(humanInboxPaths.bodiesDir) : []).toEqual([])
  })

  it('every field the sender writes is scanned: subject, preview text, html, an action, an item', async () => {
    const s = FAKES['github-token']
    for (const over of [
      { subject: `token ${s()}` },
      { text: `token ${s()}` },
      { markdown: undefined, html: `<p>${s()}</p>` },
      { type: 'action_required' as const, actions: [{ id: 'a', label: 'Use it', description: `with ${s()}` }] },
    ] as Array<Partial<NewLetter>>) {
      const err = await refusal(sendLetter(letter(over)))
      expect(err.code).toBe('credential')
    }
  })

  it('a reply in a letter\'s thread is refused the same way', async () => {
    const sent = await sendLetter(letter())
    const err = await refusal(agentReply(sent.id, { text: `Here: ${FAKES['aws-access-key']()}` }))
    expect(err.code).toBe('credential')
    expect(err.message).toMatch(/^This reply holds a credential/)
    const err2 = await refusal(agentReply(sent.id, { text: 'Details below', markdown: FAKES['private-key']() }))
    expect(err2.message).toContain('private-key in markdown')
    expect((await getLetter(sent.id))?.thread).toEqual([])
  })

  it('class guard: a letter is refused exactly when the sync\'s scan flags its text', async () => {
    const cases = [...Object.entries(FAKES).map(([kind, make]) => ({ kind, text: `Use this: ${make()}` })), ...CLEAN.map((text) => ({ kind: 'clean', text }))]
    for (const c of cases) {
      const flagged = findSecretsInText(c.text).length > 0
      expect(flagged, `${c.kind}: the sync scan and this list disagree`).toBe(c.kind !== 'clean')
      const outcome = await sendLetter(letter({ markdown: c.text })).then(() => 'sent', (e: LetterError) => e.code)
      expect(outcome, c.kind).toBe(flagged ? 'credential' : 'sent')
    }
  })
})

describe('a letter written before the check: its credential lines are taken out', () => {
  it('replaces the flagged lines in the body, records the new size, keeps the rest', async () => {
    const sent = await sendLetter(letter({ markdown: 'Step 1\n\nStep 2: paste the secret\n\nStep 3' }))
    // As the letter of 2026-11-12 was written: the body on disk holds the secret.
    const file = path.join(humanInboxPaths.bodiesDir, `${sent.id}.md`)
    const secret = FAKES['google-oauth-secret']()
    fs.writeFileSync(file, `Step 1\n- Client secret: \`${secret}\`\nStep 3`)
    expect(findSecretsInText(fs.readFileSync(file, 'utf-8'))).toHaveLength(1)

    const { lines, letter: after } = await redactLetterCredentials(sent.id)
    expect(lines).toBe(1)
    const text = fs.readFileSync(file, 'utf-8')
    expect(text).toBe(`Step 1\n${REDACTED_LINE}\nStep 3`)
    expect(text).not.toContain(secret)
    expect(findSecretsInText(text)).toEqual([])
    expect(after.bodyBytes).toBe(Buffer.byteLength(text, 'utf-8'))
    const index = JSON.parse(fs.readFileSync(humanInboxPaths.indexFile, 'utf-8'))
    expect(index.letters.find((l: { id: string }) => l.id === sent.id).bodyBytes).toBe(Buffer.byteLength(text, 'utf-8'))

    // Again: a clean letter changes nothing.
    expect((await redactLetterCredentials(sent.id)).lines).toBe(0)
    expect(fs.readFileSync(file, 'utf-8')).toBe(text)
  })

  it('a private key goes whole, BEGIN to END, not only its first line', () => {
    const out = redactLetterLines(`before\n${FAKES['private-key']()}\nafter`)
    expect(out.text).toBe(`before\n${REDACTED_LINE}\n${REDACTED_LINE}\n${REDACTED_LINE}\nafter`)
    expect(findSecretsInText(out.text)).toEqual([])
  })
})

describe('the rest of what a letter keeps', () => {
  it('a withdraw note or a settle reason with a credential is refused', async () => {
    const { withdrawLetter, settleLetter } = await import('../../src/core/human-inbox/store.js')
    const a = await sendLetter(letter({ type: 'action_required', actions: [{ id: 'ok', label: 'OK' }] }))
    expect((await refusal(withdrawLetter(a.id, { note: `moot, key ${FAKES['github-token']()}` }))).code).toBe('credential')
    expect((await refusal(settleLetter(a.id, { reason: `done ${FAKES['github-token']()}` }))).code).toBe('credential')
    expect((await getLetter(a.id))?.answered).toBeUndefined()
  })

  it('redaction cleans the index too: an action, an item, the person\'s answer', async () => {
    const sent = await sendLetter(letter({ type: 'action_required', actions: [{ id: 'ok', label: 'OK', description: 'plain' }] }))
    // As an index written before the check: a credential in the action description and the answer note.
    const index = JSON.parse(fs.readFileSync(humanInboxPaths.indexFile, 'utf-8'))
    const row = index.letters.find((l: { id: string }) => l.id === sent.id)
    row.actions[0].description = `with ${FAKES['github-token']()}`
    row.answered = { actionId: 'ok', label: 'OK', at: Date.now(), freeText: `here ${FAKES['github-token']()}` }
    fs.writeFileSync(humanInboxPaths.indexFile, JSON.stringify(index))
    const { lines } = await redactLetterCredentials(sent.id)
    expect(lines).toBe(2)
    expect(findSecretsInText(fs.readFileSync(humanInboxPaths.indexFile, 'utf-8'))).toEqual([])
  })
})
