import { describe, it, expect, vi, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'
vi.mock('../../src/constants.js', () => createMockConstants('cert-warning-store', { IS_EPHEMERAL: true }))
import { WALNUT_HOME } from '../../src/constants.js'
import { createCertExpiryAlert, certLetterHandedOff } from '../../src/core/hosts/ssh-cert-expiry-alert.js'
import { sendLetterOnce, listLetters, getLetter, agentReply, setArchived } from '../../src/core/human-inbox/store.js'
import { readCertificateWarning } from '../../src/core/sign-in-ask.js'

// Real inbox persistence and its operation-key dedupe, without a server or a real SSH process.
afterAll(async () => { await fs.rm(WALNUT_HOME, { recursive: true, force: true }) })

describe('certificate warning through the real inbox store', () => {
  it('the reported owner-without-letter state delivers one visible letter, including across a restart and expiry', async () => {
    const expiresAt = Date.parse('2026-11-14T07:20:29Z')
    let now = Date.parse('2026-11-14T02:10:00Z')
    const dir = path.join(WALNUT_HOME, 'local')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'sign-in-state.json'), JSON.stringify({ ok: true, owns: true, checkedAt: new Date(now).toISOString(), by: 'the sign-in plugin' }))
    const sender = { sessionId: 'external', host: 'local' }
    const deps = {
      hosts: async () => [{ host: 'dev', label: 'Dev box' }, { host: 'build', label: 'Build box' }],
      certExpiry: async () => expiresAt,
      freshSignIn: async () => ({ ok: false, error: 'Permission denied (publickey).' }),
      send: async (letter: { subject: string; markdown: string; opKey: string }) => (await sendLetterOnce({
        subject: letter.subject, markdown: letter.markdown, type: 'review', sender,
      }, { opKey: letter.opKey })).letter.id,
      addTurn: async (id: string, text: string) => { await agentReply(id, { text }, { sender }) },
      archive: async (ref: { letterId?: string }) => { if (ref.letterId) await setArchived(ref.letterId, true) },
      loginHint: async () => undefined,
      handedOff: (phase: 'ahead' | 'expired') => certLetterHandedOff(undefined, now, dir, phase),
      warningLetter: (expiry: number) => readCertificateWarning(expiry, now, dir),
      timeZone: () => 'America/Los_Angeles', online: () => true, now: () => now,
      statePath: path.join(dir, 'cert.json'), setTimer: () => ({ unref: () => {} }), clearTimer: () => {},
    }
    const alert = createCertExpiryAlert(deps)
    await Promise.all([alert.check(), alert.check()])
    const ep = JSON.parse(await fs.readFile(deps.statePath, 'utf8')).episode
    expect(ep.openedAt).toBe(now)
    const first = await getLetter(ep.letterId)
    expect(first?.archived).toBe(false)
    expect(first?.subject).toContain('expires at 2026-11-14 07:20 UTC')
    expect(first?.body).toContain('Dev box')
    expect(first?.body).toContain('Build box')
    expect((await listLetters()).letters.map(l => l.id)).toEqual([ep.letterId])
    now = expiresAt + 60_000
    const restarted = createCertExpiryAlert(deps)
    await restarted.check()
    await restarted.check()
    expect((await listLetters()).letters.map(l => l.id)).toEqual([ep.letterId])
    expect(JSON.parse(await fs.readFile(deps.statePath, 'utf8')).episode.expiredTold).toBe(true)
    expect(await restarted.joinLetter(['dev'])).toBe(ep.letterId)
  })
})
