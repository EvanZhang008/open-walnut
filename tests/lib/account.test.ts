/**
 * src/lib/account.ts: the account as the passwd database knows it. Under bun,
 * os.userInfo() answers $USER and $HOME, so a process started with a fake HOME
 * and no USER (a test, an ephemeral server) must still see the real account.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { accountInfo, parsePasswdLine } from '../../src/lib/account.js'

const ROOT = path.resolve(import.meta.dirname, '../..')
const onBun = typeof (process.versions as { bun?: string }).bun === 'string'

describe('parsePasswdLine', () => {
  it('reads the 7-field passwd form', () => {
    expect(parsePasswdLine('quentin:x:1001:1002:Quentin,,,:/home/quentin:/bin/bash\n')).toEqual({
      username: 'quentin', homedir: '/home/quentin', shell: '/bin/bash', uid: 1001, gid: 1002,
    })
  })

  it("reads macOS's 10-field form (`id -P`)", () => {
    expect(parsePasswdLine('quentin:********:501:20::0:0:Quentin:/Users/quentin:/bin/zsh')).toEqual({
      username: 'quentin', homedir: '/Users/quentin', shell: '/bin/zsh', uid: 501, gid: 20,
    })
  })

  it('reads the home and shell from the end when the full name holds a colon (Directory Services allows it)', () => {
    expect(parsePasswdLine('quentin:********:501:20::0:0:Quentin: the second:/Users/quentin:/bin/zsh')).toEqual({
      username: 'quentin', homedir: '/Users/quentin', shell: '/bin/zsh', uid: 501, gid: 20,
    })
  })

  it('keeps an empty shell', () => {
    expect(parsePasswdLine('svc:x:999:999::/var/lib/svc:')?.shell).toBe('')
  })

  it('refuses what is not an entry', () => {
    for (const line of ['', '# comment', '+::::::', 'a:x:1:2:g:/h', 'a:x:one:2:g:/h:/bin/sh', 'a:x:1:2:g:relative:/bin/sh', ':x:1:2:g:/h:/bin/sh']) {
      expect(parsePasswdLine(line), line).toBeNull()
    }
  })
})

describe('accountInfo', () => {
  it('names the running uid', () => {
    const info = accountInfo()
    expect(info.uid).toBe(process.getuid!())
    expect(info.username).not.toBe('')
    expect(path.isAbsolute(info.homedir)).toBe(true)
  })

  it.skipIf(!onBun)('looks the entry up once per process', () => {
    expect(accountInfo()).toBe(accountInfo())
  })

  it.skipIf(!onBun)('a bun process with a fake HOME and no USER still sees the real account', async () => {
    const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'account-fake-home-'))
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, HOME: fake }
      delete env.USER
      delete env.LOGNAME
      const script = `import { accountInfo } from ${JSON.stringify(path.join(ROOT, 'src/lib/account.ts'))}
import os from 'node:os'
console.log(JSON.stringify({ account: accountInfo(), envHome: os.homedir(), envUser: os.userInfo().username }))`
      const out = await new Promise<string>((resolve, reject) => {
        const child = spawn(process.execPath, ['-e', script], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (d) => { stdout += d })
        child.stderr.on('data', (d) => { stderr += d })
        child.on('error', reject)
        child.on('close', (code) => (code === 0 ? resolve(stdout) : reject(new Error(`exit ${code}: ${stderr}`))))
      })
      const seen = JSON.parse(out.trim().split('\n').pop()!)
      // What the environment says, which is what bun's own os module reports.
      expect(seen.envHome).toBe(fake)
      expect(seen.envUser).toBe('unknown')
      // What the account is.
      expect(seen.account).toEqual(accountInfo())
      expect(seen.account.homedir).not.toBe(fake)
    } finally {
      fs.rmSync(fake, { recursive: true, force: true })
    }
  })
})
