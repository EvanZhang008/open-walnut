/**
 * Fixture server for "a mail account brings its calendar" (mail-calendars.spec.ts).
 *
 * Its own server, not the shared :3457 fixture: it needs two IMAP accounts saved the way the
 * IMAP setup form saves them (settings in config, passwords in the plugin's secret file), the
 * `mail_calendars` experiment on, and a CalDAV server (tests/helpers/fake-caldav-server.ts) in
 * this process holding one event today, at 15:00 local. A third account's calendar setting
 * points at a server that redirects to another host, so Walnut must stop and let the person
 * pick that host ("Use <host>") before its password goes there. The Mac's calendar source is a mock
 * with no calendars (a Mac with no accounts), so nothing compiles the EventKit helper.
 *
 * Never :3456 and never the developer's data: OPEN_WALNUT_HOME, HOME and the daemon dirs all
 * point inside one temp directory that is removed on shutdown.
 *
 * Run: bun tests/e2e/browser/mail-calendar-server.ts
 * Reads PW_MAIL_CALENDAR_PORT; prints `MAIL_CALENDAR_READY <json>` when it is serving.
 */
import fs from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fixtureHome } from './fixture-home'

const port = Number(process.env.PW_MAIL_CALENDAR_PORT ?? 3463)
const tmpBase = await fixtureHome(path.join(os.tmpdir(), `walnut-mail-calendar-${port}-${Date.now()}`))

process.env.OPEN_WALNUT_HOME = tmpBase
process.env.WALNUT_DAEMON_DIR = path.join(tmpBase, 'daemon')
process.env.WALNUT_STREAMS_DIR = path.join(tmpBase, 'daemon-streams')
process.env.WALNUT_DISABLE_SEARCH = '1'
process.env.WALNUT_DISABLE_BACKGROUND_AI = '1'
process.env.HOME = tmpBase
process.env.USERPROFILE = tmpBase
process.argv.push('--_ephemeral-child')

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..')

const { ics, startFakeCalDav } = await import('../../helpers/fake-caldav-server.js')
const { localIdFor } = await import('../../../src/integrations/mail-imap/config.js')

const ADDRESS = 'pat@example.com'
const GMAIL = 'sam@gmail.com'
const LEE = 'lee@example.org'
const WORK = '/dav/calendars/pat/work/'
const caldav = await startFakeCalDav({ username: ADDRESS, password: 'app-pass', calendars: [{ path: WORK, name: 'Mail calendar', color: '#aa3300' }] })
const today = new Date()
const at = (h: number) => new Date(today.getFullYear(), today.getMonth(), today.getDate(), h, 0, 0)
const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
caldav.put(`${WORK}dentist.ics`, ics(['UID:dentist', `DTSTART:${stamp(at(15))}`, `DTEND:${stamp(at(16))}`, 'SUMMARY:Dentist from mail']))
const leeCaldav = await startFakeCalDav({ username: LEE, password: 'lee-pass', calendars: [{ path: WORK, name: 'Lee calendar' }] })
// "localhost" sends Walnut to 127.0.0.1: another host, so the password must not follow on its own.
const redirector = http.createServer((_req, res) => {
  res.writeHead(301, { Location: `${leeCaldav.origin}/.well-known/caldav` })
  res.end()
})
await new Promise<void>((resolve) => redirector.listen(0, '127.0.0.1', () => resolve()))
const redirectPort = (redirector.address() as AddressInfo).port
// The same port on ::1 too, whichever address "localhost" resolves to first.
const redirector6 = http.createServer(redirector.listeners('request')[0] as http.RequestListener)
await new Promise<void>((resolve) => {
  redirector6.once('error', () => resolve())
  redirector6.listen(redirectPort, '::1', () => resolve())
})

await fs.rm(tmpBase, { recursive: true, force: true })
await fs.mkdir(path.join(tmpBase, 'tasks'), { recursive: true })
await fs.mkdir(path.join(tmpBase, 'secrets', 'plugins'), { recursive: true, mode: 0o700 })
await fs.writeFile(path.join(tmpBase, 'tasks', 'tasks.json'), JSON.stringify({ version: 1, tasks: [] }, null, 2))
await fs.writeFile(path.join(tmpBase, 'secrets', 'plugins', 'mail-imap.json'), JSON.stringify({
  [`password.${localIdFor(ADDRESS)}`]: 'app-pass',
  [`password.${localIdFor(GMAIL)}`]: 'gmail-pass',
  [`password.${localIdFor(LEE)}`]: 'lee-pass',
}), { mode: 0o600 })

const mockMainAgent = path.join(repoRoot, 'tests/providers/mock-main-agent.mjs')
await fs.writeFile(path.join(tmpBase, 'config.yaml'), JSON.stringify({
  version: 1,
  defaults: { priority: 'none', platform: 'local' },
  provider: { type: 'claude-code' },
  agent: { main_provider: 'mail-cal-cli', main_model: 'mail-cal-mock', triage: { debounce_minutes: 0 } },
  providers: { 'mail-cal-cli': { api: 'claude-cli', claude_cli_command: mockMainAgent } },
  experimental: { mail_calendars: true },
  plugins: {
    'mail-imap': {
      accounts: {
        // The IMAP server is never reached (port 1 refuses at once); only the calendar is.
        [localIdFor(ADDRESS)]: { address: ADDRESS, imap_host: '127.0.0.1', imap_port: 1, imap_tls: 'tls', display_name: 'Pat', caldav_url: `${caldav.origin}/.well-known/caldav` },
        [localIdFor(GMAIL)]: { address: GMAIL, imap_host: 'imap.gmail.com', imap_port: 993, imap_tls: 'tls' },
        [localIdFor(LEE)]: { address: LEE, imap_host: '127.0.0.1', imap_port: 1, imap_tls: 'tls', caldav_url: `http://localhost:${redirectPort}/` },
      },
    },
  },
}, null, 2))

// A Mac with no calendar accounts: the EventKit source is a mock, put in place before boot.
const { CalendarService, _setCalendarServiceForTest } = await import('../../../src/integrations/calendar/service.js')
const { createMockCalendarSource } = await import('../../helpers/mock-calendar-source.js')
_setCalendarServiceForTest(new CalendarService(createMockCalendarSource({ events: [], calendars: [] }).source))

const { startServer, stopServer } = await import('../../../src/web/server.js')
const apiServer = await startServer({ port: 0, dev: true })
const apiAddress = apiServer.address()
if (!apiAddress || typeof apiAddress === 'string') throw new Error('Mail calendar fixture did not bind a TCP port')
const apiTarget = `http://127.0.0.1:${apiAddress.port}`

// The mail list shows accounts the mail base mirrors. The setup form would add them after
// proving the IMAP login, which this fixture cannot; the base's own adoption of what the
// provider already knows does the same mirroring.
const { createServiceHandle } = await import('../../../src/core/plugins/service-registry.js')
const mailBase = createServiceHandle<{ adoptAccounts(providerId: string): Promise<string[]> }>({ key: 'mail:base', publisherId: 'mail' })
const adopted = await mailBase.adoptAccounts('imap')
if (adopted.length !== 3) throw new Error(`mail calendar fixture: expected three adopted IMAP accounts, got ${JSON.stringify(adopted)}`)

const { createServer: createViteServer } = await import('vite')
const { restateOwnOrigin } = await import('../../../web/dev-proxy-origin.js')
const { holdUntilWarm } = await import('./fixture-warm.js')
// Ready only once the SPA is compiled (fixture-warm.ts), so the first test does not pay for it.
const warmGate = holdUntilWarm()
const viteServer = await createViteServer({
  root: path.join(repoRoot, 'web'),
  plugins: [warmGate.plugin],
  cacheDir: path.join(tmpBase, 'vite-cache'),
  server: {
    host: '127.0.0.1',
    port,
    strictPort: true,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: true, configure: (proxy) => restateOwnOrigin(proxy, apiTarget) },
      '/ws': { target: apiTarget.replace(/^http/, 'ws'), ws: true, configure: (proxy) => restateOwnOrigin(proxy, apiTarget.replace(/^http/, 'ws')) },
    },
  },
  logLevel: 'warn',
})
await viteServer.listen()
await warmGate.warm(viteServer)

const fixture = {
  port,
  home: tmpBase,
  account: `imap:${localIdFor(ADDRESS)}`,
  gmailAccount: `imap:${localIdFor(GMAIL)}`,
  leeAccount: `imap:${localIdFor(LEE)}`,
  leeServerHost: new URL(leeCaldav.origin).host,
}
console.log(`MAIL_CALENDAR_READY ${JSON.stringify(fixture)}`)

const shutdown = async () => {
  await viteServer.close().catch(() => {})
  await stopServer()
  await caldav.close().catch(() => {})
  await leeCaldav.close().catch(() => {})
  redirector.close()
  redirector6.close()
  try {
    const { localDaemon } = await import('../../../src/providers/local-daemon.js')
    await localDaemon.stopIfIsolated()
  } catch { /* best effort */ }
  await fs.rm(tmpBase, { recursive: true, force: true }).catch(() => {})
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
