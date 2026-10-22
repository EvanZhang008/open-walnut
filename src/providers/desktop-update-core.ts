import type fsType from 'node:fs'
import type childProcess from 'node:child_process'

export interface DesktopUpdateStatus {
  available: boolean
  token: string | null
  version: string | null
}

export interface DesktopUpdateDeps {
  fs: typeof fsType
  execFile: typeof childProcess.execFile
  spawn: typeof childProcess.spawn
  platform: string
  home: string
  env: Record<string, string | undefined>
  isolated?: boolean
}

export function createDesktopUpdate(deps: DesktopUpdateDeps) {
  var empty = { available: false, token: null, version: null } as DesktopUpdateStatus
  async function executable(): Promise<string | null> {
    if (deps.platform !== 'darwin' || deps.isolated) return null
    var candidates = ['/Applications/Walnut.app/Contents/MacOS/Walnut', deps.home + '/Applications/Walnut.app/Contents/MacOS/Walnut']
    for (var file of candidates) {
      try {
        if ((await deps.fs.promises.readFile(file)).includes(Buffer.from('--desktop-update-bridge'))) return file
      } catch (_e) { /* An older app cannot answer this helper flag. */ }
    }
    return null
  }
  async function status(): Promise<DesktopUpdateStatus> {
    var file = await executable()
    if (!file) return Promise.resolve(empty)
    return new Promise(function (resolve) {
      deps.execFile(file!, ['--desktop-update-bridge', 'status'], { timeout: 6000, maxBuffer: 8192, env: deps.env }, function (err, stdout) {
        if (err) { resolve(empty); return }
        try {
          var out = JSON.parse(String(stdout)) as DesktopUpdateStatus
          resolve(typeof out.available === 'boolean' && (!out.available || typeof out.token === 'string') ? out : empty)
        } catch (_e) { resolve(empty) }
      })
    })
  }
  var restarting = false
  var restartError: string | null = null
  async function restart(token: unknown): Promise<{ accepted: boolean }> {
    if (typeof token !== 'string' || token.length > 200 || restarting) return { accepted: false }
    var current = await status()
    var file = await executable()
    if (!file || !current.available || current.token !== token || restarting) return { accepted: false }
    restarting = true
    restartError = null
    try {
      await new Promise<void>(function (resolve, reject) {
        var proc = deps.spawn(file!, ['--desktop-update-bridge', 'restart', token as string], { detached: true, stdio: 'ignore', env: deps.env })
        proc.once('error', reject)
        proc.once('spawn', function () { proc.unref(); resolve() })
        proc.once('exit', function (code) { restarting = false; restartError = code === 0 ? null : 'Walnut could not restart. Save your work and close any extra app windows, then try again.' })
      })
      return { accepted: true }
    } catch (_e) { restarting = false; return { accepted: false } }
  }
  return { status: async function () { return { ...await status(), restarting: restarting, error: restartError } }, restart: restart }
}
