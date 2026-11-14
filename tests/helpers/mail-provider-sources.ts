/**
 * The mail providers this repository ships, found from the source, for the guards that hold every
 * one of them to a rule (mail-provider-guards.test.ts). Enumerated rather than listed, so a provider
 * added next month is held to the rules without anybody remembering to add it.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Where a provider can live: built-in integrations, the shipped plugin store, the examples. */
export const SHIPPED_ROOTS = ['src/integrations', 'plugin-store', 'examples']
/** The fixtures the browser specs install, which the console renders like any other provider. */
export const FIXTURE_ROOTS = ['tests/e2e/browser/fixtures']

/** The base declares the contract; it is not a provider. */
const BASE = path.join('src', 'integrations', 'mail') + path.sep

export function sourceFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (at: string) => {
    if (!fs.existsSync(at)) return
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue
      const full = path.join(at, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.(ts|mts|js|mjs)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(full)
    }
  }
  walk(path.join(REPO_ROOT, dir))
  return out
}

/** The source without its comments, so a provider that only MENTIONS a method does not pass. */
export function codeOf(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
}

/** A file that builds a mail provider: it answers a folder list, a poll and a body. */
export function buildsProvider(code: string): boolean {
  return /\blistMailboxes\s*[:(]/.test(code) && /\bpoll\s*[:(]/.test(code) && /\bgetBody\s*[:(]/.test(code)
}

/** Every file under `roots` that builds a mail provider, the base excluded. */
export function mailProviderFiles(roots: string[]): string[] {
  return roots.flatMap(sourceFiles)
    .filter((file) => !path.relative(REPO_ROOT, file).startsWith(BASE))
    .filter((file) => buildsProvider(codeOf(fs.readFileSync(file, 'utf8'))))
}
