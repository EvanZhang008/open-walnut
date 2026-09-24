import { createHash } from 'node:crypto'
import type { DaemonServiceCommandResult } from './daemon-service-manager.js'

const SYSTEM_CONFIG = '/etc/systemd/system/open-walnut-daemon.service'
const MUTATIONS = new Set(['daemon-reload', 'enable', 'disable', 'restart', 'stop', 'reset-failed'])

// The privileged part touches only the fixed unit, and re-checks the original bytes under a root directory descriptor before overwriting.
export const SYSTEM_CONFIG_SCRIPT = `import os,sys,json,hashlib,secrets,stat,fcntl
if os.geteuid()!=0: raise RuntimeError('Administrator privileges are required')
action=sys.argv[1]
if action=='probe': sys.exit(0)
if action not in ('write','remove'): raise RuntimeError('Invalid service operation')
data=json.load(sys.stdin)
name='open-walnut-daemon.service'
fd=os.open('/etc/systemd/system',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
temporary=None
try:
 info=os.fstat(fd)
 if info.st_uid!=0 or info.st_mode&0o022: raise RuntimeError('System unit directory is not protected')
 try: fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
 except BlockingIOError: raise RuntimeError('Another administrator service write is in progress; retry after it finishes')
 try:
  source=os.open(name,os.O_RDONLY|os.O_NOFOLLOW,dir_fd=fd)
 except FileNotFoundError: source=None
 digest=None
 if source is not None:
  with os.fdopen(source,'rb') as stream:
   info=os.fstat(stream.fileno())
   if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_mode&0o022: raise RuntimeError('System unit is not protected')
   digest=hashlib.sha256(stream.read()).hexdigest()
 if digest!=data['expectedHash']: raise RuntimeError('Service configuration changed during installation')
 if action=='remove':
  if digest is None: raise RuntimeError('Service configuration is absent')
  os.unlink(name,dir_fd=fd)
 else:
  text=data['text'].encode('utf-8')
  temporary=name+'.'+secrets.token_hex(12)+'.tmp'
  target=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=fd)
  with os.fdopen(target,'wb') as stream:
   stream.write(text)
   stream.flush()
   os.fchmod(stream.fileno(),0o644)
   os.fsync(stream.fileno())
  os.rename(temporary,name,src_dir_fd=fd,dst_dir_fd=fd)
  temporary=None
 os.fsync(fd)
finally:
 if temporary is not None:
  try: os.unlink(temporary,dir_fd=fd)
  except FileNotFoundError: pass
 os.close(fd)
`

export type ServiceCommandRunner = (program: string, args: string[], input?: string) => Promise<DaemonServiceCommandResult>

export function createSystemServiceAccess(run: ServiceCommandRunner) {
  async function mutate(action: 'probe' | 'write' | 'remove', payload?: Record<string, unknown>): Promise<void> {
    const result = await run('sudo', ['-n', '--', '/usr/bin/python3', '-I', '-c', SYSTEM_CONFIG_SCRIPT, action], payload ? JSON.stringify(payload) : undefined)
    if (result.code !== 0) throw new Error(`Administrator service operation failed: ${result.stderr.trim() || `exit ${result.code}`}`)
  }
  const checkTarget = (target: string) => {
    if (target !== SYSTEM_CONFIG) throw new Error('Only the Walnut system unit can be changed')
  }
  return {
    preflight: async () => {
      const commands = [
        ...['write', 'remove'].map((action) => ['/usr/bin/python3', '-I', '-c', SYSTEM_CONFIG_SCRIPT, action]),
        ['daemon-reload'], ['enable', '--now', 'open-walnut-daemon.service'],
        ['disable', '--now', 'open-walnut-daemon.service'], ['disable', 'open-walnut-daemon.service'],
        ['restart', 'open-walnut-daemon.service'], ['stop', 'open-walnut-daemon.service'],
        ['reset-failed', 'open-walnut-daemon.service'],
      ]
      for (const command of commands) {
        const argv = command[0] === '/usr/bin/python3' ? command : ['/usr/bin/systemctl', ...command]
        const result = await run('sudo', ['-n', '-l', '--', ...argv])
        if (result.code !== 0) throw new Error(`Administrator service permission is unavailable: ${result.stderr.trim() || `exit ${result.code}`}`)
      }
      await mutate('probe')
    },
    run: (program: string, args: string[]) => {
      if (program !== 'systemctl' || !MUTATIONS.has(args[0])) return run(program, args)
      const expected = args[0] === 'daemon-reload' ? [args[0]]
        : [args[0], ...(['enable', 'disable'].includes(args[0]) && args[1] === '--now' ? ['--now'] : []), 'open-walnut-daemon.service']
      if (args.length !== expected.length || args.some((arg, i) => arg !== expected[i])) {
        throw new Error('Only the Walnut system unit can be changed')
      }
      return run('sudo', ['-n', '--', '/usr/bin/systemctl', ...args])
    },
    configOwnerUid: 0,
    configIo: {
      write: async (target: string, text: string, previous: string | null) => {
        checkTarget(target)
        await mutate('write', { text, expectedHash: previous === null ? null : createHash('sha256').update(previous).digest('hex') })
      },
      remove: async (target: string, previous: string) => {
        checkTarget(target)
        await mutate('remove', { expectedHash: createHash('sha256').update(previous).digest('hex') })
      },
    },
  }
}
