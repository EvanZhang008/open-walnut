/**
 * Ratchet: every way DaemonConnection reaches a daemon has an update path or a reasoned
 * exemption (src/providers/daemon-update-paths.ts). 2026-11-03: a Mac that joined over the
 * host network kept a daemon 8 hours older than the server, because every update path ran
 * over SSH and that kind had none, while a comment said its daemon "updates itself".
 *
 * Fails when:
 *  - a kind has neither a path nor an exemption with its reason, or a path names code
 *    that is not there;
 *  - a `via` of SshTarget (a new transport) is not classified as a kind of its own, so it
 *    would silently take the ssh kind's update path, which needs SSH;
 *  - DaemonConnection decides its transport anywhere but through `linkKind`;
 *  - a kind with an update path is not handled by it (the net updater acts on 'net' only,
 *    and the ssh path is reached only for 'ssh');
 *  - a kind with an update path neither waits out the update gap with a request path that
 *    updates it now (host_daemon_update), nor names why not (2026-11-24: 19 replacements of
 *    one host's daemon in 24 hours, and an SSH host could not be asked for its update at all).
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DAEMON_LINK_KINDS, DAEMON_UPDATE_PATHS, daemonLinkKind } from '../../src/providers/daemon-update-paths.js'
import { decideNetUpdate, type NetUpdateFacts } from '../../src/providers/daemon-net-update.js'

const repo = path.resolve(import.meta.dirname, '../..')
const read = (file: string) => fs.readFileSync(path.join(repo, file), 'utf8')

describe('every daemon link kind has an update path or a reasoned exemption', () => {
  it('the table covers every kind, and each entry is real', () => {
    expect(Object.keys(DAEMON_UPDATE_PATHS).sort()).toEqual([...DAEMON_LINK_KINDS].sort())
    for (const kind of DAEMON_LINK_KINDS) {
      const entry = DAEMON_UPDATE_PATHS[kind]
      if ('path' in entry) {
        expect(entry.path.length, kind).toBeGreaterThan(40)
        expect(entry.code.length, `${kind} names the code that updates it`).toBeGreaterThan(0)
      } else {
        expect(entry.exempt.length, `${kind} says why it is exempt`).toBeGreaterThan(60)
      }
      for (const { file, symbol } of entry.code ?? []) {
        expect(fs.existsSync(path.join(repo, file)), `${kind}: ${file}`).toBe(true)
        expect(read(file), `${kind}: ${symbol} in ${file}`).toMatch(new RegExp(`\\b${symbol}\\b`))
      }
    }
  })

  it('every kind with an update path waits out the gap and can be asked for it now, or says why not', () => {
    const named: string[] = []
    for (const kind of DAEMON_LINK_KINDS) {
      const entry = DAEMON_UPDATE_PATHS[kind]
      if (!('path' in entry)) continue
      named.push(kind)
      const batch = entry.batch
      expect(batch, `${kind} says how its replacements are batched`).toBeTruthy()
      if ('unbatched' in batch) {
        expect(batch.unbatched.length, `${kind} says why it has no gap or request path`).toBeGreaterThan(60)
        continue
      }
      for (const { file, symbol } of [...batch.gap, ...batch.request]) {
        expect(read(file), `${kind}: ${symbol} in ${file}`).toMatch(new RegExp(`\\b${symbol}\\b`))
      }
      // The gap is the one rule (daemon-update-gap.ts), never a copy of it.
      const gapFiles = [...new Set(batch.gap.map((c) => c.file))]
      expect(gapFiles.some((f) => /\b(daemonUpdateGapHold|UpdateGapHold|hostUpdateGap)\b/.test(read(f))), `${kind}: ${gapFiles.join(', ')} use the gap rule`).toBe(true)
      expect(batch.request.length, `${kind} names its request path`).toBeGreaterThan(0)
    }
    expect(named.length).toBeGreaterThan(0)
  })

  it('host_daemon_update is refused only for a kind with no request path, in that kind\'s own words', () => {
    const src = read('src/providers/daemon-connection.ts')
    const body = /requestDaemonUpdate\(gate\?: \(\) => void[^)]*\)[^{]*\{([\s\S]*?)\n {2}\}/.exec(src)?.[1] ?? ''
    // The kinds it answers null for: every one but those whose batch has a request path.
    const requestable = DAEMON_LINK_KINDS.filter((k) => { const e = DAEMON_UPDATE_PATHS[k]; return 'path' in e && 'request' in e.batch })
    expect(requestable.sort()).toEqual(['net', 'ssh'])
    expect(body).toContain('if (this.netUpdater) return this.netUpdater.request(')
    expect(body).toContain("if (this.linkKind !== 'ssh' || this.isReadOnlyRemote) return null")
  })

  it('every SshTarget via is a kind of its own, never the ssh one', () => {
    const src = read('src/providers/session-io.ts')
    const decl = /export interface SshTarget \{[\s\S]*?\n\}/.exec(src)?.[0] ?? ''
    const via = /\bvia\?:\s*([^\n]+)/.exec(decl)?.[1] ?? ''
    const literals = [...via.matchAll(/'([^']+)'/g)].map((m) => m[1])
    expect(literals.length, 'SshTarget.via names its values as string literals').toBeGreaterThan(0)
    for (const v of literals) {
      const kind = daemonLinkKind({ hostKey: 'some-host', via: v as never, dialledDirect: false }, '__cloudbox__')
      expect(kind, `via '${v}'`).not.toBe('ssh')
      expect(DAEMON_LINK_KINDS).toContain(kind)
    }
    expect(daemonLinkKind({ hostKey: 'some-host', dialledDirect: false }, '__cloudbox__')).toBe('ssh')
    expect(daemonLinkKind({ hostKey: '__local__', dialledDirect: true }, '__cloudbox__')).toBe('local')
    expect(daemonLinkKind({ hostKey: '__cloudbox__', dialledDirect: false }, '__cloudbox__')).toBe('cloud-tunnel')
    expect(daemonLinkKind({ hostKey: 'mock', dialledDirect: true }, '__cloudbox__')).toBe('direct-url')
  })

  it('DaemonConnection decides its transport only through linkKind', () => {
    const src = read('src/providers/daemon-connection.ts')
    // Literal transport tests outside the classifier would let a kind grow its own branch.
    const offenders = src.split('\n')
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter(({ line }) => !line.startsWith('//') && !line.startsWith('*'))
      .filter(({ line }) => /\.via\s*===|===\s*CLOUD_BOX_HOST_ALIAS|CLOUD_BOX_HOST_ALIAS\s*===/.test(line))
    expect(offenders).toEqual([])
    expect(src).toMatch(/get linkKind\(\): DaemonLinkKind \{\s*return daemonLinkKind\(/)
    expect(src).toMatch(/private get isCloudTunnel\(\): boolean \{\s*return this\.linkKind === 'cloud-tunnel'/)
    expect(src).toMatch(/private get isNetHost\(\): boolean \{\s*return this\.linkKind === 'net'/)
    // The net updater is built for net links only and runs on every connected edge.
    expect(src).toMatch(/private get netUpdater\(\): NetDaemonUpdater \| null \{\s*if \(!this\.isNetHost\) return null/)
    expect(src).toMatch(/if \(changed && value\) this\.netUpdater\?\.schedule\(\)/)
  })

  // 2026-11-22: a host network machine's switch of mode went to the postponed update's SSH check,
  // which threw every minute. Every way into that check (checkServiceMode, startDeferredUpgrade,
  // postponeUpgrade's timer, the fold prewarm) goes through recheckPostponedUpgrade, so the turn
  // away from SSH sits at its top, and the net updater carries the mode itself.
  it('the SSH update check is never entered for a link with no SSH, and the net updater carries the mode', () => {
    const src = read('src/providers/daemon-connection.ts')
    const body = /private recheckPostponedUpgrade\(.*\): Promise<boolean> \{([\s\S]*?)\n {2}\}/.exec(src)?.[1] ?? ''
    const firstStatement = body.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('//'))
    expect(firstStatement).toBe('if (this.noSsh) { this.netUpdater?.schedule(0); return Promise.resolve(false) }')
    // runUpgradeRecheck (the SSH check) has no other caller.
    expect(src.match(/this\.runUpgradeRecheck\(/g)).toHaveLength(1)
    expect(body).toContain('this.runUpgradeRecheck(')
    const net = /private get netUpdater\(\)[\s\S]*?\n {2}\}/.exec(src)?.[0] ?? ''
    expect(net).toMatch(/mode: \{\s*read: \(\) => this\.serviceModeNow\(\)/)
    // The net updater reaches the host only through its link: no SSH helper is named in it.
    for (const file of ['src/providers/daemon-net-update.ts', 'src/providers/daemon-net-update-io.ts', 'src/providers/daemon-net-update-source.ts']) {
      const code = read(file).split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n')
      expect(code, file).not.toMatch(/\bsshExec\b|\bpipeChunk\b|\bdeployWalnutFile\b|\bsshUpdateHost\b/)
    }
  })

  it('the net updater acts on the net kind and on no other', () => {
    const base: NetUpdateFacts = {
      kind: 'net', host: 'h', testServer: false, follower: false, expected: 'walnut-daemon-b', running: 'walnut-daemon-a', startup: 'service',
      serviceExecutable: '/x/walnut', has: () => true, autofixOff: null, turnedOff: false, requested: true, lastAttempt: null,
      now: 0, cooldownMs: 1, target: 'linux-x64', source: { file: '/b' },
    }
    for (const kind of DAEMON_LINK_KINDS) {
      const d = decideNetUpdate({ ...base, kind, host: kind === 'local' ? '__local__' : 'h' })
      const entry = DAEMON_UPDATE_PATHS[kind]
      const covered = 'path' in entry && entry.code.some((c) => c.symbol === 'NetDaemonUpdater')
      expect(d.go === true, kind).toBe(covered)
    }
  })

  // 2026-11-23: clouddev (host network) and newdev (SSH) are one daemon; each path updated it on its
  // own, 4.66 GB went up in a day for updates that failed on the other's lock (daemon-update-claim.ts).
  // A remote kind's update reaches a daemon another host name may also reach: it claims the update
  // for all of them first. This Mac's own daemon is its LocalDaemon's alone (exempt here, not claimed).
  it('every remote kind that updates a daemon claims the update for all its names first', () => {
    const LOCAL_ONLY = new Set(['local'])
    for (const kind of DAEMON_LINK_KINDS) {
      const entry = DAEMON_UPDATE_PATHS[kind]
      if (!('path' in entry) || LOCAL_ONLY.has(kind)) continue
      const files = [...new Set(entry.code.map((c) => c.file))]
      const claims = files.filter((f) => /\bclaimDaemonUpdate\(/.test(read(f)))
      expect(claims, `${kind}: one of ${files.join(', ')} calls claimDaemonUpdate`).not.toEqual([])
    }
  })
})
