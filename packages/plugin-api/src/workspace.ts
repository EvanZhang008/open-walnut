/**
 * Workspace providers: the protocol a plugin's provider command speaks, and a
 * small helper that implements its framing.
 *
 * A provider is declared in the plugin's manifest under
 * `capabilities.workspace.providers` (see `WorkspaceProviderManifest`). Walnut's
 * daemon on the task's host runs the declared argv with no shell, once per
 * operation: ONE JSON request on stdin, ONE JSON reply on stdout. Anything on
 * stderr is shown to the user as progress (last line wins). Full reference:
 * docs/reference/workspace-providers.md in the Walnut repository.
 *
 * The daemon materializes at most one adapter script per provider and runs it
 * where the task's files live (possibly another machine), with no package
 * installed beside it. So a provider written with this helper must be bundled
 * into that one file (for example with esbuild `--bundle --platform=node`).
 */

export const WORKSPACE_PROTOCOL_VERSION = 1 as const

export type WorkspaceOperation = 'detect' | 'create' | 'listRepos' | 'status' | 'remove'

/** One entry of `capabilities.workspace.providers` in manifest.json. */
export interface WorkspaceProviderManifest {
  /** Lowercase id, unique across plugins (`[a-z0-9][a-z0-9._-]*`). */
  id: string
  displayName: string
  /** Higher wins when several providers claim a folder; git-worktree is 10. */
  priority?: number
  /** File names whose presence in the folder or an ancestor claims it. */
  markers?: string[]
  /** argv, no shell. `{script}` is the adapter's path on the host, a leading `~/` the host's home. */
  command: string[]
  /** One adapter file inside the plugin folder, shipped to the host with the allowlist (at most 512 KB). */
  script?: string
  /** Folders (absolute or `~/…`) a created workspace may live in besides the home folder. */
  roots?: string[]
  /** Seconds. create and remove default to 180, everything else to 30; at most 1800. */
  timeouts?: { createSec?: number; removeSec?: number; otherSec?: number }
  /** The operations it implements (default: all five). */
  operations?: WorkspaceOperation[]
  /** The fields the user fills in when choosing this provider. */
  inputSchema?: {
    type?: 'object'
    properties?: Record<string, {
      type: 'string' | 'boolean' | 'array'
      title?: string
      description?: string
      placeholder?: string
      enum?: string[]
      default?: unknown
      items?: { type: 'string' }
    }>
    required?: string[]
  }
}

export interface WorkspaceRepoRef {
  /** Absolute, or relative to the workspace root. */
  path: string
  name?: string
  branch?: string
}

export interface DetectArgs { anchor: string; markerRoot?: string }
export interface DetectResult { claimed: boolean; root?: string; reason?: string }

export interface CreateArgs {
  /** The folder the task was started from. */
  anchor: string
  /** A safe one-segment name for the new workspace (letters, digits, `.`, `_`, `-`). */
  name: string
  /** The nearest folder holding one of the provider's markers, when there is one. */
  markerRoot?: string
  taskId?: string
  title?: string
  baseRef?: string
  inputs: Record<string, unknown>
}
export interface CreateResult {
  /** Absolute, normalized; inside the home folder or a declared root; never holding `anchor`. */
  root: string
  /** Where sessions start (absolute or relative to root). Default: root. */
  cwd?: string
  /** Every git repository in the workspace. Listed here or by listRepos; Walnut checks each before removing. */
  repos?: WorkspaceRepoRef[]
  branch?: string
}

export interface ListReposArgs { root: string; inputs: Record<string, unknown> }
export interface ListReposResult { repos: WorkspaceRepoRef[] }

export interface RemoveArgs { root: string; repos: WorkspaceRepoRef[]; anchor?: string; inputs: Record<string, unknown> }
export interface RemoveResult { removed: boolean }

export interface WorkspaceRequest<Op extends WorkspaceOperation = WorkspaceOperation> {
  version: typeof WORKSPACE_PROTOCOL_VERSION
  operation: Op
  arguments: Op extends 'detect' ? DetectArgs
    : Op extends 'create' ? CreateArgs
      : Op extends 'listRepos' ? ListReposArgs
        : Op extends 'remove' ? RemoveArgs
          : Record<string, unknown>
}

export type WorkspaceReply<R = Record<string, unknown>> =
  | { version: typeof WORKSPACE_PROTOCOL_VERSION; ok: true; result: R }
  | { version: typeof WORKSPACE_PROTOCOL_VERSION; ok: false; error: string; code?: string }

export interface WorkspaceContext {
  /** One line of progress for the user ("Cloning 3 of 7"). */
  progress(line: string): void
}

/**
 * Handlers per operation. One left out answers `unsupported`; `status` is
 * normally left out, because Walnut probes every repository itself (git status,
 * unpushed commits) before any removal.
 */
export interface WorkspaceHandlers {
  detect?(args: DetectArgs, ctx: WorkspaceContext): Promise<DetectResult> | DetectResult
  create(args: CreateArgs, ctx: WorkspaceContext): Promise<CreateResult> | CreateResult
  listRepos?(args: ListReposArgs, ctx: WorkspaceContext): Promise<ListReposResult> | ListReposResult
  remove?(args: RemoveArgs, ctx: WorkspaceContext): Promise<RemoveResult> | RemoveResult
}

/** A failure with a short machine code next to the sentence the user reads. */
export class WorkspaceProviderError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message)
    this.name = 'WorkspaceProviderError'
  }
}

export interface WorkspaceIo {
  readStdin(): Promise<string>
  writeStdout(text: string): void
  writeStderr(text: string): void
}

function processIo(): WorkspaceIo {
  const proc = (globalThis as { process?: NodeJS.Process }).process
  if (!proc) throw new Error('serveWorkspaceProvider needs a Node-compatible runtime (process.stdin/stdout)')
  return {
    readStdin: () => new Promise((resolve, reject) => {
      let text = ''
      proc.stdin.setEncoding('utf8')
      proc.stdin.on('data', (chunk: string) => { text += chunk })
      proc.stdin.on('end', () => resolve(text))
      proc.stdin.on('error', reject)
    }),
    writeStdout: (text) => { proc.stdout.write(text) },
    writeStderr: (text) => { proc.stderr.write(text) },
  }
}

/** Parse one request (exported for tests of a provider). */
export function parseWorkspaceRequest(text: string): WorkspaceRequest | WorkspaceReply<never> {
  let v: unknown
  try { v = JSON.parse(text) } catch { return { version: 1, ok: false, error: 'the request was not JSON', code: 'bad_request' } }
  const r = v as Partial<WorkspaceRequest>
  if (!r || typeof r !== 'object' || typeof r.operation !== 'string') return { version: 1, ok: false, error: 'the request has no operation', code: 'bad_request' }
  if (r.version !== WORKSPACE_PROTOCOL_VERSION) return { version: 1, ok: false, error: `unsupported protocol version ${String(r.version)}`, code: 'bad_request' }
  return { version: 1, operation: r.operation, arguments: (r.arguments ?? {}) as never }
}

/** Run one operation: read the request, call the handler, write exactly one reply line. */
export async function serveWorkspaceProvider(handlers: WorkspaceHandlers, io: WorkspaceIo = processIo()): Promise<WorkspaceReply> {
  const reply = await (async (): Promise<WorkspaceReply> => {
    const req = parseWorkspaceRequest(await io.readStdin())
    if ('ok' in req) return req
    const ctx: WorkspaceContext = { progress: (line) => io.writeStderr(String(line).replace(/\s+/g, ' ').trim() + '\n') }
    const handler = (handlers as unknown as Record<string, ((a: unknown, c: WorkspaceContext) => unknown) | undefined>)[req.operation]
    if (typeof handler !== 'function') return { version: 1, ok: false, error: `${req.operation} is not implemented by this provider`, code: 'unsupported' }
    try {
      const result = await handler.call(handlers, req.arguments, ctx)
      return { version: 1, ok: true, result: (result ?? {}) as Record<string, unknown> }
    } catch (err) {
      return {
        version: 1, ok: false,
        error: err instanceof Error ? err.message : String(err),
        ...(err instanceof WorkspaceProviderError && err.code ? { code: err.code } : {}),
      }
    }
  })()
  io.writeStdout(JSON.stringify(reply) + '\n')
  return reply
}
