/**
 * Whether the newest release carries join.ps1 (JOIN_PS1_URL), the script a Mac with no
 * companion hands a Windows PC: a release from before the Windows join has none, and its line
 * would answer 404 until the next one. Asked at most once an hour (ten minutes after a no),
 * with a 4 s deadline; WALNUT_JOIN_PS1_PUBLISHED=1 or 0 answers for a test.
 */
import { JOIN_PS1_URL } from './join-ticket.js'

let known: { at: number; yes: boolean } | null = null

export async function joinPs1Published(): Promise<boolean> {
  const forced = process.env.WALNUT_JOIN_PS1_PUBLISHED
  if (forced === '1' || forced === '0') return forced === '1'
  if (known && Date.now() - known.at < (known.yes ? 60 : 10) * 60_000) return known.yes
  let yes = false
  try {
    yes = (await fetch(JOIN_PS1_URL, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(4000) })).ok
  } catch { /* offline, or GitHub slow: not now */ }
  known = { at: Date.now(), yes }
  return yes
}
