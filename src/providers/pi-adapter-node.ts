/**
 * The Node that runs pi, used to run pi's ACP adapter too (2026-11-02). The adapter
 * (dist/daemon-binaries/pi-acp.js) is plain JS; started with the compiled walnut file it
 * costs a second boot of that large file before pi itself starts (0.5 to 1.5 s each on a
 * busy Mac, where Node starts in about 0.2 s). pi's launcher names its Node in its first
 * line: `#!/usr/bin/env node` (the node on PATH) or an absolute path. Anything else (a
 * native build, a wrapper script, a file that cannot be read) keeps the walnut file.
 */
import fs from 'node:fs/promises'
import path from 'node:path'

async function executable(file: string): Promise<boolean> {
  try {
    const st = await fs.stat(file)
    if (!st.isFile()) return false
    await fs.access(file, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** The interpreter a `#!` line names, when it is Node; null otherwise. */
export function nodeFromShebang(firstLine: string): { onPath: string } | { file: string } | null {
  const m = /^#!\s*(\S+)(?:\s+(.*))?$/.exec(firstLine.trim())
  if (!m) return null
  const [, interp, rest = ''] = m
  if (path.basename(interp) === 'env') {
    // `env node`, `env -S node --flag`: the first word that is not an option.
    const word = rest.split(/\s+/).find((w) => w && !w.startsWith('-'))
    return word && /^node(\d+)?$/.test(word) ? { onPath: word } : null
  }
  return /^node(\d+)?$/.test(path.basename(interp)) ? { file: interp } : null
}

export async function piNodeFor(piExecutable: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  let head: string
  try {
    const handle = await fs.open(await fs.realpath(piExecutable), 'r')
    try {
      const buf = Buffer.alloc(256)
      const { bytesRead } = await handle.read(buf, 0, buf.length, 0)
      head = buf.subarray(0, bytesRead).toString('utf8')
    } finally {
      await handle.close()
    }
  } catch {
    return undefined
  }
  const wanted = nodeFromShebang(head.split('\n', 1)[0] ?? '')
  if (!wanted) return undefined
  // The worker spawns the adapter in the session's cwd, so only an absolute path names the same file.
  if ('file' in wanted) return path.isAbsolute(wanted.file) && (await executable(wanted.file)) ? wanted.file : undefined
  for (const dir of (env.PATH ?? '').split(path.delimiter).filter((d) => path.isAbsolute(d))) {
    const candidate = path.join(dir, wanted.onPath)
    if (await executable(candidate)) return candidate
  }
  return undefined
}
