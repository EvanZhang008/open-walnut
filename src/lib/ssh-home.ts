/**
 * The home whose ~/.ssh Walnut reads (its config, keys and certificates) and the SSH agent it
 * asks. Everywhere: $HOME, else os.homedir(), and the process's own SSH_AUTH_SOCK.
 *
 * Walnut Demo runs under a HOME of its own. When the person has a ~/.ssh/config, the Demo reads
 * the OS account's ~/.ssh by itself (src/commands/demo-real-ssh.ts) and asks the agent the Demo
 * launcher was started with, the same settings its ssh wrapper then uses (src/commands/demo-ssh.ts),
 * so the hosts it lists are the ones it connects to. Otherwise it reads only the Demo HOME's ~/.ssh
 * and asks no agent.
 *
 * Every path to ~/.ssh in src/ goes through here (tests/core/ssh-home-guard.test.ts). Its one
 * Walnut import is lib/account.ts: the scanner, the credential checks and the file routes all ask it.
 */
import os from 'node:os'
import path from 'node:path'
import { accountInfo } from './account.js'

interface AccountSsh { home: string; agentSock: string | undefined }

let account: AccountSsh | null = null

/** The home whose `.ssh` holds the settings and keys this process uses. */
export function sshHome(env: NodeJS.ProcessEnv = process.env): string {
  return account?.home ?? (env.HOME || os.homedir())
}

/** `<sshHome>/.ssh`. */
export function sshDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(sshHome(env), '.ssh')
}

/**
 * Every `.ssh` that holds this person's keys: its own HOME's, the account's in use, and the OS
 * account's own (a Demo runs under another HOME, but the person's real ~/.ssh is still theirs,
 * so the file routes refuse it there too, opt-in or not).
 */
export function sshDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const dirs = [path.join(env.HOME || os.homedir(), '.ssh')]
  if (account) dirs.push(path.join(account.home, '.ssh'))
  let osHome: string | undefined
  // The passwd entry: on bun os.userInfo().homedir answers $HOME, the Demo HOME (lib/account.ts).
  try { osHome = accountInfo().homedir } catch { osHome = undefined }
  if (osHome) dirs.push(path.join(osHome, '.ssh'))
  return [...new Set(dirs)]
}

/** The agent socket ssh would use, or undefined when there is none. */
export function sshAgentSock(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return account ? account.agentSock : env.SSH_AUTH_SOCK
}

/**
 * The environment for a child that asks the agent (`ssh-add`): undefined (inherit this process's)
 * unless the account's ~/.ssh is in use, then `env` with the account's agent.
 */
export function sshAgentEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv | undefined {
  if (!account) return undefined
  const out = { ...env }
  if (account.agentSock) out.SSH_AUTH_SOCK = account.agentSock
  else delete out.SSH_AUTH_SOCK
  return out
}

/** Walnut Demo only: read the account's ~/.ssh and its agent from now on (null: back to $HOME). */
export function setAccountSsh(next: AccountSsh | null): void {
  account = next && path.isAbsolute(next.home) ? { home: next.home, agentSock: next.agentSock || undefined } : null
}

/** Is the account's ~/.ssh in use (the Demo's opt-in)? */
export function accountSshInUse(): boolean {
  return account !== null
}
