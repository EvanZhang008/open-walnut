/**
 * Every 503 a route answers is classified: either the machine its answer lives on is not reachable
 * now (a code in HOST_AWAY_CODES, which real use counts as unreachable, never as the route's own
 * server error), or the route's own state (listed below with why). A new 503 fails here until it is
 * one or the other (2026-11-26: GET /api/usage/sessions/:sid answered five 503s an hour while
 * clouddev was unreachable, code budget_unavailable, and rang as the route's server errors).
 * A 503 from a caught error's own status is guarded in tests/web/link-failure-answer.test.ts.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { HOST_AWAY_CODES } from '../../src/web/middleware/host-unreachable-answer.js'

const ROOT = path.resolve(__dirname, '../..')

/** A 503 code that is the route's own state, not a machine away. */
const OWN_503_CODES: Record<string, string> = {
  page_unavailable: 'a page of a projection this server has not built yet',
  transcript_unavailable: 'a transcript this server keeps no copy of yet',
  unavailable: 'a projection not synced yet (and a replica relay that answers it alike)',
  same_site_unchecked: 'a browser check that has not run',
  send_state_unavailable: "the send ledger's own state could not be read",
  check_failed: "the host check's own failure",
  ai_failed: "a plugin's model call failed",
  pairings_busy: 'the pairing store is busy',
  primary_needs_upgrade: 'the Mac answers but runs an older Walnut',
  source_unavailable: "a router source's own state",
  stop_pending: 'a stop still waits for its acknowledgement',
  stt_unavailable: 'no speech-to-text engine is set up',
  tts_unavailable: 'no text-to-speech engine is set up',
  busy: 'a store is busy',
  browser_key_unavailable: "the browser's key is not unlocked",
  storage_unavailable: 'the voice archive storage is not set up',
}

/** A 503 with no code of its own, by file and words, with why it is not a machine away. */
const OWN_503_UNCODED: Record<string, string> = {
  "bridge-send.ts|'host_unknown'": 'the send could not be judged before it went; unverified whether the host was away, kept as it was',
  "bridge-send.ts|'delivery_unconfirmed'": 'the send may have gone: never "not reachable"',
  'browser-v1.ts|isFollower()': 'a replica has no browser of its own',
  'human-inbox-items-v1.ts|status_unconfirmed': "a ternary: primary_unavailable (not sent, in HOST_AWAY_CODES) or status_unconfirmed (it may have gone)",
  'drafts.ts|drafts store is busy': 'the drafts store is busy',
  'files.ts|daemon needs upgrade': 'the host answers but runs an older daemon',
  'git-bundle-push.ts|disk critically full': "the data hub's disk is full",
  'git-http.ts|disk critically full': "the data hub's disk is full",
  'git-http.ts|post-receive hook': "the data hub's hook could not be written",
  'health-monitor-v1.ts|not_running': 'the health monitor does not run on this server',
  'org-avatars-v1.ts|no_renderer': 'this server cannot draw PNGs',
  'org-v1.ts|status check timed out': "the org status check's own deadline",
  'plugin-jobs-routes.ts|plugin jobs are': 'plugin jobs are not run on this server',
  'sessions.ts|fork ancestor history unavailable': "a fork ancestor's history could not be joined",
  'system.ts|The local daemon': "this machine's own daemon is older or missing",
  'system.ts|Could not request the app restart': 'the app restart request failed here',
}

const CODE_IN = [/\b503\s*,\s*'([a-z_]+)'/, /\bcode:\s*'([a-z_]+)'/, /\b503\s*,\s*([A-Z][A-Z_]+)\b/, /\bcode:\s*([A-Z][A-Z_]+)\b/]
const CONSTANTS: Record<string, string> = { HOST_RECONNECTING: 'host_reconnecting' }
const SITE = /status\(503\)|\b503\s*,\s*['"A-Z]|sendV1Error\([^,]+,\s*503|sendError\([^,]+,\s*503/

function codeOnly(text: string): string[] {
  return text.split('\n').map((line) => (/^\s*(\/\/|\*|\/\*)/.test(line) ? '' : line))
}

const sites: Array<{ key: string; file: string; line: string; window: string; code?: string }> = []
for (const name of fs.readdirSync(path.join(ROOT, 'src/web/routes')).filter((n) => n.endsWith('.ts'))) {
  const lines = codeOnly(fs.readFileSync(path.join(ROOT, 'src/web/routes', name), 'utf8'))
  lines.forEach((line, i) => {
    if (!SITE.test(line)) return
    const window = lines.slice(i, i + 4).join('\n')
    let code: string | undefined
    for (const re of CODE_IN) { const m = re.exec(window); if (m) { code = CONSTANTS[m[1]!] ?? m[1]; break } }
    sites.push({ key: `${name}:${i + 1}`, file: name, line: line.trim(), window, ...(code ? { code } : {}) })
  })
}

describe('every 503 a route answers says whether its machine is away', () => {
  it('finds the sites', () => {
    expect(sites.length).toBeGreaterThanOrEqual(80)
  })

  it.each(sites.map((s) => [s.key, s]))('%s', (_key, site) => {
    if (site.code) {
      expect(HOST_AWAY_CODES.has(site.code) || site.code in OWN_503_CODES,
        `${site.line}: 503 code "${site.code}" is neither in HOST_AWAY_CODES (a machine away: real use counts it unreachable) nor in OWN_503_CODES with why it is the route's own`).toBe(true)
      return
    }
    const own = Object.keys(OWN_503_UNCODED).some((k) => { const [file, words] = k.split('|'); return file === site.file && site.window.includes(words!) })
    expect(own, `${site.line}: a 503 with no code. A machine away answers code: HOST_RECONNECTING; the route's own state goes in OWN_503_UNCODED with why`).toBe(true)
  })

  it('every listed exception still names a real site', () => {
    for (const key of Object.keys(OWN_503_UNCODED)) {
      const [file, words] = key.split('|')
      expect(sites.some((s) => !s.code && s.file === file && s.window.includes(words!)), key).toBe(true)
    }
    for (const code of Object.keys(OWN_503_CODES)) {
      expect(sites.some((s) => s.code === code), code).toBe(true)
    }
  })

  it('a code is never both a machine away and the route\'s own', () => {
    expect(Object.keys(OWN_503_CODES).filter((c) => HOST_AWAY_CODES.has(c))).toEqual([])
  })
})
