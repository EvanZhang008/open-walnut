/**
 * Whether a request comes from the Walnut Mac app's own process (2026-11-11, the user: approving an
 * agent's browser step "is just a button click", so it must not need the Passwords master password).
 *
 * The Mac app's first Touch ID key may be trusted on first use only when the app itself sends it,
 * never a script: any process on this computer can call the console's routes, and an agent with a
 * key of its own as the first signer could approve its own steps. So the process holding the
 * request's client end must be running a validly signed bundle with the Mac app's identifier, and
 * the code it runs must be that bundle's code (the same CDHash), so a copied or patched binary does
 * not pass. Each check is a child process with a deadline, never on the event loop.
 *
 * The app must also be signed by an Apple-issued certificate of a team (never ad-hoc, which anyone
 * can make with the same identifier), the bundle's signature must name that same team, and its code
 * must run under the hardened runtime with no entitlement that lets another program load code into
 * it or attach to it (DYLD_INSERT_LIBRARIES, a debugger).
 *
 * Known limit: a process of this account that can sign with the person's own Apple certificate
 * (which an agent here may reach too) can build a look-alike app before any key exists. That is
 * the same first-use limit the iPhone's first key has (a process here can make a device token), and
 * it closes once any key exists: every later key needs an existing key's Touch ID or Face ID.
 */
import { execFile } from 'node:child_process'
import { clientPidsOf, type Conn } from './caller-proof.js'

/** The Mac app's bundle identifier (desktop/build.sh, desktop/build-release.sh). */
export const MAC_APP_BUNDLE_ID = 'com.local.walnut-desktop'

const RUN_MS = 4_000

interface RunOut { code: number; stdout: string; stderr: string }

function run(cmd: string, args: string[]): Promise<RunOut | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: RUN_MS, maxBuffer: 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : -1) : 0
      if (err && (err as { killed?: boolean }).killed) { resolve(null); return }
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
  })
}

/** The .app bundle an executable path sits in (`/X/Walnut.app/Contents/MacOS/Walnut`), else null. Pure. */
export function bundleOfExecutable(exe: string): string | null {
  const m = /^(\/.+?\.app)\/Contents\/MacOS\/[^/]+$/.exec(exe.trim())
  return m ? m[1]! : null
}

export interface SigningInfo { identifier?: string; cdhash?: string; team?: string; flags?: string[] }

/** `codesign -dvvv` output: its Identifier, CDHash, TeamIdentifier and CodeDirectory flags. Pure. */
export function signingInfo(text: string): SigningInfo {
  const identifier = /^Identifier=(.+)$/m.exec(text)?.[1]?.trim()
  const cdhash = /^CDHash=([0-9a-f]+)$/m.exec(text)?.[1]?.trim()
  const team = /^TeamIdentifier=([A-Z0-9]{10})$/m.exec(text)?.[1]
  const flagText = /^CodeDirectory\b.*?\bflags=0x[0-9a-f]+\(([^)]*)\)/m.exec(text)?.[1]
  const flags = flagText === undefined ? undefined : flagText.split(',').map((f) => f.trim()).filter((f) => f && f !== 'none')
  return { ...(identifier ? { identifier } : {}), ...(cdhash ? { cdhash } : {}), ...(team ? { team } : {}), ...(flags ? { flags } : {}) }
}

/** Entitlements that let another program put code into the app or drive it. */
export const INJECTION_ENTITLEMENTS = [
  'com.apple.security.get-task-allow',
  'com.apple.security.cs.allow-dyld-environment-variables',
  'com.apple.security.cs.disable-library-validation',
] as const

/** Why the running code's signature cannot speak for the person, else null. Pure. */
export function liveSigningRefusal(info: SigningInfo, bundleId = MAC_APP_BUNDLE_ID): string | null {
  if (info.identifier !== bundleId || !info.cdhash) return 'the process is not the Walnut Mac app'
  if (!info.flags || info.flags.includes('adhoc')) return 'the app is not signed by a developer certificate'
  if (!info.team) return 'the app\'s signature names no team'
  if (!info.flags.includes('runtime')) return 'the app does not run under the hardened runtime'
  return null
}

/** An entitlements plist (`codesign -d --entitlements - --xml`) granting code injection, by key. Pure. */
export function injectionEntitlementIn(xml: string): string | null {
  for (const key of INJECTION_ENTITLEMENTS) {
    const at = xml.indexOf(`<key>${key}</key>`)
    if (at >= 0 && /^\s*<true\s*\/>/.test(xml.slice(at + key.length + 11))) return key
  }
  return null
}

export type MacAppProof = { ok: true; pid: number; bundle: string } | { ok: false; why: string }

/** One pid: is it the Mac app's signed code, running from its signed bundle? */
export async function pidIsMacApp(pid: number, bundleId = MAC_APP_BUNDLE_ID): Promise<MacAppProof> {
  if (!Number.isInteger(pid) || pid <= 1) return { ok: false, why: 'no such process' }
  const ps = await run('ps', ['-o', 'comm=', '-p', String(pid)])
  const bundle = ps && ps.code === 0 ? bundleOfExecutable(ps.stdout) : null
  if (!bundle) return { ok: false, why: 'the process is not an app bundle' }
  // The running code (the kernel's view), then the bundle on disk with its signature checked.
  const live = await run('codesign', ['-dvvv', `+${pid}`])
  const liveInfo = live ? signingInfo(live.stderr) : {}
  const refusal = liveSigningRefusal(liveInfo, bundleId)
  if (refusal) return { ok: false, why: refusal }
  // An Apple-issued certificate of that same team (team ids are [A-Z0-9]{10}, read by signingInfo).
  const requirement = `=anchor apple generic and identifier "${bundleId}" and certificate leaf[subject.OU] = "${liveInfo.team}"`
  const verify = await run('codesign', ['--verify', '--strict', `-R${requirement}`, bundle])
  if (!verify || verify.code !== 0) return { ok: false, why: 'the app bundle\'s signature does not verify' }
  const disk = await run('codesign', ['-dvvv', bundle])
  const diskInfo = disk ? signingInfo(disk.stderr) : {}
  if (diskInfo.cdhash !== liveInfo.cdhash) return { ok: false, why: 'the running code is not the signed bundle\'s code' }
  // The code directory hash covers the entitlements, so the bundle's are the running code's.
  const ents = await run('codesign', ['-d', '--entitlements', '-', '--xml', bundle])
  if (!ents || ents.code !== 0) return { ok: false, why: 'could not read the app\'s entitlements' }
  const injection = injectionEntitlementIn(ents.stdout)
  if (injection) return { ok: false, why: `the app allows other programs into it (${injection})` }
  return { ok: true, pid, bundle }
}

let proofForTesting: ((conn: Conn | undefined) => Promise<MacAppProof>) | null = null
/** Tests: stand in for the process check (a test process is never the signed app). */
export function _setMacAppProofForTesting(fn: typeof proofForTesting): void { proofForTesting = fn }

/** The request's connection is held by the Mac app's own process, and only by it. macOS only. */
export async function requestFromMacApp(conn: Conn | undefined): Promise<MacAppProof> {
  if (proofForTesting) return proofForTesting(conn)
  if (process.platform !== 'darwin') return { ok: false, why: 'not a Mac' }
  if (!conn) return { ok: false, why: 'no connection to check' }
  const pids = await clientPidsOf(conn)
  if (!pids || pids.length !== 1) return { ok: false, why: 'could not tell which process sent it' }
  return pidIsMacApp(pids[0]!)
}
