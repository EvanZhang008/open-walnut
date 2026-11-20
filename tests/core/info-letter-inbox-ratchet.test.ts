/**
 * An info letter enters the inbox only when it is a report the user asked for (2026-11-20, the user
 * on a plugin letter "Slack: 1 new (0 mentions, 1 DM)" marked info: "why send me this";
 * src/core/human-inbox/info-letter-rule.ts).
 *
 *   (a) the store refuses one without the mark, and nothing is added to the inbox: the one check
 *       every path meets;
 *   (b) every letter send site in src/ is listed here with how it meets the rule, read from the
 *       source: a new site fails until it is decided;
 *   (c) a site that writes a literal info letter itself also marks it as asked, and every Walnut
 *       letter kind of type info says when it is asked and where it goes otherwise.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants())

import { LetterError, humanInboxPaths, listLetters, sendLetterOnce } from '../../src/core/human-inbox/store.js'
import { WALNUT_LETTER_KINDS } from '../../src/core/human-inbox/walnut-letters/registry.js'
import { noticeSubjectKey, passesInfoRule } from '../../src/core/human-inbox/info-letter-rule.js'
import type { NewLetter } from '../../src/core/human-inbox/types.js'

const ROOT = path.resolve(__dirname, '../..')

function sources(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, e.name)
    if (e.isDirectory()) out.push(...sources(rel))
    else if (/\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(rel)
  }
  return out
}

/** The code without its comments, so a sentence about a letter is not a send. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
}

/** Every way a letter is written: the store's writers, the session entry point, the plugin API. */
const SEND = /(?<![\w.])sendLetter(Once)?\s*\(|\bstore\.sendLetter(Once)?\s*\(|\bsendLetterAsCaller(Once)?\s*\(|\bletters\.send\s*\(/
const files = sources('src').map((f) => ({ f, text: code(fs.readFileSync(path.join(ROOT, f), 'utf8')) }))
const sendSites = files.filter(({ text }) => SEND.test(text)).map(({ f }) => f).sort()

/** How each send site meets the info rule. */
const SITES: Record<string, string> = {
  'src/core/human-inbox/store.ts': 'the choke point: sendLetterOnce refuses an info letter without userAsked (409 info_not_inbox)',
  'src/core/human-inbox/letter-ops.ts': 'a caller\'s letter: a session\'s info letter is refused, a script\'s becomes a notice',
  'src/web/routes/human-inbox-v1.ts': 'POST /api/v1/human-inbox: through sendLetterAsCallerOnce, after a thread filing',
  'src/core/human-inbox/relay.ts': 'a replica\'s relay: through sendLetterAsCallerOnce, after a thread filing',
  'src/core/offline-merge/apply-letter.ts': 'a host\'s journal replay: through sendLetterAsCallerOnce; a refusal is the session\'s',
  'src/core/plugins/plugin-letters.ts': 'walnut.letters.send: a letter with no actions and no userAsked becomes a notice of the plugin',
  'src/core/org/morning-report.ts': 'the org report the user asked for (org_report): userAsked',
  'src/integrations/mail/digest.ts': 'the mail plugin: the daily run becomes a notice, "Send it now" is userAsked',
  'src/integrations/mail/approvals.ts': 'the mail plugin\'s approval: a letter with actions',
  'src/integrations/mail/unsubscribe.ts': 'the mail plugin\'s unsubscribe ask: a letter with actions',
  'src/core/router/service.ts': 'a router\'s for_user letter: review',
  'src/core/router/account-intake.ts': 'a router intake letter: review',
  'src/core/usage/session-budget.ts': 'budget paused: review (its kind)',
  'src/core/hosts/ssh-cert-expiry-alert.ts': 'ssh certificate expiry: review (its kind)',
  'src/core/hosts/local-network-alert.ts': 'local network blocked: review (its kind)',
  'src/core/hosts/host-auth-alert.ts': 'host sign-in: review (its kind)',
  'src/core/hosts/host-exec-grant.ts': 'host exec ask: action_required (its kind)',
  'src/core/offline-merge/letter.ts': 'offline conflicts: review',
}

beforeEach(() => {
  fs.rmSync(humanInboxPaths.dir, { recursive: true, force: true })
})

const info = (over: Partial<NewLetter> = {}): NewLetter => ({
  subject: 'Chat app: 1 new (0 mentions, 1 DM)',
  type: 'info',
  markdown: 'One new direct message.',
  sender: { sessionId: 'external', host: 'local', pluginId: 'chat-app' },
  ...over,
})

describe('(a) the store takes an info letter only when the user asked for it', () => {
  it('an info letter with no mark is refused and never listed', async () => {
    const before = (await listLetters()).letters.length
    const err = await sendLetterOnce(info()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LetterError)
    expect((err as LetterError).code).toBe('info_not_inbox')
    expect((err as LetterError).status).toBe(409)
    expect((err as LetterError).message).toMatch(/user_asked:true/)
    expect((await listLetters()).letters).toHaveLength(before)
    // No body file was left behind for it either.
    const bodies = path.join(humanInboxPaths.dir, 'bodies')
    expect(fs.existsSync(bodies) ? fs.readdirSync(bodies) : []).toEqual([])
  })

  it('user_asked:false, a pin or a journal op key do not count as asked', async () => {
    for (const over of [{ user_asked: false }, { pin: true }, { userAsked: false }] as Partial<NewLetter>[]) {
      await expect(sendLetterOnce(info(over))).rejects.toMatchObject({ code: 'info_not_inbox' })
    }
    await expect(sendLetterOnce(info(), { opKey: 'op-info-0001' })).rejects.toMatchObject({ code: 'info_not_inbox' })
    expect((await listLetters()).letters).toEqual([])
  })

  it('the same letter the user asked for lands, either spelling', async () => {
    const a = await sendLetterOnce(info({ userAsked: true }))
    const b = await sendLetterOnce(info({ subject: 'Daily digest', user_asked: true }))
    const ids = (await listLetters()).letters.map((l) => l.id)
    expect(ids).toEqual(expect.arrayContaining([a.letter.id, b.letter.id]))
    // The mark is never stored on the letter.
    expect(Object.keys(a.letter)).not.toContain('userAsked')
  })

  it('other types are unchanged', async () => {
    await sendLetterOnce(info({ type: 'review', subject: 'Review this' }))
    await sendLetterOnce(info({ type: 'completion', subject: 'Done' }))
    expect((await listLetters()).letters).toHaveLength(2)
  })

  it('passesInfoRule reads the rule the same way', () => {
    expect(passesInfoRule({ type: 'info' })).toBe(false)
    expect(passesInfoRule({ type: 'info', user_asked: true })).toBe(true)
    expect(passesInfoRule({ type: 'review' })).toBe(true)
  })

  it('a notice key folds counts, so a newer count replaces the last', () => {
    expect(noticeSubjectKey('Chat app: 1 new (0 mentions, 1 DM)')).toBe(noticeSubjectKey('Chat app: 12 new (3 mentions, 2 DM)'))
    expect(noticeSubjectKey('Chat app: 1 new')).not.toBe(noticeSubjectKey('Mail digest: 1 unread'))
  })
})

describe('(b) every letter send site is decided for the info rule', () => {
  it('finds the send sites at all', () => {
    expect(sendSites).toEqual(expect.arrayContaining(['src/core/human-inbox/store.ts', 'src/core/plugins/plugin-letters.ts']))
  })

  it('each one is listed with how it meets the rule', () => {
    expect(sendSites.filter((f) => !(f in SITES)),
      'A new letter send site: say how it meets the info rule (src/core/human-inbox/info-letter-rule.ts) in SITES').toEqual([])
    expect(Object.keys(SITES).filter((f) => !sendSites.includes(f)), 'a listed site that no longer sends').toEqual([])
  })

  it('the store checks the rule before it adds the letter', () => {
    const store = code(fs.readFileSync(path.join(ROOT, 'src/core/human-inbox/store.ts'), 'utf8'))
    expect(store).toMatch(/async function sendLetterOnce[\s\S]*?passesInfoRule\(input\)[\s\S]*?store\.letters\.push\(record\)/)
  })

  it('a session\'s path checks it before its letter could join an away thread', () => {
    const ops = code(fs.readFileSync(path.join(ROOT, 'src/core/human-inbox/letter-ops.ts'), 'utf8'))
    expect(ops).toMatch(/async function sendLetterAsCallerOnce[\s\S]*?passesInfoRule\(input\)[\s\S]*?sendAway\(/)
  })

  it('a plugin letter with no actions and no userAsked never reaches the store', () => {
    const plugin = code(fs.readFileSync(path.join(ROOT, 'src/core/plugins/plugin-letters.ts'), 'utf8'))
    expect(plugin).toMatch(/!input\.actions\?\.length && input\.userAsked !== true[\s\S]*?sendInfoNotice\([\s\S]*?return[\s\S]*?sendLetter\(/)
  })
})

describe('(c) Walnut\'s own info letters say when the user asked for them', () => {
  it('a site writing a literal info letter marks it asked', () => {
    for (const f of sendSites) {
      const text = files.find((x) => x.f === f)!.text
      if (/type:\s*'info'/.test(text)) expect(text, `${f} writes an info letter without userAsked`).toMatch(/userAsked:\s*true/)
    }
  })

  it('every info kind declares when it is asked and where it goes otherwise', () => {
    for (const kind of WALNUT_LETTER_KINDS.filter((k) => k.type === 'info')) {
      expect(kind.info, `${kind.id}: declare info { asked, otherwise }`).toBeDefined()
      expect(kind.info!.asked.length, kind.id).toBeGreaterThan(15)
      expect(kind.info!.otherwise.length, kind.id).toBeGreaterThan(3)
    }
    for (const kind of WALNUT_LETTER_KINDS.filter((k) => k.type !== 'info')) expect(kind.info, `${kind.id} is not an info kind`).toBeUndefined()
  })
})
