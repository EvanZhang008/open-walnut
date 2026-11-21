import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createGzip } from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import type { DaemonServiceScope } from './daemon-service-manager.js'
import { OVER_BUSY_FLAG } from './daemon-over-busy.js'
import type { UpdateTail } from './daemon-update-tail.js'
import { runDetachedUpdate, shq, type NetUpdateIoOptions } from './daemon-net-update-io.js'
import { judgeServiceUpdate, sshUpdateHost } from './daemon-update-readback.js'
import { log } from '../logging/index.js'
import { MKTEMP_STAGING, STAGING, STAGING_PREFIX } from './daemon-update-staging.js'
import { DELTA_BLOCK_BYTES, deltaAssemblyLines, planDeltaAgainst } from './walnut-file-delta.js'
import { remoteSha256Command } from './upload-resume.js'
import { serviceLauncherWanted } from './service-launcher-flag.js'

// Judged and read in daemon-update-readback.ts, which tests do not replace with a double.
export { judgeServiceUpdate, sshUpdateHost }

/** One service update: the line to run, its dir, the executable, the scope, and the build it installs. */
export interface ServiceUpdateSpec { command: string; directory: string | null; executable: string; scope: 'user' | 'cron'; build?: string }

export interface RemoteDaemonUpdateIo {
  run(command: string, timeoutMs?: number): Promise<string>
  chunk(data: Buffer, directory: string, index: number): Promise<boolean>
  /**
   * Run the final `walnut daemon update` line and answer what it printed (its JSON) and
   * what the tail found after it (daemon-update-tail.ts). Absent (SSH): the same detached
   * runner on the host (runDetachedUpdate), its script written and its record read with
   * `run`. The host network's io (daemon-net-update-io.ts) writes and reads with the
   * daemon's own file commands.
   */
  serviceUpdate?(update: ServiceUpdateSpec): Promise<{ output: string; tail: UpdateTail | null }>
  /** The detached runner's clocks for the SSH path; tests shorten them. */
  detached?: NetUpdateIoOptions
}

const VERSION = /^walnut-daemon-[a-zA-Z0-9]+$/
const REMOTE_PATH = /^\/[A-Za-z0-9._/-]+$/

/**
 * How a host executable names the daemon build it carries. The daemon binary
 * ignores the `__daemon` word; the compiled walnut file routes it to the
 * daemon (its plain `--version` is the CLI's), so one command reads both.
 */
export const DAEMON_VERSION_ARGS = '__daemon --version'

/**
 * What a service install or update runs on the host: an executable already
 * there (the daemon slot) when it is this build, else this build's daemon
 * binary, uploaded. A compiled Mac has no separate daemon binary: its source is
 * the host's walnut file, which the daemon deploy put in the slot.
 */
export interface ServiceDaemonSource {
  binary: string | null
  existing?: string
  /**
   * This build's daemon already gzipped, sent as it is (no copy here, no unpacking on
   * this side): a compiled Mac's walnut file for the host's target (host-file.ts), for a
   * host it has no SSH to (daemon-net-update.ts). The host checks it like an upload of
   * `binary`: its sha256, then its `__daemon --version`.
   */
  gz?: Buffer
  /**
   * The file the host's service runs now (hello `serviceExecutable`): an upload sends only
   * the blocks of this build that differ from it (planHostDelta).
   */
  base?: string | null
}

const CHUNK_BYTES = 262_144

function* slices(gz: Buffer): Generator<Buffer> {
  for (let at = 0; at < gz.length; at += CHUNK_BYTES) yield gz.subarray(at, at + CHUNK_BYTES)
}

/** The prefix of a chunk dir named by the daemon version it carries (chunkDirCommand). */
const RESUMABLE = `${STAGING_PREFIX}r`

/** A try's staging dir of this user's older than this is a dead update's: the next upload removes it. */
const STALE_STAGING_MINUTES = 24 * 60
/** Another version's chunk dir: an upload in progress writes into its dir every few seconds. */
const STALE_CHUNKS_MINUTES = 60
/** The find pattern of a chunk dir's name (a mktemp dir's 10 random characters never match it). */
const CHUNK_DIR_GLOB = `open-walnut-update.r${'[0-9a-f]'.repeat(24)}`
/** Printed by the reassembly line when the chunks do not add up to the payload. */
const CHUNKS_WRONG = 'WALNUT_STAGE_MISMATCH'
/** Printed by a delta's build when its base proved to differ from the file that was hashed. */
const BASE_WRONG = 'WALNUT_STAGE_BASE_DIFFERS'
/** The line that prints `marker` on both streams and fails the build. */
const failWith = (marker: string) => `{ echo ${marker}; echo ${marker} >&2; exit 1; }`

/**
 * The upload's chunks go into a dir named by the daemon version they carry, kept when the link
 * drops mid-upload, so the next try sends only the chunks the host does not hold yet (2026-11-18:
 * home-pc's link carried about 30 KB/s; each try of a 50 MB daemon was cut, and began again from
 * the first chunk, so the update never landed). The line answers each chunk's size and sha256,
 * and only a chunk whose both match is kept: two builds of one daemon version need not hold the
 * same bytes (bun's compile stamps one, and a Walnut file carries the whole server, which every
 * commit changes), so a rebuild keeps what still matches and sends the rest again.
 * A dir someone else made, or a link in its place, is never used: a fresh mktemp dir then, as
 * before. The same line removes this user's chunk dirs of other versions an hour old, and the
 * try dirs of updates a day old.
 */
export function chunkDirCommand(dir: string): string {
  // `/tmp/`: on a Mac /tmp is a link, which find does not enter without the slash.
  const sweep = (match: string, minutes: number) => `find /tmp/ -maxdepth 1 ${match} -user "$(id -u)" -mmin +${minutes} ! -name "\${d##*/}" -exec rm -rf {} + 2>/dev/null`
  return [
    `d=${dir}; umask 077`,
    sweep(`-name '${CHUNK_DIR_GLOB}'`, STALE_CHUNKS_MINUTES),
    sweep(`-name 'open-walnut-update.*' ! -name '${CHUNK_DIR_GLOB}'`, STALE_STAGING_MINUTES),
    `mkdir "$d" 2>/dev/null`,
    // A Mac has no sha256sum: shasum there, as the reassembly check does.
    'h() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi; }',
    `if [ -d "$d" ] && [ ! -L "$d" ] && [ -O "$d" ] && chmod 700 "$d"; then echo "DIR $d"; for f in "$d"/chunk_*; do [ -f "$f" ] && echo "HAVE \${f##*/} $(wc -c < "$f") $(h "$f" | cut -c1-64)"; done; else echo "DIR $(mktemp -d ${STAGING_PREFIX}XXXXXXXXXX)"; fi`,
    // A dir with no chunks yet ends the loop on a false test: the line still answered.
    'true',
  ].join('; ')
}

/** A chunk file already on the host: its size and sha256. */
export interface HeldChunk { size: number; sha256: string }

/** The chunk dir the line answered and each chunk file already in it. */
export function parseChunkDir(output: string): { directory: string; have: Map<string, HeldChunk> } {
  const lines = output.split('\n').map((line) => line.trim())
  const directory = [...lines].reverse().find((line) => line.startsWith('DIR '))?.slice(4).trim() ?? ''
  const have = new Map<string, HeldChunk>()
  for (const line of lines) {
    const m = /^HAVE (chunk_\d{4}) +(\d+) +([0-9a-f]{64})$/.exec(line)
    if (m) have.set(m[1], { size: Number(m[2]), sha256: m[3] })
  }
  return { directory, have }
}

/** Whether the host's chunk holds exactly these bytes. */
function holds(held: HeldChunk | undefined, chunk: Buffer): boolean {
  return held?.size === chunk.length && held.sha256 === createHash('sha256').update(chunk).digest('hex')
}

const chunkName = (index: number) => `chunk_${String(index).padStart(4, '0')}`

/** A chunk at a time, with a turn between, so a 30 MB payload never holds the event loop. */
async function sha256Of(payload: { file: string } | { gz: Buffer }): Promise<string> {
  const hash = createHash('sha256')
  const parts: AsyncIterable<unknown> | Iterable<Buffer> = 'gz' in payload ? slices(payload.gz) : fs.createReadStream(payload.file, { highWaterMark: CHUNK_BYTES })
  for await (const data of parts) {
    hash.update(data as Buffer)
    await new Promise((resolve) => setImmediate(resolve))
  }
  return hash.digest('hex')
}

/** What a failed reassembly proved wrong: the chunks, a delta's base, or nothing (the link failed, and they stay). */
function provedWrong(error: unknown): 'chunks' | 'base' | null {
  const e = error as { message?: unknown; stdout?: unknown; stderr?: unknown } | null
  const said = [e?.message, e?.stdout, e?.stderr].filter((x): x is string => typeof x === 'string').join('\n')
  return said.includes(BASE_WRONG) ? 'base' : said.includes(CHUNKS_WRONG) ? 'chunks' : null
}

/** A chunk dir's name: one per daemon version and payload kind (chunkDirCommand). */
function chunkDirName(version: string, kind: StagePayload['kind']): string {
  return `${RESUMABLE}${createHash('sha256').update(`${version}\0${kind}`).digest('hex').slice(0, 24)}`
}

/** After an update is applied: every chunk dir of its version goes (a whole file's a cut fallback left, too). */
async function removeVersionChunks(io: RemoteDaemonUpdateIo, version: string): Promise<void> {
  const dirs = (['binary', 'gz', 'delta'] as const).map((kind) => chunkDirName(version, kind))
  await io.run(`rm -rf ${dirs.join(' ')}`, 15_000).catch(() => {})
}

/** One payload the host turns into the executable: its gz chunks, their sha256, and how it is built. */
interface StagePayload {
  /** Names the chunk dir with the version: one dir per kind, so a delta never feeds a whole file. */
  kind: 'binary' | 'gz' | 'delta'
  chunks: AsyncIterable<unknown> | Iterable<Buffer>
  checksum: string
  /** The sh that turns the checked gz (`gz`) into `executable`; a base that proves to differ prints BASE_WRONG. */
  build(gz: string, executable: string, directory: string): string
  timeoutMs: number
}

/** The upload did not add up to this build: its chunks, a delta's base, or the version it prints. */
class StagedWrongError extends Error {
  constructor(message: string, readonly why: 'chunks' | 'base' | 'version') { super(message) }
}

/** Bases a delta built wrong from, with the version: the next try sends the whole file (a few at most). */
const deltaBuiltWrong = new Set<string>()

/** The whole gz, unpacked as it is. */
const unpackWhole = (gz: string, executable: string): string => `gzip -dc ${gz} > ${executable} && rm -f ${gz}`

/**
 * Put this build's daemon binary (or its gz) on the host in a private temp dir,
 * checked byte for byte and by its own `--version`. The service command then copies
 * it into the install root's versions, so the dir is removed afterwards. The chunks
 * travel through their own dir (chunkDirCommand), which outlives a dropped link.
 * With `base` (the file the host's service runs now) only the blocks that differ from
 * it go up (planHostDelta), and the host builds the new file from both; a delta that
 * does not fit sends the whole file, and one that builds wrong sends it at once after.
 */
async function stageRemoteDaemonBinary(
  payload: { binary: string } | { gz: Buffer }, expectedVersion: string, io: RemoteDaemonUpdateIo, base?: string | null,
): Promise<{ executable: string; directory: string; chunks: string | null }> {
  const temporary = 'binary' in payload ? await fsp.mkdtemp(path.join(os.tmpdir(), 'walnut-service-update-')) : null
  try {
    let whole: StagePayload
    let gz: () => Buffer | Promise<Buffer>
    if ('binary' in payload) {
      const compressed = path.join(temporary!, 'daemon.gz')
      await pipeline(fs.createReadStream(payload.binary), createGzip(), fs.createWriteStream(compressed, { mode: 0o600, flags: 'wx' }))
      // Opened when the upload reads it: a staging dir refused first removes `temporary`,
      // and a stream opened already would then fail with no one listening.
      whole = {
        kind: 'binary', checksum: await sha256Of({ file: compressed }), build: unpackWhole, timeoutMs: 30_000,
        chunks: { [Symbol.asyncIterator]: () => fs.createReadStream(compressed, { highWaterMark: CHUNK_BYTES })[Symbol.asyncIterator]() },
      }
      // Read only once the host answered its blocks' hashes, and dropped after the plan.
      gz = () => fsp.readFile(compressed)
    } else {
      const bytes = payload.gz
      gz = () => bytes
      whole = { kind: 'gz', checksum: await sha256Of({ gz: bytes }), chunks: slices(bytes), build: unpackWhole, timeoutMs: 30_000 }
    }
    const tried = `${base}\0${expectedVersion}`
    const delta = base && !deltaBuiltWrong.has(tried) ? await planHostDelta(io, base, gz) : null
    if (delta) {
      try {
        return await sendAndBuild(delta, expectedVersion, io)
      } catch (error) {
        if (!(error instanceof StagedWrongError) || error.why !== 'base') throw error
        if (deltaBuiltWrong.size > 32) deltaBuiltWrong.clear()
        deltaBuiltWrong.add(tried)
        log.session.warn('DaemonConnection: daemon update delta built wrong on the host; sending the whole file', { base })
      }
    }
    return await sendAndBuild(whole, expectedVersion, io)
  } finally {
    if (temporary) await fsp.rm(temporary, { recursive: true, force: true })
  }
}

/**
 * The blocks of `gz`'s file that differ from `base` on the host (walnut-file-delta.ts),
 * as a payload whose build reads the rest from `base`; null when it does not fit (no
 * such file, no sha256 tool, an answer cut short, most blocks changed, a JS daemon's
 * runtime). Two builds of one Walnut share most blocks at the same offsets (2026-11-19,
 * home-pc: 415 of 625, so 33 MB of gz to send instead of 85 MB over a link of 30 KB/s).
 */
async function planHostDelta(io: RemoteDaemonUpdateIo, base: string, gz: () => Buffer | Promise<Buffer>): Promise<StagePayload | null> {
  // A JS daemon's service runs node or bun: nothing of a walnut file to share.
  // Quoted wherever it goes: a Mac's install root has spaces (Application Support/Open Walnut).
  if (!base.startsWith('/') || base.length > 1024 || /[\u0000-\u001f]/.test(base) || /(^|\/)(node|bun)$/.test(base)) return null
  const planned = await planDeltaAgainst((command, timeoutMs) => io.run(command, timeoutMs), base, gz)
  if (!planned) return null
  const { plan, baseSize } = planned
  log.session.info('DaemonConnection: daemon update goes up as a delta', {
    blocks: plan.blocks, changed: plan.changed.length, payloadBytes: plan.payload.length,
  })
  const baseWrong = failWith(BASE_WRONG)
  return {
    kind: 'delta', checksum: plan.payloadSha256, chunks: slices(plan.payload), timeoutMs: 180_000,
    build: (deltaGz, executable, directory) => {
      const raw = `${directory}/delta.raw`
      const lines = [
        // A base that changed or went since it was hashed builds wrong: the whole file then.
        `[ "$(wc -c < ${shq(base)} 2>/dev/null | tr -d ' ')" = '${baseSize}' ] || ${baseWrong}`,
        `gzip -dc ${deltaGz} > ${raw} || exit 1`,
        `rm -f ${deltaGz}`,
        // A write that fails (a full disk) keeps the chunks for the next try.
        ...deltaAssemblyLines({ base, raw, out: executable, blocks: plan.blocks, changed: plan.changed, blockBytes: DELTA_BLOCK_BYTES }, () => 'exit 1'),
        `rm -f ${raw}`,
        // `$( (` with a space: dash reads `$((` as arithmetic (2026-11-19, CI's /bin/sh).
        `[ "$( ${remoteSha256Command(executable)} )" = '${plan.sha256}' ] || ${baseWrong}`,
      ]
      return `{\n${lines.join('\n')}\n}`
    },
  }
}

/** Send `payload`'s chunks (those the host does not hold yet) and build the executable from them. */
async function sendAndBuild(payload: StagePayload, expectedVersion: string, io: RemoteDaemonUpdateIo): Promise<{ executable: string; directory: string; chunks: string | null }> {
  // Named by the version and the payload's kind, not its checksum: one dir per version on the
  // host whatever the build, and holds() keeps only the chunks that match this one.
  const named = chunkDirName(expectedVersion, payload.kind)
  const { directory: chunkDir, have } = parseChunkDir(await io.run(chunkDirCommand(named)))
  if (!STAGING.test(chunkDir)) throw new Error('Invalid daemon update staging directory')
  // Not this name: a mktemp dir (the name was another user's), used as one try's dir as before.
  const resumable = chunkDir === named
  const files: string[] = []
  let index = 0, kept = 0
  for await (const data of payload.chunks) {
    const chunk = data as Buffer
    const name = chunkName(index)
    files.push(`${chunkDir}/${name}`)
    if (holds(have.get(name), chunk)) { kept++; index++; continue }
    let sent = false
    // The same name on a retry: a write that lands late holds the same bytes.
    for (let attempt = 0; attempt < 3 && !sent; attempt++) sent = await io.chunk(chunk, chunkDir, index)
    if (!sent) {
      // The chunks sent so far stay on the host for the next try; a plain mktemp dir does not.
      if (!resumable) await removeStaging(io, chunkDir)
      throw new Error('Daemon update upload failed; the installed service was not changed')
    }
    index++
  }
  if (kept) log.session.info('DaemonConnection: daemon upload resumed', { kept, of: index })
  const directory = resumable ? (await io.run(MKTEMP_STAGING)).trim() : chunkDir
  if (!STAGING.test(directory)) throw new Error('Invalid daemon update staging directory')
  const gz = `${directory}/daemon.gz`
  const executable = `${directory}/daemon`
  // A Mac has no sha256sum (a host that joined over the host network may be one): shasum then.
  const line = `printf '%s  %s\\n' '${payload.checksum}' '${gz}'`
  const check = `{ if command -v sha256sum >/dev/null 2>&1; then ${line} | sha256sum -c - >/dev/null; else ${line} | shasum -a 256 -c - >/dev/null; fi; }`
  const verify = `{ ${check} || ${failWith(CHUNKS_WRONG)}; }`
  let wrong = false
  try {
    const version = await io.run(
      `cat ${files.join(' ')} > ${gz} && ${verify} && ${payload.build(gz, executable, directory)} && chmod 700 ${executable} && ${executable} ${DAEMON_VERSION_ARGS}`,
      payload.timeoutMs,
    ).catch((error: unknown) => {
      const proved = provedWrong(error)
      if (!proved) throw error
      wrong = true
      throw new StagedWrongError(error instanceof Error ? error.message : String(error), proved)
    })
    if (version.trim().split('\n').pop()?.trim() !== expectedVersion) {
      wrong = true
      throw new StagedWrongError('Uploaded daemon version differs; the installed service was not changed', 'version')
    }
  } catch (error) {
    await removeStaging(io, directory)
    // Chunks that do not add up to this build are of no use to the next try; a link that
    // dropped during the check leaves them for it (2026-11-18 review).
    if (resumable && wrong) await removeStaging(io, chunkDir)
    throw error
  }
  // The chunks stay until the update is applied: a refused or held update sends nothing again.
  return { executable, directory, chunks: resumable ? chunkDir : null }
}

async function removeStaging(io: RemoteDaemonUpdateIo, directory: string): Promise<void> {
  if (STAGING.test(directory)) await io.run(`rm -rf ${directory}`, 15_000).catch(() => {})
}

/** The executable to hand the service command: the one on the host when it is this build, else an upload. */
async function serviceExecutable(
  source: ServiceDaemonSource, expectedVersion: string, io: RemoteDaemonUpdateIo,
): Promise<{ executable: string; directory: string | null; chunks?: string | null }> {
  if (source.existing && REMOTE_PATH.test(source.existing)) {
    const said = await io.run(`${source.existing} ${DAEMON_VERSION_ARGS} 2>/dev/null || true`, 30_000).catch(() => '')
    if (said.trim().split('\n').pop()?.trim() === expectedVersion) return { executable: source.existing, directory: null }
  }
  if (source.binary) return stageRemoteDaemonBinary({ binary: source.binary }, expectedVersion, io, source.base)
  if (source.gz?.length) return stageRemoteDaemonBinary({ gz: source.gz }, expectedVersion, io, source.base)
  throw new Error(`the daemon file on the host is not this build (${expectedVersion}), and this Walnut has no other copy to send`)
}

/** The new daemon did not get onto the host: the installed service and the running daemon are untouched. */
export class DaemonUpdateStageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DaemonUpdateStageError'
  }
}

/**
 * Update the host's daemon service to `expectedVersion`: the executable onto
 * the host first (an upload while the old daemon still serves), then the
 * service swap. `onStaged` is asked between the two: false keeps the old daemon
 * (work started during the upload) and answers 'held'. `onBuildFailed`: the build stopped the
 * daemon and did not stay serving; it runs before the staging dir is removed.
 */
export async function updateRemoteDaemonService(
  source: ServiceDaemonSource, expectedVersion: string, io: RemoteDaemonUpdateIo, scope: DaemonServiceScope = 'user',
  opts: { onStaged?: () => boolean | Promise<boolean>; overBusy?: boolean; onBuildFailed?: (error: Error) => void | Promise<void> } = {},
): Promise<'applied' | 'held'> {
  if (!VERSION.test(expectedVersion)) throw new Error('Invalid daemon build version')
  if (scope !== 'user' && scope !== 'cron') throw new Error(`Walnut does not update a ${scope} service from the server`)
  const { executable, directory, chunks } = await serviceExecutable(source, expectedVersion, io).catch((error: unknown) => {
    throw new DaemonUpdateStageError(error instanceof Error ? error.message : String(error))
  })
  // The host network's runner keeps its record in the staging dir until the server read it.
  let keep = false, applied = false
  try {
    if (opts.onStaged && !(await opts.onStaged())) return 'held'
    // An overdue update goes over the daemon's own work (daemon-update-behind.ts); the launcher when its experiment is on.
    const command = `${executable} walnut daemon update --yes --scope ${scope} --executable ${executable}${opts.overBusy ? ` ${OVER_BUSY_FLAG}` : ''}${await serviceLauncherWanted() ? ' --launcher' : ''}`
    const update = io.serviceUpdate ? io.serviceUpdate.bind(io) : (u: ServiceUpdateSpec) => updateOverSsh(io, u)
    const answer = await update({ command, directory, executable, scope, build: expectedVersion }).catch((error: unknown) => {
      keep = (error as { keepStaging?: unknown } | null)?.keepStaging === true
      throw error
    })
    const verdict = judgeServiceUpdate(answer.output, answer.tail)
    applied = true
    return verdict
  } catch (error) {
    // The build's hold is written before its record (the staging dir) goes: a server killed in
    // between keeps one of them, never neither (2026-11-04 review 5).
    if ((error as { buildFailed?: unknown } | null)?.buildFailed === true && opts.onBuildFailed) await opts.onBuildFailed(error as Error)
    throw error
  } finally {
    if (directory && !keep) await removeStaging(io, directory)
    if (chunks && applied) await removeVersionChunks(io, expectedVersion)
  }
}

/**
 * Over SSH: the detached runner on the host, in the update's own dir (the staging dir, or
 * one made for it when nothing was uploaded), its record read every few seconds. 2026-11-04:
 * the tail ran as a second SSH command, so a dropped link or a server restart during the
 * update meant no tail; and an SSH command that timed out left the CLI running on the host
 * while the tail started or restored the service beside its bootout wait.
 */
async function updateOverSsh(
  io: RemoteDaemonUpdateIo, update: ServiceUpdateSpec,
): Promise<{ output: string; tail: UpdateTail | null }> {
  const own = !update.directory
  const directory = update.directory ?? (await io.run(MKTEMP_STAGING).catch(() => '')).trim()
  if (!STAGING.test(directory)) throw new Error('the update could not make a dir of its own on the host, so nothing was changed')
  let keep = false
  try {
    // One try: a busy daemon is asked again from here, on the server's clock.
    return await runDetachedUpdate(sshUpdateHost(io), { ...update, directory }, { tries: 1, pollMs: 5_000, ...io.detached })
  } catch (error) {
    keep = (error as { keepStaging?: unknown } | null)?.keepStaging === true
    throw error
  } finally {
    if (own && !keep) await removeStaging(io, directory)
  }
}

interface ServiceReply { ok?: boolean; status?: { scope?: string; startup?: string }; failure?: { code?: string; message?: string; rollback?: string } }
interface DaemonStatusReply { installed?: boolean; scope?: string }

export interface RemoteInstallResult {
  ok: boolean
  /** The failure's own words, then its rollback, for the log and Settings. */
  message?: string
  code?: string
  scope?: string
  startup?: string
  uploaded: boolean
}

/**
 * Install the daemon as a service on the host (`walnut daemon install --yes`,
 * no scope: the host picks a boot start it can have without root). The
 * executable already there is used when it is this build (a binary host, or
 * the walnut file a compiled Mac put in the daemon slot); otherwise this build's
 * daemon binary is uploaded. Never throws for a refusal the host answered: the
 * result says it, so the caller can record and show it.
 */
export async function installRemoteDaemonService(
  source: ServiceDaemonSource, expectedVersion: string, io: RemoteDaemonUpdateIo,
): Promise<RemoteInstallResult> {
  if (!VERSION.test(expectedVersion)) throw new Error('Invalid daemon build version')
  const { executable, directory, chunks } = await serviceExecutable(source, expectedVersion, io)
  const uploaded = directory !== null
  // `|| true`: a refusal exits 1 with its JSON on stdout, which is the answer to keep.
  const cli = async (args: string, timeoutMs: number): Promise<ServiceReply | null> => {
    const output = (await io.run(`${executable} walnut daemon ${args} 2>/dev/null || true`, timeoutMs)).trim()
    try { return JSON.parse(output.slice(output.indexOf('{'))) as ServiceReply } catch { return null }
  }
  const install = `install --yes --executable ${executable}${await serviceLauncherWanted() ? ' --launcher' : ''}`
  try {
    let reply = await cli(install, 600_000)
    // The old daemon may have exited after handing over: a second install finishes that handover.
    if (reply && reply.ok !== true && (reply.failure?.code === 'handoverPending' || /retry install/i.test(reply.failure?.rollback ?? ''))) {
      reply = await cli(install, 600_000)
    }
    if (reply?.ok === true) {
      if (chunks) await removeVersionChunks(io, expectedVersion)
      return { ok: true, scope: reply.status?.scope, startup: reply.status?.startup, uploaded }
    }
    // Never leave a config with no daemon behind it: the server will not start one beside a service.
    const left = await cli('status', 60_000).catch(() => null)
    let removed = ''
    if (left && (left as DaemonStatusReply).installed === true) {
      const scope = (left as DaemonStatusReply).scope
      const gone = await cli(`uninstall --yes${scope === 'user' || scope === 'cron' ? ` --scope ${scope}` : ''}`, 120_000).catch(() => null)
      removed = gone?.ok === true ? 'the half-made service was removed, so Walnut runs the daemon the usual way' : 'the half-made service could not be removed'
    }
    if (!reply) return { ok: false, message: ['the install gave no answer Walnut could read', removed].filter(Boolean).join('; '), uploaded }
    const f = reply.failure ?? {}
    return { ok: false, code: f.code, message: [f.message, f.rollback, removed].filter(Boolean).join('; ') || 'the install failed', uploaded }
  } finally {
    if (directory) await removeStaging(io, directory)
  }
}
