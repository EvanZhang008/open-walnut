/**
 * A net host this Walnut moved into its own service set is reached at the set's walnut-net endpoint,
 * not the host row's: every read of its link state goes by netEndpointDialled (2026-11-24 relay drill:
 * Settings showed `path: unknown` for a moved host, read by the row's endpoint).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { hostServiceSets, movedNetEndpoint, netEndpointDialled } from '../../src/providers/service-set-leader.js'

const ROW = 'a'.repeat(64)
const SET_EP = 'b'.repeat(64)
const SET = '0123456789abcdef'

describe('the endpoint a net host is reached at', () => {
  let dir = ''
  const prior = process.env.WALNUT_SERVICE_SET_FILE
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-set-dialled-'))
    process.env.WALNUT_SERVICE_SET_FILE = path.join(dir, 'daemon-service-set.json')
  })
  afterEach(() => {
    if (prior === undefined) delete process.env.WALNUT_SERVICE_SET_FILE
    else process.env.WALNUT_SERVICE_SET_FILE = prior
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('is the set\'s once moved there, the row\'s before', async () => {
    expect(movedNetEndpoint(null)).toBeNull()
    expect(movedNetEndpoint({ at: 1, set: SET, netEndpoint: SET_EP })).toBeNull()
    expect(movedNetEndpoint({ at: 1, set: SET, netEndpoint: SET_EP, movedAt: 2 })).toBe(SET_EP)
    expect(await netEndpointDialled('chen', ROW)).toBe(ROW)
    await hostServiceSets.write('net:chen', { at: Date.now(), set: SET, netEndpoint: SET_EP })
    expect(await netEndpointDialled('chen', ROW)).toBe(ROW)
    await hostServiceSets.write('net:chen', { at: Date.now(), set: SET, netEndpoint: SET_EP, movedAt: Date.now() })
    expect(await netEndpointDialled('chen', ROW)).toBe(SET_EP)
    expect(await netEndpointDialled('other', ROW)).toBe(ROW)
  })

  it('no reader of a net host\'s link state looks it up by the host row\'s endpoint', () => {
    const root = path.resolve(__dirname, '../../src')
    const files: string[] = []
    const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.tsx?$/.test(e.name)) files.push(p) } }
    walk(root)
    const byRow = /\.id === h\.endpoint\)\?\.link|links\.get\(h\.endpoint/
    const offenders = files.filter((f) => byRow.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(root, f))
    expect(offenders, 'look a net host\'s link up with netEndpointDialled (service-set-leader.ts)').toEqual([])
    for (const f of ['web/routes/hosts-net.ts', 'core/net/net-seen.ts']) expect(fs.readFileSync(path.join(root, f), 'utf8')).toContain('netEndpointDialled(')
  })
})
