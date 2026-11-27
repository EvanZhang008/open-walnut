/**
 * The two readers of this machine's SSH certificates see the same certificates, on every config
 * shape: the expiry ahead (sshCertificateExpiry, which drives the certificate letter) and the reason
 * a refused dial gives (gatherSshCredentialEvidence, which makes the refusal a `cert_expired` login
 * failure that joins that letter). 2026-11-26: the host named no `certificatefile`, its certificate
 * sat beside the identity file (`~/.ssh/id_ecdsa-cert.pub`) and the agent was empty. The expiry
 * reader looked there and sent the letter; the evidence reader did not, so the refusal read as a
 * plain key refusal and sent a second letter for the same expiry.
 *
 * The source ratchet fails on a new reader of a host's certificate files that does not go through
 * hostCertificateFiles, the one helper both readers use.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { gatherSshCredentialEvidence, sshCertificateExpiry, hostCertificateFiles, type RunResult } from '../../src/providers/ssh-credential-evidence.js'

const CERT = 'ecdsa-sha2-nistp256-cert-v01@openssh.com AAAAKGVjZHNhLXNoYTItbmlzdHAyNTYtY2VydC12MDFAb3BlbnNzaC5jb20 me@laptop'
const KEY = 'ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTY me@laptop'
const OTHER_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOther work@laptop'
const KEY_PRINT = 'SHA256:certkeycertkeycertkey'
const UNTIL = '2026-09-24T08:00:00'
const NOW = new Date('2026-09-24T12:00:00').getTime()
/** The expiry reads as a date and 12-hour clock; the year shows only when it is not this year. */
const CERT_EXPIRED_AT = /^SSH certificate expired at Sep 24, (2026, )?8:00 AM$/
const report = (until: string) =>
  `/dev/stdin:\n        Type: ecdsa-sha2-nistp256-cert-v01@openssh.com user certificate\n        Public key: ECDSA-CERT ${KEY_PRINT}\n        Valid: from 2026-09-23T08:00:00 to ${until}\n`

interface Shape {
  name: string
  sshG: string
  /** `ssh-add -L`'s answer; absent = no SSH_AUTH_SOCK. */
  agent?: RunResult
  /** Readable files under HOME=/h. */
  files: Record<string, string>
  /** Passphrase-less identity files and the key each gives. */
  keys: Record<string, string>
  /**
   * Another plain key was refused too and the certificate is not one the host names: the refusal
   * names no certificate reason (it may be that other key), and the letters join once the
   * certificate is past its expiry (tests/core/hosts/expired-login-letter-guard.test.ts).
   */
  ambiguous?: true
}

const EMPTY_AGENT: RunResult = { code: 1, stdout: '', stderr: 'The agent has no identities.\n' }
const IDS = 'identityfile ~/.ssh/id_rsa\nidentityfile ~/.ssh/id_ecdsa\nidentityfile ~/.ssh/id_ed25519\n'

const SHAPES: Shape[] = [
  { name: 'the 2026-11-26 shape: no certificatefile, the certificate beside the identity file, an empty agent',
    sshG: `user me\n${IDS}`, agent: EMPTY_AGENT, files: { '/h/.ssh/id_ecdsa-cert.pub': CERT }, keys: { '/h/.ssh/id_ecdsa': KEY } },
  { name: 'the certificate beside the identity file, no agent at all',
    sshG: `user me\n${IDS}`, files: { '/h/.ssh/id_ecdsa-cert.pub': CERT }, keys: { '/h/.ssh/id_ecdsa': KEY } },
  { name: 'the certificate beside the identity file, another plain key refused too',
    sshG: `user me\n${IDS}`, agent: EMPTY_AGENT, files: { '/h/.ssh/id_ecdsa-cert.pub': CERT }, keys: { '/h/.ssh/id_ecdsa': KEY, '/h/.ssh/id_ed25519': OTHER_KEY }, ambiguous: true },
  { name: 'a named certificatefile, another plain key refused too',
    sshG: `user me\ncertificatefile ~/.ssh/work-cert.pub\n${IDS}`, agent: EMPTY_AGENT, files: { '/h/.ssh/work-cert.pub': CERT }, keys: { '/h/.ssh/id_ecdsa': KEY, '/h/.ssh/id_ed25519': OTHER_KEY } },
  { name: 'a named certificatefile',
    sshG: `user me\ncertificatefile ~/.ssh/work-cert.pub\n${IDS}`, agent: EMPTY_AGENT, files: { '/h/.ssh/work-cert.pub': CERT }, keys: { '/h/.ssh/id_ecdsa': KEY } },
  { name: 'the agent holds the certificate and its key, no files',
    sshG: `user me\n${IDS}`, agent: { code: 0, stdout: `${KEY}\n${CERT}\n`, stderr: '' }, files: {}, keys: {} },
]

function deps(shape: Shape, until: string) {
  const run = async (file: string, args: string[], input?: string): Promise<RunResult> => {
    const cmd = `${file} ${args.join(' ')}`
    if (cmd.startsWith('ssh -G')) return { code: 0, stdout: shape.sshG, stderr: '' }
    if (cmd.startsWith('ssh-add -L')) return shape.agent ?? { code: 2, stdout: '', stderr: 'Could not open a connection to your authentication agent.\n' }
    if (cmd.startsWith('ssh-keygen -L')) return { code: 0, stdout: report(until), stderr: '' }
    if (cmd.startsWith('ssh-keygen -y')) {
      const key = shape.keys[args[args.length - 1]!]
      return key ? { code: 0, stdout: `${key}\n`, stderr: '' } : { code: 255, stdout: '', stderr: 'No such file or directory\n' }
    }
    if (cmd.startsWith('ssh-keygen -l')) return { code: 0, stdout: `256 ${input?.startsWith(OTHER_KEY) ? 'SHA256:other' : KEY_PRINT} me@laptop\n`, stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  }
  const readFile = async (p: string) => { const t = shape.files[p]; if (t === undefined) throw new Error(`ENOENT ${p}`); return t + '\n' }
  return { env: { HOME: '/h', ...(shape.agent ? { SSH_AUTH_SOCK: '/agent' } : {}) }, run, readFile, now: () => NOW }
}

describe('the expiry reader and the refusal reader see the same certificates', () => {
  for (const shape of SHAPES) {
    it(`${shape.name}: expired is ${shape.ambiguous ? 'the expiry ahead, and no other reason' : 'cert-expired in both'}`, async () => {
      expect(await sshCertificateExpiry('me@devbox', deps(shape, UNTIL))).toBe(new Date(UNTIL).getTime())
      expect(await gatherSshCredentialEvidence('me@devbox', deps(shape, UNTIL))).toEqual(shape.ambiguous ? null : { tag: 'cert-expired', detail: expect.stringMatching(CERT_EXPIRED_AT) })
    })
    it(`${shape.name}: still valid names no certificate reason`, async () => {
      expect(await sshCertificateExpiry('me@devbox', deps(shape, '2026-09-25T08:00:00'))).toBe(new Date('2026-09-25T08:00:00').getTime())
      expect((await gatherSshCredentialEvidence('me@devbox', deps(shape, '2026-09-25T08:00:00')))?.tag).not.toBe('cert-expired')
    })
  }

  it('hostCertificateFiles: the named ones win, else the one beside each identity file', () => {
    expect(hostCertificateFiles(`certificatefile ~/.ssh/work-cert.pub\n${IDS}`, '/h')).toEqual({ files: ['/h/.ssh/work-cert.pub'], named: true })
    expect(hostCertificateFiles(IDS, '/h')).toEqual({ files: ['/h/.ssh/id_rsa-cert.pub', '/h/.ssh/id_ecdsa-cert.pub', '/h/.ssh/id_ed25519-cert.pub'], named: false })
    expect(hostCertificateFiles('user me\n', '/h')).toEqual({ files: [], named: false })
  })
})

describe('source ratchet: one reader of a host\'s certificate files', () => {
  const ROOT = path.resolve(__dirname, '../..')
  function walk(d: string, out: string[] = []): string[] {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p, out)
      else if (/\.(ts|tsx|mjs|js)$/.test(e.name)) out.push(p)
    }
    return out
  }

  it('only hostCertificateFiles turns ssh -G output into certificate files, and only hostCertificateLines reads them', () => {
    const hits: string[] = []
    for (const file of walk(path.join(ROOT, 'src'))) {
      const lines = fs.readFileSync(file, 'utf-8').split('\n')
      let inHelper = false
      for (const line of lines) {
        if (/export (async )?function (hostCertificateFiles|hostCertificateLines|certificateFilesFromSshG)\(/.test(line)) inHelper = true
        else if (inHelper && /^}/.test(line)) { inHelper = false; continue }
        if (inHelper || /^\s*(\*|\/\/|\/\*)/.test(line)) continue
        if (/\b(certificateFilesFromSshG|hostCertificateFiles)\(|-cert\.pub/.test(line)) hits.push(`${path.relative(ROOT, file)}: ${line.trim()}`)
      }
    }
    expect(hits).toEqual([])
  })
})
