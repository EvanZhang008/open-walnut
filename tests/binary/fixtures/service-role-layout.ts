/**
 * An install root for the service-role tests (tests/binary/service-role*.test.ts): one follower spec
 * of Walnut w1 for LEADER, a launcher state naming the version, and a promoted data dir.
 * MACHINE SAFETY: temp dirs only.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SERVICE_MODE_FILE } from '../../../src/binary/service-mode.js'
import { guardedPath } from '../../setup/exec-guard.js'

const roots: string[] = []
export function cleanRoleLayouts(): void { for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }) }

export const LEADER = '/leader/walnut-home'
export const TOKEN = 'a'.repeat(64)

/** An install root with one follower spec of Walnut w1 for LEADER, a launcher state, and a promoted data dir. */
export function roleLayout(opts: { specs?: number; walnutId?: string; launcher?: boolean; envWalnutId?: string | null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'service-role-'))
  roots.push(root)
  const state = path.join(root, 'state')
  const exe = path.join(state, 'versions', 'abc', 'walnut')
  fs.mkdirSync(path.dirname(exe), { recursive: true })
  fs.writeFileSync(exe, '')
  fs.mkdirSync(path.join(state, 'host-server'), { recursive: true })
  const promoted = path.join(root, 'promoted-home')
  fs.mkdirSync(promoted)
  for (let i = 0; i < (opts.specs ?? 1); i++) {
    const spec = {
      v: 1, home: LEADER, walnutId: opts.walnutId ?? 'w1', cwd: path.join(root, 'data'),
      env: {
        OPEN_WALNUT_HOME: path.join(root, 'data'), WALNUT_DAEMON_DIR: path.join(root, 'run'), WALNUT_ROLE: 'replica',
        ...(opts.envWalnutId === null ? {} : { WALNUT_WALNUT_ID: opts.envWalnutId ?? opts.walnutId ?? 'w1' }), WALNUT_PLACEMENT: 'host',
      },
    }
    fs.writeFileSync(path.join(state, 'host-server', `server-000000000000000${i}.json`), JSON.stringify({ spec, token: TOKEN }))
  }
  if (opts.launcher !== false) {
    fs.mkdirSync(path.join(state, 'launcher'), { recursive: true })
    fs.writeFileSync(path.join(state, 'launcher', 'state'), `current=${exe}\ngood=${exe}\nphase=committed\nsince=1\n`)
  }
  const env: NodeJS.ProcessEnv = {
    HOME: root, PATH: guardedPath(), WALNUT_DAEMON_DIR: path.join(root, 'daemon'), WALNUT_DAEMON_STATE_DIR: state,
    WALNUT_DAEMON_SUPERVISOR: 'launcher', WALNUT_LAUNCHER_DIR: path.join(state, 'launcher'),
  }
  return { root, state, exe, promoted, env }
}

export const modeText = (state: string): string => fs.readFileSync(path.join(state, SERVICE_MODE_FILE), 'utf8')
