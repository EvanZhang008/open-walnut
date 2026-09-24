import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import {
  daemonOwnershipPath,
  openDaemonServiceFiles,
  parseDaemonServiceOwners,
  withDaemonServiceFiles,
  type DaemonServiceFileIo,
  type DaemonServiceFiles,
} from '../../src/providers/daemon-service-files.js'

const UID = os.userInfo().uid
const UNIT_A = '[Unit]\nDescription=A\n'
const UNIT_B = '[Unit]\nDescription=B\n'
const sha = (text: string): string => createHash('sha256').update(text).digest('hex')

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true })
})

async function makeRoot(): Promise<{ root: string; unit: string; owners: string; dir: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-service-files-'))
  roots.push(root)
  const dir = path.join(root, 'etc')
  await fs.mkdir(dir, { mode: 0o700 })
  return { root, dir, unit: path.join(dir, 'open-walnut-daemon.service'), owners: daemonOwnershipPath(root) }
}

const open = <T>(
  root: string,
  fn: (files: DaemonServiceFiles) => Promise<T>,
  io?: Partial<DaemonServiceFileIo>,
): Promise<T> => withDaemonServiceFiles({ root, uid: UID, ...(io ? { io } : {}) }, fn)

const readOwners = async (ownersPath: string): Promise<Record<string, string | string[]>> =>
  JSON.parse(await fs.readFile(ownersPath, 'utf8'))

const temps = async (dir: string): Promise<string[]> =>
  (await fs.readdir(dir)).filter((name) => name.endsWith('.tmp'))

// Only make rename / fsync fail to simulate a crash partway through; everything else uses the real file system.
const failRename = (match: string, when = 1): Partial<DaemonServiceFileIo> => {
  let seen = 0
  return {
    rename: async (from, to) => {
      if (to === match && ++seen === when) throw new Error('EIO: simulated crash before the rename landed')
      await fs.rename(from, to)
    },
  }
}

describe('parseDaemonServiceOwners', () => {
  it('reads both the single-hash and the two-hash spelling', () => {
    const one = sha(UNIT_A)
    const two = sha(UNIT_B)
    expect(parseDaemonServiceOwners(JSON.stringify({ '/etc/a.service': one }))).toEqual({ '/etc/a.service': [one] })
    expect(parseDaemonServiceOwners(JSON.stringify({ '/etc/a.service': [one, two] })))
      .toEqual({ '/etc/a.service': [one, two] })
    expect(parseDaemonServiceOwners(JSON.stringify({ '/etc/a.service': [one, one] })))
      .toEqual({ '/etc/a.service': [one] })
  })

  it('rejects every shape it cannot vouch for, item by item', () => {
    const good = sha(UNIT_A)
    const bad: string[] = [
      '[]',
      'null',
      '"text"',
      JSON.stringify({ 'relative.service': good }),
      JSON.stringify({ '/etc/a.service': [] }),
      JSON.stringify({ '/etc/a.service': good.toUpperCase() }),
      JSON.stringify({ '/etc/a.service': good.slice(0, 63) }),
      JSON.stringify({ '/etc/a.service': 42 }),
      JSON.stringify({ '/etc/a.service': { hash: good } }),
      JSON.stringify({ '/etc/a.service': [good, 7] }),
      JSON.stringify({ '/etc/a.service': good, 'b.service': good }),
    ]
    for (const raw of bad) expect(() => parseDaemonServiceOwners(raw), raw).toThrow(/ownership file/)
  })
})

describe('writing a config', () => {
  it('leaves one hash, a private config, and no temp behind', async () => {
    const { root, dir, unit, owners } = await makeRoot()
    await open(root, (files) => files.writeConfig(unit, UNIT_A))

    expect(await fs.readFile(unit, 'utf8')).toBe(UNIT_A)
    expect((await fs.lstat(unit)).mode & 0o777).toBe(0o600)
    expect(await readOwners(owners)).toEqual({ [unit]: sha(UNIT_A) })
    expect(await temps(dir)).toEqual([])
    expect(await temps(root)).toEqual([])
    expect((await fs.lstat(root)).mode & 0o077).toBe(0)
  })

  it('has both hashes on disk at the moment the config is swapped', async () => {
    const { root, unit, owners } = await makeRoot()
    await open(root, (files) => files.writeConfig(unit, UNIT_A))

    let duringSwap: Record<string, string | string[]> = {}
    await open(root, (files) => files.writeConfig(unit, UNIT_B), {
      rename: async (from, to) => {
        if (to === unit) duringSwap = await readOwners(owners)
        await fs.rename(from, to)
      },
    })

    // At the moment of the swap, both the old and the new content are in the grant set, so a crash on either side never turns foreign.
    expect(duringSwap).toEqual({ [unit]: [sha(UNIT_A), sha(UNIT_B)] })
    expect(await readOwners(owners)).toEqual({ [unit]: sha(UNIT_B) })
  })

  it('still owns the old config when the new one never landed', async () => {
    const { root, dir, unit } = await makeRoot()
    await open(root, (files) => files.writeConfig(unit, UNIT_A))

    await expect(open(root, (files) => files.writeConfig(unit, UNIT_B), failRename(unit)))
      .rejects.toThrow(/simulated crash/)

    expect(await fs.readFile(unit, 'utf8')).toBe(UNIT_A)
    expect(await temps(dir)).toEqual([])
    const found = await open(root, (files) => files.inspectConfig(unit))
    expect(found).toEqual({ present: true, owned: true })
    expect(await open(root, (files) => files.readConfig(unit))).toBe(UNIT_A)
  })

  it('still owns the new config when the narrowing never landed', async () => {
    const { root, unit, owners } = await makeRoot()
    await open(root, (files) => files.writeConfig(unit, UNIT_A))

    // The first owners rename widens and the second narrows; make the narrowing one crash.
    await expect(open(root, (files) => files.writeConfig(unit, UNIT_B), failRename(owners, 2)))
      .rejects.toThrow(/simulated crash/)

    expect(await fs.readFile(unit, 'utf8')).toBe(UNIT_B)
    expect(await readOwners(owners)).toEqual({ [unit]: [sha(UNIT_A), sha(UNIT_B)] })
    expect(await open(root, (files) => files.inspectConfig(unit))).toEqual({ present: true, owned: true })
  })

  it('still owns the old config when the widening never landed', async () => {
    const { root, unit, owners } = await makeRoot()
    await open(root, (files) => files.writeConfig(unit, UNIT_A))

    await expect(open(root, (files) => files.writeConfig(unit, UNIT_B), failRename(owners)))
      .rejects.toThrow(/simulated crash/)

    expect(await fs.readFile(unit, 'utf8')).toBe(UNIT_A)
    expect(await readOwners(owners)).toEqual({ [unit]: sha(UNIT_A) })
    expect(await open(root, (files) => files.inspectConfig(unit))).toEqual({ present: true, owned: true })
    expect(await temps(root)).toEqual([])
  })

  it('cleans up only the temp it made itself', async () => {
    const { root, dir, unit } = await makeRoot()
    const foreign = `${unit}.someone-else.tmp`
    await fs.writeFile(foreign, 'not mine\n', { mode: 0o600 })

    await expect(open(root, (files) => files.writeConfig(unit, UNIT_A), failRename(unit)))
      .rejects.toThrow(/simulated crash/)

    expect(await temps(dir)).toEqual([path.basename(foreign)])
    expect(await fs.readFile(foreign, 'utf8')).toBe('not mine\n')
  })
})

describe('a config this tool did not write', () => {
  it('is reported foreign and left exactly as it was', async () => {
    const { root, unit, owners } = await makeRoot()
    await fs.writeFile(unit, 'someone else wrote this\n', { mode: 0o644 })
    await fs.chmod(unit, 0o644)

    expect(await open(root, (files) => files.inspectConfig(unit))).toEqual({ present: true, owned: false })
    await expect(open(root, (files) => files.readConfig(unit))).rejects.toThrow(/not the config this tool wrote/)
    await expect(open(root, (files) => files.writeConfig(unit, UNIT_A))).rejects.toThrow(/changed during installation/)
    await expect(open(root, (files) => files.removeConfig(unit))).rejects.toThrow(/changed before removal/)

    expect(await fs.readFile(unit, 'utf8')).toBe('someone else wrote this\n')
    expect((await fs.lstat(unit)).mode & 0o777).toBe(0o644)
    await expect(fs.access(owners)).rejects.toThrow()
  })

  it('is foreign when the path is a symlink, and the link is never followed', async () => {
    const { root, dir, unit } = await makeRoot()
    const real = path.join(dir, 'elsewhere.service')
    await fs.writeFile(real, UNIT_A, { mode: 0o600 })
    await fs.symlink(real, unit)

    expect(await open(root, (files) => files.inspectConfig(unit))).toEqual({ present: true, owned: false })
    await expect(open(root, (files) => files.readConfig(unit))).rejects.toThrow(/not the config this tool wrote/)
    await expect(open(root, (files) => files.writeConfig(unit, UNIT_B))).rejects.toThrow(/changed during installation/)

    expect((await fs.lstat(unit)).isSymbolicLink()).toBe(true)
    expect(await fs.readFile(real, 'utf8')).toBe(UNIT_A)
  })

  it('refuses a writable config even when its bytes match', async () => {
    const { root, unit } = await makeRoot()
    await open(root, (files) => files.writeConfig(unit, UNIT_A))
    await fs.chmod(unit, 0o666)
    expect(await open(root, (files) => files.inspectConfig(unit))).toEqual({ present: true, owned: false })
    await expect(open(root, (files) => files.writeConfig(unit, UNIT_B))).rejects.toThrow('changed')
    expect(await fs.readFile(unit, 'utf8')).toBe(UNIT_A)
  })

  it('refuses an install root that became public or was replaced by a link', async () => {
    const { root } = await makeRoot()
    await fs.chmod(root, 0o755)
    await expect(open(root, async () => {})).rejects.toThrow('not private')
    await fs.chmod(root, 0o700)
    const alias = path.join(root, 'linked')
    await fs.symlink(path.join(root, 'etc'), alias)
    await expect(open(alias, async () => {})).rejects.toThrow('not private')
  })

  it('is foreign once its bytes change under us, because the hash is taken from what was read', async () => {
    const { root, unit } = await makeRoot()
    await open(root, (files) => files.writeConfig(unit, UNIT_A))
    await fs.writeFile(unit, UNIT_B, { mode: 0o600 })

    expect(await open(root, (files) => files.inspectConfig(unit))).toEqual({ present: true, owned: false })
    await expect(open(root, (files) => files.readConfig(unit))).rejects.toThrow(/not the config this tool wrote/)
  })
})

describe('removing a config', () => {
  it('deletes the file first, then the ownership row', async () => {
    const { root, unit, owners } = await makeRoot()
    await open(root, (files) => files.writeConfig(unit, UNIT_A))
    await open(root, (files) => files.removeConfig(unit))

    await expect(fs.access(unit)).rejects.toThrow()
    expect(await readOwners(owners)).toEqual({})
  })

  it('leaves a harmless orphan row when the crash lands between the two, and installs again fine', async () => {
    const { root, unit, owners } = await makeRoot()
    await open(root, (files) => files.writeConfig(unit, UNIT_A))

    await expect(open(root, (files) => files.removeConfig(unit), {
      syncDir: async () => { throw new Error('EIO: simulated crash after the unlink') },
    })).rejects.toThrow(/simulated crash/)

    await expect(fs.access(unit)).rejects.toThrow()
    expect(await readOwners(owners)).toEqual({ [unit]: sha(UNIT_A) })
    expect(await open(root, (files) => files.inspectConfig(unit))).toEqual({ present: false, owned: false })

    await open(root, (files) => files.writeConfig(unit, UNIT_B))
    expect(await readOwners(owners)).toEqual({ [unit]: sha(UNIT_B) })
  })

  it('reads null instead of throwing when the config is simply gone', async () => {
    const { root, unit } = await makeRoot()
    expect(await open(root, (files) => files.readConfig(unit))).toBeNull()
  })
})

describe('the ownership file itself', () => {
  it('is refused when it is readable by anyone else', async () => {
    const { root, owners } = await makeRoot()
    await fs.writeFile(owners, '{}\n', { mode: 0o644 })
    await fs.chmod(owners, 0o644)

    await expect(open(root, async (files) => files.inspectConfig('/etc/a.service')))
      .rejects.toThrow(/not private/)
  })

  it('is refused when it is a symlink', async () => {
    const { root, dir, owners } = await makeRoot()
    const real = path.join(dir, 'owners.json')
    await fs.writeFile(real, '{}\n', { mode: 0o600 })
    await fs.symlink(real, owners)

    await expect(open(root, async (files) => files.inspectConfig('/etc/a.service')))
      .rejects.toThrow(/not private/)
  })

  it('honours a two-hash row written by an interrupted run', async () => {
    const { root, unit, owners } = await makeRoot()
    await fs.writeFile(unit, UNIT_B, { mode: 0o600 })
    await fs.writeFile(owners, `${JSON.stringify({ [unit]: [sha(UNIT_A), sha(UNIT_B)] })}\n`, { mode: 0o600 })

    expect(await open(root, (files) => files.inspectConfig(unit))).toEqual({ present: true, owned: true })
    expect(await open(root, (files) => files.readConfig(unit))).toBe(UNIT_B)
  })
})

describe('system config adapter', () => {
  it('keeps the ownership ledger local and supplies prior bytes to the privileged boundary', async () => {
    const { root, unit, owners } = await makeRoot()
    const seen: unknown[] = []
    const options = {
      root, uid: UID, configOwnerUid: UID,
      configIo: {
        write: async (target: string, text: string, previous: string | null) => {
          seen.push(['write', target, previous])
          expect((await readOwners(owners))[unit]).toBeDefined()
          await fs.writeFile(target, text, { mode: 0o600 })
        },
        remove: async (target: string, previous: string) => {
          seen.push(['remove', target, previous])
          await fs.unlink(target)
        },
      },
    }
    await withDaemonServiceFiles(options, async (files) => {
      await files.writeConfig(unit, UNIT_A)
      await files.writeConfig(unit, UNIT_B)
      await files.removeConfig(unit)
    })
    expect(seen).toEqual([['write', unit, null], ['write', unit, UNIT_A], ['remove', unit, UNIT_B]])
    expect(await readOwners(owners)).toEqual({})
  })

  it('retains prior ownership when the privileged compare-and-swap refuses', async () => {
    const { root, unit } = await makeRoot()
    await open(root, (files) => files.writeConfig(unit, UNIT_A))
    await expect(withDaemonServiceFiles({
      root, uid: UID,
      configIo: {
        write: async () => { throw new Error('configuration changed') },
        remove: async () => { throw new Error('not called') },
      },
    }, (files) => files.writeConfig(unit, UNIT_B))).rejects.toThrow('configuration changed')
    expect(await open(root, (files) => files.readConfig(unit))).toBe(UNIT_A)
  })
})

describe('status stays read-only', () => {
  it('inspects without the lock and refuses to change anything', async () => {
    const { root, unit } = await makeRoot()
    await open(root, (files) => files.writeConfig(unit, UNIT_A))

    const files = await openDaemonServiceFiles({ root, uid: UID })
    expect(await files.inspectConfig(unit)).toEqual({ present: true, owned: true })
    expect(await files.readConfig(unit)).toBe(UNIT_A)
    await expect(files.writeConfig(unit, UNIT_B)).rejects.toThrow(/install lock/)
    await expect(files.removeConfig(unit)).rejects.toThrow(/install lock/)
    expect(await fs.readFile(unit, 'utf8')).toBe(UNIT_A)
  })

  it('creates nothing, not even the install directory', async () => {
    const { root } = await makeRoot()
    const missing = path.join(root, 'never-created')

    const files = await openDaemonServiceFiles({ root: missing, uid: UID })
    expect(await files.inspectConfig(path.join(missing, 'a.service'))).toEqual({ present: false, owned: false })
    await expect(fs.access(missing)).rejects.toThrow()
  })
})

describe('two actions on the same install directory', () => {
  it('run one after the other instead of interleaving', async () => {
    const { root, unit, owners } = await makeRoot()
    const order: string[] = []
    const section = (name: string, text: string) => open(root, async (files) => {
      order.push(`${name}:start`)
      await files.writeConfig(unit, text)
      order.push(`${name}:done`)
    })

    await Promise.all([section('first', UNIT_A), section('second', UNIT_B)])

    expect([
      ['first:start', 'first:done', 'second:start', 'second:done'],
      ['second:start', 'second:done', 'first:start', 'first:done'],
    ]).toContainEqual(order)
    // The later writer reads owners inside its own lock, so it sees what the earlier one wrote and does not treat it as foreign.
    const text = await fs.readFile(unit, 'utf8')
    expect([UNIT_A, UNIT_B]).toContain(text)
    expect(await readOwners(owners)).toEqual({ [unit]: sha(text) })
    expect(await temps(path.dirname(unit))).toEqual([])
  })

  it('does not let a stale ownership view call the other run foreign', async () => {
    const { root, unit } = await makeRoot()
    const results = await Promise.all([
      open(root, (files) => files.writeConfig(unit, UNIT_A)).then(() => 'ok', (error: Error) => error.message),
      open(root, (files) => files.writeConfig(unit, UNIT_B)).then(() => 'ok', (error: Error) => error.message),
    ])
    expect(results).toEqual(['ok', 'ok'])
  })
})
