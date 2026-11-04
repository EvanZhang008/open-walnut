/**
 * Another update's runner dir, named the latest (src/providers/daemon-update-shell.ts t_later):
 *   alive  a real `/bin/sh <dir>/update.sh` process, as the launcher starts a runner;
 *   reused its update.pid names a live process that is not that runner (this test process),
 *          as when a dead runner's pid was reused by whatever started next;
 *   dead   its update.pid names no process;
 *   done   alive, and it wrote update.done.
 *   hung   alive, its command line naming update.sh, and its update.pid older than a runner may
 *          run (RUNNER_MAX_MINUTES): a runner that hangs.
 *
 * MACHINE SAFETY: the only processes are the script it starts in a process group of its own (and
 * its `sleep`); `stop()` signals only that group (pid > 1 checked) and removes only the dir it
 * made under /tmp.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export type FakeRunnerState = 'alive' | 'reused' | 'dead' | 'done' | 'hung'

export interface FakeRunner { dir: string; stop(): void }

export function fakeUpdateRunner(state: FakeRunnerState, latest?: string): FakeRunner {
  const dir = fs.mkdtempSync('/tmp/open-walnut-update.')
  // Not `exec sleep`: the shell itself must stay, its command line naming update.sh.
  fs.writeFileSync(path.join(dir, 'update.sh'), 'sleep 120\n:\n', { mode: 0o700 })
  let child: ReturnType<typeof spawn> | undefined
  let pid: number
  if (state === 'alive' || state === 'done' || state === 'hung') {
    child = spawn('/bin/sh', [path.join(dir, 'update.sh')], { stdio: 'ignore', detached: true })
    child.unref()
    pid = child.pid!
  } else {
    pid = state === 'reused' ? process.pid : 2 ** 22 + 4321
  }
  fs.writeFileSync(path.join(dir, 'update.pid'), `${pid}\n`)
  if (state === 'hung') { const t = new Date(Date.now() - 2 * 60 * 60_000); fs.utimesSync(path.join(dir, 'update.pid'), t, t) }
  if (state === 'done') fs.writeFileSync(path.join(dir, 'update.done'), 'rc=0 tries=1 tail=serving\n')
  if (latest) fs.writeFileSync(latest, `${dir}\n`)
  return {
    dir,
    stop() {
      if (child?.pid && child.pid > 1) { try { process.kill(-child.pid, 'SIGKILL') } catch { /* gone */ } }
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}
