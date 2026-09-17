import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const port = Number(process.env.PW_TEST_PORT ?? 3457)
if (port === 3456) throw new Error('Production port is forbidden')
const manifest = process.env.WARM_FIXTURE_MANIFEST
if (!manifest) throw new Error('WARM_FIXTURE_MANIFEST is required')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-warm-ui-'))
process.argv.push('--_ephemeral-child')
Object.assign(process.env, {
  OPEN_WALNUT_HOME: root,
  HOME: root,
  USERPROFILE: root,
  SHELL: '/bin/sh',
  WALNUT_DAEMON_DIR: path.join(root, 'daemon'),
  WALNUT_STREAMS_DIR: path.join(root, 'streams'),
  WALNUT_DISABLE_BACKGROUND_AI: '1',
  WALNUT_DISABLE_SEARCH: '1',
  WALNUT_ENGINE_PROBE_ALL: '1',
  WALNUT_SNAPSHOT_STATUS: 'enforce',
  WARM_FIXTURE_ROOT: root,
  WALNUT_WEB_STATIC_DIR: path.resolve('dist/web/static'),
})
const bin = path.join(root, '.toolbox/bin')
fs.mkdirSync(bin, { recursive: true })
const mock = path.resolve('tests/providers/mock-warm-claude.mjs')
fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(mock)} "$@"\n`, { mode: 0o755 })
fs.mkdirSync(path.join(root, 'project'), { recursive: true })
fs.writeFileSync(path.join(root, 'config.yaml'), JSON.stringify({
  version: 1,
  defaults: { priority: 'none', platform: 'local' },
  provider: { type: 'claude-code' },
  agent: { triage: { debounce_minutes: 0 } },
}))
fs.writeFileSync(manifest, JSON.stringify({ root, port }))
const { startServer, stopServer, armGracefulSignalExit } = await import('../../../dist/web/server.js')
await startServer({ port, dev: false })
armGracefulSignalExit()
let closing = false
async function close() {
  if (closing) return
  closing = true
  await stopServer()
  const pidFile = path.join(root, 'daemon/daemon.pid')
  if (fs.existsSync(pidFile)) {
    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim())
    if (Number.isInteger(pid) && pid > 1) {
      try { process.kill(pid, 'SIGTERM') } catch {}
    }
  }
  process.exit(0)
}
process.on('SIGTERM', close)
process.on('SIGINT', close)
console.log(`Warm session fixture ready on ${port}`)
