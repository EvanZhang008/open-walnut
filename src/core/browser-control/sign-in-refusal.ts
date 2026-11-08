/**
 * A sign-in page that refuses the agent's browser, known by its address or words, so the agent
 * hands the sign-in to the person instead of trying again (2026-11-08, the user, after another
 * agent's browser met Google's "This browser or app may not be secure": "let our browser task
 * learn from this"). Retrying such a page only repeats the refusal and can lock the account; the
 * person signing in themselves (request_sign_in, Take over) works, because it is their own input.
 *
 * Judged on an act's answer (its address, title, and the page's text where the act read it).
 */

export interface SignInRefusal {
  why: 'google_refused_browser'
  /** Which page said it. */
  site: string
  note: string
  next: 'request_sign_in'
}

/** Google's refusal pages: the address forms it uses (v3 and the older v2), and the words on them. */
const GOOGLE_HOST = /^accounts\.google\.(?:com|[a-z]{2}|co\.[a-z]{2}|com\.[a-z]{2})$/i
const GOOGLE_PATH = /\/(?:v3\/)?signin\/(?:v2\/)?(?:rejected|deniedsigninrejected)\b|\/signin\/v2\/sl\/rejected/i
const GOOGLE_WORDS = /this browser or app may not be secure|couldn['’]t sign you in[\s\S]{0,200}may not be secure/i

function hostOf(url: unknown): string {
  try { return typeof url === 'string' ? new URL(url).hostname : '' } catch { return '' }
}

export function signInRefusalOf(r: Record<string, unknown> | undefined): SignInRefusal | null {
  if (!r) return null
  const url = typeof r.url === 'string' ? r.url : ''
  const host = hostOf(url)
  if (!GOOGLE_HOST.test(host)) return null
  let path = ''
  try { path = new URL(url).pathname } catch { /* no address */ }
  const words = [r.title, r.text, r.snapshot].filter((x): x is string => typeof x === 'string').join('\n').slice(0, 200_000)
  if (!GOOGLE_PATH.test(path) && !GOOGLE_WORDS.test(words)) return null
  return {
    why: 'google_refused_browser',
    site: host,
    note: 'Google refuses to sign in from this browser while an agent drives it ("This browser or app may not be secure"). '
      + 'Do not try again: call request_sign_in on this tab so the person signs in themselves (Take over in the task\'s Browser view), then go on once it answers done.',
    next: 'request_sign_in',
  }
}
