/**
 * One machine is one choice wherever hosts are listed for a person to pick from.
 * 2026-11-03: a Mac found in ~/.ssh/config (`studio-mac`, ssh) and the same Mac joined over
 * the host network (`Studio-MacBook`) were two rows in the session host picker, the
 * phone's launcher, transfers, the import projects and Settings. pickableHosts() is the
 * list; the last block keeps a new place that lists config.hosts from skipping the choice.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { joinedAliasOf, pickableHosts } from '../../../src/core/hosts/joined-twins.js'

const ROOT = path.resolve(__dirname, '../../..')
const MAC = 'a'.repeat(64)
const hosts = {
  'studio-mac': { hostname: '10.20.30.40', discovered: true },
  'Studio-MacBook': { hostname: 'Studio-MacBook.walnut-net.invalid', label: 'Studio-MacBook', transport: 'net', endpoint: MAC },
  devbox: { hostname: 'dev.example.com' },
  old: { hostname: 'old.example.com', enabled: false },
}
const net = { enabled: true, where: { [MAC]: { self: ['10.20.30.40:62955'] } } }
/** A walk over config.hosts (entries, keys or values; `config.`, `cfg.`, `c.` or `this.config.`, optional chaining too). */
const WALKS = /Object\.(?:entries|keys|values)\((?:\(?(?:config|cfg|c|this\.config)\??\.|\(await getConfig\(\)\)\??\.)?hosts(?:Cfg)?\b/

describe('pickableHosts', () => {
  it('lists each machine once and leaves out a host that is off', () => {
    expect(pickableHosts(hosts, net).map(([a]) => a)).toEqual(['Studio-MacBook', 'devbox'])
  })

  it('with no joined machine, every enabled row', () => {
    expect(pickableHosts(hosts, undefined).map(([a]) => a)).toEqual(['studio-mac', 'Studio-MacBook', 'devbox'])
  })

  it('a folder used on the found row is read as the joined machine\'s', () => {
    const asJoined = joinedAliasOf(hosts, net)
    expect([asJoined('studio-mac'), asJoined('devbox'), asJoined(null), asJoined('gone')]).toEqual(['Studio-MacBook', 'devbox', null, 'gone'])
  })
})

/** Source files under `dir` (no tests, no generated output). */
function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return e.name === 'node_modules' || e.name === 'dist' ? [] : sources(p)
    return /\.tsx?$/.test(e.name) ? [p] : []
  })
}

describe('the class: every list of hosts to pick from goes through pickableHosts', () => {
  // Files that walk config.hosts for something other than a person's choice, with why.
  const NOT_A_CHOICE: Record<string, string> = {
    'src/core/hosts/joined-twins.ts': 'the one place',
    'src/core/diagnostics/local-probes.ts': 'a count for diagnostics',
    'src/core/hosts/cloud-box-host.ts': 'finds the cloud box row',
    'src/core/hosts/host-status.ts': 'connection state of every row (Settings hides the twin itself)',
    'src/core/net/net-rows.ts': 'the joined rows themselves',
    'src/core/observability/bug-report.ts': 'a bug report lists every row as it is',
    'src/core/plugins/plugin-hosts.ts': 'a plugin reads the configured rows',
    'src/core/replication/search-replica.ts': 'a change key of the keep settings',
    'src/core/routines/clock-placement.ts': 'which hosts may run a clock',
    'src/core/self-repair/host-fix-record.ts': 'disabled rows',
    'src/core/sessions/external-session-import.ts': 'the import scan (drops twins itself)',
    'src/core/transfer/transfer.ts': 'checks a named target exists',
    'src/core/usage/session-budget.ts': 'budgets of every host',
    'src/web/routes/browser-pair.ts': 'browser pairing per host',
    'src/web/routes/console-v1.ts': "the phone's copy of the settings (drops twins itself)",
    'src/web/routes/files-locate.ts': 'searches the other hosts for a file',
    'src/web/routes/hosts-net.ts': 'the joined rows themselves',
    'src/web/routes/system.ts': 'daemon status of every row',
    'src/web/server.ts': 'warms and checks every row',
    'src/web/terminal/dtach-lifecycle.ts': 'terminal upkeep on every row',
    'src/web/routes/host-servers.ts': 'every row a server may run on: a server on the found row must stay visible to stop it',
    'src/core/host-server/index.ts': 'reconciles every row a server may run on',
    'src/core/routines/executors/claude-code.ts': 'names the configured hosts in an error',
    'src/core/expose/placement.ts': 'only always-on hosts matched by hostname, which a joined row (*.walnut-net.invalid) never is',
    'src/core/hosts/host-connect-action.ts': 'reconnects the rows that failed',
    'src/core/net/net-mac.ts': 'the joined rows themselves',
    'src/core/session-projection.ts': 'labels by alias',
    'src/core/companion-sessions.ts': 'labels by alias',
    'src/core/config-manager.ts': 'the rows themselves',
    'src/commands/ephemeral-snapshot.ts': "turns off every row's tunnel in a test copy",
    'src/core/sessions/mobile-launch.ts': 'the reserved-alias check (its list is pickableHosts)',
    'src/core/hosts/found-hosts.ts': 'merges the ~/.ssh/config rows into config.hosts: the rows themselves',
  }

  it('a file that walks config.hosts either uses pickableHosts or says why it is no choice', () => {
    const offenders: string[] = []
    for (const file of sources(path.join(ROOT, 'src'))) {
      const rel = path.relative(ROOT, file)
      // A file that also uses pickableHosts still walks the rows somewhere else: it says why too.
      if (!WALKS.test(fs.readFileSync(file, 'utf8')) || NOT_A_CHOICE[rel]) continue
      offenders.push(rel)
    }
    // A new one: list hosts for a choice with pickableHosts(hosts, config.net), or add it above with why.
    expect(offenders).toEqual([])
  })
})
