/**
 * Child for tests/core/self-update/startup-update-wait.test.ts, run on bun as
 * `walnut web` is. It calls updateOnStart with the real startDetachedInstall (the
 * installer detached and unref'd, its log copied by an unref'd interval) and the
 * real watchStop (an unref'd budget timer), and an installer that is
 * `sh -c 'sleep <secs>; exit 0'` (2 s by default). Nothing else holds the event
 * loop, as in `walnut web` before it listens. It prints the outcome as one JSON
 * line on stdout.
 *
 *   bun startup-wait-child.ts <dir> [budget ms] [installer secs]
 */
import path from 'node:path'
import { startDetachedInstall } from '../../../../src/core/self-update/background-install.js'
import { updateOnStart, watchStop } from '../../../../src/core/self-update/startup-update.js'
import type { UpdateStatus } from '../../../../src/core/self-update/update-check.js'

const dir = process.argv[2]!
const budget = process.argv[3] ? Number(process.argv[3]) : undefined
const installerSecs = process.argv[4] ? Number(process.argv[4]) : 2
const started = Date.now()
const status: UpdateStatus = {
  enabled: true,
  install: { kind: 'npm', sourceDir: null, packageRoot: path.join(dir, 'lib/node_modules/open-walnut'), manager: 'npm', updateCommand: 'npm install -g open-walnut@latest' },
  current: '9.9.8', channel: 'stable', latest: '9.9.9', tags: { latest: '9.9.9', nightly: null }, available: true,
  checkedAt: new Date().toISOString(), error: null, checking: false, packageUrl: 'https://www.npmjs.com/package/open-walnut',
}

async function main() {
  const outcome = await updateOnStart({
    checkNow: async () => status,
    configAuto: async () => true,
    env: {},
    writable: () => true,
    run: async () => { throw new Error('this start installs through startInstall') },
    startInstall: (_file, _args, version) => startDetachedInstall('/bin/sh', ['-c', `sleep ${installerSecs}; exit 0`], {
      logFile: path.join(dir, 'update-install.log'), record: path.join(dir, 'update-installing.json'), version, tail: () => {},
    }),
    reexec: async () => ({ exitCode: 0, served: true, stopped: false, ms: 0 }),
    watch: () => (budget === undefined ? watchStop() : watchStop(budget)),
    err: (line) => { process.stderr.write(`${line}\n`) },
  })
  process.stdout.write(`${JSON.stringify({ outcome: outcome.kind, ms: Date.now() - started })}\n`)
}

void main()
