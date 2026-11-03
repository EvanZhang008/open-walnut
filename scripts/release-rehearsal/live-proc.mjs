/**
 * Process questions the live-update rehearsal asks (live.mjs): who listens on a
 * port, whose child a process is, is it alive. Read-only: nothing here signals
 * anything. Linux reads /proc; elsewhere `ps` and `lsof`.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'

export const alive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 1) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

export const groupAlive = (pgid) => {
  if (!Number.isInteger(pgid) || pgid <= 1) return false
  try { process.kill(-pgid, 0); return true } catch { return false }
}

/** The parent pid of `pid`, or null when it is gone. */
export function parentOf(pid) {
  try {
    if (fs.existsSync('/proc/self/stat')) {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
      return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
    }
    return Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim()) || null
  } catch { return null }
}

/** When `pid` started, in clock ticks since boot (Linux), or its pid elsewhere: smaller is older. */
export function startedAt(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19])
  } catch { return pid }
}

/** Every live process whose parent is `pid`. */
export function childrenOf(pid) {
  if (fs.existsSync('/proc/self/stat')) {
    const out = []
    for (const name of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue
      if (parentOf(Number(name)) === pid) out.push(Number(name))
    }
    return out
  }
  try {
    return execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' }).split('\n')
      .map((l) => l.trim().split(/\s+/).map(Number)).filter(([, pp]) => pp === pid).map(([p]) => p)
  } catch { return [] }
}

/** The command line of `pid` (for the report), or ''. */
export function commandOf(pid) {
  try {
    if (fs.existsSync(`/proc/${pid}/cmdline`)) return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ')
    return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim()
  } catch { return '' }
}

/** Socket inodes listening on `port` (IPv4 and IPv6), from /proc/net/tcp*. */
function listeningInodes(port) {
  const hex = port.toString(16).toUpperCase().padStart(4, '0')
  const inodes = new Set()
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let lines = []
    try { lines = fs.readFileSync(f, 'utf8').split('\n').slice(1) } catch { continue }
    for (const line of lines) {
      const cols = line.trim().split(/\s+/)
      if (cols.length < 10) continue
      // local_address is ADDR:PORT; st 0A is LISTEN.
      if (cols[1].endsWith(`:${hex}`) && cols[3] === '0A') inodes.add(cols[9])
    }
  }
  return inodes
}

/** The pids holding a listening socket on `port` (this user's processes only). */
export function listenersOf(port) {
  if (!fs.existsSync('/proc/net/tcp')) {
    try {
      return execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' }).split('\n').filter(Boolean).map(Number)
    } catch { return [] }
  }
  const inodes = listeningInodes(port)
  if (inodes.size === 0) return []
  const out = []
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue
    let fds = []
    try { fds = fs.readdirSync(`/proc/${name}/fd`) } catch { continue }
    for (const fd of fds) {
      let target = ''
      try { target = fs.readlinkSync(`/proc/${name}/fd/${fd}`) } catch { continue }
      const m = /^socket:\[(\d+)\]$/.exec(target)
      if (m && inodes.has(m[1])) { out.push(Number(name)); break }
    }
  }
  return out
}

/** What `pid`'s open file descriptors point at (Linux), or []. */
export function openPaths(pid) {
  const dir = `/proc/${pid}/fd`
  let fds = []
  try { fds = fs.readdirSync(dir) } catch { return [] }
  const out = []
  for (const fd of fds) { try { out.push(fs.readlinkSync(`${dir}/${fd}`)) } catch { /* closed meanwhile */ } }
  return out
}

/** CPU time `pid` used (user + system, clock ticks; Linux), or null. */
export function cpuTicks(pid) {
  try {
    const f = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    const cols = f.slice(f.lastIndexOf(')') + 2).split(' ')
    return Number(cols[11]) + Number(cols[12])
  } catch { return null }
}
