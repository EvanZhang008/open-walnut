import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { RegistryEntry, DaemonHooksConfig } from './daemon-core.js'
import { daemonInstallRoot, type DaemonServicePlatform } from './daemon-service-config.js'
import { probeCronProcess, readCronBootId } from './daemon-cron-host.js'
import type { CronProcessIdentity } from './daemon-cron-supervision.js'

interface HandoverSnapshot {
  version: 1
  instanceId: string
  owner: CronProcessIdentity
  registry: { version: 1; sessions: Record<string, RegistryEntry> }
  registryFile: string
  hooks: DaemonHooksConfig | null
}

interface HandoverLocation {
  stateDir: string
  uid: number
}

async function checkDirectory({ stateDir, uid }: HandoverLocation): Promise<void> {
  const stat = await fs.lstat(stateDir)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o077)) {
    throw new Error('Service handover directory is not private')
  }
}

async function readPrivate(target: string, uid: number): Promise<string | null> {
  let handle
  try { handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.uid !== uid || (stat.mode & 0o077)) throw new Error('Service handover file is not private')
    return await handle.readFile('utf8')
  } finally { await handle.close() }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

async function writePrivate(target: string, text: string, exclusive: boolean): Promise<void> {
  const temporary = `${target}.${randomUUID()}.tmp`
  let published = false
  try {
    const handle = await fs.open(temporary, 'wx', 0o600)
    try { await handle.writeFile(text); await handle.sync() } finally { await handle.close() }
    if (exclusive) await fs.link(temporary, target)
    else await fs.rename(temporary, target)
    published = true
    await syncDirectory(path.dirname(target))
  } catch (error) {
    if (published) throw Object.assign(new Error(`Handover publication was not flushed: ${String(error)}`), { code: 'handover-published' })
    throw error
  } finally { await fs.unlink(temporary).catch(() => {}) }
}

export async function prepareDaemonServiceHandover(input: HandoverLocation & {
  home: string
  platform: DaemonServicePlatform
  instanceId: string
  pid: number
  startTime: string | null
  entries: Record<string, RegistryEntry>
  registryFile: string
  hooks: DaemonHooksConfig | null
}): Promise<void> {
  if (path.resolve(input.stateDir) !== daemonInstallRoot(input.platform, input.home)) {
    throw new Error('Service handover requires the default host service directory')
  }
  await checkDirectory(input)
  if (!path.isAbsolute(input.registryFile) || await readPrivate(input.registryFile, input.uid) === null) {
    throw new Error('Service handover requires the current private registry')
  }
  const target = path.join(input.stateDir, 'handover.json')
  if (await readPrivate(target, input.uid) !== null) throw new Error('An earlier service handover is still pending')
  const deadline = AbortSignal.timeout(45_000)
  const bootId = await readCronBootId(input.platform, deadline)
  if (!bootId || !input.startTime) throw new Error('Service handover requires a host boot and daemon process identity')
  const entries: Record<string, RegistryEntry> = {}
  for (const [sid, entry] of Object.entries(input.entries)) {
    deadline.throwIfAborted()
    if (!entry.startTime) throw new Error('Service handover cannot prove a session process identity')
    const identity = { bootId: entry.bootId ?? bootId, pid: entry.pid, startTime: entry.startTime }
    const probe = await probeCronProcess(identity, bootId, input.platform, deadline)
    if (probe.status === 'unknown') throw new Error('Session process identity changed during service handover')
    if (probe.status === 'alive') entries[sid] = { ...entry, bootId }
  }
  const snapshot: HandoverSnapshot = {
    version: 1, instanceId: input.instanceId,
    owner: { bootId, pid: input.pid, startTime: input.startTime },
    registry: { version: 1, sessions: entries }, registryFile: input.registryFile, hooks: input.hooks,
  }
  deadline.throwIfAborted()
  await writePrivate(target, JSON.stringify(snapshot) + '\n', true)
}

export async function consumeDaemonServiceHandover(input: HandoverLocation & { platform: DaemonServicePlatform }): Promise<void> {
  await checkDirectory(input)
  const target = path.join(input.stateDir, 'handover.json')
  const raw = await readPrivate(target, input.uid)
  if (raw === null) return
  const snapshot = JSON.parse(raw) as HandoverSnapshot
  if (!snapshot || snapshot.version !== 1 || typeof snapshot.instanceId !== 'string'
    || typeof snapshot.registryFile !== 'string' || !path.isAbsolute(snapshot.registryFile)
    || snapshot.registry?.version !== 1 || !snapshot.registry.sessions || Array.isArray(snapshot.registry.sessions)
    || typeof snapshot.registry.sessions !== 'object'
    || (snapshot.hooks !== null && (snapshot.hooks?.version !== 1 || !Array.isArray(snapshot.hooks.hooks) || typeof snapshot.hooks.hash !== 'string'))) {
    throw new Error('Invalid daemon service handover snapshot')
  }
  if (!snapshot.owner || typeof snapshot.owner.bootId !== 'string' || typeof snapshot.owner.startTime !== 'string') {
    throw new Error('Invalid daemon service handover owner')
  }
  const bootId = await readCronBootId(input.platform, AbortSignal.timeout(5000))
  const owner = await probeCronProcess(snapshot.owner, bootId, input.platform, AbortSignal.timeout(5000))
  if (owner.status !== 'dead') throw new Error('The previous daemon has not confirmed its exit')
  for (const entry of Object.values(snapshot.registry.sessions)) {
    if (!entry || !Number.isSafeInteger(entry.pid) || entry.pid <= 1 || !entry.bootId || !entry.startTime
      || typeof entry.cwd !== 'string' || !Array.isArray(entry.args) || entry.args.some((arg) => typeof arg !== 'string')) {
      throw new Error('Invalid daemon service handover process')
    }
  }
  // The old daemon still receives CLI results and permission requests before it exits, so an early snapshot must not overwrite the final state.
  if (bootId === snapshot.owner.bootId) {
    const rawRegistry = await readPrivate(snapshot.registryFile, input.uid)
    if (rawRegistry === null) throw new Error('The previous daemon final registry is missing')
    const latest = JSON.parse(rawRegistry) as HandoverSnapshot['registry']
    if (latest?.version !== 1 || !latest.sessions || typeof latest.sessions !== 'object' || Array.isArray(latest.sessions)) {
      throw new Error('Invalid previous daemon final registry')
    }
    for (const [sid, entry] of Object.entries(snapshot.registry.sessions)) {
      const final = latest.sessions[sid]
      if (!final || final.pid !== entry.pid || final.startTime !== entry.startTime
        || (final.bootId && final.bootId !== entry.bootId)) {
        delete snapshot.registry.sessions[sid]
        continue
      }
      entry.pendingCtrl = final.pendingCtrl
      entry.turnRetry = final.turnRetry
    }
  }
  const hooksFile = path.join(input.stateDir, 'hooks.json')
  const registryFile = path.join(input.stateDir, 'sessions.json')
  await readPrivate(hooksFile, input.uid)
  await readPrivate(registryFile, input.uid)
  if (snapshot.hooks) await writePrivate(hooksFile, JSON.stringify(snapshot.hooks) + '\n', false)
  else {
    await fs.unlink(hooksFile).catch((error) => { if (error.code !== 'ENOENT') throw error })
    await syncDirectory(input.stateDir)
  }
  await writePrivate(registryFile, JSON.stringify(snapshot.registry) + '\n', false)
  await fs.unlink(target)
  await syncDirectory(input.stateDir)
}
