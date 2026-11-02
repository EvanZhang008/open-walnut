/**
 * Walnut for Windows: one window, like the Mac app's. Walnut itself runs in WSL, in a Linux of
 * its own (OpenWalnut), set up by the same PowerShell steps as the invite line
 * (src/core/net/net-join-ps1.ts appScriptWindows, bundled as resources/walnut-setup.ps1), which
 * this app runs hidden and shows as steps. Then the window shows the console of this PC's own
 * Walnut (http://localhost:3456, served by a systemd service in the Linux, so it keeps serving
 * while the window is closed) or, for a PC that joined another Walnut, the This PC page.
 */
import { app, BrowserWindow, clipboard, dialog, ipcMain, session, shell, type IpcMainInvokeEvent } from 'electron'
import { autoUpdater } from 'electron-updater'
import fs from 'node:fs'
import path from 'node:path'
import { CONSOLE_PERMISSIONS, endOf, externalUrl, inferMode, netSummary, originIs, originOf, parseInvite, readState, stageOf, type AppState } from './model'
import { CONSOLE_URL, consoleAnswers, holdLinux, netStatus, probeLinux, runPowerShellFile, walnutDir } from './wsl'

const UI = path.join(__dirname, '..', 'ui')
const CONSOLE_ORIGIN = new URL(CONSOLE_URL).origin
const stateFile = () => path.join(walnutDir(), 'app.json')
const logFile = () => path.join(walnutDir(), 'app.log')
/** An own setup that stopped for the restart WSL needs: the next open carries on with it. */
const pendingFile = () => path.join(walnutDir(), 'setup-pending')

let win: BrowserWindow | null = null
let setupRunning = false
let closeAnyway = false
/** The joined Walnut's own console (its companion), once the This PC page opened it. */
let openedOrigin = ''
/** Console loads that failed lately: a few go back to waiting for it, more show why. */
let consoleFailures: number[] = []

function log(line: string): void {
  try {
    fs.mkdirSync(walnutDir(), { recursive: true })
    const f = logFile()
    if (fs.existsSync(f) && fs.statSync(f).size > 2_000_000) fs.renameSync(f, f + '.1')
    fs.appendFileSync(f, `${new Date().toISOString()} ${line}\n`)
  } catch { /* a log is never worth a failure */ }
}

function loadState(): AppState | null {
  try { return readState(fs.readFileSync(stateFile(), 'utf8')) } catch { return null }
}

function saveState(s: AppState): void {
  fs.mkdirSync(walnutDir(), { recursive: true })
  fs.writeFileSync(stateFile() + '.tmp', JSON.stringify(s, null, 2))
  fs.renameSync(stateFile() + '.tmp', stateFile())
}

function page(name: string, query: Record<string, string> = {}): void {
  win?.loadFile(path.join(UI, name), { query }).catch((err: Error & { code?: string }) => {
    // The next page replaced this one before it finished loading: nothing went wrong.
    if (err.code !== 'ERR_ABORTED') log(`could not show ${name}: ${err.message}`)
  })
}

/** Only the app's own pages (file://) may call it, never the console or a page it links to. */
function fromApp(e: IpcMainInvokeEvent): boolean {
  return (e.senderFrame?.url ?? '').startsWith('file:')
}

/** A web page the window may show: the console, or the joined Walnut's companion once opened. */
function trusted(url: string): boolean {
  return originIs(url, CONSOLE_ORIGIN) || (!!openedOrigin && originIs(url, openedOrigin))
}

/** Waits for the console, holding the Linux open meanwhile, then shows it. */
async function showConsole(): Promise<void> {
  page('loading.html')
  holdLinux()
  const until = Date.now() + 180_000
  while (Date.now() < until) {
    if (!win) return
    if (await consoleAnswers()) {
      log('console answers; showing it')
      await win?.loadURL(CONSOLE_URL).catch((err: Error) => log(`console load: ${err.message}`))
      return
    }
    await new Promise((r) => setTimeout(r, 1500))
  }
  log('console did not answer in 3 minutes')
  page('loading.html', { failed: '1' })
}

async function showStart(): Promise<void> {
  const state = loadState()
  if (state?.mode === 'own') return showConsole()
  if (state?.mode === 'join') return page('this-pc.html')
  if (fs.existsSync(pendingFile())) {
    log('an own setup waited for the restart WSL needed; carrying on')
    return page('setup.html', { auto: 'own' })
  }
  // No record: a PC that joined by the PowerShell line before the app, one whose app.json was
  // lost, or one with nothing set up (or a setup that stopped halfway).
  page('loading.html', { probing: '1' })
  const linux = await probeLinux().catch(() => ({ exists: false, consoleActive: false, joined: false }))
  const mode = inferMode(linux)
  log(`no app.json; the Linux says ${JSON.stringify(linux)}: ${mode ?? 'set up'}`)
  if (mode) {
    try { saveState({ mode, at: new Date().toISOString() }) } catch (err) { log(`app.json: ${(err as Error).message}`) }
    return mode === 'own' ? showConsole() : page('this-pc.html')
  }
  page('setup.html')
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 520,
    title: 'Walnut',
    backgroundColor: '#f7f5f0',
    autoHideMenuBar: true,
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  })
  win.once('ready-to-show', () => win?.show())
  // The console's own title stays the window's ("Walnut").
  win.on('page-title-updated', (e) => e.preventDefault())
  // A link that opens a window, or leaves the console, goes to the default browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    const ext = externalUrl(url)
    if (ext) void shell.openExternal(ext)
    return { action: 'deny' }
  })
  const guard = (e: Electron.Event, url: string) => {
    const current = win?.webContents.getURL() ?? ''
    if (url.startsWith('file:') && current.startsWith('file:')) return
    if (trusted(url)) return
    e.preventDefault()
    const ext = externalUrl(url)
    if (ext) void shell.openExternal(ext)
  }
  win.webContents.on('will-navigate', guard)
  win.webContents.on('will-redirect', guard)
  // The console went away under the window (an update restarted it, WSL stopped): wait for it
  // again rather than leave Chromium's error page. Three in two minutes: say it did not start.
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3 || !originIs(url, CONSOLE_ORIGIN)) return
    log(`console page failed to load (${code} ${desc})`)
    const now = Date.now()
    consoleFailures = [...consoleFailures.filter((t) => now - t < 120_000), now]
    if (consoleFailures.length >= 3) return page('loading.html', { failed: '1' })
    void showConsole()
  })
  // Setup runs in PowerShell, a child of this app: closing the window would end it halfway.
  win.on('close', (e) => {
    if (!setupRunning || closeAnyway || !win) return
    e.preventDefault()
    void dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Keep setting up', 'Close anyway'],
      defaultId: 0,
      cancelId: 0,
      message: 'Walnut is still setting up',
      detail: 'Closing now stops setup halfway. Open Walnut again to start it over.',
    }).then((r) => {
      if (r.response !== 1) return
      closeAnyway = true
      log('closed during setup')
      win?.close()
    })
  })
  win.on('closed', () => { win = null })
  void showStart()
}

/** Each page the window shows may ask only for what the console needs, and only the console. */
function permissions(): void {
  const allowed = (url: string, permission: string) => trusted(url) && CONSOLE_PERMISSIONS.has(permission)
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb, details) => cb(allowed(details.requestingUrl, permission)))
  session.defaultSession.setPermissionCheckHandler((_wc, permission, requestingOrigin) => allowed(requestingOrigin, permission))
}

ipcMain.handle('setup:start', async (e, mode: unknown, text: unknown) => {
  if (!fromApp(e) || setupRunning) return { ok: false, error: setupRunning ? 'Setup is already running.' : 'Not allowed.' }
  if (mode !== 'own' && mode !== 'join') return { ok: false, error: 'Choose how to use Walnut on this PC.' }
  const env: Record<string, string> = { WALNUT_APP_MODE: mode }
  let origin: string | undefined
  if (mode === 'join') {
    const invite = parseInvite(String(text ?? ''))
    if (!invite) return { ok: false, error: 'That is not a Walnut invite. Copy the link your Mac shows under Settings > Remote Hosts > Add a machine.' }
    if ('link' in invite) env.WALNUT_JOIN_LINK = invite.link
    else env.WALNUT_JOIN_TICKET = invite.ticket
    origin = originOf(invite)
  }
  setupRunning = true
  const sender = e.sender
  const script = path.join(process.resourcesPath, 'walnut-setup.ps1')
  log(`setup ${mode} starts${origin ? ` (joins ${origin})` : ''}`)
  void runPowerShellFile(script, env, (line) => {
    log(`setup| ${line}`)
    if (!sender.isDestroyed()) sender.send('setup:line', { line, stage: stageOf(line) })
  }).then((code) => {
    setupRunning = false
    const end = endOf(code)
    log(`setup ${mode} ended: ${end} (exit ${code})`)
    try {
      if (end === 'done') saveState({ mode, ...(origin ? { origin } : {}), at: new Date().toISOString() })
      if (end === 'restart' && mode === 'own') fs.writeFileSync(pendingFile(), 'own\n')
      else fs.rmSync(pendingFile(), { force: true })
    } catch (err) {
      // The next open reads what the Linux says instead.
      log(`could not keep how setup ended: ${(err as Error).message}`)
    }
    if (!sender.isDestroyed()) sender.send('setup:end', { end, code, mode })
  })
  return { ok: true }
})

ipcMain.handle('setup:clipboard-invite', async (e) => {
  if (!fromApp(e)) return null
  const invite = parseInvite(await clipboard.readText())
  return invite ? ('link' in invite ? invite.link : invite.ticket) : null
})

ipcMain.handle('app:continue', (e) => { if (fromApp(e)) void showStart() })
ipcMain.handle('app:info', (e) => fromApp(e) ? { version: app.getVersion(), log: logFile() } : null)
ipcMain.handle('console:retry', (e) => { if (fromApp(e)) { consoleFailures = []; void showConsole() } })

// Setup again, from a page that has nothing else to offer (a console that never starts, a PC
// whose join did not hold): what the app remembers goes, the Linux stays (setup reuses it).
ipcMain.handle('app:setup-again', (e) => {
  if (!fromApp(e) || setupRunning) return
  log('setup again')
  try { fs.rmSync(stateFile(), { force: true }) } catch (err) { log(`app.json: ${(err as Error).message}`) }
  page('setup.html')
})

ipcMain.handle('pc:status', async (e) => {
  if (!fromApp(e)) return null
  holdLinux()
  const state = loadState()
  const s = netSummary(await netStatus().catch((err: Error) => `Could not read this PC's Walnut: ${err.message}`))
  return { ...s, origin: state?.origin ?? null }
})

ipcMain.handle('pc:open-walnut', (e) => {
  if (!fromApp(e)) return
  const origin = loadState()?.origin
  if (!origin) return
  openedOrigin = origin
  win?.loadURL(origin + '/').catch((err: Error) => log(`companion load: ${err.message}`))
})

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!win) return createWindow()
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  })
  app.whenReady().then(() => {
    app.setAppUserModelId('dev.openwalnut.walnut')
    log(`Walnut for Windows ${app.getVersion()} starts`)
    permissions()
    createWindow()
    // A build made for a test (version 0.0.0) never updates itself from the releases.
    if (app.isPackaged && app.getVersion() !== '0.0.0') {
      autoUpdater.on('error', (err) => log(`update check: ${err.message}`))
      const check = () => { autoUpdater.checkForUpdatesAndNotify().catch((err: Error) => log(`update check: ${err.message}`)) }
      setTimeout(check, 15_000)
      setInterval(check, 4 * 60 * 60_000)
    }
  })
  // Closing the window ends the app; Walnut keeps running in the Linux.
  app.on('window-all-closed', () => app.quit())
}
