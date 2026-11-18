import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'
vi.mock('../../src/constants.js', () => createMockConstants('credential-ask-store', { IS_EPHEMERAL: true }))
import { WALNUT_HOME } from '../../src/constants.js'
import { saveConfig } from '../../src/core/config-manager.js'
import { sendLetterOnce, listLetters, getLetter, setArchived } from '../../src/core/human-inbox/store.js'
import type { NewLetter } from '../../src/core/human-inbox/types.js'

function input(host = '__local__', kind: 'ssh-certificate' | 'login-cookie' = 'ssh-certificate', expiresAt = 1000, sender = 'external'): NewLetter {
  return { subject: `Renew ${kind} on ${host}`, type: 'review', markdown: `Renew the ${kind} on ${host}.`,
    credentialAsk: { host, kind, expiresAt }, sender: { sessionId: sender, host: 'local' } }
}
beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  await saveConfig({ ssh_login_hint: 'run acmelogin on the Mac', hosts: { cloudbox: { hostname: 'box.example.test', label: 'Cloud workstation', user: 'dev' } } } as never)
})

describe('credential asks share the inbox write lock across every sender', () => {
  it('concurrent core, task and plugin sends create one letter, regardless of their words or op keys', async () => {
    const all = await Promise.all([
      sendLetterOnce(input(), { opKey: 'core:expiry' }),
      sendLetterOnce({ ...input(), subject: 'The local certificate stopped working' }, { opKey: 'task:other' }),
      sendLetterOnce({ ...input(), sender: { sessionId: 'external', host: 'local', pluginId: 'fixture-login' } }),
    ])
    expect(new Set(all.map(out => out.letter.id)).size).toBe(1)
    expect(all.filter(out => !out.duplicate)).toHaveLength(1)
    expect((await listLetters()).letters).toHaveLength(1)
    expect((await getLetter(all[0]!.letter.id))?.credentialAsk).toEqual({ host: '__local__', kind: 'ssh-certificate', expiresAt: 1000 })
  })
  it('same destination does not merge credentials stored on two machines or two kinds on one machine', async () => {
    await sendLetterOnce(input())
    await sendLetterOnce(input('cloudbox'))
    await sendLetterOnce(input('cloudbox', 'login-cookie'))
    expect((await listLetters()).letters).toHaveLength(3)
  })
  it('old prose callers identify the renewal location and fold into an existing typed core letter', async () => {
    const first = await sendLetterOnce(input())
    const again = await sendLetterOnce({ subject: 'SSH certificate expired', type: 'review', markdown: 'Please run acmelogin on the Mac.', sender: { sessionId: 'task-other', host: 'cloudbox' } })
    expect(again.duplicate).toBe(true)
    expect(again.letter.id).toBe(first.letter.id)
  })
  it('an older core record without identity still folds a later task asking for the same local certificate', async () => {
    const first = await sendLetterOnce({ subject: 'Old target certificate expired', type: 'review', markdown: 'Renew on this computer.', sender: { sessionId: 'external', host: 'local' } }, { opKey: 'ssh-cert-expiry:1000' })
    const later = await sendLetterOnce(input())
    expect(later.letter.id).toBe(first.letter.id)
    expect((await listLetters()).letters).toHaveLength(1)
  })

  it('an unknown-expiry old ask is updated and made unread once when the core knows this certificate expiry', async () => {
    const old = input(); delete old.credentialAsk!.expiresAt;
    const first = await sendLetterOnce(old);
    const all = await Promise.all([sendLetterOnce(input()), sendLetterOnce(input())]);
    expect(new Set(all.map(out => out.letter.id))).toEqual(new Set([first.letter.id]));
    const detail = await getLetter(first.letter.id);
    expect(detail?.credentialAsk?.expiresAt).toBe(1000);
    expect(detail?.thread).toHaveLength(1);
    expect(detail?.thread[0]?.body).toContain('ssh-certificate');
    expect(detail?.read).toBe(false);
  })

  it('archive and restart-normalization do not repeat the same known expiry, but renewal creates a new one', async () => {
    const first = await sendLetterOnce(input())
    await setArchived(first.letter.id, true)
    expect((await sendLetterOnce(input(), { opKey: 'retry:different' })).letter.id).toBe(first.letter.id)
    const next = await sendLetterOnce(input('__local__', 'ssh-certificate', 2000))
    expect(next.letter.id).not.toBe(first.letter.id)
    expect((await listLetters()).letters).toHaveLength(1)
  })
})
