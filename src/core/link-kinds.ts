/**
 * Link kinds: who knows a service's links. Walnut ships GitHub's; a plugin adds its own service
 * (a company's code review tool, its build pipelines) with `walnut.registry.linkKind(...)`, and the
 * handle it gets back withdraws it. Core holds no service-specific rule beyond the public forges.
 *
 * A kind is a tag key (`cr`) and up to two ways its links reach a task:
 *   match  a regex whose whole match is one of its URLs, for links people paste and sessions name
 *          (link-tags.ts linkTagsInText, linkEntriesFromField);
 *   made   the links a session's own command made: `gh pr create`, a code review tool's CLI, a
 *          `git push` straight to the main branch. Walnut remembers each Bash command `made.command`
 *          matches and, when its output arrives, asks `made.links` for the URLs it made
 *          (link-made-hook.ts). It gets the command, its output and the git pushes Walnut read in
 *          that output, so a service only maps a pushed commit to its own commit page.
 * Its links take a place among the task's three like any other (link-tags.ts MAX_LINK_TAGS); the
 * session's LINKS list decides which three stay, a code review or ticket first.
 */

import type { Disposable } from './plugins/disposable.js'
import { toDisposable } from './plugins/disposable.js'
import { isTagKey } from './tag-model.js'
import { canonicalLinkUrl, type LinkPattern } from './link-tags.js'
import { GITHUB_PR_URL_RE } from './pull-requests/model.js'

/** One ref a `git push` moved, as git printed it. */
export interface GitPush {
  /** The remote as git printed it after "To " (`github.com:acme/app.git`, `ssh://host/pkg/App`). */
  remote: string
  /** The branch it moved on the remote. */
  branch: string
  /** The commit it moved to (as printed: short), and from, when git said. */
  to: string
  from?: string
  /** The remote's main line (main, master, mainline, trunk): a push there is a change without a review. */
  main: boolean
}

export interface MadeRun {
  command: string
  output: string
  pushes: GitPush[]
}

export interface LinkKindSpec {
  /** Unique id; a plugin's is prefixed with the plugin id. */
  id: string
  /** The tag key its links get (`cr`, `pr`, `commit`). */
  key: string
  /** A regex source; its whole match is one URL of this kind. */
  match?: string
  made?: {
    /** A regex source over a Bash command line: the runs worth reading the output of. */
    command: string
    /** The URLs the run made, or none. */
    links(run: MadeRun): readonly string[] | null | undefined
  }
}

interface RegisteredLinkKind extends LinkKindSpec {
  owner: string
  commandRe?: RegExp
}

const kinds = new Map<string, RegisteredLinkKind>()

function compileCommand(source: string | undefined): RegExp | undefined {
  if (!source) return undefined
  try { return new RegExp(source) } catch { return undefined }
}

/** Add a kind. Throws on a bad spec or a taken id (a plugin's mistake, shown at its load). */
export function registerLinkKind(owner: string, spec: LinkKindSpec): Disposable {
  const key = String(spec?.key ?? '').trim().toLowerCase()
  if (!spec?.id || !isTagKey(key)) throw new Error(`linkKind: a kind needs an id and a tag key, got ${JSON.stringify({ id: spec?.id, key: spec?.key })}`)
  if (spec.match !== undefined) {
    try { new RegExp(spec.match) } catch (err) { throw new Error(`linkKind "${spec.id}": match is not a regex: ${(err as Error).message}`) }
  }
  const commandRe = compileCommand(spec.made?.command)
  if (spec.made && (!commandRe || typeof spec.made.links !== 'function')) throw new Error(`linkKind "${spec.id}": made needs a command regex and a links function`)
  if (kinds.has(spec.id)) throw new Error(`linkKind "${spec.id}" is already registered`)
  const entry: RegisteredLinkKind = { ...spec, key, owner, ...(commandRe ? { commandRe } : {}) }
  kinds.set(spec.id, entry)
  return toDisposable(() => { if (kinds.get(spec.id) === entry) kinds.delete(spec.id) })
}

/** The patterns plugins added, for effectiveLinkPatterns. */
export function pluginLinkPatterns(): LinkPattern[] {
  return [...kinds.values()].filter((k) => k.owner !== 'core' && k.match).map((k) => ({ key: k.key, match: k.match! }))
}

/** Whether any kind reads this command's output. */
export function commandMakesLinks(command: string): boolean {
  ensureCoreLinkKinds()
  return [...kinds.values()].some((k) => k.commandRe?.test(command))
}

/** The `key:url` link tags a finished command made, by every kind that reads it. A kind that throws
 *  costs only its own links. */
export function linksMadeBy(command: string, output: string): string[] {
  ensureCoreLinkKinds()
  const run: MadeRun = { command, output, pushes: gitPushes(output) }
  const out: string[] = []
  for (const kind of kinds.values()) {
    if (!kind.commandRe?.test(command)) continue
    let urls: readonly string[] | null | undefined
    try { urls = kind.made!.links(run) } catch { continue }
    for (const url of urls ?? []) {
      const canonical = typeof url === 'string' ? canonicalLinkUrl(url) : undefined
      if (canonical && !out.includes(`${kind.key}:${canonical}`)) out.push(`${kind.key}:${canonical}`)
    }
  }
  return out
}

const MAIN_BRANCHES: ReadonlySet<string> = new Set(['main', 'master', 'mainline', 'trunk'])
const TO_RE = /^To\s+(\S+)\s*$/
// `   1a2b3c4..5d6e7f8  main -> main`, `+ 1a2b3c4...5d6e7f8 main -> main (forced update)`,
// ` * [new branch]      fix -> fix`.
const REF_RE = /^\s*[+*\s]?\s*(?:([0-9a-f]{7,40})\.\.\.?([0-9a-f]{7,40})|\[new branch\])\s+(\S+)\s+->\s+(\S+)/

/** The refs every `git push` in the output moved (refused and up-to-date ones are not printed so).
 *  A new branch (`* [new branch] main -> main`) has no commit in git's line, so it is left out: the
 *  first push of a repository is not a change worth a link. */
export function gitPushes(output: string): GitPush[] {
  const out: GitPush[] = []
  let remote: string | undefined
  for (const raw of output.split(/\r?\n/)) {
    const to = TO_RE.exec(raw.trim())
    if (to) { remote = to[1]; continue }
    if (!remote) continue
    const ref = REF_RE.exec(raw)
    if (!ref || !ref[2]) continue
    const branch = ref[4]!.replace(/^refs\/heads\//, '')
    out.push({ remote, branch, to: ref[2], from: ref[1], main: MAIN_BRANCHES.has(branch) })
  }
  return out
}

// ── GitHub, Walnut's own ──

/** The pull request URL gh printed: the last line that is a pull request URL and nothing else, so a
 *  `gh pr list` after it, or an issue link in a template, is not taken for it. */
export function createdPrUrl(output: string): string | null {
  const lines = output.split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim()
    if (GITHUB_PR_URL_RE.test(line)) return line
  }
  return null
}

/** `owner/repo` of a GitHub remote as git prints it, or undefined. */
export function githubRepoOfRemote(remote: string): string | undefined {
  const m = /^(?:https?:\/\/|ssh:\/\/)?(?:[\w.-]+@)?github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(remote)
  return m ? `${m[1]}/${m[2]}` : undefined
}

// `gh -R acme/app pr create`, `git -C dir -c k=v --no-pager push`: global options before the verb.
export const GH_PR_CREATE_COMMAND = String.raw`(?:^|[\s;&|(\x60])gh(?:\s+(?:-R|--repo)\s+\S+)?\s+pr\s+create\b`
export const GIT_PUSH_COMMAND = String.raw`(?:^|[\s;&|(\x60])git(?:\s+(?:-[Cc]\s+(?:"[^"]*"|'[^']*'|\S+)|--[\w-]+(?:=\S+)?))*\s+push\b`

let coreReady = false
/** Walnut's own kinds, registered once on first use. */
export function ensureCoreLinkKinds(): void {
  if (coreReady) return
  coreReady = true
  registerLinkKind('core', {
    id: 'github-pr',
    key: 'pr',
    made: { command: GH_PR_CREATE_COMMAND, links: (run) => { const url = createdPrUrl(run.output); return url ? [url] : [] } },
  })
  registerLinkKind('core', {
    id: 'github-commit',
    key: 'commit',
    made: {
      command: GIT_PUSH_COMMAND,
      links: (run) => run.pushes.flatMap((p) => {
        const repo = p.main ? githubRepoOfRemote(p.remote) : undefined
        return repo ? [`https://github.com/${repo}/commit/${p.to}`] : []
      }),
    },
  })
}

/** Every kind registered now, Walnut's first. */
export function listLinkKinds(): readonly LinkKindSpec[] {
  ensureCoreLinkKinds()
  return [...kinds.values()]
}

/** For tests: every plugin kind withdrawn, Walnut's registered again on next use. */
export function _resetLinkKindsForTesting(): void {
  kinds.clear()
  coreReady = false
}
