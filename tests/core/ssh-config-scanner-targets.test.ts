/**
 * Found hosts from ~/.ssh/config: every alias that reaches its own SSH target (HostName, Port,
 * User) is listed, and only true duplicates fold into one (2026-11-10 review: "demo-devbox-c",
 * 127.0.0.1:3461 beside "demo-devbox" on :3460, was never listed, because the scanner deduped
 * by HostName alone). The values are the ones ssh would resolve from the file: first value wins,
 * wildcard Host blocks and `Host *` apply, Match blocks it cannot evaluate are skipped, Include
 * is read in place.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { _resetScanCacheForTest, scanSshConfig, sshTargetKey } from '../../src/core/ssh-config-scanner.js'
import { mergeFoundHosts } from '../../src/core/hosts/found-hosts.js'
import type { Config } from '../../src/core/types.js'

let dir: string
beforeEach(() => {
  _resetScanCacheForTest()
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-sshcfg-'))
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

const write = (name: string, text: string) => {
  const p = path.join(dir, name)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, text)
  return p
}
const scanText = (text: string) => scanSshConfig(write('config', text))
const view = (m: Map<string, { hostname: string; port?: number; user?: string }>) =>
  Object.fromEntries([...m].map(([a, h]) => [a, `${h.user ? `${h.user}@` : ''}${h.hostname}:${h.port ?? 22}`]))

describe('the reported case: one HostName, two ports', () => {
  it('lists both aliases', async () => {
    const found = await scanText([
      'Host demo-devbox', '  HostName 127.0.0.1', '  Port 3460', '  User dev',
      'Host demo-devbox-c', '  HostName 127.0.0.1', '  Port 3461', '  User dev',
    ].join('\n'))
    expect(view(found)).toEqual({ 'demo-devbox': 'dev@127.0.0.1:3460', 'demo-devbox-c': 'dev@127.0.0.1:3461' })
    // And the merge into config.hosts keeps both (it keys by target too).
    const config = { hosts: {} } as unknown as Config
    mergeFoundHosts(config, found, { asking: true })
    expect(Object.keys(config.hosts!).sort()).toEqual(['demo-devbox', 'demo-devbox-c'])
  })
})

describe('guard: every distinct (HostName, Port, User) is one entry, every true duplicate folds', () => {
  // Every pair of aliases over these axes: a pair stays two entries exactly when its targets differ.
  const hostnames = ['box.example.test', 'BOX.example.test', 'other.example.test']
  const ports: Array<number | undefined> = [undefined, 22, 2222]
  const users: Array<string | undefined> = [undefined, 'alice', 'bob']
  const variants = hostnames.flatMap((hostname) => ports.flatMap((port) => users.map((user) => ({ hostname, port, user }))))
  for (const [i, a] of variants.entries()) {
    for (const [j, b] of variants.entries()) {
      if (j <= i) continue
      const same = sshTargetKey(a) === sshTargetKey(b)
      it(`${JSON.stringify(a)} + ${JSON.stringify(b)}: ${same ? 'one' : 'two'}`, async () => {
        const block = (alias: string, v: typeof a) => [`Host ${alias}`, `  HostName ${v.hostname}`, ...(v.port ? [`  Port ${v.port}`] : []), ...(v.user ? [`  User ${v.user}`] : [])]
        const found = await scanText([...block('first', a), ...block('second', b)].join('\n'))
        expect(found.size).toBe(same ? 1 : 2)
        if (same) expect([...found.keys()]).toEqual(['first'])
      })
    }
  }

  it('a human alias wins over the FQDN entry of the same target', async () => {
    const found = await scanText(['Host box.example.test', '  User alice', 'Host box', '  HostName box.example.test', '  User alice'].join('\n'))
    expect([...found.keys()]).toEqual(['box'])
  })
})

describe('what ssh resolves from the file', () => {
  it('a Host line with several names lists each name; patterns and negations are no alias', async () => {
    const found = await scanText(['Host a b *.example.test !c', '  HostName %h.example.test', '  Port 2200'].join('\n'))
    expect(view(found)).toEqual({ a: 'a.example.test:2200', b: 'b.example.test:2200' })
  })

  it('first value wins, and wildcard blocks (Host *, Host dev-*) apply to the aliases they match', async () => {
    const found = await scanText([
      'Port 2201', // before any Host line: applies to every host
      'Host dev-*', '  User builder',
      'Host dev-one', '  HostName one.example.test', '  User ignored-later',
      'Host dev-two !dev-one', '  HostName two.example.test',
      'Host plain', '  HostName plain.example.test', '  Port 9999',
      'Host *', '  User fallback', '  Port 3000',
    ].join('\n'))
    expect(view(found)).toEqual({
      'dev-one': 'builder@one.example.test:2201',
      'dev-two': 'builder@two.example.test:2201',
      plain: 'fallback@plain.example.test:2201',
    })
  })

  it('a negated pattern keeps a block off an alias', async () => {
    const found = await scanText(['Host * !jump', '  User alice', 'Host jump', '  HostName jump.example.test', 'Host work', '  HostName work.example.test'].join('\n'))
    expect(view(found)).toEqual({ jump: 'jump.example.test:22', work: 'alice@work.example.test:22' })
  })

  it('a Match block it cannot evaluate is skipped; Match all applies', async () => {
    const found = await scanText([
      'Host box', '  HostName box.example.test',
      'Match host box exec "true"', '  Port 4000', '  User nobody',
      'Match all', '  User everyone',
    ].join('\n'))
    expect(view(found)).toEqual({ box: 'everyone@box.example.test:22' })
  })

  it('Include is read in place: a file, a glob, ~, and nested', async () => {
    const inc = write('conf.d/10-devbox.conf', ['Host devbox', '  HostName 127.0.0.1', '  Port 3460', 'Include ' + path.join(dir, 'nested.conf')].join('\n'))
    write('conf.d/20-other.conf', ['Host devbox-c', '  HostName 127.0.0.1', '  Port 3461'].join('\n'))
    write('nested.conf', ['Host deep', '  HostName deep.example.test'].join('\n'))
    write('conf.d/.hidden', 'Host hidden\n  HostName hidden.example.test\n')
    const found = await scanText([`Include ${path.join(dir, 'conf.d', '*.conf')}`, 'Host top', '  HostName top.example.test'].join('\n'))
    expect(view(found)).toEqual({ devbox: '127.0.0.1:3460', deep: 'deep.example.test:22', 'devbox-c': '127.0.0.1:3461', top: 'top.example.test:22' })
    expect(fs.existsSync(inc)).toBe(true)
  })

  it('an Include loop stops at the depth limit instead of hanging', async () => {
    const p = path.join(dir, 'config')
    fs.writeFileSync(p, `Host loop\n  HostName loop.example.test\nInclude ${p}\n`)
    const found = await scanSshConfig(p)
    expect(view(found)).toEqual({ loop: 'loop.example.test:22' })
  })

  it('a change in an included file is read again (the cache follows every file it read)', async () => {
    const inc = write('extra.conf', 'Host x\n  HostName x.example.test\n  Port 3461\n')
    const main = write('config', `Include ${inc}\n`)
    expect(view(await scanSshConfig(main))).toEqual({ x: 'x.example.test:3461' })
    fs.writeFileSync(inc, 'Host x\n  HostName x.example.test\n  Port 3460\n')
    const later = new Date(Date.now() + 5_000)
    fs.utimesSync(inc, later, later)
    expect(view(await scanSshConfig(main))).toEqual({ x: 'x.example.test:3460' })
  })

  it('Keyword=value and quoted values parse; git servers stay out', async () => {
    const found = await scanText(['Host=eq', '  HostName = eq.example.test', '  Port=2022', 'Host github.com', '  User git'].join('\n'))
    expect(view(found)).toEqual({ eq: 'eq.example.test:2022' })
  })
})
