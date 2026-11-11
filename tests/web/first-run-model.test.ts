/**
 * First-run setup's hosts step (web/src/components/first-run/first-run-model.ts): which
 * hosts it lists, what an added host's row says, and that every failure the person must
 * fix outside Walnut is walked through with commands, never left as a raw error.
 */
import { describe, expect, it } from 'vitest'
import type { Config } from '../../src/core/types'
import type { HostStatus } from '../../web/src/api/hosts'
import fs from 'node:fs'
import path from 'node:path'
import {
  addedRowState, addressOf, firstRunHostRows, offeredMethods, REMOTE_HOSTS_WORDS, walkthroughOf,
} from '../../web/src/components/first-run/first-run-model'

const hosts = {
  'lab-mac': { hostname: '10.0.0.9', user: 'sam', port: 2222, discovered: true, connect: 'ask', enabled: false },
  'quiet': { hostname: 'quiet.example.test', discovered: true, connect: 'not_now', enabled: false },
  devbox: { hostname: 'dev.example.test', label: 'Dev box', enabled: true },
  'found-yes': { hostname: 'yes.example.test', discovered: true, connect: 'yes', enabled: true },
  'turned-off': { hostname: 'off.example.test', enabled: false },
  'gpu-box': { hostname: 'gpu-box', transport: 'net' },
} as unknown as Config['hosts']

// Every kind a connect failure can carry, read from the source, so a new kind is checked here too.
const HOST_FAILURE_KINDS: string[] = (() => {
  const src = fs.readFileSync(path.join(__dirname, '../../src/core/sessions/host-connect-hint.ts'), 'utf8')
  const union = /export type HostConnectErrorKind =([\s\S]*?)\n\n/.exec(src)?.[1] ?? ''
  return [...union.matchAll(/\|\s*'([a-z_]+)'/g)].map((m) => m[1])
})()

const status = (over: Partial<HostStatus>): HostStatus => ({
  host: 'lab-mac', label: 'lab-mac', hostname: '10.0.0.9', connected: false, phase: 'idle', phaseLabel: '',
  steps: [], phaseElapsedMs: 0, connectElapsedMs: 0, at: 1, ...over,
})

describe('firstRunHostRows', () => {
  it('lists the hosts in the ssh config order, waiting and added alike, never a turned-off or non-SSH host', () => {
    const rows = firstRunHostRows(hosts)
    expect(rows.map((r) => [r.alias, r.waits])).toEqual([
      ['lab-mac', true], ['quiet', true], ['devbox', false], ['found-yes', false],
    ])
    // An added host keeps its place: a reload shows it where it was.
    const mixed = { a: { hostname: 'a.test', discovered: true, connect: 'yes', enabled: true }, b: { hostname: 'b.test', discovered: true, connect: 'ask', enabled: false } } as unknown as Config['hosts']
    expect(firstRunHostRows(mixed).map((r) => r.alias)).toEqual(['a', 'b'])
    expect(rows.find((r) => r.alias === 'devbox')?.name).toBe('Dev box')
    expect(firstRunHostRows(undefined)).toEqual([])
  })
  it('writes the address the way ssh dials it', () => {
    expect(addressOf({ hostname: '10.0.0.9', user: 'sam', port: 2222 })).toBe('sam@10.0.0.9:2222')
    expect(addressOf({ hostname: 'h', port: 22 })).toBe('h')
  })
})

describe('walkthroughOf', () => {
  it('a host that asks for a password: make a key, copy it with ssh-copy-id, try again', () => {
    const w = walkthroughOf('auth', 'lab-mac', 'Lab Mac', 'sam@10.0.0.9: Permission denied (publickey,password,keyboard-interactive).')!
    expect(w.headline).toBe('Lab Mac needs a one-time setup')
    expect(w.lead).toContain('asks for a password')
    expect(w.steps.map((s) => s.command).filter(Boolean)).toEqual(['ssh-keygen -t ed25519', 'ssh-copy-id lab-mac'])
  })
  it('a host that takes keys only: show the key to add there', () => {
    expect(offeredMethods('Permission denied (publickey).')).toEqual(['publickey'])
    const w = walkthroughOf('auth', 'lab-mac', 'Lab Mac', 'Permission denied (publickey).')!
    expect(w.lead).toContain('takes no password')
    expect(w.steps.map((s) => s.command).filter(Boolean)).toEqual(['ssh-keygen -t ed25519', 'cat ~/.ssh/id_ed25519.pub', 'ssh lab-mac'])
  })
  it('uses the key ssh really offers that host, and makes it only when it is missing', () => {
    const denied = 'Permission denied (publickey,password).'
    const have = walkthroughOf('auth', 'lab-mac', 'Lab Mac', denied, { path: '~/.ssh/lab key', exists: true })!
    expect(have.steps.map((s) => s.command).filter(Boolean)).toEqual([`ssh-copy-id -i ~/'.ssh/lab key' lab-mac`])
    const missing = walkthroughOf('auth', 'lab-mac', 'Lab Mac', denied, { path: '~/.ssh/lab', exists: false })!
    expect(missing.steps.map((s) => s.command).filter(Boolean)).toEqual(['ssh-keygen -t ed25519 -f ~/.ssh/lab', 'ssh-copy-id -i ~/.ssh/lab lab-mac'])
    const keysOnly = walkthroughOf('auth', 'lab-mac', 'Lab Mac', 'Permission denied (publickey).', { path: '~/.ssh/lab', exists: true })!
    expect(keysOnly.steps[0].command).toBe('cat ~/.ssh/lab.pub')
    expect(walkthroughOf('agent_missing', 'lab-mac', 'Lab Mac', '', { path: '~/.ssh/lab', exists: true })!.steps[0].command).toBe('ssh-add ~/.ssh/lab')
  })
  it('a host that does not answer, refuses or cannot be found reads as plain words, no commands', () => {
    for (const kind of ['timeout', 'unreachable', 'refused', 'dns']) {
      const w = walkthroughOf(kind, 'lab-mac', 'Lab Mac', '', null, 2222)!
      expect(w.steps).toEqual([])
      expect(w.lead).toContain('Try again')
      expect(`${w.headline} ${w.lead}`).not.toMatch(/daemon|Retry\b/)
    }
    expect(walkthroughOf('refused', 'lab-mac', 'Lab Mac', '', null, 2222)!.lead).toContain('port 2222')
  })
  it('a machine that is not Linux: how to add it instead, no commands', () => {
    const w = walkthroughOf('not_linux', 'mac-mini', 'Mac mini')!
    expect(w.headline).toBe('Mac mini is not a Linux machine')
    expect(w.lead).toContain('Join a machine with a link')
    expect(w.steps).toEqual([])
  })
  it('in Remote Hosts every walkthrough names that row\'s own buttons, never the dialog\'s Try again', () => {
    for (const kind of ['auth', 'agent_missing', 'timeout', 'unreachable', 'refused', 'dns', 'not_linux']) {
      const w = walkthroughOf(kind, 'lab-mac', 'Lab Mac', 'sam@lab: Permission denied (publickey,password).', null, 22, REMOTE_HOSTS_WORDS)!
      const all = [w.headline, w.lead, ...w.steps.map((s) => s.text)].join(' ')
      expect(all, kind).not.toContain('Try again')
      if (kind === 'not_linux') expect(w.lead).toContain('press Join with a link')
      else expect(all, kind).toContain('Retry SSH')
    }
  })
  it('a key not loaded: ssh-add', () => {
    expect(walkthroughOf('agent_missing', 'lab-mac', 'Lab Mac')!.steps[0].command).toBe('ssh-add')
  })
  it('every failure kind reads as either a walkthrough or the server hint, never only the raw error', () => {
    expect(HOST_FAILURE_KINDS.length).toBeGreaterThan(15)
    for (const kind of HOST_FAILURE_KINDS) {
      const s = addedRowState(
        { alias: 'lab-mac', name: 'Lab Mac', address: '10.0.0.9', waits: false },
        status({ phase: 'failed', kind, hint: `hint for ${kind}`, error: 'raw ssh words' }), 1,
      )
      if (kind === 'ephemeral') { expect(s.type).toBe('off'); continue }
      expect(s.type).toBe('failed')
      if (s.type !== 'failed') continue
      expect(s.headline.length).toBeGreaterThan(0)
      expect(s.walkthrough !== null || s.hint === `hint for ${kind}`).toBe(true)
    }
  })
})

describe('addedRowState', () => {
  const row = { alias: 'lab-mac', name: 'Lab Mac', address: '10.0.0.9', waits: false }
  it('no status yet, or a dial in flight: Connecting with the phase words', () => {
    expect(addedRowState(row, undefined, 1)).toEqual({ type: 'connecting', words: 'Connecting…' })
    expect(addedRowState(row, status({ phase: 'upload', phaseLabel: 'Uploading the session daemon' }), 1))
      .toEqual({ type: 'connecting', words: 'Uploading the session daemon' })
  })
  it('connected says so, with the shared words', () => {
    expect(addedRowState(row, status({ connected: true, phase: 'connected' }), 1)).toEqual({ type: 'connected', words: 'Connected' })
  })
  it('a test server that dials no host says so plainly', () => {
    expect(addedRowState(row, status({ phase: 'off' }), 1).type).toBe('off')
  })
  it('a failure coming back keeps its fix on screen', () => {
    const s = addedRowState(row, status({ phase: 'reconnecting', lastError: 'Permission denied (password).', lastKind: 'auth', lastHint: 'h' }), 1)
    expect(s.type).toBe('failed')
    if (s.type === 'failed') expect(s.walkthrough?.steps.some((x) => x.command === 'ssh-copy-id lab-mac')).toBe(true)
  })
})
