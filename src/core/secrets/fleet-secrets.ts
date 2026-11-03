/**
 * Fleet secrets: the Mac keeps each secret the user gives it and copies it to
 * the hosts the user picks, so a task there keeps working while the Mac is away
 * (the user, 2026-10-31: "the Mac as a secret manager that replicates it ...
 * because the Mac may go down; look at how T3 Code does it"). T3 Code never
 * copies a secret; every machine signs in by itself. We borrow its file
 * discipline (0700 dir, 0600 files, temp file then rename) and its rule that
 * settings and APIs carry only "set", never the value; the copying is ours.
 *
 * The Mac's copy (the master) lives outside the data home, in
 * `$XDG_STATE_HOME/open-walnut/secrets-master`, so git sync never carries it.
 * Each host's copy is its daemon's (src/providers/secrets-core.ts, capability
 * `secrets-v1`), sent over the link (hosts/link.ts) and never through the cloud
 * bridge. A rotate is a new version sent to every host it is shared with; a
 * revoke removes it there. A host that is away gets both when it next connects
 * (reconcileHost on every connect). A host's copy that the Mac never recorded
 * sending is left alone: another Walnut on the same host may own it. Every put
 * names this Walnut (`home`), which the host records as the copy's owner.
 *
 * Who may do what: only the user adds, rotates, shares or deletes a secret
 * (routes refuse a session: credentials are the user's, in the team charter);
 * agents list names, hosts and states, never values. Nothing here logs a value.
 *
 * A throwaway server (tests, ephemeral, a temp or task-dir data home, a fake
 * HOME) never touches the master or any host's copy unless WALNUT_FLEET_SECRETS=1:
 * its own local daemon shares the real HOME, and its empty master would read as
 * "revoke everything there".
 */
import fs from 'node:fs'
import path from 'node:path'
import { log } from '../../logging/index.js'
import { createSecretStore, envNameProblem, isSecretName, secretsRoot, type SecretStore } from '../../providers/secrets-core.js'

const LOCAL = '__local__'
const FLEET_FILE = '.fleet.json'
const PUSH_MS = 15_000

export class SecretsError extends Error {
  constructor(message: string, public status: number, public code: string) {
    super(message)
    this.name = 'SecretsError'
  }
}

/** One host's copy, as the Mac last saw it. */
export interface HostCopy {
  /** The version the host holds; null = removed (or never sent). */
  version: number | null
  at: number
  /** Why the last send failed (the host away, an older daemon), never a value. */
  error?: string
}

export interface FleetSecretMeta {
  name: string
  description?: string
  /** Hosts the user shares it with. */
  hosts: string[]
  /** The env var a session there gets it as, when `sessions`. */
  env?: string
  sessions?: boolean
  version: number
  createdAt: number
  updatedAt: number
  /** Deleted by the user: the row stays, with no hosts, only until every copy is gone. */
  deletedAt?: number
  /** Every host the Mac ever sent it to, and that copy's state: a revoke reaches each one. */
  copies: Record<string, HostCopy>
}

interface Fleet { secrets: Record<string, Omit<FleetSecretMeta, 'name'>> }

type Env = Record<string, string | undefined>

export function masterRoot(env: Env = process.env, home = process.env.HOME || ''): string {
  const override = env.WALNUT_SECRETS_MASTER_DIR
  if (override && path.isAbsolute(override)) return path.resolve(override)
  return path.join(path.dirname(secretsRoot(env, home)), 'secrets-master')
}

let activeOverride: boolean | null = null
/** Tests: force the store on or off (null = decide from the server, as in production). */
export function setFleetSecretsActiveForTest(v: boolean | null): void {
  activeOverride = v
}

/** Only the user's real Walnut keeps and sends secrets (see the file comment). */
export async function fleetSecretsActive(): Promise<boolean> {
  if (activeOverride !== null) return activeOverride
  const flag = process.env.WALNUT_FLEET_SECRETS
  if (flag === '1') return true
  if (flag === '0') return false
  const [{ semanticLaneDecision }, { IS_EPHEMERAL, WALNUT_HOME }] = await Promise.all([
    import('../search/semantic-default.js'), import('../../constants.js'),
  ])
  return semanticLaneDecision({ env: { ...process.env, WALNUT_SEARCH_V2_SEMANTIC: undefined }, isEphemeral: IS_EPHEMERAL, walnutHome: WALNUT_HOME }).on
}

let store: SecretStore | null = null
function master(): SecretStore {
  if (!store) store = createSecretStore(masterRoot())
  return store
}

function fleetFile(): string {
  return path.join(masterRoot(), FLEET_FILE)
}

/**
 * The fleet file, keyed with no prototype (a name like `__proto__` is only ever a
 * miss). Only a file that is not there yet reads as empty: any other failure throws,
 * because writing an "empty" fleet back would forget every secret and its versions.
 */
function readFleet(): Fleet {
  const secrets = Object.create(null) as Fleet['secrets']
  let text: string
  try {
    text = fs.readFileSync(fleetFile(), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { secrets }
    throw new SecretsError('Walnut could not read its list of secrets; nothing was changed', 500, 'fleet_unreadable')
  }
  let raw: Partial<Fleet>
  try {
    raw = JSON.parse(text) as Partial<Fleet>
  } catch {
    throw new SecretsError('Walnut\'s list of secrets is damaged; nothing was changed', 500, 'fleet_unreadable')
  }
  for (const [name, m] of Object.entries(raw?.secrets ?? {})) if (isSecretName(name) && m && typeof m === 'object') secrets[name] = m
  return { secrets }
}

function own(f: Fleet, name: string): Fleet['secrets'][string] | undefined {
  return Object.hasOwn(f.secrets, name) ? f.secrets[name] : undefined
}

let chain: Promise<unknown> = Promise.resolve()
/** One writer at a time; the fleet file is the Mac's alone. */
function mutate<T>(fn: (f: Fleet) => T): Promise<T> {
  const next = chain.then(async () => {
    const f = readFleet()
    const out = fn(f)
    const file = fleetFile()
    await fs.promises.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
    const tmp = `${file}.${process.pid}.tmp`
    await fs.promises.writeFile(tmp, JSON.stringify(f, null, 2) + '\n', { mode: 0o600 })
    await fs.promises.rename(tmp, file)
    return out
  })
  chain = next.catch(() => {})
  return next
}

function normHost(h: string): string {
  return !h || h === 'local' ? LOCAL : h
}

/** Every secret, with where it is shared and each copy's state. Never a value. */
export function listSecrets(): FleetSecretMeta[] {
  const f = readFleet()
  return Object.entries(f.secrets).map(([name, m]) => ({ name, ...m })).sort((a, b) => a.name.localeCompare(b.name))
}

async function assertActive(): Promise<void> {
  if (!(await fleetSecretsActive())) {
    throw new SecretsError('Secrets live with your own Walnut; this is a test or throwaway server', 409, 'isolated_server')
  }
}

/** The hosts asked for, each known to Walnut (or already holding a copy: a host removed from the config may still be unticked). */
async function knownHosts(hosts: string[], already: Set<string>): Promise<string[]> {
  const config = await configHosts()
  const out = [...new Set(hosts.map(normHost))]
  const unknown = out.filter((h) => h !== LOCAL && !Object.hasOwn(config, h) && !already.has(h))
  if (unknown.length) throw new SecretsError(`Unknown host: ${unknown.join(', ')} (host_list names them)`, 404, 'unknown_host')
  return out
}

async function configHosts(): Promise<Record<string, unknown>> {
  const { getConfig } = await import('../config-manager.js')
  return (await getConfig()).hosts ?? {}
}

export interface SetSecretInput {
  name: string
  /** A new value (a rotate); absent keeps the current one (sharing or env changes only). */
  value?: string
  hosts?: string[]
  env?: string | null
  sessions?: boolean
  description?: string
  /** Adding: refuse when the name is taken (409 exists), so Add never rotates by accident. */
  create?: boolean
}

/** Add a secret, rotate its value, or change where it is shared; then send each host what changed. */
export async function setSecret(input: SetSecretInput): Promise<FleetSecretMeta> {
  await assertActive()
  if (!isSecretName(input.name)) throw new SecretsError('A secret name is lower case letters, digits, . _ - (at most 64), like github-read', 400, 'bad_name')
  const envProblem = envNameProblem(input.env ?? undefined)
  if (envProblem) throw new SecretsError(envProblem, 400, 'bad_env')
  const name = input.name
  const before = own(readFleet(), name)
  const hosts = input.hosts
    ? await knownHosts(input.hosts, new Set([...(before?.hosts ?? []), ...Object.keys(before?.copies ?? {})]))
    : null
  const value = typeof input.value === 'string' && input.value !== '' ? input.value : null
  // Version, master value and meta in one step of the chain: two saves at once never share a version.
  const meta = await mutate((f) => {
    const prev = own(f, name)
    if (prev && input.create && !prev.deletedAt) throw new SecretsError(`A secret named ${name} already exists: edit it to rotate its value`, 409, 'exists')
    if (!prev && !value) throw new SecretsError(`Secret ${name} is new: give its value`, 400, 'value_required')
    const env = input.env === null ? undefined : (input.env ?? prev?.env)
    const sessions = input.sessions ?? prev?.sessions ?? false
    if (sessions && !env) throw new SecretsError('A secret sessions get in their environment needs an env name (GH_TOKEN)', 400, 'bad_env')
    // A new value, or a new way sessions get it, is a new version: each host's copy is replaced.
    const changed = !!value || !prev || env !== prev.env || sessions !== (prev.sessions === true)
    const held = master().list().secrets.find((e) => e.name === name)?.version ?? 0
    const version = changed ? Math.max(prev?.version ?? 0, held) + 1 : prev!.version
    // The master value first: a send never carries a version the Mac does not hold.
    if (value) master().put({ name, version, value, env, sessions })
    else if (changed) {
      const current = fs.readFileSync(path.join(masterRoot(), name), 'utf8')
      master().put({ name, version, value: current, env, sessions })
    }
    const now = Date.now()
    const m = prev ?? { hosts: [], version, createdAt: now, updatedAt: now, copies: {} }
    m.hosts = hosts ?? prev?.hosts ?? []
    m.version = version
    m.updatedAt = now
    delete m.deletedAt
    if (env) m.env = env; else delete m.env
    if (sessions) m.sessions = true; else delete m.sessions
    if (typeof input.description === 'string') m.description = input.description.slice(0, 300)
    f.secrets[name] = m
    return { name, ...m }
  })
  log.session.info('fleet secret set', { name, version: meta.version, hosts: meta.hosts, rotated: !!value, env: meta.env ?? null, sessions: meta.sessions === true })
  await sendSoon([...new Set([...meta.hosts, ...Object.keys(meta.copies)])])
  return listSecrets().find((x) => x.name === name) ?? meta
}

/** How long a save waits for its hosts before answering (the rest finishes in the background). */
const SEND_WAIT_MS = 8_000

/** Send to these hosts; answer once they are done or SEND_WAIT_MS passed, whichever first. */
export async function sendSoon(hosts: string[]): Promise<void> {
  const all = Promise.all(hosts.map((h) => reconcileHost(h).catch((err) => log.session.warn('fleet secrets: reconcile failed', { host: h, error: String(err) }))))
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([all, new Promise<void>((r) => { timer = setTimeout(r, SEND_WAIT_MS); timer.unref?.() })])
  clearTimeout(timer)
}

/** Delete a secret: from every host it was sent to, then from the Mac. */
export async function deleteSecret(name: string): Promise<{ name: string; pending: string[] }> {
  await assertActive()
  if (!isSecretName(name)) throw new SecretsError(`No secret ${name}`, 404, 'not_found')
  const config = await configHosts()
  const prev = await mutate((f) => {
    const m = own(f, name)
    if (!m) return null
    m.hosts = []
    m.updatedAt = Date.now()
    m.deletedAt = Date.now()
    // A host Walnut no longer knows can never be reached to remove its copy: forget it.
    for (const h of Object.keys(m.copies)) if (h !== LOCAL && !Object.hasOwn(config, h)) m.copies[h] = { version: null, at: Date.now(), error: 'no longer one of your hosts' }
    return { ...m }
  })
  if (!prev) throw new SecretsError(`No secret ${name}`, 404, 'not_found')
  await sendSoon(Object.keys(prev.copies))
  const left = own(readFleet(), name)
  const pending = Object.entries(left?.copies ?? {}).filter(([, c]) => c.version !== null || (c.error && c.error !== 'no longer one of your hosts')).map(([h]) => h)
  // Hosts still holding a copy (away now) keep the row, with no hosts, until they connect.
  if (!pending.length) await dropIfGone()
  log.session.info('fleet secret deleted', { name, pending })
  return { name, pending }
}

/** A deleted secret whose every copy is gone leaves the list and the master. */
async function dropIfGone(): Promise<void> {
  await mutate((f) => {
    for (const [name, m] of Object.entries(f.secrets)) {
      if (m.deletedAt && Object.values(m.copies).every((c) => c.version === null && (!c.error || c.error === 'no longer one of your hosts'))) {
        delete f.secrets[name]
        try { master().remove({ name }) } catch { /* already gone */ }
      }
    }
  })
}

const reconciling = new Map<string, Promise<void>>()

/** Bring one host's copies in line with the master: send what is new, remove what is no longer shared. */
export function reconcileHost(host: string): Promise<void> {
  const h = normHost(host)
  const running = reconciling.get(h)
  if (running) return running.then(() => reconcileHost(h))
  const run = (async () => {
    if (!(await fleetSecretsActive())) return
    const fleet = readFleet()
    // Shared here, or a copy here that may still exist (sent, or a send whose answer was lost).
    const relevant = Object.entries(fleet.secrets).filter(([, m]) => m.hosts.includes(h)
      || (Object.hasOwn(m.copies, h) && (m.copies[h].version !== null || !!m.copies[h].error)))
    if (!relevant.length) return
    const results: Record<string, HostCopy> = {}
    try {
      const [{ link }, { WALNUT_HOME }] = await Promise.all([import('../hosts/link.js'), import('../../constants.js')])
      let timer: ReturnType<typeof setTimeout> | undefined
      const conn = await Promise.race([
        link(h),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('the host did not answer')), PUSH_MS) }),
      ]).finally(() => clearTimeout(timer))
      if (!conn.hasCapability('secrets-v1')) throw new Error('its Walnut daemon needs an update (it updates on its next connect)')
      const listed = await conn.send('secrets.list', {}) as { ok?: boolean; secrets?: Array<{ name: string; version: number }>; error?: string }
      if (!listed.ok) throw new Error(listed.error ?? 'the host could not list its secrets')
      const there = new Map((listed.secrets ?? []).map((s) => [s.name, s.version]))
      for (const [name, m] of relevant) {
        const at = Date.now()
        try {
          if (m.hosts.includes(h)) {
            const entry = master().list().secrets.find((s) => s.name === name)
            if (!entry) throw new Error('the Mac no longer holds its value')
            const same = there.get(name) === m.version
            // Env and sessions ride the put too, so a sharing change is sent as one.
            if (!same || m.copies[h]?.version !== m.version || m.copies[h]?.error) {
              const value = fs.readFileSync(path.join(masterRoot(), name), 'utf8')
              const r = await conn.send('secrets.put', { name, version: m.version, value, ...(m.env ? { env: m.env } : {}), sessions: m.sessions === true, home: WALNUT_HOME }) as { ok?: boolean; error?: string; code?: string }
              if (!r.ok && r.code === 'stale_version') throw new Error('this host holds a newer copy (another Walnut there?); it was not replaced')
              if (!r.ok) throw new Error(r.error ?? 'the host refused it')
            }
            results[name] = { version: m.version, at }
          } else {
            const r = await conn.send('secrets.remove', { name, home: WALNUT_HOME }) as { ok?: boolean; error?: string }
            if (!r.ok) throw new Error(r.error ?? 'the host could not remove it')
            results[name] = { version: null, at }
          }
        } catch (err) {
          // A failed put may still have landed: the copy stays "maybe there", so a revoke removes it.
          results[name] = { version: m.copies[h]?.version ?? null, at, error: String((err as Error).message ?? err).replace(/^secrets\.\w+ failed: /, '').slice(0, 300) }
        }
      }
    } catch (err) {
      const why = String((err as Error).message ?? err).slice(0, 300)
      for (const [name, m] of relevant) results[name] = { version: m.copies[h]?.version ?? null, at: Date.now(), error: why }
    }
    await mutate((f) => {
      for (const [name, copy] of Object.entries(results)) {
        const m = own(f, name)
        if (m) m.copies[h] = copy
      }
    })
    await dropIfGone()
    const failed = Object.entries(results).filter(([, c]) => c.error).map(([n]) => n)
    log.session.info('fleet secrets reconciled', { host: h, secrets: Object.keys(results), failed })
  })().finally(() => reconciling.delete(h))
  reconciling.set(h, run)
  return run
}

/** The secret names a session on `host` can use, for its prompt: never a value. */
export function secretsForHost(host: string): Array<{ name: string; env?: string; sessions?: boolean; description?: string }> {
  const h = normHost(host)
  return listSecrets().filter((s) => s.hosts.includes(h) && s.copies[h]?.version === s.version)
    .map((s) => ({ name: s.name, ...(s.env ? { env: s.env } : {}), ...(s.sessions ? { sessions: true } : {}), ...(s.description ? { description: s.description } : {}) }))
}

/** The session prompt's line about the secrets on its host: names and how to use them, never a value. */
export async function secretsPromptLine(host: string | undefined): Promise<string> {
  if (!(await fleetSecretsActive())) return ''
  const list = secretsForHost(host || LOCAL)
  if (!list.length) return ''
  const items = list.map((s) => `${s.name}${s.env && s.sessions ? ` (already in your environment as $${s.env})` : ''}${s.description ? `: ${s.description}` : ''}`)
  return `Secrets the user shared with this host: ${items.join('; ')}. Each is a file in $WALNUT_SECRETS_DIR; use one inside the command `
    + 'that needs it (GH_TOKEN="$(cat "$WALNUT_SECRETS_DIR/<name>")" gh ...), never print, echo or write a value anywhere: '
    + 'your transcript and tool output are kept.\n\n'
}

let unwire: (() => void) | null = null
/** Every host that connects gets its copies brought in line (boot job `fleet-secrets`, leader only). */
export async function startFleetSecrets(): Promise<void> {
  if (unwire || !(await fleetSecretsActive())) return
  unwire = () => {}
  const dc = await import('../../providers/daemon-connection.js')
  unwire = dc.addOnDaemonHostConnected((host) => { void reconcileHost(host).catch((err) => log.session.warn('fleet secrets: reconcile failed', { host, error: String(err) })) })
  for (const s of listSecrets()) for (const h of new Set([...s.hosts, ...Object.keys(s.copies)])) void reconcileHost(h).catch(() => {})
}

/** Tests: forget the cached master store (its root may change between tests). */
export function resetFleetSecretsForTest(): void {
  store = null
  reconciling.clear()
  unwire?.()
  unwire = null
}
