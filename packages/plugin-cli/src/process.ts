import { spawn } from 'node:child_process'

/** npm is a `.cmd` shim on Windows, which `spawn` only finds by that name. */
export function npmBin(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

export async function spawnCommand(command: string, args: string[], cwd: string): Promise<number> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: 'inherit',
      env: process.env,
      // Windows resolves a `.cmd` shim through the shell only.
      shell: process.platform === 'win32',
      windowsHide: true,
    })
    child.once('error', reject)
    child.once('exit', (code) => resolve(code ?? 1))
  })
}

export async function npmInstall(root: string): Promise<void> {
  const code = await spawnCommand(npmBin(), ['install'], root)
  // A scaffold depends on the published @open-walnut packages by semver, so inside an unreleased checkout this is a registry 404, not a bug in the project.
  if (code !== 0) {
    throw new Error(
      `npm install failed in ${root} (exit code ${code}). If @open-walnut/plugin-api or @open-walnut/plugin-cli is not on the registry yet, re-run with --no-install and provide those packages yourself.`,
    )
  }
}

/** True when this looks like CI, where opening a browser is pointless noise. */
export function isCi(): boolean {
  const value = process.env.CI
  return typeof value === 'string' && value !== '' && value !== '0' && value.toLowerCase() !== 'false'
}

/** Only an interactive terminal that is not CI gets a browser window. */
export function canOpenBrowser(): boolean {
  return !!process.stdout.isTTY && !isCi()
}

/** Hand the URL to the platform opener, never through a shell: `&` and `^` in a URL are cmd metacharacters. */
export async function openUrl(url: string): Promise<void> {
  const command = process.platform === 'win32'
    ? 'explorer.exe'
    : process.platform === 'darwin' ? 'open' : 'xdg-open'
  await new Promise<void>((resolve) => {
    const child = spawn(command, [url], {
      stdio: 'ignore',
      detached: true,
      shell: false,
      windowsHide: true,
    })
    child.once('error', () => resolve())
    child.once('spawn', () => { child.unref(); resolve() })
  })
}
