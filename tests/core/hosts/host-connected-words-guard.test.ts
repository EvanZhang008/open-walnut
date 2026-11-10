/**
 * Every surface that tells the user a remote host is "Connected" also says when its link keeps
 * dropping (2026-11-08: a laptop on the host network dropped every 30 s for hours, and Hosts,
 * the notification pane and host_list read "Connected" between drops). The rule is one:
 * hostFlapOf / hostConnectedWords in src/core/hosts/host-problem.ts, carried to agents and the
 * fleet cards as `connection.unstable` (fleet-model.ts).
 *
 * The class, enumerated from the source: a file under web/src, src/core/hosts or src/web/routes
 * that writes the word "Connected" as text. Each one either reads the rule (hostConnectedWords,
 * hostFlapOf or `unstable`) or is listed below as not a host link, with why. A new file that
 * says "Connected" fails here until it is one or the other.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../../..')
const DIRS = ['web/src', 'src/core/hosts', 'src/web/routes']
const SAYS_CONNECTED = /(['"`>(]|: )(Connected|Online)\b/
const READS_RULE = /hostConnectedWords|hostFlapOf|\bunstable\b/

/** Says "Connected" about something that is not a remote host's daemon link. */
const NOT_A_HOST_LINK: Record<string, string> = {
  'web/src/hooks/terminal-status-label.ts': 'a terminal socket',
  'web/src/components/settings/sections/JevSettings.tsx': 'a test connection to a service',
  'web/src/components/settings/sections/CloudSection.tsx': "the cloud companion's pairing",
  'web/src/components/settings/sections/backup/backup-model.ts': 'a backup storage test',
  'web/src/components/settings/sections/backup/DriveConnect.tsx': "the Google account a backup goes to",
  'web/src/components/settings/sections/BrowserExtensionGroup.tsx': 'the browser extension',
  'web/src/components/settings/sections/ProvidersSection.tsx': 'a model provider test',
  'web/src/components/settings/sections/cloud/RemoteAccessCard.tsx': "the phone's remote access",
  'web/src/components/settings/sections/cloud/ways-model.ts': "the phone's ways in",
  'web/src/components/settings/sections/cloud/device-rows-copy.ts': 'paired devices (a comment)',
  'web/src/components/settings/sections/cloud/browser-access-status.ts': 'browser access through a relay',
  'web/src/components/settings/inputs/SectionCard.tsx': 'a generic card banner (a comment)',
  'web/src/pages/ConnectExtensionPage.tsx': 'the browser extension',
  'src/web/routes/devices.ts': 'paired devices (a comment)',
  'web/src/components/settings/sections/HostFleetVitals.tsx': 'the uptime lane of the last 12 hours, not the link now',
  'web/src/components/settings/sections/HostFleetCard.tsx': 'the dashboard card\'s uptime lane of the last 12 hours, not the link now',
  'web/src/components/settings/sections/useSshHostEditor.ts': 'a comment naming the row receipt',
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out) }
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p)
  }
  return out
}

describe('a host that keeps dropping never reads plain "Connected"', () => {
  const files = DIRS.flatMap((d) => walk(path.join(ROOT, d)))
  const saying = files.filter((f) => SAYS_CONNECTED.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(ROOT, f))

  it('finds the surfaces (the scan works)', () => {
    expect(saying).toContain('src/core/hosts/host-problem.ts')
    expect(saying).toContain('web/src/components/settings/sections/useLinkedHostRow.tsx')
  })

  it('every file that says "Connected" reads the flapping rule, or is listed as no host link', () => {
    const unread = saying.filter((f) => !NOT_A_HOST_LINK[f] && !READS_RULE.test(fs.readFileSync(path.join(ROOT, f), 'utf8')))
    expect(unread, 'say "Connected" through hostConnectedWords (host-problem.ts), or list the file in NOT_A_HOST_LINK with why').toEqual([])
  })

  it('inside a host file, every line that says "Connected" reads the rule too, or is listed here with why', () => {
    // Lines that say it after the rule already decided the link is steady.
    const LINE_OK: Record<string, string[]> = {
      'src/core/hosts/host-problem.ts': [
        "return flap ? `Unstable: ${flapWords(flap)}` : 'Connected'", // hostConnectedWords itself
        "return { kind: 'connected', title: `${l}: Connected` }", // hostDotOf, after its flap check
      ],
      'web/src/components/settings/sections/host-row-model.ts': ["export function liveLine(card: FleetHost | undefined, online = 'Online')"], // reads connection.unstable on its next lines
      // The uptime share of the week, not the link now.
      'web/src/components/settings/sections/host-fleet-model.ts': ["rows.push({ key: 'online', label: 'Online'"],
      // The receipt of a Connect now the person just pressed, for the moment after it connected.
      'web/src/components/settings/sections/useLinkedHostRow.tsx': ['testId="host-fleet-action-note">Connected.</Line>'],
    }
    const bare: string[] = []
    for (const f of saying.filter((x) => !NOT_A_HOST_LINK[x])) {
      fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n').forEach((line, i) => {
        const code = line.trim()
        if (!SAYS_CONNECTED.test(code) || /^(\/\/|\*|\/\*|\{\/\*)/.test(code) || READS_RULE.test(code)) return
        if ((LINE_OK[f] ?? []).some((ok) => code.includes(ok))) return
        bare.push(`${f}:${i + 1}: ${code}`)
      })
    }
    expect(bare, 'say it through hostConnectedWords, or check hostFlapOf on that line').toEqual([])
  })

  it('the list holds no file that no longer says it', () => {
    expect(Object.keys(NOT_A_HOST_LINK).filter((f) => !saying.includes(f))).toEqual([])
  })

  it('the shared words for a connected host come from the rule', () => {
    for (const f of ['web/src/utils/host-connect.ts', 'web/src/components/common/NotificationHostRow.tsx']) {
      expect(fs.readFileSync(path.join(ROOT, f), 'utf8')).toMatch(/hostConnectedWords\(status, serverNow\(\)\)/)
    }
  })
})
