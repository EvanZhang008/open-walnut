/**
 * A write that leaves config.yaml byte for byte as it is touches nothing (2026-11-15): on the
 * Mac a plugin reload rewrote the same content (new inode and mtime, a config:changed for every
 * client) in the middle of an hour that should have left the file alone. Every writer goes
 * through writeConfigWithBackup (tests/replica/config-yaml-writers-ratchet.test.ts keeps it
 * so), so the check there covers each of them: a read-modify-write, a section update and a full save.
 *
 * Real: config.yaml, its backup and dated copies in a temp Walnut home.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import yaml from 'js-yaml'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-config-write-noop'))

import { CONFIG_FILE, WALNUT_HOME } from '../../src/constants.js'
import {
  _configRepairIdleForTest, _resetWriteLockForTest, onConfigWritten, patchPluginConfig, saveConfig, updateConfig,
} from '../../src/core/config-manager.js'
import { _setBeforeConfigCommitForTest, dumpConfig, modifyConfigDoc } from '../../src/core/config-store.js'
import { writeFileAtomic } from '../../src/core/config-file-io.js'

const DOC = {
  version: 1,
  hosts: { devbox: { hostname: 'dev.example.com', user: 'me', enabled: true } },
  plugins: { sample: { enabled: true, keep: ['a', 'b'] } },
}
let writes = 0
let off: () => void

async function snapshot() {
  await _configRepairIdleForTest()
  const stat = await fs.stat(CONFIG_FILE)
  return {
    content: await fs.readFile(CONFIG_FILE, 'utf8'),
    ino: stat.ino, mtime: stat.mtimeMs,
    backup: await fs.readFile(`${CONFIG_FILE}.bak`, 'utf8').catch(() => null),
    backupIno: (await fs.stat(`${CONFIG_FILE}.bak`).catch(() => null))?.ino,
    backupMtime: (await fs.stat(`${CONFIG_FILE}.bak`).catch(() => null))?.mtimeMs,
    mode: stat.mode & 0o777,
    history: (await fs.readdir(`${CONFIG_FILE}.history`).catch(() => [])).sort(),
  }
}

beforeEach(async () => {
  _resetWriteLockForTest()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  // A file Walnut wrote itself: the content a writer that changes nothing dumps again.
  await modifyConfigDoc((doc) => { Object.assign(doc, structuredClone(DOC)); return { write: true, result: undefined } })
  writes = 0
  off = onConfigWritten(() => { writes++ })
})
afterEach(async () => {
  _setBeforeConfigCommitForTest(null)
  off()
  await _configRepairIdleForTest()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
})

describe('a config write that changes nothing leaves config.yaml alone', () => {
  it('a read-modify-write that asks to write the same content', async () => {
    const before = await snapshot()
    for (let i = 0; i < 5; i++) {
      await modifyConfigDoc((doc) => { doc.plugins = structuredClone(DOC.plugins); return { write: true, result: undefined } })
    }
    expect(await snapshot()).toEqual(before)
    expect(writes).toBe(0)
  })

  it('a section update with the values it already has', async () => {
    const before = await snapshot()
    await updateConfig({ plugins: structuredClone(DOC.plugins) } as never)
    expect(await snapshot()).toEqual(before)
    expect(writes).toBe(0)
  })

  it("a plugin re-applying its own settings (config.patch at reload) writes nothing and says it changed nothing", async () => {
    const before = await snapshot()
    expect(await patchPluginConfig('sample', { enabled: true, keep: ['a', 'b'] })).toEqual({ config: DOC.plugins.sample, changed: false })
    expect(await snapshot()).toEqual(before)
    expect(writes).toBe(0)
    expect((await patchPluginConfig('sample', { enabled: false })).changed).toBe(true)
    expect(writes).toBe(1)
    expect((await patchPluginConfig('fresh', {})).changed).toBe(true)
  })

  it('a full save of the same config', async () => {
    const before = await snapshot()
    await saveConfig(yaml.load(before.content) as never)
    expect(await snapshot()).toEqual(before)
    expect(writes).toBe(0)
  })

  it('a real change is still written once, mirrored and kept as a dated copy', async () => {
    const before = await snapshot()
    await modifyConfigDoc((doc) => { (doc.plugins as Record<string, unknown>).sample = { enabled: false }; return { write: true, result: undefined } })
    const after = await snapshot()
    expect(after.content).not.toBe(before.content)
    expect(after.backup).toBe(after.content)
    expect(after.history.length).toBeGreaterThan(before.history.length)
    expect(writes).toBe(1)
    // The same change again is a no-op.
    await modifyConfigDoc((doc) => { (doc.plugins as Record<string, unknown>).sample = { enabled: false }; return { write: true, result: undefined } })
    expect(await snapshot()).toEqual(after)
    expect(writes).toBe(1)
  })

  it('an editor that saved the same content as a new file between read and commit: its file stays, nothing is written over it', async () => {
    const content = await fs.readFile(CONFIG_FILE, 'utf8')
    let editorIno = 0
    _setBeforeConfigCommitForTest(async () => {
      _setBeforeConfigCommitForTest(null)
      await writeFileAtomic(CONFIG_FILE, content, 0o600)
      editorIno = (await fs.stat(CONFIG_FILE)).ino
    })
    let runs = 0
    await modifyConfigDoc((doc) => { runs++; doc.plugins = structuredClone(DOC.plugins); return { write: true, result: undefined } })
    expect(editorIno).not.toBe(0)
    expect((await fs.stat(CONFIG_FILE)).ino).toBe(editorIno)
    expect(writes).toBe(0)
    // The commit still saw a file other than the one read: it read again (a second run) and
    // only then found nothing to write. A no-op that ignored `expected` would stop at one.
    expect(runs).toBe(2)
  })

  it('a backup that fell behind is brought up to the file, which itself is not rewritten', async () => {
    await fs.writeFile(`${CONFIG_FILE}.bak`, dumpConfig({ version: 1, plugins: { old: { enabled: true } } }))
    const before = await snapshot()
    await modifyConfigDoc((doc) => { doc.plugins = structuredClone(DOC.plugins); return { write: true, result: undefined } })
    const after = await snapshot()
    expect([after.content, after.ino, after.mtime]).toEqual([before.content, before.ino, before.mtime])
    expect(after.backup).toBe(after.content)
    expect(writes).toBe(0)
  })

  it('a file readable by others is rewritten private even when its content stays', async () => {
    await fs.chmod(CONFIG_FILE, 0o644)
    const before = await snapshot()
    await modifyConfigDoc((doc) => { doc.plugins = structuredClone(DOC.plugins); return { write: true, result: undefined } })
    const after = await snapshot()
    expect(after.content).toBe(before.content)
    expect(after.mode).toBe(0o600)
  })

  it('a file an editor changed between read and commit is still re-read and merged, not skipped', async () => {
    const edited = { ...structuredClone(DOC), hosts: { devbox: { ...DOC.hosts.devbox, user: 'editor' } } }
    let first = true
    await modifyConfigDoc(async (doc) => {
      if (first) { first = false; await fs.writeFile(CONFIG_FILE, dumpConfig(edited)) }
      doc.plugins = structuredClone(DOC.plugins)
      return { write: true, result: undefined }
    })
    expect((yaml.load(await fs.readFile(CONFIG_FILE, 'utf8')) as typeof DOC).hosts.devbox.user).toBe('editor')
  })
})
