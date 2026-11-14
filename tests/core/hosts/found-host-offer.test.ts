/**
 * Which found hosts Walnut offers (src/core/hosts/found-host-offer.ts). 2026-11-13: a Mac found in
 * ~/.ssh/config read "Could not connect" on Home after every reload, while the same Mac was already
 * connected, joined with a link. A host Walnut cannot set up over SSH, or that is a machine already
 * connected under another name, is offered by no list; an older config without the field reads
 * exactly as before.
 *
 * Class guards: every standing connect failure decides whether it marks the host, and every list
 * that offers found hosts reads the one rule.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  consentedFoundHosts, foundHostOffered, foundHostsToAsk, keepNotOffered, notOfferedOf, notOfferedStands, osOfNotLinuxError,
  SSH_FIXABLE_STANDING_KINDS, SSH_SETUP_REFUSED_KINDS, withNotLinuxMark, withoutNotLinuxMark, withSameMachineMark,
} from '../../../src/core/hosts/found-host-offer.js'
import { STANDING_FAILURE_KINDS } from '../../../src/core/hosts/host-problem.js'
import { notLinuxSentence } from '../../../src/core/sessions/host-connect-hint.js'
import { firstRunHostRows } from '../../../web/src/components/first-run/first-run-model'
import { foundHostsToAsk as webFoundHostsToAsk } from '../../../web/src/utils/first-use'

const NOW = new Date('2026-11-13T10:00:00Z')
const MAC = 'a'.repeat(64)
const joinedMac = { hostname: 'Studio-MacBook.walnut-net.invalid', label: 'Studio-MacBook', transport: 'net', endpoint: MAC, enabled: true }
const net = { enabled: true }

describe('a found host Walnut cannot add is offered by no list', () => {
  const hosts = () => ({
    // The reported case: said Connect to once, and it answered that it runs Darwin.
    'studio-mac': withNotLinuxMark({ hostname: '10.20.30.40', user: 'sam', discovered: true, connect: 'yes', enabled: true }, 'Darwin', NOW),
    // Found, never answered, and the same machine as the joined Studio-MacBook.
    'studio-alias': withSameMachineMark({ hostname: 'studio.local', discovered: true, connect: 'ask', enabled: false }, 'Studio-MacBook', NOW),
    'Studio-MacBook': joinedMac,
    devbox: { hostname: 'devbox.example.test', discovered: true, connect: 'ask', enabled: false },
    added: { hostname: 'added.example.test', discovered: true, connect: 'yes', enabled: true },
  })

  it('the not Linux mark turns the row off, and every list leaves it out', () => {
    const h = hosts()
    expect(h['studio-mac']).toMatchObject({ enabled: false, not_offered: { reason: 'not_linux', os: 'Darwin', at: NOW.toISOString() } })
    expect(foundHostsToAsk(h, net).map((r) => r.host)).toEqual(['devbox'])
    expect(consentedFoundHosts(h, net).map((r) => r.host)).toEqual(['added'])
    // The first-run picker (with or without the network known) and the web's own copy agree.
    expect(firstRunHostRows(h as never, net).map((r) => r.alias)).toEqual(['devbox', 'added'])
    expect(firstRunHostRows(h as never).map((r) => r.alias)).toEqual(['devbox', 'added'])
    expect(webFoundHostsToAsk(h, net)).toEqual(foundHostsToAsk(h, net))
  })

  it('a mark stands even when the person answers again: Not now after the mark still offers nothing', () => {
    const h = { ...hosts(), 'studio-mac': { ...hosts()['studio-mac'], connect: 'not_now' } }
    expect(foundHostOffered(h['studio-mac'], h, net)).toBe(false)
    expect(firstRunHostRows(h as never, net).map((r) => r.alias)).not.toContain('studio-mac')
  })

  it('the same machine mark holds only while the joined machine can be used', () => {
    const h = hosts()
    expect(notOfferedStands(h['studio-alias'], h, net)).toBe(true)
    // The joined row removed, turned off, or the host network off: the found row is offered again.
    const { 'Studio-MacBook': _gone, ...without } = h
    expect(foundHostsToAsk(without, net).map((r) => r.host)).toEqual(['studio-alias', 'devbox'])
    expect(foundHostsToAsk({ ...h, 'Studio-MacBook': { ...joinedMac, enabled: false } }, net).map((r) => r.host)).toEqual(['studio-alias', 'devbox'])
    expect(foundHostsToAsk(h, { enabled: false }).map((r) => r.host)).toEqual(['studio-alias', 'devbox'])
  })

  it('a config written before the field (or by a newer Walnut with another reason) reads as before', () => {
    const older = {
      acme: { discovered: true, connect: 'ask', label: ' Acme computer ' },
      decided: { discovered: true, connect: 'yes' },
      dismissed: { discovered: true, connect: 'not_now' },
      manual: { connect: 'ask' },
      next: { discovered: true, connect: 'ask' },
      newer: { discovered: true, connect: 'ask', not_offered: { reason: 'from_the_future', at: 'x' } },
    }
    expect(foundHostsToAsk(older)).toEqual([{ host: 'acme', label: 'Acme computer' }, { host: 'next', label: 'next' }, { host: 'newer', label: 'newer' }])
    expect(consentedFoundHosts(older).map((r) => r.host)).toEqual(['decided'])
    expect(notOfferedOf(older.newer)).toBeUndefined()
    expect(foundHostsToAsk(undefined)).toEqual([])
  })

  it('a connect that works clears only the not Linux mark', () => {
    const h = hosts()
    expect(notOfferedOf(withoutNotLinuxMark(h['studio-mac']))).toBeUndefined()
    expect(withoutNotLinuxMark(h['studio-alias'])).toBe(h['studio-alias'])
  })

  it('a settings save that does not know the field keeps it; one that sends it keeps its own', () => {
    const was = hosts()['studio-mac']
    expect(keepNotOffered({ hostname: '10.20.30.40', discovered: true, enabled: false }, was)).toMatchObject({ not_offered: was.not_offered })
    expect(keepNotOffered({ hostname: '10.20.30.40', not_offered: undefined }, was)).toEqual({ hostname: '10.20.30.40', not_offered: undefined })
    expect(keepNotOffered({ hostname: 'x' }, { hostname: 'x' })).toEqual({ hostname: 'x' })
  })

  it('reads the system the SSH probe named, from the connect error Walnut writes', () => {
    expect(osOfNotLinuxError(notLinuxSentence('studio-mac', 'Darwin'))).toBe('Darwin')
    expect(osOfNotLinuxError(`daemon connect failed: ${notLinuxSentence('bsd-box', 'FreeBSD')}`)).toBe('FreeBSD')
    expect(osOfNotLinuxError('Permission denied (publickey)')).toBeUndefined()
  })
})

describe('guard: every standing connect failure decides whether it marks the host', () => {
  it('each STANDING_FAILURE_KINDS member is either "cannot be set up over SSH" or "the person fixes it", never both', () => {
    const undecided = STANDING_FAILURE_KINDS.filter((k) => !SSH_SETUP_REFUSED_KINDS.includes(k) && !SSH_FIXABLE_STANDING_KINDS.includes(k))
    expect(undecided, 'a new standing kind: add it to SSH_SETUP_REFUSED_KINDS (marks the found host) or SSH_FIXABLE_STANDING_KINDS').toEqual([])
    expect(SSH_SETUP_REFUSED_KINDS.filter((k) => SSH_FIXABLE_STANDING_KINDS.includes(k))).toEqual([])
    for (const k of [...SSH_SETUP_REFUSED_KINDS, ...SSH_FIXABLE_STANDING_KINDS]) expect(STANDING_FAILURE_KINDS, k).toContain(k)
  })
})

describe('guard: every list that offers found hosts reads the one rule', () => {
  const root = path.resolve(import.meta.dirname, '../../..')
  const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(d, e.name)
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : walk(p)
    return /\.tsx?$/.test(e.name) ? [p] : []
  })
  // Files that filter found hosts by their answer and are not a list that offers them.
  const NOT_OFFER_LISTS: Record<string, string> = {
    'src/core/hosts/found-host-offer.ts': 'the rule itself',
    'src/core/hosts/found-hosts.ts': 'foundHostWaits: the dial rule (a waiting host is never dialled)',
    'web/src/components/settings/sections/remote-hosts-model.ts': 'Remote Hosts manages every row; a remembered twin is hidden through GET /api/hosts/net twins',
  }
  const RULE = /\b(foundHostOffered|foundHostsToAsk|consentedFoundHosts|notOfferedOf|notOfferedStands|foundPickableHosts)\b/

  it('a file that filters found hosts by connect === ask / not_now also reads found-host-offer.ts', () => {
    const files = [...walk(path.join(root, 'src')), ...walk(path.join(root, 'web/src'))]
    const offenders: string[] = []
    for (const file of files) {
      const rel = path.relative(root, file)
      const src = fs.readFileSync(file, 'utf8')
      if (!/connect === ['"](ask|not_now)['"]/.test(src)) continue
      if (NOT_OFFER_LISTS[rel] || RULE.test(src)) continue
      offenders.push(rel)
    }
    expect(offenders, 'a new list of found hosts: read foundHostOffered (or say here why it is not a list)').toEqual([])
  })
})
