import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createSystemServiceAccess, SYSTEM_CONFIG_SCRIPT } from '../../src/providers/daemon-service-system.js'

const target = '/etc/systemd/system/open-walnut-daemon.service'
const ok = { code: 0, stdout: '', stderr: '' }

describe('system service administrator boundary', () => {
  it('probes noninteractive administrator access without changing a service', async () => {
    const run = vi.fn().mockResolvedValue(ok)
    const access = createSystemServiceAccess(run)
    await access.preflight()
    expect(run).toHaveBeenCalledTimes(10)
    expect(run.mock.calls.slice(0, 9).every((call) => call[0] === 'sudo' && call[1][1] === '-l')).toBe(true)
    expect(run).toHaveBeenCalledWith('sudo', ['-n', '-l', '--', '/usr/bin/systemctl', 'restart', 'open-walnut-daemon.service'])
    expect(run).toHaveBeenLastCalledWith('sudo', ['-n', '--', '/usr/bin/python3', '-I', '-c', SYSTEM_CONFIG_SCRIPT, 'probe'], undefined)
    expect(access.configOwnerUid).toBe(0)
  })

  it('resets start limits only for the exact owned unit and preflights that permission', async () => {
    const run = vi.fn().mockResolvedValue(ok)
    const access = createSystemServiceAccess(run)
    await access.preflight()
    expect(run).toHaveBeenCalledWith('sudo', ['-n', '-l', '--', '/usr/bin/systemctl', 'reset-failed', 'open-walnut-daemon.service'])
    run.mockClear()
    await access.run('systemctl', ['reset-failed', 'open-walnut-daemon.service'])
    expect(run).toHaveBeenCalledExactlyOnceWith('sudo', ['-n', '--', '/usr/bin/systemctl', 'reset-failed', 'open-walnut-daemon.service'])
    for (const args of [['reset-failed'], ['reset-failed', 'other.service'], ['reset-failed', '*'], ['reset-failed', '--now', 'open-walnut-daemon.service']]) {
      expect(() => access.run('systemctl', args)).toThrow('Only the Walnut')
    }
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('leaves status probes unprivileged and elevates only unit mutations', async () => {
    const run = vi.fn().mockResolvedValue(ok)
    const access = createSystemServiceAccess(run)
    await access.run('systemctl', ['show', 'open-walnut-daemon.service'])
    await access.run('loginctl', ['show-user', 'walnut', '-p', 'Linger', '--value'])
    await access.run('systemctl', ['restart', 'open-walnut-daemon.service'])
    expect(run.mock.calls).toEqual([
      ['systemctl', ['show', 'open-walnut-daemon.service']],
      ['loginctl', ['show-user', 'walnut', '-p', 'Linger', '--value']],
      ['sudo', ['-n', '--', '/usr/bin/systemctl', 'restart', 'open-walnut-daemon.service']],
    ])
    expect(() => access.run('systemctl', ['restart', 'other.service'])).toThrow('Only the Walnut')
    expect(() => access.run('systemctl', ['daemon-reload', '--root=/other'])).toThrow('Only the Walnut')
    expect(run).toHaveBeenCalledTimes(3)
  })

  it('passes config bytes through stdin with a hash of the version being replaced', async () => {
    const run = vi.fn().mockResolvedValue(ok)
    const access = createSystemServiceAccess(run)
    const text = '[Service]\nUser=walnut\nExecStart="/home/walnut/a $b" "--service"\n'
    await access.configIo.write(target, text, 'previous')
    expect(run).toHaveBeenCalledExactlyOnceWith('sudo', ['-n', '--', '/usr/bin/python3', '-I', '-c', SYSTEM_CONFIG_SCRIPT, 'write'], JSON.stringify({
      text, expectedHash: createHash('sha256').update('previous').digest('hex'),
    }))
    expect(run.mock.calls[0][1]).not.toContain(text)
  })

  it('distinguishes first install and removal without accepting another path', async () => {
    const run = vi.fn().mockResolvedValue(ok)
    const access = createSystemServiceAccess(run)
    await access.configIo.write(target, 'new', null)
    expect(JSON.parse(run.mock.calls[0][2])).toEqual({ text: 'new', expectedHash: null })
    await access.configIo.remove(target, 'new')
    expect(JSON.parse(run.mock.calls[1][2])).toEqual({ expectedHash: createHash('sha256').update('new').digest('hex') })
    await expect(access.configIo.write('/etc/other.service', 'bad', null)).rejects.toThrow('Only the Walnut')
    await expect(access.configIo.remove('/etc/other.service', 'bad')).rejects.toThrow('Only the Walnut')
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('does not convert authorization or compare-and-swap failures into success', async () => {
    const run = vi.fn().mockResolvedValue({ code: 1, stdout: '', stderr: 'Service configuration changed during installation' })
    const access = createSystemServiceAccess(run)
    await expect(access.preflight()).rejects.toThrow('Administrator service permission is unavailable')
    await expect(access.configIo.write(target, 'new', 'old')).rejects.toThrow('configuration changed')
    await expect(access.configIo.remove(target, 'old')).rejects.toThrow('configuration changed')
  })

  it('refuses before writing when Python is allowed but service control is not', async () => {
    const run = vi.fn(async (_program: string, args: string[]) => args.includes('/usr/bin/systemctl')
      ? { code: 1, stdout: '', stderr: 'not permitted' } : ok)
    await expect(createSystemServiceAccess(run).preflight()).rejects.toThrow('not permitted')
    expect(run.mock.calls.every((call) => call[1][1] === '-l')).toBe(true)
  })

  it('keeps the administrator script limited to a protected unit and durable atomic replacement', () => {
    expect(SYSTEM_CONFIG_SCRIPT).toContain("os.open('/etc/systemd/system',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)")
    expect(SYSTEM_CONFIG_SCRIPT).toContain("if digest!=data['expectedHash']")
    expect(SYSTEM_CONFIG_SCRIPT.indexOf('fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)')).toBeLessThan(SYSTEM_CONFIG_SCRIPT.indexOf('source=os.open'))
    expect(SYSTEM_CONFIG_SCRIPT).toContain('except BlockingIOError:')
    expect(SYSTEM_CONFIG_SCRIPT).toContain('os.O_EXCL|os.O_NOFOLLOW')
    expect(SYSTEM_CONFIG_SCRIPT).toContain('os.rename(temporary,name,src_dir_fd=fd,dst_dir_fd=fd)')
    expect(SYSTEM_CONFIG_SCRIPT).toContain('os.fsync(fd)')
    expect(SYSTEM_CONFIG_SCRIPT).not.toMatch(/subprocess|os\.system|shutil|chown|kill/)
  })
})
