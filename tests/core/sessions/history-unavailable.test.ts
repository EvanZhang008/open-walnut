/**
 * One wording for "this session's history cannot be shown"
 * (src/core/sessions/history-unavailable.ts). 2026-11-08: a session on a host
 * that was connected and had just answered read "Remote host ... is
 * unreachable", because its transcript was not found there.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const connected = vi.hoisted(() => ({ hosts: new Set<string>() }))
vi.mock('../../../src/providers/daemon-connection.js', () => ({
  isDaemonConnected: (host: string) => connected.hosts.has(host),
}))

import { unavailableHistoryReason } from '../../../src/core/sessions/history-unavailable.js'

describe('unavailableHistoryReason', () => {
  it('a connected host is never called unreachable', async () => {
    connected.hosts = new Set(['devbox'])
    expect(await unavailableHistoryReason({ engine: 'claude', host: 'devbox' } as never)).toBe('Session history file not found on "devbox"')
  })

  it('a host that is not connected is unreachable; this computer says file not found', async () => {
    connected.hosts = new Set()
    expect(await unavailableHistoryReason({ engine: 'claude', host: 'devbox' } as never)).toBe('Remote host "devbox" is unreachable — session history is stored on that machine')
    expect(await unavailableHistoryReason({ engine: 'claude' } as never)).toBe('Session history file not found')
    expect(await unavailableHistoryReason({ engine: 'claude', host: '__local__' } as never)).toBe('Session history file not found')
  })

  it('is the only place the words are written', () => {
    const root = path.resolve(__dirname, '../../../src')
    const found: string[] = []
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, e.name)
        if (e.isDirectory()) walk(file)
        else if (/\.ts$/.test(e.name) && /session history is stored on that machine|function unavailableHistoryReason/.test(fs.readFileSync(file, 'utf8'))) found.push(path.relative(root, file))
      }
    }
    walk(root)
    expect(found).toEqual(['core/sessions/history-unavailable.ts'])
  })
})
