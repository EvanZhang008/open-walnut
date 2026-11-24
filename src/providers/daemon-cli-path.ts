/**
 * The PATH the daemon program's `walnut daemon ...` commands run with: the account's login-shell
 * PATH first, as the daemon runtime computes it for itself (host-runtime-core.ts computeDaemonPath).
 *
 * The CLI is dispatched before the daemon runtime is created (it sets no daemon up), and the
 * runtime is what used to put that PATH on the process. The service commands need it: the service
 * config takes its PATH from the CLI's (daemon-service-cli.ts servicePath), and systemctl,
 * launchctl and crontab are looked up on it, so a host whose tools live in a login-shell dir (nvm,
 * a toolbox bin) kept them. Spawns the login shell once and writes no file; other CLI commands
 * (tools, wait, guide) need none of it and skip the shell.
 */
import { execFile, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createHostRuntime } from './host-runtime-core.js'

/** `words` are the CLI's own (after `walnut`). */
export function cliNeedsLoginPath(words: readonly string[]): boolean {
  return words[0] === 'daemon'
}

/** Put the daemon's PATH on `env` for a CLI command that needs it. */
export function applyCliLoginPath(words: readonly string[], env: NodeJS.ProcessEnv = process.env): void {
  if (!cliNeedsLoginPath(words)) return
  const runtime = createHostRuntime({
    fs, env, platform: process.platform, arch: process.arch,
    execFile: execFile as unknown as NonNullable<Parameters<typeof createHostRuntime>[0]['execFile']>,
    execFileSync: execFileSync as unknown as NonNullable<Parameters<typeof createHostRuntime>[0]['execFileSync']>,
  })
  env.PATH = runtime.computeDaemonPath().path
}
