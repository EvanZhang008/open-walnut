/**
 * The host side of fleet secrets (src/core/secrets/fleet-secrets.ts): the copy
 * of each secret the user shared with THIS host, kept so the host's sessions
 * keep working while the Mac is away (the user, 2026-10-31: "the Mac as a
 * secret manager that replicates it, because the Mac may go down").
 *
 * Layout, under `$XDG_STATE_HOME/open-walnut/secrets` (secretsRoot):
 *   <name>          the value, exactly as given, mode 0600
 *   .index.json     names, versions, the env var a session gets it as; never a value
 * The directory is 0700. Every write is a temp file renamed into place, so a
 * reader never sees half a value. Nothing here is under the data home, so git
 * sync never carries it, and nothing here logs a value: the daemon logs only
 * command names, and every error names the secret, never its contents.
 *
 * A session reads a secret from its file (`$WALNUT_SECRETS_DIR/<name>`) inside
 * its own command, or gets it in its environment when the user said so
 * (`env` + `sessions`), so the value never has to appear in the transcript.
 *
 * Bundled into the binary daemon and shipped as the secrets-core.cjs sidecar
 * for the source twin; 'secrets-v1' is advertised only where it loads.
 */
import fs from 'node:fs'
import path from 'node:path'

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/
const ENV_RE = /^[A-Z_][A-Z0-9_]{0,63}$/
const INDEX = '.index.json'
const VALUE_MAX_BYTES = 64 * 1024
/** Environment names a secret may never replace: they steer the shell, Walnut, or the CLI itself. */
const RESERVED_ENV = /^(PATH|HOME|USER|SHELL|PWD|TMPDIR|LANG|TERM|LD_.*|DYLD_.*|NODE_OPTIONS|WALNUT_.*|OPEN_WALNUT_.*|CLAUDE_.*|ANTHROPIC_.*)$/

type Env = Record<string, string | undefined>

export function secretsRoot(env: Env, home: string): string {
  const override = env.WALNUT_SECRETS_DIR_ROOT
  if (override && path.isAbsolute(override)) return path.resolve(override)
  const state = env.XDG_STATE_HOME && path.isAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : path.join(home, '.local', 'state')
  return path.join(state, 'open-walnut', 'secrets')
}

export function isSecretName(name: unknown): name is string {
  return typeof name === 'string' && NAME_RE.test(name) && !name.includes('..')
}

/** A session env var name a secret may take, or why not. */
export function envNameProblem(env: unknown): string | null {
  if (env === undefined || env === null || env === '') return null
  if (typeof env !== 'string' || !ENV_RE.test(env)) return 'an env name is upper case letters, digits and _ (GH_TOKEN)'
  if (RESERVED_ENV.test(env)) return `${env} steers the shell or Walnut itself; pick another name`
  return null
}

export interface SecretEntry {
  name: string
  version: number
  /** The env var sessions on this host get it as, when `sessions`. */
  env?: string
  sessions?: boolean
  updatedAt: string
}

interface Index { secrets: Record<string, Omit<SecretEntry, 'name'>> }

function fail(message: string, code: string): never {
  throw Object.assign(new Error(message), { code })
}

export function createSecretStore(root: string, now: () => Date = () => new Date()) {
  function ensureRoot(): void {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 })
    // A directory made by someone else (or an older umask) is tightened, not trusted.
    try { if ((fs.statSync(root).mode & 0o777) !== 0o700) fs.chmodSync(root, 0o700) } catch { /* reported by the write */ }
  }

  function readIndex(): Index {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(root, INDEX), 'utf8')) as Partial<Index>
      return { secrets: raw && typeof raw.secrets === 'object' && raw.secrets ? raw.secrets : {} }
    } catch {
      return { secrets: {} }
    }
  }

  function writeAtomic(file: string, data: string | Buffer): void {
    const tmp = path.join(root, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`)
    const fd = fs.openSync(tmp, 'wx', 0o600)
    try { fs.writeSync(fd, typeof data === 'string' ? Buffer.from(data) : data); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    fs.renameSync(tmp, file)
  }

  function writeIndex(ix: Index): void {
    writeAtomic(path.join(root, INDEX), JSON.stringify(ix, null, 2) + '\n')
  }

  function list(): SecretEntry[] {
    const ix = readIndex()
    return Object.entries(ix.secrets)
      .filter(([name]) => isSecretName(name) && fs.existsSync(path.join(root, name)))
      .map(([name, e]) => ({ name, version: e.version, ...(e.env ? { env: e.env } : {}), ...(e.sessions ? { sessions: true } : {}), updatedAt: e.updatedAt }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  /** Store a value (a newer version replaces it; the same version is a no-op). */
  function put(req: { name?: unknown; version?: unknown; value?: unknown; env?: unknown; sessions?: unknown }): SecretEntry {
    if (!isSecretName(req.name)) fail('a secret name is lower case letters, digits, . _ - (at most 64)', 'bad_name')
    if (typeof req.version !== 'number' || !Number.isInteger(req.version) || req.version < 1) fail(`secret ${req.name}: version must be a positive integer`, 'bad_request')
    if (typeof req.value !== 'string' || req.value === '') fail(`secret ${req.name}: the value is empty`, 'bad_request')
    if (Buffer.byteLength(req.value) > VALUE_MAX_BYTES) fail(`secret ${req.name}: the value is over ${VALUE_MAX_BYTES} bytes`, 'too_large')
    const envProblem = envNameProblem(req.env)
    if (envProblem) fail(`secret ${req.name}: ${envProblem}`, 'bad_env')
    ensureRoot()
    const ix = readIndex()
    const prev = ix.secrets[req.name]
    if (prev && prev.version > req.version) fail(`secret ${req.name}: this host already has version ${prev.version}`, 'stale_version')
    writeAtomic(path.join(root, req.name), req.value)
    ix.secrets[req.name] = {
      version: req.version,
      ...(typeof req.env === 'string' && req.env ? { env: req.env } : {}),
      ...(req.sessions === true ? { sessions: true } : {}),
      updatedAt: now().toISOString(),
    }
    writeIndex(ix)
    return list().find((e) => e.name === req.name)!
  }

  /** Remove a secret's value and its index row. Removing one that is not here is fine. */
  function remove(req: { name?: unknown }): { name: string; removed: boolean } {
    if (!isSecretName(req.name)) fail('a secret name is lower case letters, digits, . _ - (at most 64)', 'bad_name')
    const file = path.join(root, req.name)
    let removed = false
    try { fs.unlinkSync(file); removed = true } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err }
    const ix = readIndex()
    if (ix.secrets[req.name]) { delete ix.secrets[req.name]; ensureRoot(); writeIndex(ix); removed = true }
    return { name: req.name, removed }
  }

  /** Keep exactly these names: every other secret on this host is removed (the Mac's revoke while the host was away). */
  function sync(req: { keep?: unknown }): { removed: string[] } {
    const keep = new Set(Array.isArray(req.keep) ? req.keep.filter(isSecretName) : [])
    const removed: string[] = []
    const names = new Set(Object.keys(readIndex().secrets))
    try { for (const f of fs.readdirSync(root)) if (isSecretName(f)) names.add(f) } catch { /* no dir yet */ }
    for (const name of names) {
      if (keep.has(name) || !isSecretName(name)) continue
      remove({ name })
      removed.push(name)
    }
    return { removed }
  }

  /** The env a new session on this host gets: each secret the user said sessions may have. */
  function sessionEnv(): Record<string, string> {
    const out: Record<string, string> = {}
    for (const e of list()) {
      if (!e.sessions || !e.env || envNameProblem(e.env)) continue
      try { out[e.env] = fs.readFileSync(path.join(root, e.name), 'utf8') } catch { /* gone between list and read */ }
    }
    return out
  }

  return { root, list: () => ({ root, secrets: list() }), put, remove, sync, sessionEnv }
}

export type SecretStore = ReturnType<typeof createSecretStore>
