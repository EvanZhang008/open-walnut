/**
 * A fake host for host-runtime-core.ts: a map of files and a scripted execFile,
 * so the real classification, search order, caching and message text all run.
 * Shared by the host runtime tests.
 */
import fs from 'node:fs'
import type { HostRuntimeDeps } from '../../src/providers/host-runtime-core.js'

export const HOME = '/home/dev'

export interface FakeFile { content: string; exec?: boolean; linkTo?: string }
// killed: the child hit its timeout (execFile kills it and sets err.killed).
export type ExecScript = (file: string, args: string[], opts: Record<string, unknown>) => { code: number; stdout?: string; stderr?: string; killed?: boolean }

export function fakeHost(files: Record<string, FakeFile>, script: ExecScript, env: Record<string, string | undefined>) {
  const calls: Array<{ file: string; args: string[]; timeout: number; env: Record<string, unknown> }> = []
  const resolve = (p: string): FakeFile | undefined => {
    let f = files[p]
    for (let i = 0; f?.linkTo && i < 5; i++) f = files[f.linkTo]
    return f
  }
  const enoent = (p: string) => Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
  const fds = new Map<number, FakeFile>()
  let nextFd = 3
  const fakeFs = {
    constants: fs.constants,
    existsSync: (p: string) => !!resolve(String(p)) || Object.keys(files).some((k) => k.startsWith(String(p) + '/')),
    statSync: (p: string) => {
      const f = resolve(String(p))
      if (!f) throw enoent(String(p))
      return { isFile: () => true }
    },
    accessSync: (p: string) => { if (!resolve(String(p))?.exec) throw enoent(String(p)) },
    openSync: (p: string) => {
      const f = resolve(String(p))
      if (!f) throw enoent(String(p))
      fds.set(nextFd, f)
      return nextFd++
    },
    readSync: (fd: number, buf: Buffer) => {
      const bytes = Buffer.from(fds.get(fd)!.content, 'latin1')
      bytes.copy(buf, 0, 0, Math.min(bytes.length, buf.length))
      return Math.min(bytes.length, buf.length)
    },
    closeSync: (fd: number) => { fds.delete(fd) },
    readdirSync: (dir: string) => {
      const prefix = String(dir).replace(/\/$/, '') + '/'
      const names = new Set<string>()
      for (const k of Object.keys(files)) if (k.startsWith(prefix)) names.add(k.slice(prefix.length).split('/')[0])
      if (!names.size) throw enoent(String(dir))
      return [...names]
    },
  }
  const execFile: HostRuntimeDeps['execFile'] = (file, args, opts, cb) => {
    calls.push({ file, args, timeout: Number(opts.timeout), env: opts.env as Record<string, unknown> })
    const r = script(file, args, opts)
    const err = r.code === 0 && !r.killed ? null : Object.assign(new Error(`exit ${r.code}`), { code: r.code, killed: !!r.killed })
    queueMicrotask(() => cb(err, r.stdout ?? '', r.stderr ?? ''))
    return undefined
  }
  const deps: HostRuntimeDeps = { fs: fakeFs as unknown as HostRuntimeDeps['fs'], execFile, env }
  return { deps, calls }
}

export const NPM_CLI = '#!/usr/bin/env node\nimport "./dist/cli.js"\n'
export const ELF = '\x7fELF\x02\x01\x01\x00rest-of-binary'
export const glibcFail = { code: 1, stderr: "node: /lib64/libc.so.6: version `GLIBC_2.28' not found (required by node)" }

/** The fixture a remote user hit: npm claude symlinked into ~/.local/bin, nvm with too-new nodes. */
export function npmHostFiles(extra: Record<string, FakeFile> = {}): Record<string, FakeFile> {
  return {
    [`${HOME}/.local/bin/claude`]: { content: '', exec: true, linkTo: `${HOME}/.local/lib/node_modules/@anthropic-ai/claude-code/cli.js` },
    [`${HOME}/.local/lib/node_modules/@anthropic-ai/claude-code/cli.js`]: { content: NPM_CLI, exec: true },
    ...extra,
  }
}
