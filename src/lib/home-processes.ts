/**
 * The processes of this account on this machine whose current folder is a given folder or under it (by folder: `/a/b`
 * holds `/a/b/c`, never `/a/b-c`). A leader switch's stop reads it once its sessions in the data home were stopped
 * (core/leader/switch/home-sessions.ts): what is still there is named. It only reads (no process is signalled):
 * Linux by /proc/<pid>/cwd, macOS by `lsof -a -d cwd -u <uid> -Fpcn`. Another platform answers nothing.
 *
 * Leaf module: node built-ins only.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'

export interface FolderProcess { pid: number; name: string; cwd: string }

function inside(cwd: string, roots: readonly string[]): boolean {
  return roots.some((r) => {
    const rel = path.relative(r, cwd)
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
  })
}

/** Processes of this account whose cwd is one of `roots` or under it, this process excepted. */
export async function processesInFolders(roots: readonly string[], o: { platform?: NodeJS.Platform; uid?: number } = {}): Promise<FolderProcess[]> {
  const platform = o.platform ?? process.platform
  const uid = o.uid ?? process.getuid?.() ?? -1
  const resolved = roots.map((r) => path.resolve(r))
  if (platform === 'linux') return linux(resolved, uid)
  if (platform === 'darwin') return mac(resolved, uid)
  return []
}

async function linux(roots: readonly string[], uid: number): Promise<FolderProcess[]> {
  const out: FolderProcess[] = []
  const names = await fs.readdir('/proc').catch(() => [] as string[])
  await Promise.all(names.filter((n) => /^\d+$/.test(n)).map(async (n) => {
    const pid = Number(n)
    if (pid === process.pid) return
    try {
      const st = await fs.stat(`/proc/${n}`)
      if (uid >= 0 && st.uid !== uid) return
      const cwd = await fs.readlink(`/proc/${n}/cwd`)
      if (!inside(cwd, roots)) return
      const name = (await fs.readFile(`/proc/${n}/comm`, 'utf8').catch(() => '')).trim()
      out.push({ pid, name, cwd })
    } catch { /* gone, or not ours to read */ }
  }))
  return out.sort((a, b) => a.pid - b.pid)
}

async function mac(roots: readonly string[], uid: number): Promise<FolderProcess[]> {
  const text = await new Promise<string>((resolve) => {
    execFile('lsof', ['-a', '-d', 'cwd', '-u', String(uid), '-Fpcn'], { timeout: 10_000, maxBuffer: 16 * 1024 * 1024 }, (_err, stdout) => resolve(String(stdout ?? '')))
  })
  const out: FolderProcess[] = []
  let cur: { pid: number; name: string } | null = null
  for (const line of text.split('\n')) {
    const tag = line[0]
    const v = line.slice(1)
    if (tag === 'p') cur = { pid: Number(v), name: '' }
    else if (tag === 'c' && cur) cur.name = v
    else if (tag === 'n' && cur && cur.pid !== process.pid && inside(v, roots)) out.push({ ...cur, cwd: v })
  }
  return out.sort((a, b) => a.pid - b.pid)
}
