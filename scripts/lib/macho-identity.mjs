/**
 * The identity macOS privacy keys on for a darwin program Walnut ships without
 * an app bundle (the compiled walnut file, the daemon binary), made the same for
 * every build.
 *
 * Measured on macOS 26 (2026-11-04, task "Mac stops asking to allow walnut on the
 * local network"): Local Network privacy records an unbundled, ad-hoc signed
 * program by its signing identifier and its path, and matches a later run by the
 * path and the Mach-O LC_UUID, never the code hash. A different binary with the
 * same UUID at an allowed path connected; the same binary with another UUID at
 * that path was refused. bun gives every file it compiles the UUID of bun's own
 * runtime and the identifier `a.out`, so Walnut shared both with every bun
 * program on the Mac and lost them at each bun upgrade. Every darwin file
 * therefore carries its own fixed UUID and identifier, stamped after the compile
 * and re-signed ad hoc (codesign on macOS, rcodesign elsewhere), so a new build
 * at the same path keeps the user's choice. A server the deploy runs gets its
 * identity from Walnut.app instead (scripts/dev-prod.sh, session_host_prefix).
 */
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'

/** Fixed per program and architecture. Never change one: every user's choice for it is keyed on it. */
export const DARWIN_IDENTITY = {
  'walnut-darwin-arm64': { uuid: '90E0D031-0C66-4B6B-A38D-AEE71802CB8C', identifier: 'dev.openwalnut.walnut' },
  'walnut-darwin-x64': { uuid: 'B3E7574B-01A9-4AB7-BD60-CF61C13E2E87', identifier: 'dev.openwalnut.walnut' },
  'daemon-darwin-arm64': { uuid: 'B9853906-D9B3-41FF-8A08-DA411D493CE1', identifier: 'dev.openwalnut.session-daemon' },
}

const MH_MAGIC_64 = 0xfeedfacf
const LC_UUID = 0x1b

function uuidBytes(uuid) {
  const hex = uuid.replace(/-/g, '')
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new Error(`not a UUID: ${uuid}`)
  return Buffer.from(hex, 'hex')
}

function formatUuid(bytes) {
  const h = Buffer.from(bytes).toString('hex').toUpperCase()
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

/** Offset of the 16 UUID bytes in a thin 64-bit Mach-O. Throws on anything else (a fat file, no LC_UUID). */
export function uuidOffset(buf) {
  if (buf.length < 32 || buf.readUInt32LE(0) !== MH_MAGIC_64) throw new Error('not a thin 64-bit little-endian Mach-O')
  const ncmds = buf.readUInt32LE(16)
  const sizeofcmds = buf.readUInt32LE(20)
  let off = 32
  const end = 32 + sizeofcmds
  for (let i = 0; i < ncmds && off + 8 <= end; i++) {
    const cmd = buf.readUInt32LE(off)
    const size = buf.readUInt32LE(off + 4)
    if (size < 8) break
    if (cmd === LC_UUID) {
      if (size < 24) throw new Error('LC_UUID is too short')
      return off + 8
    }
    off += size
  }
  throw new Error('no LC_UUID load command')
}

/** The Mach-O UUID of a file, upper-case with dashes. */
export function readMachoUuid(file) {
  const fd = fs.openSync(file, 'r')
  try {
    const head = Buffer.alloc(64 * 1024)
    fs.readSync(fd, head, 0, head.length, 0)
    const off = uuidOffset(head)
    return formatUuid(head.subarray(off, off + 16))
  } finally {
    fs.closeSync(fd)
  }
}

/** Write `uuid` into the file's LC_UUID in place (the load commands sit in the first page). */
export function writeMachoUuid(file, uuid) {
  const fd = fs.openSync(file, 'r+')
  try {
    const head = Buffer.alloc(64 * 1024)
    fs.readSync(fd, head, 0, head.length, 0)
    fs.writeSync(fd, uuidBytes(uuid), 0, 16, uuidOffset(head))
  } finally {
    fs.closeSync(fd)
  }
}

/** The code signature's identifier (`codesign -dv`, which writes to stderr), or null. macOS only. */
export function readSigningIdentifier(file) {
  const r = spawnSync('codesign', ['-dv', file], { encoding: 'utf8' })
  const m = /^Identifier=(.*)$/m.exec(`${r.stdout ?? ''}${r.stderr ?? ''}`)
  return m ? m[1] : null
}

/** No way to sign on this host: nothing was changed (see `--where-signable`). */
export class NoDarwinSignerError extends Error {
  code = 'signer_unavailable'
}

/**
 * The tool that signs a darwin file here, found BEFORE the file is touched: a
 * stamped UUID breaks the signature bun gave the file, so a stamp that cannot
 * re-sign must never begin (2026-11-07: a daemon built on Linux shipped with its
 * UUID stamped and bun's signature broken, and macOS refused to start it).
 */
function darwinSigner(name, opts, run) {
  if ((opts.platform ?? process.platform) === 'darwin') return { kind: 'codesign' }
  const rcodesign = opts.rcodesign ?? process.env.WALNUT_RCODESIGN ?? 'rcodesign'
  try {
    run(rcodesign, ['--version'])
  } catch {
    throw new NoDarwinSignerError(`${name} needs an ad-hoc signature after its identity is stamped: build it on macOS, or put rcodesign on PATH (sh scripts/install-rcodesign.sh <dir>)`)
  }
  return { kind: 'rcodesign', cmd: rcodesign }
}

/**
 * rcodesign's verify says an ad-hoc signature has no CMS part (it has none by design), so only
 * a code hash that does not match, or no signature at all, counts as broken.
 */
function rcodesignVerifies(cmd, file, opts) {
  const r = (opts.capture ?? ((c, a) => spawnSync(c, a, { encoding: 'utf8' })))(cmd, ['verify', file])
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  if (r.error) throw new Error(`${cmd} verify did not run: ${r.error.message}`)
  if (/digest mismatch|no code signature|not signed/i.test(out)) throw new Error(`the signature does not match the file: ${out.trim().split('\n').slice(-3).join(' ')}`)
}

/**
 * Give `file` its fixed identity: the UUID, then an ad-hoc signature with the
 * identifier, keeping the flags and entitlements bun signed it with (its JIT
 * needs allow-jit). `name` is a key of DARWIN_IDENTITY. The work is done on a
 * copy that replaces `file` only once it is signed and the signature checks, so
 * on any failure `file` is left exactly as bun wrote it.
 */
export function stampDarwinIdentity(file, name, opts = {}) {
  const id = DARWIN_IDENTITY[name]
  if (!id) throw new Error(`no fixed darwin identity for ${name}; add one to scripts/lib/macho-identity.mjs`)
  const run = opts.run ?? ((cmd, args) => execFileSync(cmd, args, { stdio: 'ignore' }))
  const signer = darwinSigner(name, opts, run)
  const work = `${file}.stamp-${process.pid}`
  fs.copyFileSync(file, work)
  fs.chmodSync(work, fs.statSync(file).mode & 0o7777)
  try {
    writeMachoUuid(work, id.uuid)
    if (signer.kind === 'codesign') {
      run('codesign', ['--force', '--sign', '-', '--identifier', id.identifier, '--preserve-metadata=entitlements,flags', work])
      run('codesign', ['--verify', work])
    } else {
      run(signer.cmd, ['sign', '--binary-identifier', id.identifier, work])
      rcodesignVerifies(signer.cmd, work, opts)
    }
    fs.renameSync(work, file)
  } catch (err) {
    fs.rmSync(work, { force: true })
    throw new Error(`${name}: stamping its identity failed, ${file} is left as it was: ${err instanceof Error ? err.message : err}`)
  }
  return id
}

/**
 * The fixed identity a darwin file carries, or what differs (`walnut-darwin-arm64`
 * style names). macOS only for the identifier half; the UUID is read anywhere.
 */
export function checkDarwinIdentity(file, name, opts = {}) {
  const id = DARWIN_IDENTITY[name]
  if (!id) return [`no fixed darwin identity for ${name}`]
  const problems = []
  const uuid = readMachoUuid(file)
  if (uuid !== id.uuid) problems.push(`Mach-O UUID is ${uuid}, not ${id.uuid}`)
  if ((opts.platform ?? process.platform) === 'darwin') {
    const identifier = readSigningIdentifier(file)
    if (identifier === null) problems.push('no code signature identifier')
    else if (identifier !== id.identifier) problems.push(`signing identifier is ${identifier}, not ${id.identifier}`)
  }
  return problems
}

/**
 * `bun scripts/lib/macho-identity.mjs stamp|check <file> <name>` for the shell builds
 * (scripts/build-daemon.sh) and the deploy's check (scripts/dev-prod.sh). `stamp
 * --where-signable` skips with a note on a host with no way to sign (Linux without
 * rcodesign), and only then: the file keeps bun's own identity and signature,
 * untouched. Such a daemon binary is for that host's own tests; a deploy builds and
 * checks its own on the Mac. A build whose darwin file must carry Walnut's identity
 * sets WALNUT_REQUIRE_DARWIN_SIGN=1, and then a missing signer fails it too. A
 * signer that is there and fails always fails the build.
 */
if (import.meta.main) {
  const [verb, file, name, flag] = process.argv.slice(2)
  if (!file || !name || (verb !== 'stamp' && verb !== 'check')) {
    console.error('usage: macho-identity.mjs stamp|check <file> <name> [--where-signable]')
    process.exit(2)
  }
  if (verb === 'stamp') {
    try {
      stampDarwinIdentity(file, name)
    } catch (err) {
      const mayKeep = flag === '--where-signable' && err instanceof NoDarwinSignerError && process.env.WALNUT_REQUIRE_DARWIN_SIGN !== '1'
      if (!mayKeep) {
        console.error(`macho-identity: ${err instanceof Error ? err.message : err}`)
        process.exit(1)
      }
      console.error(`macho-identity: ${name} keeps bun's own identity and signature, untouched, on this host (${err.message})`)
      process.exit(0)
    }
  }
  const problems = checkDarwinIdentity(file, name)
  if (problems.length) {
    console.error(`macho-identity: ${file}: ${problems.join('; ')}`)
    process.exit(1)
  }
}
