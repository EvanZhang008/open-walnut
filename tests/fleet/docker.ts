/**
 * The fleet's only door to Docker. Every container, network and image it makes,
 * touches or removes is named `walnut-fleet-*` and labelled `walnut-fleet=1`;
 * a name without the prefix is refused before `docker` runs (fleetName), so a
 * typo or a bad variable can never reach the user's own containers, images or
 * volumes. Volumes are never made or removed at all.
 *
 * sweep() removes what a crashed earlier run left: containers and networks with
 * the label whose owner process (the label `walnut-fleet.owner`) is gone. A run
 * that is still going keeps its own.
 *
 * Images are kept between runs (the cache): `walnut-fleet-host:<hash of the build
 * context>` and the base they build on, `walnut-fleet-base:<tag>`. removeImages()
 * removes them all (`bash scripts/run-fleet-tests.sh clean`).
 */
import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const PREFIX = 'walnut-fleet-'
export const LABEL = 'walnut-fleet'
export const OWNER_LABEL = 'walnut-fleet.owner'
const NAME_RE = /^walnut-fleet-[a-z0-9][a-z0-9_.-]{0,100}(:[A-Za-z0-9_.-]{1,128})?$/

/** `name` when it is one of the fleet's (prefix, plain characters, an optional :tag); throws otherwise. */
export function fleetName(name: string): string {
  if (typeof name !== 'string' || !NAME_RE.test(name)) throw new Error(`fleet: refusing a Docker name outside ${PREFIX}*: ${JSON.stringify(name)}`)
  return name
}

export interface DockerResult { code: number; stdout: string; stderr: string }

/** One `docker` call; never throws for a non-zero exit (`code` says it). */
export function docker(args: string[], opts: { timeoutMs?: number; input?: string } = {}): Promise<DockerResult> {
  return new Promise((resolve) => {
    const child = execFile('docker', args, { timeout: opts.timeoutMs ?? 60_000, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') || (err && code !== 0 ? String(err.message) : '') })
    })
    if (opts.input !== undefined) child.stdin?.end(opts.input)
  })
}

async function ok(args: string[], what: string, timeoutMs?: number): Promise<string> {
  const r = await docker(args, { timeoutMs })
  if (r.code !== 0) throw new Error(`fleet: ${what} failed (docker ${args.slice(0, 3).join(' ')} ...): ${r.stderr.trim().slice(-1500)}`)
  return r.stdout
}

/** Why Docker cannot be used here, or null when it can. */
export async function dockerUnavailable(): Promise<string | null> {
  const r = await docker(['info', '--format', '{{.ServerVersion}} {{.Architecture}}'], { timeoutMs: 15_000 })
  if (r.code !== 0) return (r.stderr.trim().split('\n').pop() || 'docker info failed').slice(0, 300)
  return null
}

/** The Docker VM's architecture as Go names it (arm64, amd64). */
export async function dockerArch(): Promise<string> {
  const out = await ok(['version', '--format', '{{.Server.Arch}}'], 'docker version', 15_000)
  return out.trim()
}

const ownerAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 1) return false
  try { process.kill(pid, 0); return true } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM' }
}

/** Removes the containers and networks of fleet runs whose owner process is gone. Returns their names. */
export async function sweep(): Promise<string[]> {
  const removed: string[] = []
  const rows = (await ok(['ps', '-a', '--filter', `label=${LABEL}=1`, '--format', `{{.Names}}\t{{.Label "${OWNER_LABEL}"}}`], 'listing fleet containers')).split('\n').filter(Boolean)
  for (const row of rows) {
    const [name, owner] = row.split('\t')
    if (!name?.startsWith(PREFIX) || ownerAlive(Number(owner))) continue
    await docker(['rm', '-f', fleetName(name)], { timeoutMs: 60_000 })
    removed.push(name)
  }
  const nets = (await ok(['network', 'ls', '--filter', `label=${LABEL}=1`, '--format', `{{.Name}}\t{{.Label "${OWNER_LABEL}"}}`], 'listing fleet networks')).split('\n').filter(Boolean)
  for (const row of nets) {
    const [name, owner] = row.split('\t')
    if (!name?.startsWith(PREFIX) || ownerAlive(Number(owner))) continue
    await docker(['network', 'rm', fleetName(name)], { timeoutMs: 30_000 })
    removed.push(name)
  }
  return removed
}

const labels = (run: string) => ['--label', `${LABEL}=1`, '--label', `${OWNER_LABEL}=${process.pid}`, '--label', `walnut-fleet.run=${run}`]

export async function imageExists(tag: string): Promise<boolean> {
  return (await docker(['image', 'inspect', fleetName(tag)], { timeoutMs: 15_000 })).code === 0
}

/**
 * The base image every host builds on, under the fleet's own name. Pulled once
 * from its public name and tagged `walnut-fleet-base:<tag>`; the public tag is
 * removed again only when this pull made it (one the user already had stays).
 */
export async function ensureBase(publicRef: string, fleetTag: string): Promise<void> {
  if (await imageExists(fleetTag)) return
  const had = (await docker(['image', 'inspect', publicRef], { timeoutMs: 15_000 })).code === 0
  if (!had) await ok(['pull', publicRef], `pulling ${publicRef}`, 600_000)
  await ok(['tag', publicRef, fleetName(fleetTag)], 'tagging the base image')
  if (!had) await docker(['rmi', publicRef], { timeoutMs: 60_000 })
}

/** sha256 (12 hex) over every file of a build context, names included. */
export function contextHash(dir: string): string {
  const h = crypto.createHash('sha256')
  const walk = (d: string, rel: string) => {
    for (const name of fs.readdirSync(d).sort()) {
      const p = path.join(d, name)
      const r = rel ? `${rel}/${name}` : name
      if (fs.statSync(p).isDirectory()) { walk(p, r); continue }
      h.update(r).update('\0').update(fs.readFileSync(p)).update('\0')
    }
  }
  walk(dir, '')
  return h.digest('hex').slice(0, 12)
}

/** Builds `repo:<context hash>` from `dir` unless it is there already; returns the tag and whether it was built now. */
export async function ensureImage(repo: string, dir: string, run: string): Promise<{ tag: string; built: boolean }> {
  const tag = fleetName(`${repo}:${contextHash(dir)}`)
  if (await imageExists(tag)) return { tag, built: false }
  await ok(['build', '--quiet', ...labels(run), '-t', tag, dir], `building ${tag}`, 900_000)
  // Older builds of the same image only take space: the newest one is the cache.
  const old = (await docker(['images', fleetName(repo), '--format', '{{.Repository}}:{{.Tag}}'])).stdout.split('\n').filter((t) => t && t !== tag && t.startsWith(`${repo}:`))
  for (const t of old) await docker(['rmi', fleetName(t)], { timeoutMs: 60_000 })
  return { tag, built: true }
}

export async function createNetwork(name: string, run: string): Promise<void> {
  await ok(['network', 'create', ...labels(run), fleetName(name)], `creating network ${name}`)
}

export interface RunSpec {
  name: string
  image: string
  network: string
  run: string
  env?: Record<string, string>
  /** Container ports published on 127.0.0.1, each on a port Docker picks. */
  publish?: number[]
  memory?: string
  cpus?: string
  pids?: number
  hostname?: string
}

export async function runContainer(s: RunSpec): Promise<void> {
  const args = ['run', '-d', '--init', '--name', fleetName(s.name), ...labels(s.run), '--network', fleetName(s.network),
    '--memory', s.memory ?? '1g', '--memory-swap', s.memory ?? '1g', '--cpus', s.cpus ?? '1.5', '--pids-limit', String(s.pids ?? 512)]
  if (s.hostname) args.push('--hostname', s.hostname)
  for (const p of s.publish ?? []) args.push('-p', `127.0.0.1::${p}`)
  for (const [k, v] of Object.entries(s.env ?? {})) args.push('-e', `${k}=${v}`)
  args.push(fleetName(s.image))
  await ok(args, `starting ${s.name}`, 120_000)
}

/** The 127.0.0.1 port Docker published for `containerPort`. */
export async function publishedPort(name: string, containerPort: number): Promise<number> {
  const out = await ok(['port', fleetName(name), `${containerPort}/tcp`], 'reading a published port')
  const m = /127\.0\.0\.1:(\d+)/.exec(out)
  if (!m) throw new Error(`fleet: ${name} publishes ${containerPort} nowhere on 127.0.0.1 (${out.trim()})`)
  return Number(m[1])
}

/** `docker exec` as `user` (default the fleet user) running `sh -c script`. */
export async function exec(name: string, script: string, opts: { user?: string; timeoutMs?: number } = {}): Promise<DockerResult> {
  return docker(['exec', '-u', opts.user ?? 'walnut', fleetName(name), 'sh', '-c', script], { timeoutMs: opts.timeoutMs ?? 30_000 })
}

export const pause = async (name: string) => ok(['pause', fleetName(name)], `pausing ${name}`)
export const unpause = async (name: string) => ok(['unpause', fleetName(name)], `unpausing ${name}`)
export const logs = async (name: string): Promise<string> => { const r = await docker(['logs', '--tail', '200', fleetName(name)]); return r.stdout + r.stderr }

/** Removes the containers then the network of one run (each by its fleet name). */
export async function removeRun(containers: string[], network: string | null): Promise<void> {
  for (const c of containers) await docker(['rm', '-f', fleetName(c)], { timeoutMs: 60_000 })
  if (network) await docker(['network', 'rm', fleetName(network)], { timeoutMs: 30_000 })
}

/** Every fleet image (the cache), by name: `scripts/run-fleet-tests.sh clean`. */
export async function removeImages(): Promise<string[]> {
  const out = (await docker(['images', '--format', '{{.Repository}}:{{.Tag}}'])).stdout.split('\n').filter((t) => t.startsWith(PREFIX))
  for (const t of out) await docker(['rmi', fleetName(t)], { timeoutMs: 60_000 })
  return out
}
