/**
 * The env a host replica (`walnut web --replica`) boots with, for in-process
 * tests that run the real startServer as one (docs/plan/walnut-replica-servers-impl.md, WP1).
 * Every dir is a temp dir; the run dir is the worker's own (tests/setup/runtime-dir-isolation.ts).
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const LEADER_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
export const FOLLOWER_TOKEN = 'follower-token-for-tests-only'

export const sha256 = (t: string): string => crypto.createHash('sha256').update(t, 'utf-8').digest('hex')

export interface HostReplicaEnv { hostDaemonDir: string; restore(): void }

const KEYS = ['WALNUT_ROLE', 'WALNUT_PLACEMENT', 'WALNUT_HOST_SERVER', 'WALNUT_WALNUT_ID', 'WALNUT_FOLLOWER_TOKEN', 'WALNUT_HOST_DAEMON_DIR', 'OPEN_WALNUT_HOME'] as const

/** Sets the host replica env on this process (the data dir is the mocked WALNUT_HOME). */
export function useHostReplicaEnv(walnutHome: string): HostReplicaEnv {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
  const hostDaemonDir = fs.mkdtempSync(path.join(os.tmpdir(), 'replica-hostd-'))
  if (!process.env.WALNUT_DAEMON_DIR || process.env.WALNUT_DAEMON_DIR === '/tmp/open-walnut') {
    throw new Error('REFUSING: the worker has no isolated WALNUT_DAEMON_DIR')
  }
  Object.assign(process.env, {
    WALNUT_ROLE: 'replica', WALNUT_PLACEMENT: 'host', WALNUT_HOST_SERVER: '1',
    WALNUT_WALNUT_ID: LEADER_ID, WALNUT_FOLLOWER_TOKEN: FOLLOWER_TOKEN, WALNUT_HOST_DAEMON_DIR: hostDaemonDir,
    OPEN_WALNUT_HOME: walnutHome,
  })
  return {
    hostDaemonDir,
    restore() {
      for (const k of KEYS) {
        if (saved[k] === undefined) delete process.env[k]
        else process.env[k] = saved[k]
      }
      fs.rmSync(hostDaemonDir, { recursive: true, force: true })
    },
  }
}

/** Every file under `dir` with its size and content hash (relative paths). */
export function snapshotFiles(dir: string, keep: (rel: string) => boolean = () => true): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (d: string) => {
    let entries: fs.Dirent[] = []
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = path.join(d, e.name)
      const rel = path.relative(dir, p)
      if (e.isDirectory()) walk(p)
      else if (keep(rel)) {
        try { out[rel] = `${fs.statSync(p).size}:${crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 16)}` } catch { /* went */ }
      }
    }
  }
  walk(dir)
  return out
}
