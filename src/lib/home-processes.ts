/**
 * The processes of this account on this machine whose current folder is a given folder or under it (by folder: `/a/b`
 * holds `/a/b/c`, never `/a/b-c`). A leader switch's stop reads it once its sessions in the data home were stopped
 * (core/leader/switch/home-sessions.ts): a session's process still there fails the stop, anything else is named. It
 * only reads (no process is signalled): Linux by /proc/<pid>/cwd and cmdline, macOS by `lsof -a -d cwd -u <uid> -Fpcn`
 * and `ps -o args=`.
 *
 * It fails closed: a scan that could not read the processes throws (the stop must not pass on a list it never saw),
 * and so does a platform with no way to read them.
 *
 * Leaf module: node built-ins only.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'

export interface FolderProcess {
  pid: number
  name: string
  cwd: string
  /** Its command line, words joined by spaces ('' when it could not be read: a process that just ended). */
  args: string
}

function inside(cwd: string, roots: readonly string[]): boolean {
  return roots.some((r) => {
    const rel = path.relative(r, cwd)
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
  })
}

/** Processes of this account whose cwd is one of `roots` or under it, this process excepted. Throws when it cannot read them. */
export async function processesInFolders(roots: readonly string[], o: { platform?: NodeJS.Platform; uid?: number } = {}): Promise<FolderProcess[]> {
  const platform = o.platform ?? process.platform
  const uid = o.uid ?? process.getuid?.() ?? -1
  const resolved = roots.map((r) => path.resolve(r))
  if (platform === 'linux') return linux(resolved, uid)
  if (platform === 'darwin') return mac(resolved, uid)
  throw new Error(`the processes of this machine cannot be read on ${platform}`)
}

async function linux(roots: readonly string[], uid: number): Promise<FolderProcess[]> {
  const out: FolderProcess[] = []
  const names = await fs.readdir('/proc')
  await Promise.all(names.filter((n) => /^\d+$/.test(n)).map(async (n) => {
    const pid = Number(n)
    if (pid === process.pid) return
    try {
      const st = await fs.stat(`/proc/${n}`)
      if (uid >= 0 && st.uid !== uid) return
      const cwd = await fs.readlink(`/proc/${n}/cwd`)
      if (!inside(cwd, roots)) return
      const name = (await fs.readFile(`/proc/${n}/comm`, 'utf8').catch(() => '')).trim()
      const args = (await fs.readFile(`/proc/${n}/cmdline`, 'utf8').catch(() => '')).split('\0').filter(Boolean).join(' ')
      out.push({ pid, name, cwd, args })
    } catch { /* gone, or not ours to read */ }
  }))
  return out.sort((a, b) => a.pid - b.pid)
}

function run(cmd: string, args: string[]): Promise<{ code: number | null; stdout: string; error?: Error }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 10_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : null) : 0
      resolve({ code, stdout: String(stdout ?? ''), ...(err ? { error: err } : {}) })
    })
  })
}

async function mac(roots: readonly string[], uid: number): Promise<FolderProcess[]> {
  const ls = await run('lsof', ['-a', '-d', 'cwd', '-u', String(uid), '-Fpcn'])
  // lsof answers 1 when it lists nothing; a timeout, a missing lsof or any other failure is no list.
  if (ls.error && !(ls.code === 1 && !ls.stdout.trim())) throw new Error(`lsof could not list the processes' folders: ${ls.error.message}`)
  const out: FolderProcess[] = []
  let cur: { pid: number; name: string } | null = null
  for (const line of ls.stdout.split('\n')) {
    const tag = line[0]
    const v = line.slice(1)
    if (tag === 'p') cur = { pid: Number(v), name: '' }
    else if (tag === 'c' && cur) cur.name = v
    else if (tag === 'n' && cur && cur.pid !== process.pid && inside(v, roots)) out.push({ ...cur, cwd: v, args: '' })
  }
  if (out.length) {
    // Their command lines (a process that ended in between has none).
    const ps = await run('ps', ['-ww', '-o', 'pid=', '-o', 'args=', '-p', out.map((p) => p.pid).join(',')])
    if (ps.error && ps.code !== 1) throw new Error(`ps could not read the command lines: ${ps.error.message}`)
    const argsOf = new Map<number, string>()
    for (const line of ps.stdout.split('\n')) {
      const m = /^\s*(\d+)\s+(.*)$/.exec(line)
      if (m) argsOf.set(Number(m[1]), m[2]!)
    }
    for (const p of out) p.args = argsOf.get(p.pid) ?? ''
  }
  return out.sort((a, b) => a.pid - b.pid)
}
