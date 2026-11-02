/**
 * The parts of the Windows app that are plain logic, with no Electron in them, so the tests run
 * them on any machine (tests/desktop-windows/model.test.ts).
 */

/** What joins this PC: an invite link a companion makes, or a ticket a Mac makes without one. */
export type Invite = { link: string } | { ticket: string }

const LINK = /https:\/\/[A-Za-z0-9.-]+(?::[0-9]+)?\/join\/[A-Za-z0-9-]+/
const TICKET = /wn1-[A-Za-z0-9_-]+/

/**
 * Reads what the person pasted: the link alone, or either line Settings > Remote Hosts > Add a
 * machine shows (`irm <link>/windows | iex`, or the one that sets WALNUT_JOIN_TICKET), so a copy
 * of the wrong row still works. Anything else is null: nothing reaches PowerShell unchecked.
 */
export function parseInvite(text: string): Invite | null {
  const s = String(text ?? '').trim()
  if (!s || s.length > 4096) return null
  const link = s.match(LINK)
  if (link) return { link: link[0] }
  const ticket = s.match(TICKET)
  if (ticket) return { ticket: ticket[0] }
  return null
}

/** The Walnut a link came from (its companion), shown on the This PC page. */
export function originOf(invite: Invite): string | undefined {
  return 'link' in invite ? new URL(invite.link).origin : undefined
}

/** The four things setup does, in the order the script does them. */
export type Stage = 'wsl' | 'linux' | 'start' | 'walnut'
export const STAGES: Stage[] = ['wsl', 'linux', 'start', 'walnut']

/**
 * Which stage a line of the setup script belongs to. The script prints `  <label> ..... <text>`
 * (net-join-ps1.ts `Step`), and the Linux join prints `  1/3  Walnut ....` and on.
 */
export function stageOf(line: string): Stage | null {
  const s = line.replace(/\s+$/, '')
  if (/^ {2}WSL \.+ /.test(s)) return 'wsl'
  if (/^ {2}Linux \.+ /.test(s)) return 'linux'
  if (/^ {2}(Start with Windows|Start menu) /.test(s)) return 'start'
  if (/^ {2}Walnut \.+ /.test(s) || /^ {2}[0-9]\/[0-9] {2}\S/.test(s)) return 'walnut'
  return null
}

/** How the setup ended, read from the script's exit code (net-join-ps1.ts: 3 = WSL needs a restart). */
export type SetupEnd = 'done' | 'restart' | 'failed'
export function endOf(code: number | null): SetupEnd {
  if (code === 0) return 'done'
  if (code === 3) return 'restart'
  return 'failed'
}

/** What this PC is, as the app remembers it (%LOCALAPPDATA%\OpenWalnut\app.json). */
export interface AppState {
  mode: 'own' | 'join'
  /** The companion a join link came from, for "Open your Walnut". */
  origin?: string
  at: string
}

export function readState(text: string | null): AppState | null {
  if (!text) return null
  try {
    const v = JSON.parse(text) as Partial<AppState>
    if (v.mode !== 'own' && v.mode !== 'join') return null
    const origin = typeof v.origin === 'string' && /^https:\/\/[A-Za-z0-9.-]+(:[0-9]+)?$/.test(v.origin) ? v.origin : undefined
    return { mode: v.mode, ...(origin ? { origin } : {}), at: typeof v.at === 'string' ? v.at : '' }
  } catch {
    return null
  }
}

/**
 * What a PC with no app.json is, from definite signs in its OpenWalnut Linux only: the console
 * service running (the app set it up and its app.json was lost), or Walnut's network on (a PC
 * that joined, by the app or by the PowerShell line before it). A setup that stopped halfway
 * (Walnut installed, a join refused, a console that never started) is neither: setup again.
 */
export function inferMode(linux: { exists: boolean; consoleActive: boolean; joined: boolean }): 'own' | 'join' | null {
  if (!linux.exists) return null
  if (linux.consoleActive) return 'own'
  if (linux.joined) return 'join'
  return null
}

/** Whether `url` is on `origin` exactly (a prefix check would let `http://localhost:3456@evil.example` in). */
export function originIs(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === origin
  } catch {
    return false
  }
}

/** What the console may ask the window for: the microphone (voice input), notifications, the clipboard. */
export const CONSOLE_PERMISSIONS: ReadonlySet<string> = new Set(['media', 'notifications', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen'])

/** `walnut net status` (its JSON) as the This PC page says it. */
export function netSummary(text: string): { joined: boolean; lines: string[] } {
  const at = text.indexOf('{')
  let s: Record<string, unknown> | null = null
  try { s = at >= 0 ? JSON.parse(text.slice(at)) as Record<string, unknown> : null } catch { s = null }
  if (!s || typeof s !== 'object') return { joined: false, lines: [text.trim() || "This PC's Walnut did not answer."] }
  const joined = s.enabled === true
  const lines = [
    joined ? 'Joined to your Walnut: yes' : 'Joined to a Walnut: no',
    `Walnut's network on this PC: ${s.running === true ? 'running' : 'not running'}`,
  ]
  if (typeof s.endpointId === 'string' && s.endpointId) lines.push(`This PC's id: ${s.endpointId.slice(0, 16)}`)
  if (typeof s.lastError === 'string' && s.lastError) lines.push(`Last problem: ${s.lastError}`)
  return { joined, lines }
}

/** A PowerShell single-quoted string. */
export function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}

/** Links that leave the window: only web pages go to the default browser, never a file or a script. */
export function externalUrl(url: string): string | null {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' || u.protocol === 'http:' || u.protocol === 'mailto:' ? u.toString() : null
  } catch {
    return null
  }
}
