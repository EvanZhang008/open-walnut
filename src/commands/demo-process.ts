import fs from 'node:fs/promises'
import { execFile } from 'node:child_process'

export async function demoProcessStart(pid: number, format?: 'ps'): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error('Invalid Demo process identity')
  if (process.platform === 'linux' && format !== 'ps') {
    try {
      const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8')
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      if (!/^\d+$/.test(fields[19] ?? '')) throw new Error('Demo process start time could not be read')
      return `proc:${fields[19]}`
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }
  return new Promise((resolve, reject) => {
    execFile('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { timeout: 5000, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } }, (error, stdout) => {
      const start = stdout.trim().replace(/\s+/g, ' ')
      if (!error && start) { resolve(`ps:${start}`); return }
      try { process.kill(pid, 0) }
      catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ESRCH') { resolve(null); return } }
      reject(new Error('Demo process identity is unavailable; no data was cleared'))
    })
  })
}

export async function demoServerGroupGone(state: { pid: number; startTime?: string }): Promise<boolean> {
  if (!Number.isSafeInteger(state.pid) || state.pid <= 1) throw new Error('Invalid Demo server process group')
  let missing = false
  try { process.kill(state.pid, 0) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false
    missing = true
  }
  if (!missing) {
    if (!state.startTime) return false
    const current = await demoProcessStart(state.pid, state.startTime.startsWith('ps:') ? 'ps' : undefined)
    // A live process group reserves its id on both Darwin and Linux, so a reused pid proves the old group ended.
    if (current !== null) return current !== state.startTime
  }
  try { process.kill(-state.pid, 0); return false }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' }
}

export async function demoProcessGone(state: { pid: number; startTime?: string }): Promise<boolean> {
  if (!Number.isSafeInteger(state.pid) || state.pid <= 1) throw new Error('Invalid Demo process identity')
  try { process.kill(state.pid, 0) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true }
  if (!state.startTime) return false
  const current = await demoProcessStart(state.pid, state.startTime.startsWith('ps:') ? 'ps' : undefined)
  return current === null || current !== state.startTime
}
