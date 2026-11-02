/**
 * Whether the newest release carries a file a new machine fetches from it: join.ps1
 * (JOIN_PS1_URL), the script a Mac with no companion hands a Windows PC, and
 * Walnut-Setup-x64.exe (WINDOWS_APP_URL), the Windows app. A release from before either has
 * none, and its link would answer 404 until the next one. Each is asked at most once an hour
 * (ten minutes after a no), with a 4 s deadline; WALNUT_JOIN_PS1_PUBLISHED and
 * WALNUT_WINDOWS_APP_PUBLISHED (1 or 0) answer for a test.
 */
import { JOIN_PS1_URL, WINDOWS_APP_URL } from './join-ticket.js'

const known = new Map<string, { at: number; yes: boolean }>()

async function published(url: string, forced: string | undefined): Promise<boolean> {
  if (forced === '1' || forced === '0') return forced === '1'
  const k = known.get(url)
  if (k && Date.now() - k.at < (k.yes ? 60 : 10) * 60_000) return k.yes
  let yes = false
  try {
    yes = (await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(4000) })).ok
  } catch { /* offline, or GitHub slow: not now */ }
  known.set(url, { at: Date.now(), yes })
  return yes
}

export function joinPs1Published(): Promise<boolean> {
  return published(JOIN_PS1_URL, process.env.WALNUT_JOIN_PS1_PUBLISHED)
}

export function windowsAppPublished(): Promise<boolean> {
  return published(WINDOWS_APP_URL, process.env.WALNUT_WINDOWS_APP_PUBLISHED)
}
