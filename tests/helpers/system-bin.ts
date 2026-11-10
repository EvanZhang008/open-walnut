import fs from 'node:fs'
import path from 'node:path'

/** The system tool dirs a test PATH would otherwise list. */
export const SYSTEM_BIN_DIRS = ['/usr/bin', '/bin', '/usr/sbin', '/sbin']

/**
 * A directory `dir` holding a link to every tool of the system dirs but `without`, the first dir
 * in PATH order winning a name, for a test PATH that must not find those tools. Listing the
 * system dirs themselves is not enough: CI's Ubuntu image ships gh in /usr/bin, so a "no gh" test
 * found one there (tests/providers/git-commit-core.test.ts, and on 2026-11-10 the session commit
 * fixture, whose PR button then showed). Returns `dir`; throws when a name in `without` is still
 * reachable through it.
 */
export function systemBinWithout(dir: string, without: string[]): string {
  fs.mkdirSync(dir, { recursive: true })
  for (const sys of SYSTEM_BIN_DIRS) {
    let names: string[] = []
    try { names = fs.readdirSync(sys) } catch { continue }
    for (const name of names) {
      if (without.includes(name) || fs.existsSync(path.join(dir, name))) continue
      try { fs.symlinkSync(path.join(sys, name), path.join(dir, name)) } catch { /* a racing duplicate */ }
    }
  }
  for (const name of without) {
    let found = false
    try { fs.lstatSync(path.join(dir, name)); found = true } catch { /* absent, as wanted */ }
    if (found) throw new Error(`systemBinWithout: ${name} is still in ${dir}`)
  }
  return dir
}
