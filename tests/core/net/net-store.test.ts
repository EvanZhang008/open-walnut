/**
 * The host network's member list and invites on the companion (src/core/net/net-store.ts):
 * an invite is one use and 10 minutes, a code is checked by hash in constant time, a join
 * that fails leaves the code good, the Mac is one member that a join never replaces, and
 * the list file is 0600 in a 0700 dir.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  INVITE_TTL_MS, NetStoreError, inviteStatus, isMember, listMembers, makeInvite, memberNameFrom, normalInviteCode,
  peekInvite, redeemInvite, removeMember, resetInvitesForTest, restoreHostMember, setMacMember, validMemberName, validNetId, validNetKey,
} from '../../../src/core/net/net-store.js'
import { netKey } from '../../helpers/net-keys.js'

// Real keys: the companion refuses an id that is not a point on the curve.
const id = (c: string) => netKey(c)
let dir = ''
let file = ''
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wn-net-store-'))
  file = path.join(dir, 'state', 'net-members.json')
  resetInvitesForTest()
})
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

describe('ids, names and codes', () => {
  it('accepts only 64 lowercase hex ids', () => {
    expect(validNetId(id('a'))).toBe(true)
    expect(validNetId('A'.repeat(64))).toBe(false)
    expect(validNetKey(id('a'))).toBe(true)
    expect(validNetKey('02'.repeat(32))).toBe(false)
    expect(validNetId('ab')).toBe(false)
    expect(validNetId(42)).toBe(false)
  })
  it('keeps reserved and odd names out', () => {
    for (const n of ['local', '__local__', '__cloudbox__', 'cloud', 'MAC']) expect(validMemberName(n)).toBe(false)
    expect(validMemberName('gpu-box')).toBe(true)
    expect(validMemberName('-x')).toBe(false)
    expect(validMemberName('a b')).toBe(false)
  })
  it('names a machine from its host name, never with dots, spaces or non-ASCII', () => {
    expect(memberNameFrom('gpu-box.lan')).toBe('gpu-box')
    expect(memberNameFrom('My Laptop')).toBe('My-Laptop')
    expect(memberNameFrom('中文')).toBe('machine')
    expect(memberNameFrom('local')).toBe('machine')
    expect(memberNameFrom(undefined)).toBe('machine')
  })
  it('reads a code as a person types it', () => {
    expect(normalInviteCode('k7qm-4xtd-92zd')).toBe('K7QM4XTD92ZD')
    expect(normalInviteCode(' K7QM 4XTD 92ZD ')).toBe('K7QM4XTD92ZD')
    expect(normalInviteCode('K7QM-4XTD-92Z')).toBeNull()
    expect(normalInviteCode('K7QM-4XTD-92Z0')).toBeNull() // 0 is not in the alphabet
  })
})

describe('invites', () => {
  it('one code, one machine: the second use is refused and the status names the member', () => {
    const t0 = 1_000_000
    const inv = makeInvite({}, t0)
    expect(inv.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/)
    expect(peekInvite(inv.code.toLowerCase(), t0 + 1)).toMatchObject({ id: inv.id })
    // An id that is not a key (walnut-net would leave it out) is refused, and the code stays good.
    expect(() => redeemInvite({ code: inv.code, endpointId: '02'.repeat(32) }, t0 + 1, file)).toThrow(/network key/)
    const m = redeemInvite({ code: inv.code, endpointId: id('b'), hostname: 'gpu-box.lan', platform: 'linux-x64' }, t0 + 2, file)
    expect(m).toMatchObject({ id: id('b'), name: 'gpu-box', role: 'host', platform: 'linux-x64' })
    expect(() => redeemInvite({ code: inv.code, endpointId: id('c') }, t0 + 3, file)).toThrow(NetStoreError)
    expect(inviteStatus(inv.id, t0 + 4)).toMatchObject({ state: 'joined', member: { id: id('b'), name: 'gpu-box' } })
    expect(listMembers(file).map((x) => x.id)).toEqual([id('b')])
  })

  it('ends after 10 minutes', () => {
    const inv = makeInvite({}, 0)
    expect(peekInvite(inv.code, INVITE_TTL_MS)).not.toBeNull()
    expect(peekInvite(inv.code, INVITE_TTL_MS + 1)).toBeNull()
    expect(() => redeemInvite({ code: inv.code, endpointId: id('b') }, INVITE_TTL_MS + 1, file)).toThrow(/not valid any more/)
    expect(() => inviteStatus(inv.id, INVITE_TTL_MS + 1)).toThrow(/No such invite/)
  })

  it('a failed join leaves the code good', () => {
    setMacMember({ id: id('a') }, 0, file)
    const inv = makeInvite({}, 0)
    // The Mac's own id cannot join as a host.
    expect(() => redeemInvite({ code: inv.code, endpointId: id('a') }, 1, file)).toThrow(/this Mac/)
    expect(peekInvite(inv.code, 2)).not.toBeNull()
    expect(redeemInvite({ code: inv.code, endpointId: id('b') }, 3, file).role).toBe('host')
  })

  it('takes the name the user gave, and a taken name gets a number', () => {
    const a = makeInvite({ name: 'box' }, 0)
    const b = makeInvite({}, 0)
    expect(redeemInvite({ code: a.code, endpointId: id('b'), hostname: 'whatever' }, 1, file).name).toBe('box')
    expect(redeemInvite({ code: b.code, endpointId: id('c'), hostname: 'box' }, 1, file).name).toBe('box-2')
    expect(() => makeInvite({ name: 'local' }, 0)).toThrow(/Name the machine/)
  })

  it('refuses a ninth open invite', () => {
    for (let i = 0; i < 8; i++) makeInvite({}, 0)
    expect(() => makeInvite({}, 0)).toThrow(/Too many open invites/)
  })

  it('a code one character off finds nothing', () => {
    const inv = makeInvite({}, 0)
    const last = inv.code.slice(-1)
    const off = inv.code.slice(0, -1) + (last === 'A' ? 'B' : 'A')
    expect(peekInvite(off, 1)).toBeNull()
    expect(peekInvite(inv.code, 1)).not.toBeNull()
  })
})

describe('members', () => {
  it('one Mac: a new id replaces the old one, and the Mac is never removed', () => {
    setMacMember({ id: id('a'), name: 'Mac' }, 0, file)
    setMacMember({ id: id('d'), name: 'Mac' }, 1, file)
    expect(listMembers(file).filter((m) => m.role === 'mac').map((m) => m.id)).toEqual([id('d')])
    expect(removeMember(id('d'), file)).toBe(false)
    expect(isMember(id('d'), file)).toBe(true)
  })

  it('removes a machine, and the file is private', () => {
    const inv = makeInvite({}, 0)
    redeemInvite({ code: inv.code, endpointId: id('b') }, 1, file)
    expect(removeMember(id('b'), file)).toBe(true)
    expect(isMember(id('b'), file)).toBe(false)
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700)
  })

  it('no file is no members; a file it cannot read is an error, never an empty list', () => {
    expect(listMembers(file)).toEqual([])
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '{not json')
    // The Mac would read an empty list as every machine removed, and a write would make it so.
    expect(() => listMembers(file)).toThrow(/not valid JSON/)
    expect(() => setMacMember({ id: id('a') }, 1, file)).toThrow(NetStoreError)
    expect(fs.readFileSync(file, 'utf8')).toBe('{not json')
    fs.writeFileSync(file, JSON.stringify({ version: 1 }))
    expect(() => listMembers(file)).toThrow(/no members array/)
    // A foreign entry is left out; the rest is read.
    fs.writeFileSync(file, JSON.stringify({ members: [{ id: 'x', name: 'y', role: 'host' }, { id: id('e'), name: 'ok', role: 'host', addedAt: 1 }] }))
    expect(listMembers(file).map((m) => m.id)).toEqual([id('e')])
  })

  it('the Mac puts back a machine the list lost, once, never over the Mac or a member already there', () => {
    setMacMember({ id: id('a'), name: 'mac' }, 1, file)
    const first = restoreHostMember({ id: id('b'), name: 'gpu-box', platform: 'linux-x64' }, 2, file)
    expect(first).toMatchObject({ restored: true, member: { id: id('b'), name: 'gpu-box', role: 'host', platform: 'linux-x64' } })
    expect(restoreHostMember({ id: id('b'), name: 'renamed' }, 3, file)).toMatchObject({ restored: false, member: { name: 'gpu-box' } })
    expect(() => restoreHostMember({ id: id('a'), name: 'x' }, 4, file)).toThrow(/is the Mac/)
    // A name taken by another machine gets a free one; a bad name becomes `machine`.
    expect(restoreHostMember({ id: id('c'), name: 'gpu-box' }, 5, file).member.name).toBe('gpu-box-2')
    expect(restoreHostMember({ id: id('d'), name: 'bad name!' }, 6, file).member.name).toBe('machine')
    expect(() => restoreHostMember({ id: 'nope' }, 7, file)).toThrow(NetStoreError)
    expect(listMembers(file).map((m) => m.role)).toEqual(['mac', 'host', 'host', 'host'])
  })

  it('an entry this version does not know (a newer one wrote it) is kept by every write', () => {
    const newer = { id: id('z'), name: 'box', role: 'companion', addedAt: 1, extra: { a: 1 } }
    const odd = { id: 'x', name: 'y', role: 'host' }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ version: 1, members: [newer, odd] }))
    setMacMember({ id: id('a'), name: 'mac' }, 2, file)
    redeemInvite({ code: makeInvite({}, 3).code, endpointId: id('b') }, 4, file)
    restoreHostMember({ id: id('c'), name: 'c' }, 5, file)
    removeMember(id('b'), file)
    // Read as members: only what this version knows.
    expect(listMembers(file).map((m) => m.id)).toEqual([id('a'), id('c')])
    expect(isMember(id('z'), file)).toBe(false)
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { members: unknown[] }
    expect(raw.members).toContainEqual(newer)
    expect(raw.members).toContainEqual(odd)
  })
})
