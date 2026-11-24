/**
 * A temp HOME with the fake Antigravity CLI (tests/fixtures/antigravity/fake-agy.mjs) installed
 * at ~/.local/bin/agy, or not yet installed, plus a fake `curl` whose "installer" puts it there.
 * Nothing touches the real HOME, the network, or a real account.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createEngineSignIn, type EngineSignInDeps } from '../../src/providers/acp-engine-sign-in.js'
import { mergeAcpSpawnEnv } from '../../src/providers/acp-worker/protocol.js'
import { guardedPath } from '../setup/exec-guard-core.js'

export const FAKE_AGY = path.resolve(import.meta.dirname, '../fixtures/antigravity/fake-agy.mjs')

export interface FakeAgyHome { root: string; home: string; agy: string; env: NodeJS.ProcessEnv; signedInFile: string; envSeenFile: string; cleanup: () => void }

function wrapper(): string {
  return `#!/bin/sh\nexec "${process.execPath}" "${FAKE_AGY}" "$@"\n`
}

export function makeFakeAgyHome(opts: { installed?: boolean } = {}): FakeAgyHome {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-fake-agy-')))
  const home = path.join(root, 'home')
  const agy = path.join(home, '.local', 'bin', 'agy')
  const tools = path.join(root, 'tools')
  fs.mkdirSync(tools, { recursive: true })
  if (opts.installed !== false) {
    fs.mkdirSync(path.dirname(agy), { recursive: true })
    fs.writeFileSync(agy, wrapper(), { mode: 0o755 })
  }
  // `curl -fsSL <url>` prints an installer that writes the wrapper; it records the URL it was asked for.
  const script = `mkdir -p "$HOME/.local/bin" && cat > "$HOME/.local/bin/agy" <<'AGY'\n${wrapper()}AGY\nchmod 755 "$HOME/.local/bin/agy"\necho "installed agy"\n`
  fs.writeFileSync(path.join(root, 'installer.sh'), script)
  fs.writeFileSync(path.join(tools, 'curl'), `#!/bin/sh\nfor a in "$@"; do last="$a"; done\necho "$last" > "${path.join(root, 'curl-url')}"\ncat "${path.join(root, 'installer.sh')}"\n`, { mode: 0o755 })
  const env: NodeJS.ProcessEnv = { HOME: home, PATH: guardedPath([tools], '/usr/bin:/bin') }
  return {
    root, home, agy, env,
    signedInFile: path.join(home, '.gemini', 'antigravity-cli', 'fake-sign-in'),
    envSeenFile: path.join(home, '.gemini', 'antigravity-cli', 'fake-env.json'),
    cleanup: () => { if (root.includes('walnut-fake-agy-')) fs.rmSync(root, { recursive: true, force: true }) },
  }
}

/** The host side as a daemon builds it (acp-daemon.ts), on the fake HOME: its CLI is looked up in ~/.local/bin only. A second call is the next daemon on the same host. */
export function fakeHostSignIn(h: FakeAgyHome, waits?: EngineSignInDeps['waits']) {
  return createEngineSignIn({
    // The daemon's own dir: an install's record, output and exit code outlive this instance.
    stateDir: path.join(h.root, 'daemon'),
    spawn: (cmd, args, o) => spawn(cmd, args, o),
    env: h.env,
    findBinary: (spec) => {
      const p = path.join(h.home, '.local', 'bin', spec.binary)
      try { fs.accessSync(p, fs.constants.X_OK); return { path: p } } catch { return { reason: `${spec.binary} is not installed` } }
    },
    version: async () => '1.5.14',
    mergeEnv: mergeAcpSpawnEnv,
    ...(waits ? { waits } : {}),
  })
}
