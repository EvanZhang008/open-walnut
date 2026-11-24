/**
 * Options this computer's own `ssh` client takes, for the few Walnut passes that an older OpenSSH
 * refuses outright: an unknown `-o` name ends ssh with "Bad configuration option" (exit 255) before
 * it dials, so the whole command fails, not just the option.
 *
 *   RemoteCommand   OpenSSH 7.6 (2017). The system ssh of some long-lived Linux distributions is
 *                   older (7.4), so a leader running there could not open any link that passes
 *                   `-o RemoteCommand=none` (2026-11-24, a real-ssh check from such a box: every
 *                   stream lane failed with "Bad configuration option: remotecommand").
 *
 * learnSshClient() asks the client once per process (`ssh -G` only prints the config it would use,
 * it dials nothing) and is awaited where a host's first ssh link starts (startControlMaster) and by
 * every async caller; the sync readers below then answer from it. Before it answered they keep
 * today's options, so a current client never changes.
 *
 * Every `-o` name Walnut passes is listed in tests/providers/ssh-client-options.test.ts with the
 * OpenSSH version that added it; a name newer than OLDEST_OPENSSH goes through here.
 */
import { runSshBounded, type SshRun } from './remote-sh.js'

/** The oldest OpenSSH client Walnut's plain options are checked against (CentOS 7 and Amazon Linux 2 ship 7.4). */
export const OLDEST_OPENSSH = '7.4'

const PROBE_TIMEOUT_MS = 5_000

let remoteCommand: boolean | null = null
let learning: Promise<void> | null = null

type ProbeRun = (args: string[], opts: { timeoutMs: number }) => Promise<SshRun>

/** Whether ssh's answer to `-G -o RemoteCommand=none` says it does not know the option. */
export function refusesRemoteCommand(res: Pick<SshRun, 'code' | 'stderr'>): boolean {
  return res.code !== 0 && /bad configuration option:\s*remotecommand/i.test(res.stderr)
}

/** Ask this computer's ssh client once which of the newer options it takes. Never throws. */
export function learnSshClient(run: ProbeRun = runSshBounded): Promise<void> {
  learning ??= (async () => {
    try {
      const res = await run(['-G', '-o', 'RemoteCommand=none', 'walnut-ssh-probe.invalid'], { timeoutMs: PROBE_TIMEOUT_MS })
      // Anything else (no ssh, a timeout) leaves the options as they were: the real call says why.
      if (!res.spawnError && !res.timedOut) remoteCommand = !refusesRemoteCommand(res)
    } catch { /* unknown: keep today's options */ }
  })()
  return learning
}

/** `-o RemoteCommand=none` (a config file's RemoteCommand would refuse Walnut's command), unless this ssh refuses the option. */
export function remoteCommandNone(): string[] {
  return remoteCommand === false ? [] : ['-o', 'RemoteCommand=none']
}

/** Tests: forget what the client said. */
export function _resetSshClientOptionsForTesting(value: boolean | null = null): void {
  remoteCommand = value
  learning = null
}
