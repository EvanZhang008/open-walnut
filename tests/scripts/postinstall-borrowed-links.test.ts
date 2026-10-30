/**
 * A clone that borrows another checkout's node_modules (a symlink) and runs
 * `bun install` must not leave that checkout loading the clone's workspace
 * packages. Bun writes the links before any lifecycle script runs (checked on bun
 * 1.4.4), so postinstall points them back (2026-10-29: the main checkout's
 * @open-walnut/plugin-api led into a push clone's unbuilt copy for 15 hours).
 *
 * MACHINE SAFETY: every checkout is a temp dir; the real-bun case installs only
 * a workspace package, so it needs no network.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { restoreBorrowedWorkspaceLinks } from '../../scripts/postinstall.mjs'
import { testBun } from '../helpers/bun-runtime.js'

const POSTINSTALL = path.resolve(__dirname, '../../scripts/postinstall.mjs')
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })

/** A dev checkout: workspaces plugin-api and plugin-cli, the real postinstall. */
function checkout(root: string): void {
  for (const name of ['plugin-api', 'plugin-cli']) {
    fs.mkdirSync(path.join(root, 'packages', name), { recursive: true })
    fs.writeFileSync(path.join(root, 'packages', name, 'package.json'), JSON.stringify({ name: `@open-walnut/${name}`, version: '1.0.0' }))
  }
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true })
  fs.copyFileSync(POSTINSTALL, path.join(root, 'scripts', 'postinstall.mjs'))
  fs.mkdirSync(path.join(root, 'web'), { recursive: true })
  fs.writeFileSync(path.join(root, 'web', 'package.json'), JSON.stringify({ name: 'web', private: true }))
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: 'fixture-root', private: true, workspaces: ['packages/plugin-api', 'packages/plugin-cli'],
    dependencies: { '@open-walnut/plugin-api': 'workspace:*', '@open-walnut/plugin-cli': 'workspace:*' },
    scripts: { postinstall: 'node scripts/postinstall.mjs' },
  }))
}

function pair(): { owner: string; clone: string } {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-borrowed-nm-')))
  dirs.push(base)
  const owner = path.join(base, 'owner')
  const clone = path.join(base, 'clone')
  checkout(owner)
  checkout(clone)
  return { owner, clone }
}

const linkOf = (root: string, name: string) => fs.realpathSync(path.join(root, 'node_modules', '@open-walnut', name))

describe('a clone that borrows node_modules', () => {
  it('points every workspace link back at the owner and names the owner', () => {
    const { owner, clone } = pair()
    fs.mkdirSync(path.join(owner, 'node_modules', '@open-walnut'), { recursive: true })
    // What bun left: the owner's links lead into the clone.
    for (const name of ['plugin-api', 'plugin-cli']) {
      fs.symlinkSync(path.join(clone, 'packages', name), path.join(owner, 'node_modules', '@open-walnut', name))
    }
    fs.symlinkSync(path.join(owner, 'node_modules'), path.join(clone, 'node_modules'))
    const said: string[] = []
    expect(restoreBorrowedWorkspaceLinks(clone, { warn: (m) => said.push(m) })).toBe(owner)
    for (const name of ['plugin-api', 'plugin-cli']) expect(linkOf(owner, name)).toBe(path.join(owner, 'packages', name))
    // Relative, as bun writes them, so the owner can move.
    expect(fs.readlinkSync(path.join(owner, 'node_modules', '@open-walnut', 'plugin-api'))).toBe('../../packages/plugin-api')
    expect(said.join('\n')).toContain(owner)
  })

  it('does nothing for a checkout with its own node_modules', () => {
    const { owner } = pair()
    fs.mkdirSync(path.join(owner, 'node_modules', '@open-walnut'), { recursive: true })
    const said: string[] = []
    expect(restoreBorrowedWorkspaceLinks(owner, { warn: (m) => said.push(m) })).toBeNull()
    expect(said).toEqual([])
  })

  const BUN = testBun()
  it.skipIf(!BUN)('a real `bun install` in the clone leaves the owner on its own packages', () => {
    const { owner, clone } = pair()
    const env = { ...process.env, npm_config_user_agent: undefined, CI: undefined }
    const own = spawnSync(BUN!, ['install'], { cwd: owner, env, encoding: 'utf8', timeout: 60_000 })
    expect(own.status, own.stderr).toBe(0)
    expect(linkOf(owner, 'plugin-api')).toBe(path.join(owner, 'packages', 'plugin-api'))
    fs.symlinkSync(path.join(owner, 'node_modules'), path.join(clone, 'node_modules'))
    const borrowed = spawnSync(BUN!, ['install'], { cwd: clone, env, encoding: 'utf8', timeout: 60_000 })
    // The install says what happened and fails, so the clone's author reads it.
    expect(borrowed.status).not.toBe(0)
    expect(borrowed.stderr + borrowed.stdout).toContain('Pointed them back')
    for (const name of ['plugin-api', 'plugin-cli']) expect(linkOf(owner, name)).toBe(path.join(owner, 'packages', name))
  }, 120_000)
})
