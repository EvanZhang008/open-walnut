/**
 * Walnut runs only on bun (docs/plan/walnut-single-binary.md, "One runtime").
 * The modules built on bun's own APIs (src/lib/pty.ts, src/lib/transpile.ts)
 * check ON_BUN to refuse clearly on Node instead of failing somewhere deeper.
 */
import { singleFile } from './single-file.js'

/** True when this process runs on bun. */
export const ON_BUN = typeof (process.versions as { bun?: string }).bun === 'string'

/** The runtime this process runs on, in words (`bun 1.4.4`): process.version on bun is the Node it imitates. */
export function runtimeVersion(): string {
  const bun = (process.versions as { bun?: string }).bun
  return typeof bun === 'string' ? `bun ${bun}` : `node ${process.version}`
}

/** bun's global, typed only as far as Walnut uses it (no bun-types in this repo). */
export function bunGlobal<T>(): T {
  const bun = (globalThis as { Bun?: unknown }).Bun
  if (!bun) throw new Error('not running on bun')
  return bun as T
}

const inBunfs = (p: string | undefined): boolean => !!p && (p.includes('/$bunfs/') || p.includes('~BUN'))

/**
 * True inside the compiled Walnut file: its entry recorded itself
 * (src/lib/single-file.ts), or it runs from bun's virtual filesystem (another
 * build compiling this code). Its import.meta.url points at the unpacked
 * runtime tree on disk, so that does not tell.
 */
export function runsCompiledFile(): boolean {
  if (singleFile()) return true
  const main = (globalThis as { Bun?: { main?: string } }).Bun?.main
  return inBunfs(main) || inBunfs(process.argv[1])
}

/**
 * Does this process's executable act as bun only when told (BUN_BE_BUN=1)? A
 * walnut file does: the compiled file itself, and a walnut file running a dist
 * build as bun, where neither the entry nor argv[1] says so. Decided from the
 * executable, never the entry; a bun binary is named bun (bun-debug, bun.exe).
 */
export function execNeedsBunBeBun(execPath: string = process.execPath): boolean {
  return runsCompiledFile() || !/^bun(-debug|-profile)?(\.exe)?$/i.test(execPath.split(/[\\/]/).pop() ?? '')
}

/**
 * How this process runs bun itself: a script outside the compiled file's own
 * tree, `-e` code, `bun info`, `bun add`. From source that is the bun binary
 * running this process. A walnut file (execNeedsBunBeBun) acts as the bun CLI
 * when BUN_BE_BUN=1 is in its env; it carries all of bun, so a machine needs no
 * other bun, Node or npm. For a bun binary the variable is dropped: bun ignores
 * it, and a child must not hand it on to a walnut file it starts.
 */
export function bunCommand(env: NodeJS.ProcessEnv = process.env, execPath: string = process.execPath): { command: string; env: NodeJS.ProcessEnv } {
  const out: NodeJS.ProcessEnv = { ...env }
  if (execNeedsBunBeBun(execPath)) out.BUN_BE_BUN = '1'
  else delete out.BUN_BE_BUN
  return { command: execPath, env: out }
}
