import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { Writable } from 'node:stream'

const SCRIPT = 'IFS= read -r walnut_start <&3 || exit 125; [ "$walnut_start" = run ] || exit 125; exec 3<&-; exec "$@"'

export function spawnBehindRegistry(
  program: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; stdio: [number, number, number] },
): { process: ChildProcess; release(): void; abort(): void } {
  const candidates = program.includes('/') ? [path.resolve(options.cwd, program)]
    : (options.env.PATH ?? '/usr/bin:/bin').split(':').map((dir) => path.resolve(options.cwd, dir, program))
  let executable: string | undefined
  let accessError: unknown
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      if (fs.statSync(candidate).isFile()) { executable = candidate; break }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') accessError = error
    }
  }
  if (!executable) throw accessError ?? Object.assign(new Error(`Executable not found: ${program}`), { code: 'ENOENT' })
  const child = spawn('/bin/sh', ['-c', SCRIPT, 'walnut-start', executable, ...args], {
    ...options, detached: true, stdio: [...options.stdio, 'pipe'],
  })
  const gate = child.stdio[3] as Writable | null
  gate?.on('error', () => {})
  return {
    process: child,
    release() {
      if (!gate || gate.destroyed) throw new Error('Process exited before registry commit')
      gate.end('run\n')
    },
    abort() { gate?.destroy() },
  }
}
