/**
 * The trial start's entry (src/core/trial-start/ticket.ts): without the argv flag nothing is
 * read, so no env var or stray file puts a server into the trial; with it, every part must hold
 * or the start is refused, so a drill's server never boots as a normal one.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  TRIAL_NONCE_ENV, TRIAL_START_FLAG, TRIAL_TICKET_FILE, TRIAL_TICKET_MAX_AGE_MS, TrialStartRefused, takeTrialTicket, writeTrialTicket,
} from '../../../src/core/trial-start/ticket.js'

let root: string
let home: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-ticket-'))
  home = path.join(root, 'walnut-restore-drill-Ab12Cd', 'home')
  fs.mkdirSync(home, { recursive: true })
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

const argv = ['bun', 'cli.ts', 'web', TRIAL_START_FLAG, '--_ephemeral-child']
const take = (over: Partial<Parameters<typeof takeTrialTicket>[0]> & { nonce?: string } = {}) => {
  const env: NodeJS.ProcessEnv = over.env ?? { [TRIAL_NONCE_ENV]: over.nonce }
  return takeTrialTicket({ home, argv, env, ppid: process.pid, ...over })
}

describe('without the argv flag nothing is read', () => {
  it('a stray nonce in the env and a ticket in the home leave a server as it was', () => {
    const nonce = writeTrialTicket(home, 'restore-drill')
    const env = { [TRIAL_NONCE_ENV]: nonce }
    expect(takeTrialTicket({ home, argv: ['bun', 'cli.ts', 'web'], env, ppid: process.pid })).toBeNull()
    // Not consumed either: it was not this process's.
    expect(fs.existsSync(path.join(home, TRIAL_TICKET_FILE))).toBe(true)
    expect(env[TRIAL_NONCE_ENV]).toBe(nonce)
  })
})

describe('with the flag', () => {
  it('a drill\'s ticket, its nonce and its pid: a restore-drill trial, and the ticket is used up', () => {
    const nonce = writeTrialTicket(home, 'restore-drill')
    const env: NodeJS.ProcessEnv = { [TRIAL_NONCE_ENV]: nonce }
    expect(take({ env })).toBe('restore-drill')
    expect(fs.existsSync(path.join(home, TRIAL_TICKET_FILE))).toBe(false)
    expect(env[TRIAL_NONCE_ENV]).toBeUndefined()
    // A second start on the same ticket is refused.
    expect(() => take({ nonce })).toThrow(/no ticket/)
  })

  it.each([
    ['no ticket', () => ({ nonce: 'x' }), /no ticket/],
    ['no nonce', () => { writeTrialTicket(home, 'restore-drill'); return { env: {} } }, /do not match/],
    ['another nonce', () => { const n = writeTrialTicket(home, 'restore-drill'); return { nonce: n.replace(/.$/, (c) => (c === '0' ? '1' : '0')) } }, /do not match/],
    ['another parent', () => ({ nonce: writeTrialTicket(home, 'restore-drill', process.pid + 1) }), /parent/],
    ['a stale ticket', () => ({ nonce: writeTrialTicket(home, 'restore-drill'), now: Date.now() + TRIAL_TICKET_MAX_AGE_MS + 1_000 }), /stale/],
    ['an unknown purpose', () => {
      const n = writeTrialTicket(home, 'restore-drill')
      const f = path.join(home, TRIAL_TICKET_FILE)
      fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, 'utf8')), purpose: 'normal' }))
      return { nonce: n }
    }, /no known purpose/],
  ] as const)('%s: refused', (_name, setup, why) => {
    const over = setup()
    expect(() => take(over)).toThrow(TrialStartRefused)
    expect(() => take(setup())).toThrow(why)
  })

  it('a home that is not a drill\'s copy is refused, ticket or not', () => {
    for (const other of [path.join(root, 'plain-home'), path.join(root, 'walnut-restore-drill-Ab12Cd', 'not-home'), path.join(root, 'walnut-restore-drill-toolong12', 'home')]) {
      fs.mkdirSync(other, { recursive: true })
      const nonce = writeTrialTicket(other, 'restore-drill')
      expect(() => takeTrialTicket({ home: other, argv, env: { [TRIAL_NONCE_ENV]: nonce }, ppid: process.pid }), other).toThrow(/not a restore drill's copy/)
    }
  })

  it('the user\'s data home is refused even when named like a drill copy (a link to it)', () => {
    const userHome = path.join(root, 'user')
    const prod = path.join(userHome, '.open-walnut')
    fs.mkdirSync(prod, { recursive: true })
    const linked = path.join(root, 'walnut-restore-drill-Zz99Yy')
    fs.mkdirSync(linked)
    fs.symlinkSync(prod, path.join(linked, 'home'))
    const nonce = writeTrialTicket(prod, 'restore-drill')
    const was = process.env.HOME
    process.env.HOME = userHome
    try {
      // The link resolves to ~/.open-walnut, which is not named like a drill copy: refused either way.
      expect(() => takeTrialTicket({ home: path.join(linked, 'home'), argv, env: { [TRIAL_NONCE_ENV]: nonce }, ppid: process.pid })).toThrow(TrialStartRefused)
    } finally {
      process.env.HOME = was
    }
  })
})
