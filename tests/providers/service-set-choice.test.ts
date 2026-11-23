/**
 * Which service set `walnut daemon … --walnut <id>` acts on (src/providers/service-set-choice.ts):
 * each of the four steps, the claim race (two claimers, one wins), and a sticky own set. Real files
 * in a temp home; nothing runs.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chooseServiceSet, readSetOwner, SET_OWNER_FILE, type ServiceSetChoiceInput } from '../../src/providers/service-set-choice.js'
import { serviceSet } from '../../src/providers/service-set.js'
import { SHARED_WINDOW_MS, SERVES_FILE, walnutKeyOf } from '../../src/providers/daemon-shared.js'
import { SERVICE_MODE_FILE } from '../../src/binary/service-mode.js'

const A = 'aaaaaaaaaaaaaaaa00000000000000aa'
const B = 'bbbbbbbbbbbbbbbb00000000000000bb'
const NOW = Date.UTC(2026, 10, 23, 12, 0, 0)

let home = ''
let runtime = ''
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-set-choice-'))
  runtime = path.join(home, 'rt-default')
  fs.mkdirSync(runtime)
})
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }) })

const defaultRoot = () => serviceSet('linux', home).installRoot
const input = (walnutId: string, o: Partial<ServiceSetChoiceInput> = {}): ServiceSetChoiceInput => ({
  platform: 'linux', home, walnutId, serveHome: path.join(home, walnutId === A ? 'data-a' : 'data-b'),
  defaultRuntimeDir: runtime, uid: 1000, claim: true, now: () => NOW, ...o,
})
const writeMode = (mode: Record<string, unknown>) => {
  fs.mkdirSync(defaultRoot(), { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(defaultRoot(), SERVICE_MODE_FILE), JSON.stringify(mode), { mode: 0o600 })
}
const writeServes = (walnuts: Record<string, number>) => fs.writeFileSync(path.join(runtime, SERVES_FILE), JSON.stringify({ version: 'v', twin: 'binary', capabilities: [], walnuts }))

describe('chooseServiceSet', () => {
  it('step 4, a free host: the first Walnut claims the default set; the claim names it', async () => {
    const got = await chooseServiceSet(input(A))
    expect(got.set.id).toBe('')
    expect(got.set.installRoot).toBe(defaultRoot())
    expect(got.set.runtimeDir).toBe(runtime)
    expect(got.claimed).toBe(true)
    expect(await readSetOwner(defaultRoot())).toBe(A)
    expect(fs.statSync(path.join(defaultRoot(), SET_OWNER_FILE)).mode & 0o777).toBe(0o600)
    // Nothing left beside it: no tmp file, no lock.
    expect(fs.readdirSync(defaultRoot()).sort()).toEqual([SET_OWNER_FILE])
  })

  it('step 2, a claim: the same Walnut keeps the default, another gets its own set', async () => {
    await chooseServiceSet(input(A))
    expect((await chooseServiceSet(input(A))).set.id).toBe('')
    const b = await chooseServiceSet(input(B))
    expect(b.set.id).toBe('bbbbbbbbbbbbbbbb')
    expect(b.set.installRoot).toBe(path.join(home, '.open-walnut-host', 'walnuts', 'bbbbbbbbbbbbbbbb', 'daemon'))
    expect(b.set.unit).toBe('open-walnut-daemon-bbbbbbbbbbbbbbbb.service')
    expect(b.why).toMatch(/claimed by another Walnut/)
    // A claim that does not read is another's, to be safe.
    fs.writeFileSync(path.join(defaultRoot(), SET_OWNER_FILE), 'not json')
    expect((await chooseServiceSet(input(A))).set.id).toBe('aaaaaaaaaaaaaaaa')
  })

  it('step 3, a mode and no claim: its owner keeps the default (and claims it), another gets its own set', async () => {
    writeMode({ v: 1, home: path.join(home, 'data-a'), exe: '/x/daemon', walnutId: A, role: 'leader' })
    const b = await chooseServiceSet(input(B))
    expect(b.set.id).toBe('bbbbbbbbbbbbbbbb')
    expect(b.why).toMatch(/another Walnut's/)
    // B's look claimed nothing: the owner still finds the default free to claim.
    expect(await readSetOwner(defaultRoot())).toBe(null)
    const a = await chooseServiceSet(input(A))
    expect(a.set.id).toBe('')
    expect(a.claimed).toBe(true)
    expect(await readSetOwner(defaultRoot())).toBe(A)
  })

  it('step 2: a readable mode of another Walnut than the claimer outranks the claim (review round 1, should-fix 2)', async () => {
    // B claimed a free-looking default while A was away; A, the one whose service it is, writes its mode.
    await chooseServiceSet(input(B))
    expect(await readSetOwner(defaultRoot())).toBe(B)
    writeMode({ v: 1, home: path.join(home, 'data-a'), exe: '/x/daemon', walnutId: A, role: 'leader' })
    const b = await chooseServiceSet(input(B))
    expect(b.set.id).toBe('bbbbbbbbbbbbbbbb')
    expect(b.why).toMatch(/another Walnut's \(its mode outranks the claim\)/)
    const a = await chooseServiceSet(input(A))
    expect(a.set.id).toBe('')
    // A mode that agrees with the claim changes nothing.
    writeMode({ v: 1, home: path.join(home, 'data-b'), exe: '/x/daemon', walnutId: B, role: 'leader' })
    expect((await chooseServiceSet(input(B))).set.id).toBe('')
  })

  it('a claim temp file a crashed CLI left is removed under the lock (low 3)', async () => {
    fs.mkdirSync(defaultRoot(), { recursive: true, mode: 0o700 })
    const left = path.join(defaultRoot(), `${SET_OWNER_FILE}.999999999.0123abcd.tmp`)
    fs.writeFileSync(left, '{}')
    await chooseServiceSet(input(A))
    expect(fs.existsSync(left)).toBe(false)
  })

  it('step 4, no mode: a default daemon another Walnut used lately sends this one to its own set (two Walnuts sharing one daemon)', async () => {
    writeServes({ [walnutKeyOf(path.join(home, 'data-a'))]: NOW - 60_000, '-': NOW })
    const b = await chooseServiceSet(input(B))
    expect(b.set.id).toBe('bbbbbbbbbbbbbbbb')
    expect(b.why).toMatch(/serves another Walnut/)
    // A itself, and an old use past the window, leave the default free.
    expect((await chooseServiceSet(input(A, { claim: false }))).set.id).toBe('')
    writeServes({ [walnutKeyOf(path.join(home, 'data-a'))]: NOW - SHARED_WINDOW_MS - 1 })
    expect((await chooseServiceSet(input(B))).set.id).toBe('')
  })

  it('step 1, sticky: an installed own set stays this Walnut\'s, whatever the default says', async () => {
    const own = serviceSet('linux', home, 'aaaaaaaaaaaaaaaa', { uid: 1000 })
    for (const mark of ['walnut-launcher.sh', 'service-mode.json', 'daemon-boot.sh', 'service-configs.json']) {
      fs.rmSync(path.join(home, '.open-walnut-host'), { recursive: true, force: true })
      fs.rmSync(defaultRoot(), { recursive: true, force: true })
      fs.mkdirSync(own.installRoot, { recursive: true })
      fs.writeFileSync(path.join(own.installRoot, mark), '')
      // Even with the default claimed for A itself.
      fs.mkdirSync(defaultRoot(), { recursive: true })
      fs.writeFileSync(path.join(defaultRoot(), SET_OWNER_FILE), JSON.stringify({ v: 1, walnutId: A }))
      const got = await chooseServiceSet(input(A))
      expect(got.set.id, mark).toBe('aaaaaaaaaaaaaaaa')
      expect(got.why).toContain(mark)
    }
  })

  it('status, uninstall and restart only read: no claim is written', async () => {
    const got = await chooseServiceSet(input(A, { claim: false }))
    expect(got.set.id).toBe('')
    expect(fs.existsSync(defaultRoot())).toBe(false)
  })

  it('the claim race: two Walnuts claiming a free host at once, exactly one gets the default', async () => {
    for (let round = 0; round < 10; round++) {
      fs.rmSync(defaultRoot(), { recursive: true, force: true })
      const [a, b] = await Promise.all([chooseServiceSet(input(A)), chooseServiceSet(input(B))])
      const winners = [a, b].filter((c) => c.set.id === '')
      expect(winners, `round ${round}`).toHaveLength(1)
      const owner = await readSetOwner(defaultRoot())
      expect(owner).toBe(a.set.id === '' ? A : B)
      expect((a.set.id === '' ? b : a).set.id).toBe((owner === A ? B : A).slice(0, 16))
    }
  })

  it('the claim race without the lock: the link is the tie-break, and the loser reads the winner\'s claim', async () => {
    // A claim another process linked in after this one looked (step 2 found none) but before its own link.
    fs.mkdirSync(defaultRoot(), { recursive: true })
    const real = fs.promises.link
    let raced = false
    ;(fs.promises as { link: typeof real }).link = async (from, to) => {
      if (!raced && String(to).endsWith(SET_OWNER_FILE)) {
        raced = true
        fs.writeFileSync(String(to), JSON.stringify({ v: 1, walnutId: B }))
      }
      return real(from, to)
    }
    try {
      const a = await chooseServiceSet(input(A))
      expect(raced).toBe(true)
      expect(a.set.id).toBe('aaaaaaaaaaaaaaaa')
      expect(await readSetOwner(defaultRoot())).toBe(B)
      expect(fs.readdirSync(defaultRoot()).filter((n) => n.endsWith('.tmp'))).toEqual([])
    } finally { (fs.promises as { link: typeof real }).link = real }
  })

  it('a walnut id that names no set is refused', async () => {
    await expect(chooseServiceSet(input('not-hex-at-all-xxxxxxxx'))).rejects.toThrow(/16 hex/)
  })
})
