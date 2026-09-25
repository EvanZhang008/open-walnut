/**
 * Why ssh said "Permission denied (publickey)" (ssh-credential-evidence.ts):
 * expired certificate, no agent, or an empty agent, read from THIS machine.
 *
 * Most cases stub the three commands (ssh-add, ssh -G, ssh-keygen) with
 * captured output. One case runs the real tools against a PRIVATE throwaway
 * agent on a temp socket holding a certificate that expires a second after it
 * is made; the user's own agent and keys are never touched (SSH_AUTH_SOCK is
 * passed explicitly, the agent is killed afterwards, and `ssh -G` is stubbed so
 * the user's ~/.ssh/config is not read).
 */
import { describe, it, expect } from 'vitest'
import { execFile, execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  annotateCredentialFailure, certValidUntil, certificateFilesFromSshG, gatherSshCredentialEvidence,
  looksLikeCredentialFailure, type RunResult,
} from '../../src/providers/ssh-credential-evidence.js'
import { classifyHostConnectError } from '../../src/core/sessions/host-connect-hint.js'
import { summarizeConnectFailure } from '../../src/providers/daemon-connection.js'

const CERT = 'ssh-ed25519-cert-v01@openssh.com AAAAIHNzaC1lZDI1NTE5LWNlcnQtdjAxQG9wZW5zc2guY29t me@laptop'
const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIs me@laptop'
const OTHER_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOther work@laptop'
/** The fingerprint of KEY, which is also the key CERT certifies. */
const KEY_PRINT = 'SHA256:2cK3vHl20xkXr6AixcnQ500/YeWBpritvZRVv3bOcMA'
const report = (validLine: string, print = KEY_PRINT) =>
  `/dev/stdin:\n        Type: ssh-ed25519-cert-v01@openssh.com user certificate\n        Public key: ED25519-CERT ${print}\n        Signing CA: ED25519 SHA256:caca (using ssh-ed25519)\n        ${validLine}\n`
const EXPIRED = report('Valid: from 2026-09-23T08:00:00 to 2026-09-24T08:00:00')
/** `ssh-keygen -l` per key line: KEY is the certificate's own key, OTHER_KEY is not. */
const printOf = (input?: string): RunResult => ({
  code: 0, stderr: '',
  stdout: input?.startsWith(OTHER_KEY) ? '256 SHA256:otherotherother work@laptop (ED25519)\n' : `256 ${KEY_PRINT} me@laptop (ED25519)\n`,
})
const SSH_G = 'user me\nidentityfile ~/.ssh/id_rsa\nidentityfile ~/.ssh/id_ed25519\n'
const NOW = new Date('2026-09-24T12:00:00').getTime()

function stubRun(map: Record<string, RunResult | ((input?: string) => RunResult)>) {
  const calls: string[] = []
  const run = async (file: string, args: string[], input?: string): Promise<RunResult> => {
    const key = `${file} ${args.join(' ')}`
    calls.push(key)
    for (const [prefix, result] of Object.entries(map)) if (key.startsWith(prefix)) return typeof result === 'function' ? result(input) : result
    if (key.startsWith('ssh-keygen -l ')) return printOf(input)
    return { code: 0, stdout: '', stderr: '' }
  }
  return { run, calls }
}
const PROTECTED: RunResult = { code: 255, stdout: '', stderr: 'Load key "x": incorrect passphrase supplied to decrypt private key\n' }
const ABSENT: RunResult = { code: 255, stdout: '', stderr: 'x: No such file or directory\n' }

describe('certificate validity parsing', () => {
  it('reads ssh-keygen -L output, including forever and open-ended forms', () => {
    expect(certValidUntil(report('Valid: from 2026-09-23T08:00:00 to 2026-09-24T08:00:00'))).toBe(new Date('2026-09-24T08:00:00').getTime())
    expect(certValidUntil(report('Valid: before 2026-09-24T08:00:00'))).toBe(new Date('2026-09-24T08:00:00').getTime())
    expect(certValidUntil(report('Valid: forever'))).toBe(Infinity)
    expect(certValidUntil(report('Valid: after 2026-01-01T00:00:00'))).toBe(Infinity)
    expect(certValidUntil('garbage')).toBeNull()
  })

  it('finds certificatefile entries in ssh -G output and expands ~', () => {
    expect(certificateFilesFromSshG('user me\ncertificatefile ~/.ssh/id_ed25519-cert.pub\ncertificatefile none\n', '/home/me'))
      .toEqual(['/home/me/.ssh/id_ed25519-cert.pub'])
  })
})

describe('gatherSshCredentialEvidence (stubbed tools)', () => {
  it('SSH_AUTH_SOCK unset and every identity file absent or passphrase-protected → agent-missing', async () => {
    const { run, calls } = stubRun({
      'ssh -G': { code: 0, stdout: SSH_G, stderr: '' },
      'ssh-keygen -y -P  -f /home/me/.ssh/id_rsa': ABSENT,
      'ssh-keygen -y -P  -f /home/me/.ssh/id_ed25519': PROTECTED,
    })
    expect(await gatherSshCredentialEvidence('me@devbox', { env: { HOME: '/home/me' }, run, now: () => NOW }))
      .toEqual({ tag: 'agent-missing', detail: 'SSH_AUTH_SOCK is not set for Walnut' })
    expect(calls).toContain('ssh-keygen -y -P  -f /home/me/.ssh/id_ed25519')
  })

  it('no agent but a passphrase-less key file: ssh offered it and was refused, so it stays plain auth', async () => {
    const { run } = stubRun({
      'ssh -G': { code: 0, stdout: SSH_G, stderr: '' },
      'ssh-keygen -y -P  -f /home/me/.ssh/id_rsa': ABSENT,
      'ssh-keygen -y -P  -f /home/me/.ssh/id_ed25519': { code: 0, stdout: `${OTHER_KEY}\n`, stderr: '' },
    })
    expect(await gatherSshCredentialEvidence('me@devbox', { env: { HOME: '/home/me' }, run, now: () => NOW })).toBeNull()
  })

  it('an empty agent next to a passphrase-less key file is plain auth too', async () => {
    const { run } = stubRun({
      'ssh-add -L': { code: 1, stdout: 'The agent has no identities.\n', stderr: '' },
      'ssh -G': { code: 0, stdout: SSH_G, stderr: '' },
      'ssh-keygen -y -P  -f /home/me/.ssh/id_ed25519': { code: 0, stdout: `${OTHER_KEY}\n`, stderr: '' },
    })
    expect(await gatherSshCredentialEvidence('me@devbox', { env: { SSH_AUTH_SOCK: '/x', HOME: '/home/me' }, run })).toBeNull()
  })

  it('an agent socket that does not answer → agent-missing', async () => {
    const { run } = stubRun({ 'ssh-add -L': { code: 2, stdout: '', stderr: 'Error connecting to agent: No such file or directory\n' } })
    expect((await gatherSshCredentialEvidence('me@devbox', { env: { SSH_AUTH_SOCK: '/x', HOME: '/h' }, run }))?.tag).toBe('agent-missing')
  })

  it('an agent with no keys (a short-lived agent dropped them) → agent-empty', async () => {
    const { run } = stubRun({ 'ssh-add -L': { code: 1, stdout: 'The agent has no identities.\n', stderr: '' } })
    expect((await gatherSshCredentialEvidence('me@devbox', { env: { SSH_AUTH_SOCK: '/x', HOME: '/h' }, run }))?.tag).toBe('agent-empty')
  })

  it('every certificate past its valid-until, and the agent key is that certificate\'s own → cert-expired with the time', async () => {
    // `ssh-add` of a key with a certificate loads BOTH: the key is the same credential.
    const { run } = stubRun({
      'ssh-add -L': { code: 0, stdout: `${KEY}\n${CERT}\n`, stderr: '' },
      'ssh-keygen -L': { code: 0, stdout: EXPIRED, stderr: '' },
    })
    expect(await gatherSshCredentialEvidence('me@devbox', { env: { SSH_AUTH_SOCK: '/x', HOME: '/h' }, run, now: () => NOW }))
      .toEqual({ tag: 'cert-expired', detail: 'SSH certificate expired at 2026-09-24 08:00' })
  })

  it('an unrelated expired certificate next to another key that was refused stays plain auth', async () => {
    const { run } = stubRun({
      'ssh-add -L': { code: 0, stdout: `${OTHER_KEY}\n${KEY}\n${CERT}\n`, stderr: '' },
      'ssh-keygen -L': { code: 0, stdout: EXPIRED, stderr: '' },
    })
    expect(await gatherSshCredentialEvidence('wrong-user@devbox', { env: { SSH_AUTH_SOCK: '/x', HOME: '/h' }, run, now: () => NOW })).toBeNull()
  })

  it("an expired certificate that is this host's own certificatefile counts even with other keys around", async () => {
    const { run } = stubRun({
      'ssh-add -L': { code: 0, stdout: `${OTHER_KEY}\n`, stderr: '' },
      'ssh -G': { code: 0, stdout: 'certificatefile ~/.ssh/id-cert.pub\n', stderr: '' },
      'ssh-keygen -L': { code: 0, stdout: EXPIRED, stderr: '' },
    })
    const readFile = async () => CERT + '\n'
    expect((await gatherSshCredentialEvidence('me@devbox', { env: { SSH_AUTH_SOCK: '/x', HOME: '/h' }, run, readFile, now: () => NOW }))?.tag).toBe('cert-expired')
  })

  it('one still-valid certificate means the refusal is something else: no evidence', async () => {
    let n = 0
    const run = async (file: string, args: string[] = []): Promise<RunResult> => {
      if (file === 'ssh-add') return { code: 0, stdout: `${CERT}\n${CERT.replace('me@laptop', 'other')}\n`, stderr: '' }
      if (file === 'ssh-keygen' && args[0] === '-l') return printOf()
      if (file === 'ssh-keygen') {
        n++
        return { code: 0, stdout: report(n === 1 ? 'Valid: from 2026-09-23T08:00:00 to 2026-09-24T08:00:00' : 'Valid: forever'), stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    }
    expect(await gatherSshCredentialEvidence('me@devbox', { env: { SSH_AUTH_SOCK: '/x', HOME: '/h' }, run, now: () => NOW })).toBeNull()
  })

  it('a certificate named by ssh config (not in the agent) counts too', async () => {
    const { run } = stubRun({
      'ssh -G': { code: 0, stdout: 'certificatefile ~/.ssh/id-cert.pub\nidentityfile ~/.ssh/id\n', stderr: '' },
      'ssh-keygen -L': { code: 0, stdout: report('Valid: from 2026-09-20T00:00:00 to 2026-09-21T00:00:00'), stderr: '' },
      'ssh-keygen -y': { code: 0, stdout: `${OTHER_KEY}\n`, stderr: '' },
    })
    const readFile = async (p: string) => { expect(p).toBe('/h/.ssh/id-cert.pub'); return CERT + '\n' }
    expect((await gatherSshCredentialEvidence('me@devbox', { env: { HOME: '/h' }, run, readFile, now: () => NOW }))?.tag).toBe('cert-expired')
  })
})

describe('annotateCredentialFailure', () => {
  it('a refusal that lists publickey among other methods is asked about too', () => {
    expect(looksLikeCredentialFailure('me@devbox: Permission denied (keyboard-interactive,publickey).')).toBe(true)
    expect(looksLikeCredentialFailure('EACCES: permission denied, open /tmp/x')).toBe(false)
  })

  it('only auth failures are annotated, once, and the tag drives the classifier and survives the summary', async () => {
    const { run } = stubRun({})
    const deps = { env: { HOME: '/h' }, run, now: () => NOW }
    const other = new Error('ssh: connect to host devbox port 22: Connection refused')
    expect(await annotateCredentialFailure(other, 'me@devbox', deps)).toBe(other)

    const raw = new Error('Command failed: ssh me@devbox sh -s\nme@devbox: Permission denied (publickey).')
    const annotated = await annotateCredentialFailure(raw, 'me@devbox', deps) as Error
    expect(annotated.message).toMatch(/\nwalnut-ssh-evidence: agent-missing \(SSH_AUTH_SOCK is not set for Walnut\)$/)
    expect(looksLikeCredentialFailure(annotated.message)).toBe(false)
    expect(classifyHostConnectError(annotated.message, 'me@devbox').kind).toBe('agent_missing')
    const summary = summarizeConnectFailure(annotated.message)
    expect(summary).toContain('Permission denied (publickey).')
    expect(summary).toContain('walnut-ssh-evidence: agent-missing')
    expect(classifyHostConnectError(summary, 'me@devbox').kind).toBe('agent_missing')
  })
})

const haveTools = ['ssh-agent', 'ssh-add', 'ssh-keygen'].every((t) => spawnSync('/bin/sh', ['-c', `command -v ${t}`]).status === 0)

describe.skipIf(!haveTools)('real tools, private throwaway agent', () => {
  it('an agent holding a certificate that just expired reads as cert-expired', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-cert-'))
    const sock = path.join(dir, 'agent.sock')
    const keygen = (args: string[]) => execFileSync('ssh-keygen', args, { cwd: dir, stdio: 'pipe' })
    let agentPid = 0
    try {
      keygen(['-q', '-t', 'ed25519', '-N', '', '-C', 'walnut-test-ca', '-f', path.join(dir, 'ca')])
      keygen(['-q', '-t', 'ed25519', '-N', '', '-C', 'walnut-test-user', '-f', path.join(dir, 'user')])
      // Valid from a minute ago until one second from now.
      keygen(['-q', '-s', path.join(dir, 'ca'), '-I', 'walnut-test', '-n', 'me', '-V', '-1m:+1s', path.join(dir, 'user.pub')])
      const out = execFileSync('ssh-agent', ['-s', '-a', sock], { encoding: 'utf-8' })
      agentPid = parseInt(out.match(/SSH_AGENT_PID=(\d+)/)?.[1] ?? '0', 10)
      const env = { ...process.env, SSH_AUTH_SOCK: sock }
      execFileSync('ssh-add', [path.join(dir, 'user')], { env, stdio: 'pipe' })
      await new Promise((r) => setTimeout(r, 2_500))
      const run = (file: string, args: string[], input?: string) => new Promise<RunResult>((resolve) => {
        if (file === 'ssh') { resolve({ code: 0, stdout: '', stderr: '' }); return }  // keep the user's ssh config out of it
        const child = execFile(file, args, { env, encoding: 'utf-8', timeout: 5_000 }, (err, stdout, stderr) => {
          resolve({ code: err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : -1) : 0, stdout, stderr })
        })
        child.stdin?.end(input ?? '')
      })
      const e = await gatherSshCredentialEvidence('me@devbox', { env: { SSH_AUTH_SOCK: sock, HOME: dir }, run })
      expect(e?.tag).toBe('cert-expired')
    } finally {
      if (agentPid > 1) { try { process.kill(agentPid, 'SIGTERM') } catch { /* gone */ } }
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 20_000)
})
