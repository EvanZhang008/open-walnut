/**
 * config.yaml is a file the user's editor writes too. An editor that saves in
 * place truncates and rewrites the file, one that saves by rename removes it for
 * a moment, a slow one pauses between writes. Walnut used to read such a window
 * as a lost config: a reader wrote the sidecar backup (Walnut's own last write,
 * older than the edit) over the file, and a read-modify-write merged into that
 * backup and renamed it over the save, so the user's new content was gone.
 *
 * Every case here drives the real file through a state an editor really puts it
 * in, in a temp WALNUT_HOME (never the user's config).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import yaml from 'js-yaml'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants())

import { WALNUT_HOME, CONFIG_FILE } from '../../src/constants.js'
import * as cm from '../../src/core/config-manager.js'
import { startConfigFileWatch } from '../../src/core/config-file-watch.js'

const BACKUP = `${CONFIG_FILE}.bak`
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const TIMINGS = { readRetryMs: 30, settleMs: 150, quietMs: 400, deadlineMs: 5_000, lateWriteWatchMs: 700 }

/** A config the size and shape of a real one: ~300 lines, comments, Unicode. */
function realisticConfig(marker: string): string {
  const doc = {
    version: 1,
    user: { name: '张三 éè', timezone: 'America/Los_Angeles' },
    defaults: { priority: 'none', platform: 'local', project: 'Walnut' },
    provider: { type: 'claude-code' },
    agent: {
      main_provider: 'bedrock',
      main_model: 'model-a',
      available_models: Array.from({ length: 12 }, (_, i) => `vendor.model-${i}-v1:0`),
    },
    stt: { engine: 'whisper-server', whisper_server_model: '/models/ggml-large-v3-turbo.bin' },
    hosts: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`host${i}`, { hostname: `h${i}.example.invalid`, user: 'me', label: `Host · ${i}` }])),
    plugins: { calendar: { enabled: true, source_enabled: true }, rhythm: { enabled: false, quiet: { from: '22:00', to: '07:00' } } },
    tools: { web_search: { provider: 'tavily' } },
    editor_marker: marker,
  }
  return `# My Walnut config (edited by hand)\n${yaml.dump(doc, { indent: 2, lineWidth: 120 })}`
}

const load = async (): Promise<Record<string, any>> => yaml.load(await fs.readFile(CONFIG_FILE, 'utf-8')) as Record<string, any>

/** An editor saving in place: truncate, (pause), write, (pause), write the rest. */
async function saveInPlace(content: string, opts: { beforeMs?: number; splitAt?: number; midMs?: number } = {}): Promise<void> {
  const fh = await fs.open(CONFIG_FILE, 'w')
  try {
    if (opts.beforeMs) await sleep(opts.beforeMs)
    const buf = Buffer.from(content, 'utf-8')
    const cut = opts.splitAt ?? buf.length
    await fh.write(buf.subarray(0, cut), 0, cut, 0)
    if (cut < buf.length) {
      if (opts.midMs) await sleep(opts.midMs)
      await fh.write(buf.subarray(cut), 0, buf.length - cut, cut)
    }
  } finally {
    await fh.close()
  }
}

/** Walnut's state before the edit: its own last write on disk and in the sidecar. */
async function seedWalnutWrite(marker = 'walnut-old'): Promise<string> {
  const content = realisticConfig(marker)
  await fs.writeFile(CONFIG_FILE, content, 'utf-8')
  await fs.writeFile(BACKUP, content, 'utf-8')
  // Old enough that it counts as finished.
  const past = new Date(Date.now() - 60_000)
  await fs.utimes(CONFIG_FILE, past, past)
  return content
}

beforeEach(async () => {
  cm._resetWriteLockForTest()
  cm._setConfigTimingsForTest(TIMINGS)
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
})

afterEach(async () => {
  cm._setBeforeConfigCommitForTest(null)
  await cm._configRepairIdleForTest()
  cm._setConfigTimingsForTest(null)
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
})

describe('an editor saving config.yaml in place', () => {
  it('a read in the empty window answers in memory and never writes the old backup over the save', async () => {
    await seedWalnutWrite()
    const edit = realisticConfig('user-new')
    const save = saveInPlace(edit, { beforeMs: 60 })
    await sleep(15) // inside the truncated window
    const during = await cm.getConfig()
    expect(cm.isFallbackConfig(during)).toBe(false)
    expect(['walnut-old', 'user-new']).toContain((during as any).editor_marker)
    await save
    await cm._configRepairIdleForTest()
    expect(await fs.readFile(CONFIG_FILE, 'utf-8')).toBe(edit)
  })

  it('a write in the empty window merges into the save instead of replacing it', async () => {
    await seedWalnutWrite()
    const edit = realisticConfig('user-new')
    const save = saveInPlace(edit, { beforeMs: 80 })
    await sleep(15)
    await cm.updateConfig({ user: { name: 'from-settings' } } as any)
    await save
    const doc = await load()
    expect(doc.editor_marker).toBe('user-new')
    expect(doc.user.name).toBe('from-settings')
    expect(Object.keys(doc.hosts)).toHaveLength(40)
  })

  it('a write in the empty window finishes soon after the save lands, not a whole quiet period later', async () => {
    cm._setConfigTimingsForTest({ ...TIMINGS, quietMs: 3_000 })
    await seedWalnutWrite()
    const save = saveInPlace(realisticConfig('user-new'), { beforeMs: 80 })
    await sleep(15)
    const t0 = Date.now()
    await cm.updateConfig({ user: { name: 'from-settings' } } as any)
    expect(Date.now() - t0).toBeLessThan(1_500)
    await save
    expect((await load()).editor_marker).toBe('user-new')
  })

  it('a write that lands between two writes of a slow save waits for the whole file', async () => {
    await seedWalnutWrite()
    const edit = realisticConfig('user-new')
    // The first part is a valid YAML mapping on its own (a prefix that parses).
    const save = saveInPlace(edit, { splitAt: edit.indexOf('stt:'), midMs: 90 })
    await sleep(20)
    await cm.updateConfig({ user: { name: 'from-settings' } } as any)
    await save
    const doc = await load()
    expect(doc.editor_marker).toBe('user-new')
    expect(doc.tools.web_search.provider).toBe('tavily')
    expect(doc.user.name).toBe('from-settings')
  })

  it('a save that pauses past the settle window and goes on after Walnut replaced the file is merged back', async () => {
    await seedWalnutWrite()
    const edit = realisticConfig('user-new')
    // Truncate, write a prefix that parses, pause far longer than settleMs, write the rest.
    const save = saveInPlace(edit, { splitAt: edit.indexOf('stt:'), midMs: TIMINGS.settleMs * 3 })
    await sleep(20)
    await cm.updateConfig({ user: { name: 'from-settings' } } as any)
    await save
    await cm._configRepairIdleForTest()
    const doc = await load()
    expect(doc.editor_marker).toBe('user-new')
    expect(doc.tools.web_search.provider).toBe('tavily')
    expect(doc.user.name).toBe('from-settings')
  })

  it('a late save that cannot be merged is kept beside the file, never dropped', async () => {
    await seedWalnutWrite()
    const edit = realisticConfig('user-new')
    const tail = 'stt: [oops\n'
    const cut = edit.indexOf('stt:')
    const fh = await fs.open(CONFIG_FILE, 'w')
    await fh.write(edit.slice(0, cut), 0)
    const p = cm.updateConfig({ user: { name: 'from-settings' } } as any)
    await sleep(TIMINGS.settleMs * 3)
    await p
    await fh.write(tail, Buffer.byteLength(edit.slice(0, cut)))
    await fh.close()
    await cm._configRepairIdleForTest()
    const kept = (await fs.readdir(WALNUT_HOME)).filter((f) => f.startsWith('config.yaml.late-'))
    expect(kept).toHaveLength(1)
    expect(await fs.readFile(`${WALNUT_HOME}/${kept[0]}`, 'utf-8')).toBe(edit.slice(0, cut) + tail)
    expect((await load()).user.name).toBe('from-settings')
  })

  it('an editor that removes the file and writes a new one keeps its save', async () => {
    await seedWalnutWrite()
    const edit = realisticConfig('user-new')
    await fs.rm(CONFIG_FILE)
    const save = (async () => { await sleep(150); await fs.writeFile(CONFIG_FILE, edit, 'utf-8') })()
    await cm.updateConfig({ user: { name: 'from-settings' } } as any)
    await save
    const doc = await load()
    expect(doc.editor_marker).toBe('user-new')
    expect(doc.user.name).toBe('from-settings')
  })

  it('an edit that lands between the read and the commit is read again and kept', async () => {
    await seedWalnutWrite()
    const edit = realisticConfig('user-new')
    let fired = false
    cm._setBeforeConfigCommitForTest(async () => {
      if (fired) return
      fired = true
      await fs.writeFile(`${CONFIG_FILE}.editor`, edit, 'utf-8')
      await fs.rename(`${CONFIG_FILE}.editor`, CONFIG_FILE)
    })
    await cm.updateConfig({ user: { name: 'from-settings' } } as any)
    const doc = await load()
    expect(fired).toBe(true)
    expect(doc.editor_marker).toBe('user-new')
    expect(doc.user.name).toBe('from-settings')
  })

  it('a file created between a first run read and its commit is not replaced', async () => {
    let fired = false
    cm._setBeforeConfigCommitForTest(async () => {
      if (fired) return
      fired = true
      await fs.writeFile(CONFIG_FILE, realisticConfig('user-new'), 'utf-8')
    })
    await cm.updateConfig({ user: { name: 'from-settings' } } as any)
    const doc = await load()
    expect(doc.editor_marker).toBe('user-new')
    expect(doc.user.name).toBe('from-settings')
  })
})

describe('a config.yaml that really is lost or broken', () => {
  it('stays missing: a write restores the backup under its change, after the quiet period', async () => {
    await seedWalnutWrite()
    await fs.rm(CONFIG_FILE)
    const t0 = Date.now()
    await cm.updateConfig({ user: { name: 'from-settings' } } as any)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(TIMINGS.quietMs - 20)
    const doc = await load()
    expect(doc.editor_marker).toBe('walnut-old')
    expect(doc.user.name).toBe('from-settings')
    expect(Object.keys(doc.hosts)).toHaveLength(40)
  })

  it('stays empty: a read answers from the backup and the file is restored byte for byte', async () => {
    const old = await seedWalnutWrite()
    await fs.writeFile(CONFIG_FILE, '', 'utf-8')
    expect(((await cm.getConfig()) as any).editor_marker).toBe('walnut-old')
    await cm._configRepairIdleForTest()
    expect(await fs.readFile(CONFIG_FILE, 'utf-8')).toBe(old)
  })

  it('an edit saved while the restore waits for quiet wins over the restore', async () => {
    await seedWalnutWrite()
    await fs.writeFile(CONFIG_FILE, '', 'utf-8')
    await cm.getConfig() // starts the restore
    await sleep(TIMINGS.quietMs / 2)
    const edit = realisticConfig('user-new')
    await fs.writeFile(CONFIG_FILE, edit, 'utf-8')
    await cm._configRepairIdleForTest()
    expect(await fs.readFile(CONFIG_FILE, 'utf-8')).toBe(edit)
  })

  it('does not parse: the write is refused, the file is untouched, and a retry after the fix goes through', async () => {
    await seedWalnutWrite()
    const broken = realisticConfig('user-new').replace('stt:', 'stt: [oops')
    await fs.writeFile(CONFIG_FILE, broken, 'utf-8')
    await expect(cm.updateConfig({ user: { name: 'x' } } as any)).rejects.toBeInstanceOf(cm.ConfigUnreadableError)
    await expect(cm.updatePushTokens(() => [])).rejects.toBeInstanceOf(cm.ConfigUnreadableError)
    expect(await fs.readFile(CONFIG_FILE, 'utf-8')).toBe(broken)
    // Readers keep working on the last good copy meanwhile (marked: it says nothing
    // sure about the user's newest text), and nothing restores over the user's text.
    const read = await cm.getConfig()
    expect(cm.isFallbackConfig(read)).toBe(true)
    expect((read as any).editor_marker).toBe('walnut-old')
    expect(await cm.readStoredConfig()).toBeNull()
    await sleep(TIMINGS.quietMs + 100)
    await cm._configRepairIdleForTest()
    expect(await fs.readFile(CONFIG_FILE, 'utf-8')).toBe(broken)
    // The user fixes the file; the same write now merges into it.
    await fs.writeFile(CONFIG_FILE, realisticConfig('user-fixed'), 'utf-8')
    await cm.updateConfig({ user: { name: 'x' } } as any)
    const doc = await load()
    expect(doc.editor_marker).toBe('user-fixed')
    expect(doc.user.name).toBe('x')
  })

  it('a second refused write for the same broken file answers at once', async () => {
    await seedWalnutWrite()
    await fs.writeFile(CONFIG_FILE, 'agent: [oops\n', 'utf-8')
    await expect(cm.updateConfig({ user: { name: 'x' } } as any)).rejects.toBeInstanceOf(cm.ConfigUnreadableError)
    const t0 = Date.now()
    await expect(cm.updateConfig({ user: { name: 'y' } } as any)).rejects.toBeInstanceOf(cm.ConfigUnreadableError)
    expect(Date.now() - t0).toBeLessThan(TIMINGS.quietMs / 2)
  })

  it('a backup that does not parse is no backup: a missing file is a first run', async () => {
    await fs.writeFile(BACKUP, '{ not: [yaml', 'utf-8')
    const t0 = Date.now()
    await cm.updateConfig({ user: { name: 'x' } } as any)
    expect(Date.now() - t0).toBeLessThan(TIMINGS.quietMs)
    expect((await load()).user.name).toBe('x')
  })

  it('boot puts back a lost file from the backup and seeds the model list', async () => {
    await seedWalnutWrite()
    await fs.rm(CONFIG_FILE)
    await cm.seedConfigDefaults()
    const doc = await load()
    expect(doc.editor_marker).toBe('walnut-old')
    expect(doc.agent.available_models.length).toBeGreaterThan(0)
  })

  it('boot leaves a file that does not parse alone', async () => {
    await seedWalnutWrite()
    const broken = 'agent: [oops\n'
    await fs.writeFile(CONFIG_FILE, broken, 'utf-8')
    await cm.seedConfigDefaults()
    expect(await fs.readFile(CONFIG_FILE, 'utf-8')).toBe(broken)
  })
})

describe('ordinary operation stays fast and exact', () => {
  it('a first run writes at once, file and backup', async () => {
    const t0 = Date.now()
    await cm.updateConfig({ user: { name: 'x' } } as any)
    expect(Date.now() - t0).toBeLessThan(TIMINGS.quietMs)
    expect((await load()).user.name).toBe('x')
    expect(await fs.readFile(BACKUP, 'utf-8')).toBe(await fs.readFile(CONFIG_FILE, 'utf-8'))
  })

  it('back-to-back writes do not wait on their own last write', async () => {
    await seedWalnutWrite()
    await cm.updateConfig({ user: { name: 'w0' } } as any)
    const t0 = Date.now()
    for (let i = 1; i <= 10; i++) await cm.updateConfig({ user: { name: `w${i}` } } as any)
    expect(Date.now() - t0).toBeLessThan(TIMINGS.settleMs * 3)
    expect((await load()).user.name).toBe('w10')
  })

  it('a mutation that runs again after a conflict counts from zero (a device removed meanwhile is a 404)', async () => {
    const { setDevicePushPreferences } = await import('../../src/core/push/registry.js')
    const row = { token: 'a'.repeat(64), platform: 'ios', kind: 'apns', key_name: 'phone-1', origin: 'local', registered_at: new Date().toISOString() }
    await cm.updatePushTokens(() => [row as any])
    let fired = false
    cm._setBeforeConfigCommitForTest(async () => {
      if (fired) return
      fired = true
      // Another writer removes the phone's row between the read and the commit.
      const doc = await load()
      doc.push_tokens = []
      await fs.writeFile(`${CONFIG_FILE}.other`, yaml.dump(doc), 'utf-8')
      await fs.rename(`${CONFIG_FILE}.other`, CONFIG_FILE)
    })
    await expect(setDevicePushPreferences('phone-1', { mode: 'when-inactive' })).rejects.toMatchObject({ code: 'device_not_registered' })
    expect(fired).toBe(true)
    expect((await load()).push_tokens).toEqual([])
  })

  it('parallel writers and readers: every key lands, no reader gets the defaults', async () => {
    await seedWalnutWrite()
    const writes = Array.from({ length: 20 }, (_, i) => cm.updatePluginConfig(`p${i}`, { enabled: true, n: i }))
    const reads = Array.from({ length: 60 }, () => cm.getConfig().then((c) => cm.isFallbackConfig(c)))
    await Promise.all(writes)
    expect((await Promise.all(reads)).every((fallback) => !fallback)).toBe(true)
    const doc = await load()
    for (let i = 0; i < 20; i++) expect(doc.plugins[`p${i}`].n).toBe(i)
    expect(doc.editor_marker).toBe('walnut-old')
  })

  it('waiting out a save never blocks the event loop', async () => {
    await seedWalnutWrite()
    await fs.rm(CONFIG_FILE)
    let last = Date.now()
    let worst = 0
    const tick = setInterval(() => { const now = Date.now(); worst = Math.max(worst, now - last); last = now }, 5)
    try {
      await cm.updateConfig({ user: { name: 'x' } } as any)
    } finally {
      clearInterval(tick)
    }
    expect(worst).toBeLessThan(150)
  })
})

describe('the backup follows edits made outside Walnut', () => {
  it('an applied edit becomes the backup, so a later loss restores the edit and not the older write', async () => {
    await seedWalnutWrite()
    const watch = startConfigFileWatch({ pollMs: 20, settleMs: 15 })
    try {
      await sleep(80)
      const edit = realisticConfig('user-new')
      await fs.writeFile(CONFIG_FILE, edit, 'utf-8')
      const end = Date.now() + 3_000
      while ((await fs.readFile(BACKUP, 'utf-8')) !== edit) {
        if (Date.now() > end) throw new Error('backup never followed the edit')
        await sleep(25)
      }
      // A save that does not parse never reaches the backup.
      await fs.writeFile(CONFIG_FILE, 'stt: [oops\n', 'utf-8')
      await sleep(TIMINGS.settleMs + 300)
      expect(await fs.readFile(BACKUP, 'utf-8')).toBe(edit)
      // Nor does one that parses but lost whole sections (a cut-off file).
      await fs.writeFile(CONFIG_FILE, 'version: 1\nuser: {}\n', 'utf-8')
      await sleep(TIMINGS.settleMs + 300)
      expect(await fs.readFile(BACKUP, 'utf-8')).toBe(edit)
    } finally {
      watch.stop()
    }
    await fs.rm(CONFIG_FILE)
    expect(((await cm.getConfig()) as any).editor_marker).toBe('user-new')
  })

  it('boot copies an edit made while Walnut was not running into the backup', async () => {
    await seedWalnutWrite()
    const edit = realisticConfig('user-new') // already holds agent.available_models: boot writes nothing
    await fs.writeFile(CONFIG_FILE, edit, 'utf-8')
    const past = new Date(Date.now() - 60_000)
    await fs.utimes(CONFIG_FILE, past, past)
    await cm.seedConfigDefaults()
    expect(yaml.load(await fs.readFile(BACKUP, 'utf-8'))).toMatchObject({ editor_marker: 'user-new' })
  })
})
