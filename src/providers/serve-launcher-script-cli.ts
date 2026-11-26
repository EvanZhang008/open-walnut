/**
 * `walnut __service-launcher-script --state <dir> --seed <run> --self <file> [--trial <s>]`: prints the
 * service launcher (service-launcher-script.ts) that keeps this machine's own Walnut server, the
 * leader's, for scripts/dev-prod.sh (scripts/lib/devprod-launcher.sh), which writes it in place and
 * loads it as the production launchd job. The same script a host's service runs under, so one
 * launcher, one protocol (request, result, state, ready, heartbeat): only what it runs differs.
 *
 *  --state  the launcher's dir (its `launcher/` files, the versions beside it); absolute
 *  --seed   the version it runs when it has no state yet: a version's run script; absolute
 *  --self   where the script itself will be (it re-runs itself when an update rewrites it)
 *  --trial  seconds a new version has to write ready before it is put back (default TRIAL_SECONDS)
 *
 * The run script sets up the server's environment itself, so the launcher's ARGS is empty and its
 * HOME and PATH are the deploy's: its PATH's absolute entries (absoluteSearchPath), so an empty entry in the
 * deploying shell's PATH (`a::b`, which the config check refuses) no longer stops a deploy
 * (2026-11-26, 6cfb4bdfc8's deploy). Exit 0 with the script on stdout, 2 with a reason for bad words.
 */
import { absoluteSearchPath } from './daemon-service-config.js'
import { renderLauncherScript, TRIAL_SECONDS } from './service-launcher-script.js'

export function serveLauncherScript(argv: string[], env: NodeJS.ProcessEnv = process.env): string {
  const opts = new Map<string, string>()
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]!
    const value = argv[i + 1]
    if (!['--state', '--seed', '--self', '--trial'].includes(key) || value === undefined) throw new Error(`unknown or incomplete argument: ${key}`)
    opts.set(key, value)
  }
  const state = opts.get('--state'); const seed = opts.get('--seed'); const self = opts.get('--self')
  if (!state || !seed || !self) throw new Error('--state, --seed and --self are all needed')
  const trial = opts.has('--trial') ? Number(opts.get('--trial')) : TRIAL_SECONDS
  if (!Number.isInteger(trial) || trial < 10 || trial > 3600) throw new Error('--trial must be whole seconds from 10 to 3600')
  const home = env.HOME
  if (!home) throw new Error('HOME is not set')
  return renderLauncherScript({
    platform: 'linux', home, executable: seed, args: [], runtimeDir: state, stateDir: state, path: absoluteSearchPath(env.PATH) || '/usr/bin:/bin:/usr/sbin:/sbin',
  }, { backend: 'launchd', self, clocks: { trial } })
}

export function runServeLauncherScript(argv: string[]): number {
  try {
    process.stdout.write(serveLauncherScript(argv))
    return 0
  } catch (err) {
    process.stderr.write(`walnut __service-launcher-script: ${err instanceof Error ? err.message : String(err)}\n`)
    return 2
  }
}
