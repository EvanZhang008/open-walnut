/**
 * Why did ssh say "Permission denied (publickey)"? ssh itself never says: an
 * expired certificate, an agent that is not running and a key the host does
 * not accept all read the same. The difference decides the next step (a login
 * command versus a key problem) and whether Walnut can simply wait and retry,
 * so on an auth failure this asks the LOCAL side, where the answer lives:
 *
 *   - every certificate (the agent's, and `ssh -G`'s certificatefile) is past
 *     its valid-until, none is still valid, AND either one of them is this
 *     host's own certificatefile or no other key could have been offered
 *                                                                 → cert-expired
 *   - no usable agent (SSH_AUTH_SOCK unset, or `ssh-add -L` cannot reach it)
 *     and every `ssh -G` identityfile is absent or passphrase-protected
 *                                                                 → agent-missing
 *   - the agent holds no keys, same identityfile condition        → agent-empty
 *
 * Anything else is a plain `auth` failure (a key the host does not accept, the
 * wrong user): an expired certificate that has nothing to do with this host,
 * next to a key that was offered and refused, must not send the user to a
 * login command and put the host on the credential retry schedule.
 *
 * "Another key" means one that is not a certificate's own key: an agent loaded
 * with `ssh-add` holds a key AND its certificate, and that key is the same
 * credential (compared by SHA256 fingerprint).
 *
 * The finding rides the error as ONE line, `walnut-ssh-evidence: <tag> ...`,
 * which classifyHostConnectError reads and summarizeConnectFailure keeps.
 * Everything runs as async child processes with short timeouts (never on the
 * event loop), only after an auth failure. Private key files are only ever
 * handed to `ssh-keygen -y -P ''` (which prints the public half, or refuses a
 * passphrase-protected key); their contents never enter this process.
 */

import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'

export const SSH_EVIDENCE_PREFIX = 'walnut-ssh-evidence:'

export type SshEvidenceTag = 'agent-missing' | 'agent-empty' | 'cert-expired'

export interface SshEvidence {
  tag: SshEvidenceTag
  /** Human detail: "SSH_AUTH_SOCK is not set", "valid until 2026-09-24 08:00". */
  detail: string
}

export interface RunResult { code: number; stdout: string; stderr: string }

export interface EvidenceDeps {
  env?: Record<string, string | undefined>
  run?: (file: string, args: string[], input?: string) => Promise<RunResult>
  readFile?: (p: string) => Promise<string>
  now?: () => number
}

const TIMEOUT_MS = 3_000
/** Bound on keys / certificates / identity files looked at, so a crowded agent cannot stall a connect. */
const MAX_ITEMS = 8

function defaultRun(file: string, args: string[], input?: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = execFile(file, args, { encoding: 'utf-8', timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : -1) : 0
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
    child.stdin?.on('error', () => {})
    child.stdin?.end(input ?? '')
  })
}

/** True for the ssh failures worth asking the agent about. */
export function looksLikeCredentialFailure(message: string): boolean {
  return /permission denied \([^)]*publickey|could not open a connection to your authentication agent|error connecting to agent/i.test(message)
    && !message.includes(SSH_EVIDENCE_PREFIX)
}

/** Certificate lines of `ssh-add -L` (or a -cert.pub file): `<type>-cert-v01@openssh.com <base64> [comment]`. */
export function certLines(text: string): string[] {
  return text.split('\n').map((l) => l.trim()).filter((l) => /^\S+-cert-v01@openssh\.com\s+\S+/.test(l))
}

/**
 * The valid-until of one `ssh-keygen -L` report, in ms (local time, which is how
 * ssh-keygen prints it), Infinity for "forever" / "after X", null when unreadable.
 */
export function certValidUntil(keygenReport: string): number | null {
  const line = keygenReport.split('\n').map((l) => l.trim()).find((l) => l.startsWith('Valid:'))
  if (!line) return null
  if (/^Valid:\s*forever/i.test(line) || /^Valid:\s*after\s/i.test(line)) return Infinity
  const m = line.match(/(?:\bto|\bbefore)\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/)
  if (!m) return null
  const t = new Date(m[1]).getTime()
  return Number.isFinite(t) ? t : null
}

function fmt(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function filesFromSshG(output: string, key: string, home: string): string[] {
  const re = new RegExp(`^${key}\\s+(.+)$`, 'i')
  return output.split('\n')
    .map((l) => l.trim().match(re)?.[1]?.trim())
    .filter((p): p is string => !!p && p.toLowerCase() !== 'none')
    .map((p) => (p.startsWith('~/') ? home + p.slice(1) : p))
}

/** `certificatefile` paths `ssh -G <target>` resolves for this host (config only, no network). */
export function certificateFilesFromSshG(output: string, home: string): string[] {
  return filesFromSshG(output, 'certificatefile', home)
}

/** `identityfile` paths `ssh -G <target>` resolves (the defaults included, whether or not they exist). */
export function identityFilesFromSshG(output: string, home: string): string[] {
  return filesFromSshG(output, 'identityfile', home)
}

/** Plain (non-certificate) public key lines of `ssh-add -L`. */
export function plainKeyLines(text: string): string[] {
  return text.split('\n').map((l) => l.trim())
    .filter((l) => /^(ssh-|ecdsa-|sk-)\S+\s+\S+/.test(l) && !/-cert-v01@openssh\.com\s/.test(l))
}

/** The `SHA256:…` fingerprint in `ssh-keygen -l` output, or in a `-L` report's "Public key:" line. */
export function fingerprintOf(text: string, certReport = false): string | null {
  const scope = certReport ? text.split('\n').find((l) => /^\s*Public key:/.test(l)) ?? '' : text
  return scope.match(/SHA256:[A-Za-z0-9+/=]+/)?.[0] ?? null
}

/**
 * Ask the local agent (and the host's configured certificate files) what is
 * wrong. Null = nothing conclusive: the plain auth hint stands.
 */
export async function gatherSshCredentialEvidence(sshTarget: string, deps: EvidenceDeps = {}): Promise<SshEvidence | null> {
  const env = deps.env ?? process.env
  const run = deps.run ?? defaultRun
  const readFile = deps.readFile ?? ((p: string) => fs.readFile(p, 'utf-8'))
  const now = (deps.now ?? Date.now)()

  // 1. The agent: which keys and certificates ssh could have offered from it.
  let agent: 'unset' | 'unreachable' | 'empty' | 'ok' = 'unset'
  const agentKeys: string[] = []
  const certs: Array<{ line: string; own: boolean }> = []
  if (env.SSH_AUTH_SOCK) {
    const listed = await run('ssh-add', ['-L'])
    if (listed.code === 2 || /could not open a connection|error connecting to agent/i.test(listed.stderr)) agent = 'unreachable'
    else if (listed.code === 1 && /no identities/i.test(listed.stdout + listed.stderr)) agent = 'empty'
    else {
      agent = 'ok'
      agentKeys.push(...plainKeyLines(listed.stdout).slice(0, MAX_ITEMS))
      for (const line of certLines(listed.stdout).slice(0, MAX_ITEMS)) certs.push({ line, own: false })
    }
  }

  // 2. This host's own configuration: its certificate files and identity files.
  const home = env.HOME || os.homedir()
  let identityFiles: string[] = []
  try {
    const g = await run('ssh', ['-G', sshTarget])
    for (const file of certificateFilesFromSshG(g.stdout, home).slice(0, MAX_ITEMS)) {
      try { for (const line of certLines(await readFile(file))) certs.push({ line, own: true }) } catch { /* configured but absent */ }
    }
    identityFiles = identityFilesFromSshG(g.stdout, home).slice(0, MAX_ITEMS)
  } catch { /* ssh -G unavailable */ }

  // A passphrase-less identity file is a key ssh offers with no agent at all.
  const fileKeys = (await Promise.all(identityFiles.map(async (file) => {
    const r = await run('ssh-keygen', ['-y', '-P', '', '-f', file])
    return r.code === 0 ? plainKeyLines(r.stdout)[0] ?? null : null
  }))).filter((k): k is string => !!k)

  // 3. Certificates: all expired, and it plausibly was the one that mattered.
  let latestExpired = -Infinity
  let anyValid = false
  let ownExpired = false
  const certKeyPrints = new Set<string>()
  // `-f -`, never `-f /dev/stdin`: Node hands a child its stdin as a socketpair, and on Linux
  // opening /dev/stdin (/proc/self/fd/0) on a socket fails with ENXIO, so every read came back
  // empty there. macOS opens it fine, which is why only Linux CI saw it.
  for (const cert of certs) {
    const report = await run('ssh-keygen', ['-L', '-f', '-'], cert.line + '\n')
    const until = certValidUntil(report.stdout)
    const print = fingerprintOf(report.stdout, true)
    if (print) certKeyPrints.add(print)
    if (until === null) continue
    if (until > now) anyValid = true
    else {
      latestExpired = Math.max(latestExpired, until)
      if (cert.own) ownExpired = true
    }
  }
  if (!anyValid && Number.isFinite(latestExpired)) {
    // A key that is not some certificate's own key was offered too, and refused.
    const prints = await Promise.all([...agentKeys, ...fileKeys].map(async (key) =>
      fingerprintOf((await run('ssh-keygen', ['-l', '-f', '-'], key + '\n')).stdout)))
    const otherKey = prints.some((p) => !p || !certKeyPrints.has(p))
    if (ownExpired || !otherKey) return { tag: 'cert-expired', detail: `SSH certificate expired at ${fmt(latestExpired)}` }
    return null
  }
  if (anyValid || agent === 'ok' || fileKeys.length > 0) return null

  // 4. Nothing ssh could have offered at all.
  if (agent === 'empty') return { tag: 'agent-empty', detail: 'the SSH agent holds no keys' }
  if (agent === 'unreachable') return { tag: 'agent-missing', detail: 'the SSH agent at SSH_AUTH_SOCK does not answer' }
  return { tag: 'agent-missing', detail: 'SSH_AUTH_SOCK is not set for Walnut' }
}

export function formatSshEvidence(e: SshEvidence): string {
  return `${SSH_EVIDENCE_PREFIX} ${e.tag} (${e.detail})`
}

/** Append the evidence line to an auth failure; any other error comes back untouched. */
export async function annotateCredentialFailure(err: unknown, sshTarget: string, deps: EvidenceDeps = {}): Promise<unknown> {
  const message = err instanceof Error ? err.message : String(err)
  if (!looksLikeCredentialFailure(message)) return err
  let evidence: SshEvidence | null = null
  try { evidence = await gatherSshCredentialEvidence(sshTarget, deps) } catch { return err }
  if (!evidence) return err
  const annotated = new Error(`${message}\n${formatSshEvidence(evidence)}`)
  if (err instanceof Error && err.stack) annotated.stack = err.stack
  return annotated
}
