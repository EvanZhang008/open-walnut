import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const evidence = fs.mkdtempSync('/tmp/walnut-warm-verify-')
const run = (command, args, env = {}) => {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
console.log(`Verification evidence: ${evidence}`)
run('npm', ['run', 'web:build'])
run(path.join(root, 'node_modules/.bin/playwright'), [
  'test', '--config', 'tests/e2e/browser/warm-session.config.ts', '--output', path.join(evidence, 'browser-results'),
], {
  WARM_FIXTURE_MANIFEST: path.join(evidence, 'fixture.json'),
  PW_SCREENSHOT_DIR: evidence,
})
