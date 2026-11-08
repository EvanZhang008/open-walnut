import fs from 'node:fs/promises'
import path from 'node:path'
import { chooseDtachMaster, dtachProbeScript, localShellRunner, parseDtachProbe, START_FN, stopDtachMaster } from '../web/terminal/dtach-master.js'
import type { DemoPaths } from './demo-home.js'
import { writeJsonFile } from '../utils/fs.js'
import { checkDemoTerminalDir } from '../lib/demo-terminal-dir.js'

type ProcessIdentity = { pid: number; start: string }
const quote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'"

async function waitForTerminalExit(targets: ProcessIdentity[]): Promise<void> {
  const deadline = Date.now() + 10_000
  for (;;) {
    const checks = targets.map(({ pid, start }) => `s=$(walnut_st ${pid}); if [ "$s" = ${quote(start)} ]; then z=$(LC_ALL=C ps -o stat= -p ${pid} 2>/dev/null); case "$z" in *Z*) ;; ?*) printf 'ALIVE\\n';; *) kill -0 ${pid} 2>/dev/null && printf 'UNKNOWN\\n';; esac; elif [ -z "$s" ] && kill -0 ${pid} 2>/dev/null; then printf 'UNKNOWN\\n'; fi`)
    const answer = await localShellRunner(`${START_FN}; ${checks.join('; ')}; printf 'CHECKED\\n'`)
    if (answer.code !== 0 || answer.stdout.includes('UNKNOWN') || !answer.stdout.includes('CHECKED')) throw new Error('Demo terminal exit could not be checked; data was kept')
    if (!answer.stdout.includes('ALIVE')) return
    if (Date.now() >= deadline) throw new Error('Demo terminal is still stopping; data was kept')
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

export async function stopDemoTerminals(paths: DemoPaths): Promise<void> {
  const hasTerminalDir = await checkDemoTerminalDir(paths.terminals, paths.data)
  const pendingFile = path.join(paths.data, 'demo-terminal-stop.json')
  let pending: ProcessIdentity[] = []
  let pendingSocket: string | undefined
  try {
    const handle = await fs.open(pendingFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    let value: { home: string; socket: string; processes: ProcessIdentity[] }
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || process.getuid && stat.uid !== process.getuid()) throw new Error('Demo terminal stop record is not owned by this account')
      value = JSON.parse(await handle.readFile('utf8'))
    } finally { await handle.close() }
    if (!value || value.home !== paths.data || typeof value.socket !== 'string'
      || path.dirname(value.socket) !== paths.terminals || !/^walnut-[a-zA-Z0-9_-]+\.dsock$/.test(path.basename(value.socket))
      || !Array.isArray(value.processes)
      || value.processes.some(p => !p || !Number.isSafeInteger(p.pid) || p.pid <= 1 || typeof p.start !== 'string' || !p.start)) {
      throw new Error('Demo terminal stop record is invalid; data was kept')
    }
    pending = value.processes
    pendingSocket = value.socket
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (pending.length) {
    if (hasTerminalDir) {
      const stopped = await stopDtachMaster(localShellRunner, pendingSocket!, { demo: true })
      if (stopped.outcome === 'left') throw new Error('Demo terminal ownership could not be confirmed; data was kept')
    }
    await waitForTerminalExit(pending)
    await fs.unlink(pendingFile)
    pending = []
  }
  if (!hasTerminalDir) return
  const dir = paths.terminals
  const entries = await fs.readdir(dir).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [] as string[]
    throw error
  })
  const ids = new Set(entries.map(name => /^walnut-([a-zA-Z0-9_-]+)\.(?:dsock|dpid)$/.exec(name)?.[1]).filter((id): id is string => !!id))
  for (const id of ids) {
    const socket = path.join(dir, `walnut-${id}.dsock`)
    let result = await localShellRunner(dtachProbeScript(socket, true))
    let probe = parseDtachProbe(result.stdout)
    if (result.code !== 0 || !probe.complete) throw new Error('Demo terminal could not be checked; data was kept')
    let choice = chooseDtachMaster(probe, socket)
    const birthDeadline = Date.now() + 5_000
    const bornMaster = choice.source === 'socket-owner' ? choice.targets : []
    // The child's record proves forkpty finished before we take the descendant snapshot.
    while (choice.targets.length && choice.source !== 'recorded') {
      if (Date.now() >= birthDeadline) throw new Error('Demo terminal has not recorded its started shell; data was kept')
      await new Promise(resolve => setTimeout(resolve, 100))
      result = await localShellRunner(dtachProbeScript(socket, true))
      probe = parseDtachProbe(result.stdout)
      if (result.code !== 0 || !probe.complete) throw new Error('Demo terminal could not be checked; data was kept')
      choice = chooseDtachMaster(probe, socket)
      if (choice.targets.length !== bornMaster.length
        || choice.targets.some(target => !bornMaster.some(old => old.pid === target.pid && old.start === target.start))) {
        throw new Error('Demo terminal identity changed before its shell was recorded; data was kept')
      }
    }
    const descendants = new Set(choice.targets.map(target => target.pid))
    const table = probe.table.map(line => /^\s*(\d+)\s+(\d+)\s+/.exec(line)).filter(Boolean)
    let changed = true
    while (changed) {
      changed = false
      for (const row of table) {
        if (descendants.has(Number(row![2])) && !descendants.has(Number(row![1]))) {
          descendants.add(Number(row![1])); changed = true
        }
      }
    }
    const starts = await localShellRunner(`${START_FN}; ${[...descendants].map(pid => `s=$(walnut_st ${pid}); if [ -n "$s" ]; then printf '${pid}:%s\\n' "$s"; elif kill -0 ${pid} 2>/dev/null; then printf '${pid}:UNKNOWN\\n'; else printf '${pid}:GONE\\n'; fi`).join('; ')}`)
    if (descendants.size && starts.code !== 0) throw new Error('Demo terminal children could not be checked; data was kept')
    const targets = starts.stdout.split('\n').map(line => /^(\d+):(.+)$/.exec(line)).filter(Boolean)
      .map(row => ({ pid: Number(row![1]), start: row![2]! })).filter(target => descendants.has(target.pid))
    if (targets.length !== descendants.size || targets.some(target => target.start === 'UNKNOWN')) throw new Error('Demo terminal children did not all report their identity; data was kept')
    const active = targets.filter(target => target.start !== 'GONE')
    if (active.length) await writeJsonFile(pendingFile, { home: paths.data, socket, processes: active }, { mode: 0o600, durable: true })
    const stopped = await stopDtachMaster(localShellRunner, socket, { demo: true })
    if (stopped.outcome === 'left') throw new Error('Demo terminal ownership could not be confirmed; data was kept')
    if (!choice.targets.length) continue
    if (active.length) { await waitForTerminalExit(active); await fs.unlink(pendingFile) }
  }
}
