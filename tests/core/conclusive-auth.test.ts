/**
 * An inconclusive sign-in re-check never replaces a definite answer
 * (host-readiness-problems.ts withConclusiveAuth). 2026-11-08: on a loaded Mac
 * one `auth: unknown` re-check after repeated "not signed in" answers flipped the
 * setup card from "Sign in to Claude Code" to "could not confirm" with no input.
 * Both writers of a fresh preflight answer (this machine, a remote host) are
 * driven here, and the guard fails on a new writer that skips the rule.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-conclusive-auth'))

import { AUTH_CARRY_MS, withConclusiveAuth } from '../../src/core/hosts/host-readiness-problems.js'
import { refreshLocalClaude, setLocalClaudeIo } from '../../src/core/hosts/local-readiness.js'
import { clearHostReadiness, getHostReadiness, refreshHostReadiness, type PreflightConnection } from '../../src/core/hosts/host-readiness.js'
import type { HostPreflightResult } from '../../src/providers/host-runtime-core.js'

const BIN = '/Users/dev/.local/bin/claude'
const base = (auth: 'ok' | 'not-logged-in' | 'unknown', over: Record<string, unknown> = {}): HostPreflightResult => ({
  claude: { found: true, path: BIN, kind: 'native', needsNode: false, version: '2.1.319', auth, installMethod: 'native', ...over },
  compiler: { found: true, name: 'cc' }, dtach: { found: true, path: '/usr/bin/dtach' }, platform: 'darwin', arch: 'arm64',
})

describe('withConclusiveAuth', () => {
  it('stamps a definite answer, and carries it over an unknown for the same CLI', () => {
    const first = withConclusiveAuth(base('not-logged-in'), undefined, 1_000)
    expect(first.claude).toMatchObject({ auth: 'not-logged-in', authAt: 1_000 })
    const next = withConclusiveAuth(base('unknown', { authDetail: 'the keychain did not say' }), first.claude, 16_000)
    expect(next.claude).toMatchObject({ auth: 'not-logged-in', authAt: 1_000 })
    expect(next.claude.authDetail).toBeUndefined()
  })

  it('keeps the earlier detail of an ok answer', () => {
    const ok = withConclusiveAuth(base('ok', { authDetail: 'a Claude account' }), undefined, 0)
    expect(withConclusiveAuth(base('unknown'), ok.claude, 5_000).claude).toMatchObject({ auth: 'ok', authDetail: 'a Claude account' })
  })

  it('lets the unknown through past the hold, for another CLI, a new version, or with no definite answer before', () => {
    const prev = withConclusiveAuth(base('not-logged-in'), undefined, 0).claude
    expect(withConclusiveAuth(base('unknown'), prev, AUTH_CARRY_MS).claude.auth).toBe('unknown')
    expect(withConclusiveAuth(base('unknown', { path: '/opt/claude' }), prev, 1).claude.auth).toBe('unknown')
    expect(withConclusiveAuth(base('unknown', { version: '2.1.320' }), prev, 1).claude.auth).toBe('unknown')
    expect(withConclusiveAuth(base('unknown'), base('unknown').claude, 1).claude.auth).toBe('unknown')
    expect(withConclusiveAuth(base('unknown'), { ...prev, authAt: undefined }, 1).claude.auth).toBe('unknown')
  })

  it('a newer definite answer always wins, and a missing CLI is never given a sign-in', () => {
    const prev = withConclusiveAuth(base('not-logged-in'), undefined, 0).claude
    expect(withConclusiveAuth(base('ok'), prev, 1).claude).toMatchObject({ auth: 'ok', authAt: 1 })
    expect(withConclusiveAuth({ ...base('unknown'), claude: { found: false } }, prev, 1).claude).toEqual({ found: false })
  })
})

describe('the writers of a fresh answer', () => {
  beforeEach(() => { setLocalClaudeIo(); clearHostReadiness() })

  it('this machine: the setup card keeps "not signed in" through an unknown re-check', async () => {
    const answers = [base('not-logged-in'), base('unknown')]
    let t = 1_000
    setLocalClaudeIo({
      onDaemonConnected: () => () => {}, now: () => t, floor: async () => null,
      preflight: async () => ({ result: structuredClone(answers.shift()!), source: 'daemon' }),
    })
    expect((await refreshLocalClaude())!.problems.map((p) => p.kind)).toEqual(['claude_not_logged_in'])
    t += 15_000
    const again = (await refreshLocalClaude())!
    expect(again.problems.map((p) => p.kind)).toEqual(['claude_not_logged_in'])
    expect(again).toMatchObject({ checkedAt: 16_000, claude: { auth: 'not-logged-in' } })
  })

  it('a remote host: the same', async () => {
    const replies = [{ ok: true, ...base('not-logged-in') }, { ok: true, ...base('unknown') }]
    const conn: PreflightConnection = { hasCapability: () => true, send: async () => replies.shift() as { ok: boolean } }
    await refreshHostReadiness('devbox', { getConnection: () => conn, now: () => 1_000, autofix: false })
    await refreshHostReadiness('devbox', { getConnection: () => conn, now: () => 16_000, autofix: false, force: true })
    expect(getHostReadiness('devbox', 16_000)).toMatchObject({ checkedAt: 16_000, claude: { auth: 'not-logged-in' } })
    expect(getHostReadiness('devbox', 16_000)!.problems.map((p) => p.kind)).toContain('claude_not_logged_in')
  })
})

describe('guard: every writer of a fresh preflight answer applies the rule', () => {
  // A fresh answer enters through applyClaudeFloor (the floor is judged on every new answer).
  const EXEMPT: Record<string, string> = {
    'src/core/diagnostics/doctor.ts': 'a one-shot report with no earlier answer to keep',
    'src/core/hosts/host-readiness-problems.ts': 'defines both helpers',
  }
  const root = path.resolve(__dirname, '../..')
  const files: string[] = []
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name)
      if (e.isDirectory()) walk(f)
      else if (f.endsWith('.ts')) files.push(f)
    }
  }
  walk(path.join(root, 'src'))
  const writers = files.map((f) => path.relative(root, f)).filter((rel) => /applyClaudeFloor\(/.test(fs.readFileSync(path.join(root, rel), 'utf8')))

  it('finds the writers it knows', () => {
    expect(writers).toEqual(expect.arrayContaining(['src/core/hosts/local-readiness.ts', 'src/core/hosts/host-readiness.ts']))
  })

  it.each(writers.filter((w) => !EXEMPT[w]))('%s calls withConclusiveAuth', (rel) => {
    expect(fs.readFileSync(path.join(root, rel), 'utf8')).toMatch(/withConclusiveAuth\(applyClaudeFloor\(/)
  })
})
