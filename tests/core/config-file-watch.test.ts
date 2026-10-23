import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import yaml from 'js-yaml'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants())

import { WALNUT_HOME, CONFIG_FILE } from '../../src/constants.js'
import { onConfigWritten, updateConfig, writeFileAtomic, _resetWriteLockForTest } from '../../src/core/config-manager.js'
import { startConfigFileWatch } from '../../src/core/config-file-watch.js'
import { bus, EventNames } from '../../src/core/event-bus.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(fn: () => boolean, ms = 3_000): Promise<void> {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out')
    await sleep(20)
  }
}

let written = 0
let changed: unknown[] = []
let offWritten: () => void
let watch: { stop: () => void } | null = null
const SUB = 'config-file-watch-test'

beforeEach(async () => {
  _resetWriteLockForTest()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  await fs.writeFile(CONFIG_FILE, yaml.dump({ version: 1, hosts: { devbox: { hostname: 'devbox' } } }), 'utf-8')
  written = 0
  changed = []
  offWritten = onConfigWritten(() => { written++ })
  bus.subscribe(SUB, (e) => { if (e.name === EventNames.CONFIG_CHANGED) changed.push(e.data) }, { global: true, interest: [EventNames.CONFIG_CHANGED] })
  watch = startConfigFileWatch({ pollMs: 20, settleMs: 15 })
  await sleep(60) // the watch reads the starting content first
})

afterEach(async () => {
  watch?.stop()
  watch = null
  offWritten()
  bus.unsubscribe(SUB)
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
})

describe('config.yaml edited outside Walnut', () => {
  it('takes effect like a save: the write listeners run and CONFIG_CHANGED goes out once', async () => {
    const edited = { version: 1, hosts: { devbox: { hostname: 'devbox', keep: { notes_exclude: ['health'] } } } }
    await fs.writeFile(CONFIG_FILE, yaml.dump(edited), 'utf-8')
    await until(() => written === 1 && changed.length === 1)
    expect(changed[0]).toEqual({ key: 'config.yaml' })
    await sleep(150)
    expect(written).toBe(1)
    expect(changed).toHaveLength(1)
  })

  it('sees an editor that replaces the file by rename', async () => {
    await writeFileAtomic(CONFIG_FILE, yaml.dump({ version: 1, hosts: { devbox: { hostname: 'devbox', keep: { memory: false } } } }))
    await until(() => written === 1 && changed.length === 1)
  })

  it("skips Walnut's own write: its listeners run once, from the write itself", async () => {
    await updateConfig({ hosts: { devbox: { hostname: 'devbox', keep: { skills: false } } } } as any)
    expect(written).toBe(1)
    await sleep(150)
    expect(written).toBe(1)
    expect(changed).toHaveLength(0) // updateConfig leaves the event to its caller (PUT /api/config)
  })

  it('waits while the file does not parse, then applies the fixed file', async () => {
    await fs.writeFile(CONFIG_FILE, 'hosts:\n  devbox: [unclosed\n', 'utf-8')
    await sleep(150)
    expect(written).toBe(0)
    await fs.writeFile(CONFIG_FILE, 'just a string\n', 'utf-8')
    await sleep(150)
    expect(written).toBe(0)
    await fs.writeFile(CONFIG_FILE, yaml.dump({ version: 1, hosts: {} }), 'utf-8')
    await until(() => written === 1 && changed.length === 1)
  })

  it('ignores a save that left the content as it was', async () => {
    const same = await fs.readFile(CONFIG_FILE, 'utf-8')
    await fs.writeFile(CONFIG_FILE, same, 'utf-8')
    await sleep(150)
    expect(written).toBe(0)
    expect(changed).toHaveLength(0)
  })

  it('hears nothing after stop', async () => {
    watch!.stop()
    await fs.writeFile(CONFIG_FILE, yaml.dump({ version: 1, hosts: {} }), 'utf-8')
    await sleep(150)
    expect(written).toBe(0)
  })
})
