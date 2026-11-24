/**
 * createDaemonRuntime's code as one text, for the ratchets that scan the whole runtime.
 *
 * The runtime is daemon-standalone.ts plus its area modules (daemon-git.ts, daemon-skills.ts,
 * ...): code that was in its body, moved to `create<Area>(deps)` factories. A ratchet that
 * reads only daemon-standalone.ts would stop seeing that code, so it reads this instead: the
 * standalone file, then each area module with its factory body dedented by the factory's two
 * spaces, so a declaration at the factory's top level sits at column 0 as it did in the
 * runtime's body.
 *
 * An area module is a file in src/providers/ that imports './daemon-module-deps.js' (every one
 * does, for the reply and log types its deps share).
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../..')
const PROVIDERS = path.join(ROOT, 'src/providers')

/** The area modules, repo-relative, sorted. */
export function daemonAreaModules(): string[] {
  return fs.readdirSync(PROVIDERS)
    .filter((f) => f.endsWith('.ts') && f !== 'daemon-module-deps.ts')
    .filter((f) => /from '\.\/daemon-module-deps\.js'/.test(fs.readFileSync(path.join(PROVIDERS, f), 'utf8')))
    .map((f) => `src/providers/${f}`)
    .sort()
}

/** One area module as the runtime's text: its imports as they are, its factory body (from `export function create`) dedented by two spaces. */
export function areaModuleText(rel: string): string {
  const text = fs.readFileSync(path.join(ROOT, rel), 'utf8')
  const start = text.search(/^export function create\w+/m)
  if (start < 0) throw new Error(`${rel}: no create<Area> factory`)
  return text.slice(0, start) + text.slice(start).split('\n').map((l) => (l.startsWith('  ') ? l.slice(2) : l)).join('\n')
}

/** daemon-standalone.ts, then every area module (areaModuleText). */
export function daemonRuntimeText(): string {
  const standalone = fs.readFileSync(path.join(ROOT, 'src/providers/daemon-standalone.ts'), 'utf8')
  return [standalone, ...daemonAreaModules().map(areaModuleText)].join('\n')
}
