/**
 * Which found hosts Walnut offers (src/core/hosts/found-host-offer.ts). 2026-11-13: a Mac found in
 * ~/.ssh/config read "Could not connect" on Home after every reload. A host whose SSH probe named
 * another system is offered by no list while its alias names the target it was learned on; a
 * machine already joined with a link is matched live (joined-twins.ts), never written down, so an
 * entry an earlier build wrote for it is ignored; an older config without the field reads exactly
 * as before.
 *
 * Class guards: every standing connect failure decides whether it marks the host, and every list
 * that offers found hosts reads the one rule.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  consentedFoundHosts, foundHostOffered, foundHostsToAsk, keepNotOfferedRows, notLinuxMarkStale, notOfferedOf, notOfferedStands,
  osOfNotLinuxError, SSH_FIXABLE_STANDING_KINDS, SSH_SETUP_REFUSED_KINDS, withNotLinuxMark, withoutNotLinuxMark, withoutStaleNotLinux,
} from '../../../src/core/hosts/found-host-offer.js'
import { STANDING_FAILURE_KINDS } from '../../../src/core/hosts/host-problem.js'
import { notLinuxSentence } from '../../../src/core/sessions/host-connect-hint.js'
import { firstRunHostRows } from '../../../web/src/components/first-run/first-run-model'
import { foundHostsToAsk as webFoundHostsToAsk } from '../../../web/src/utils/first-use'

const NOW = new Date('2026-11-13T10:00:00Z')

describe('a found host Walnut cannot add is offered by no list', () => {
  const hosts = () => ({
    // The reported case: said Connect to once, and it answered that it runs Darwin.
    'studio-mac': withNotLinuxMark({ hostname: '10.20.30.40', user: 'sam', discovered: true, connect: 'yes', enabled: true }, 'Darwin', NOW),
    devbox: { hostname: 'devbox.example.test', discovered: true, connect: 'ask', enabled: false },
    added: { hostname: 'added.example.test', discovered: true, connect: 'yes', enabled: true },
  })

  it('the not Linux mark turns the row off, names the target it was learned on, and every list leaves it out', () => {
    const h = hosts()
    expect(h['studio-mac']).toMatchObject({
      enabled: false,
      not_offered: { reason: 'not_linux', os: 'Darwin', target: { hostname: '10.20.30.40', user: 'sam' }, at: NOW.toISOString() },
    })
    expect(foundHostsToAsk(h).map((r) => r.host)).toEqual(['devbox'])
    expect(consentedFoundHosts(h).map((r) => r.host)).toEqual(['added'])
    // The first-run picker and the web's own copy agree.
    expect(firstRunHostRows(h as never).map((r) => r.alias)).toEqual(['devbox', 'added'])
    expect(webFoundHostsToAsk(h)).toEqual(foundHostsToAsk(h))
  })

  it('a mark stands even when the person answers again: Not now after the mark still offers nothing', () => {
    const h = { ...hosts(), 'studio-mac': { ...hosts()['studio-mac'], connect: 'not_now' } }
    expect(foundHostOffered(h['studio-mac'])).toBe(false)
    expect(firstRunHostRows(h as never).map((r) => r.alias)).not.toContain('studio-mac')
  })

  it('the mark holds only for its target: another hostname, user or port asks the host again, still off', () => {
    const marked = { ...hosts()['studio-mac'], connect_by: 'walnut' }
    // The same target in another case, or the default port named: still the same machine.
    expect(notOfferedStands({ ...marked, hostname: '10.20.30.40', port: 22 })).toBe(true)
    expect(notOfferedStands({ ...marked, hostname: 'STUDIO.example.test', not_offered: { ...marked.not_offered, target: { hostname: 'studio.example.test' } }, user: undefined })).toBe(true)
    for (const moved of [{ hostname: '10.20.30.41' }, { user: 'pat' }, { port: 2222 }]) {
      const row = { ...marked, ...moved }
      expect(notLinuxMarkStale(row), JSON.stringify(moved)).toBe(true)
      expect(notOfferedStands(row)).toBe(false)
      const asked = withoutStaleNotLinux(row)
      expect(asked).toMatchObject({ connect: 'ask', enabled: false, discovered: true })
      expect(asked.not_offered).toBeUndefined()
      expect(asked.connect_by).toBeUndefined()
      expect(foundHostsToAsk({ x: asked }).map((r) => r.host)).toEqual(['x'])
    }
    // A mark that still holds, a mark written before the target was kept, and a hand-added host stay as they are.
    expect(withoutStaleNotLinux(marked)).toBe(marked)
    const { target: _t, ...noTarget } = marked.not_offered
    const older = { ...marked, hostname: 'elsewhere.example.test', not_offered: noTarget }
    expect(withoutStaleNotLinux(older)).toBe(older)
    expect(notOfferedStands(older)).toBe(true)
    const manual = { ...marked, discovered: undefined, hostname: 'elsewhere.example.test' }
    expect(withoutStaleNotLinux(manual)).toBe(manual)
  })

  it('a same machine entry an earlier build wrote is ignored: that match is read live', () => {
    const row = { hostname: 'studio.local', discovered: true, connect: 'ask', enabled: false, not_offered: { reason: 'same_machine', machine: 'Studio-MacBook', at: NOW.toISOString() } }
    expect(notOfferedOf(row)).toBeUndefined()
    expect(foundHostOffered(row)).toBe(true)
    expect(foundHostsToAsk({ 'studio-alias': row }).map((r) => r.host)).toEqual(['studio-alias'])
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

  it('a connect that works clears the not Linux mark', () => {
    const h = hosts()
    expect(notOfferedOf(withoutNotLinuxMark(h['studio-mac']))).toBeUndefined()
    expect(withoutNotLinuxMark(h.devbox)).toBe(h.devbox)
  })

  it('a hosts map saved by an editor that does not know the field keeps each found row\'s stored one', () => {
    const was = { 'studio-mac': hosts()['studio-mac'], manual: { hostname: 'm', not_offered: { reason: 'not_linux', at: 'x' } } }
    const sent = { 'studio-mac': { hostname: '10.20.30.40', discovered: true, enabled: false }, manual: { hostname: 'm' }, fresh: { hostname: 'f', discovered: true } }
    const kept = keepNotOfferedRows(sent, was)
    expect(kept['studio-mac']).toMatchObject({ not_offered: was['studio-mac'].not_offered })
    // A hand-added row and a row the sender names the field on keep what was sent.
    expect(kept.manual).toEqual({ hostname: 'm' })
    const cleared = { 'studio-mac': { hostname: '10.20.30.40', discovered: true, not_offered: undefined } }
    expect(keepNotOfferedRows(cleared, was)).toBe(cleared)
    expect(keepNotOfferedRows(sent, undefined)).toBe(sent)
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
    'web/src/components/settings/sections/remote-hosts-model.ts': 'Remote Hosts manages every row; a twin is hidden through GET /api/hosts/net twins, read live',
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
