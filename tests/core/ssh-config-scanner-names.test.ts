/**
 * The ssh config scanner (src/core/ssh-config-scanner.ts) lists every name of a Host line,
 * each with the block's settings, and never a pattern, a negation or what a Match block says.
 * First-run setup and Settings › Remote Hosts list what it finds.
 */
import { describe, expect, it, beforeEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { _resetScanCacheForTest, scanSshConfig } from '../../src/core/ssh-config-scanner.js'

async function scan(text: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ssh-scan-'))
  const file = path.join(dir, 'config')
  await fs.writeFile(file, text)
  try { return await scanSshConfig(file) } finally { await fs.rm(dir, { recursive: true, force: true }) }
}

describe('a Host line with several names', () => {
  beforeEach(() => _resetScanCacheForTest())

  it('lists each name, with the block settings applied to all', async () => {
    const hosts = await scan(['Host db-01 db-02', '  User sam', '  Port 2222', ''].join('\n'))
    expect([...hosts.keys()].sort()).toEqual(['db-01', 'db-02'])
    expect(hosts.get('db-02')).toMatchObject({ hostname: 'db-02', user: 'sam', port: 2222 })
  })

  it('a %h HostName gives each name its own machine; one fixed HostName is one machine', async () => {
    const own = await scan(['Host build-1 build-2', '  HostName %h.lab.example.test', ''].join('\n'))
    expect([...own.values()].map((h) => h.hostname).sort()).toEqual(['build-1.lab.example.test', 'build-2.lab.example.test'])
    const same = await scan(['Host box box-alias', '  HostName 10.0.0.5', ''].join('\n'))
    expect(same.size).toBe(1)
  })

  it('skips patterns, negations and Match blocks', async () => {
    const hosts = await scan(['Host web-1 *.corp !web-2 ?x', '  User a', 'Match host foo', '  User b', 'Host *', '  ServerAliveInterval 30', ''].join('\n'))
    expect([...hosts.keys()]).toEqual(['web-1'])
    expect(hosts.get('web-1')?.user).toBe('a')
  })
})
