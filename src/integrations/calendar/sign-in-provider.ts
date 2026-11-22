/**
 * Mail accounts whose calendars only a sign-in of their own can read (Google's CalDAV and
 * Microsoft's calendars take OAuth, never a mail app password). One answer for the server, which
 * never tries the password there, and for the page, which offers no "Add its calendar" that
 * cannot work. Browser-safe: no Node imports.
 */
export type SignInProvider = 'Google' | 'Microsoft'

function domainOf(address: string): string {
  return address.split('@').pop()?.trim().toLowerCase() ?? ''
}

function hostMatches(host: string | undefined, patterns: RegExp[]): boolean {
  const h = host?.trim().toLowerCase()
  return !!h && patterns.some((p) => p.test(h))
}

/** The provider whose calendars need its own sign-in, or null. Hosts are the account's mail servers, when known. */
export function signInProvider(account: { address: string; hosts?: { imap?: string; smtp?: string } }): SignInProvider | null {
  const domain = domainOf(account.address)
  const hosts = [account.hosts?.imap, account.hosts?.smtp]
  if (['gmail.com', 'googlemail.com'].includes(domain) || hosts.some((h) => hostMatches(h, [/(^|\.)gmail\.com$/, /(^|\.)googlemail\.com$/]))) return 'Google'
  if (/^(outlook|hotmail|live|msn|passport)\.[a-z.]+$/.test(domain) ||
    hosts.some((h) => hostMatches(h, [/(^|\.)office365\.com$/, /(^|\.)outlook\.com$/, /(^|\.)hotmail\.com$/, /(^|\.)live\.com$/]))) return 'Microsoft'
  return null
}

/** What a row of such an account says. */
export function signInNeededText(provider: SignInProvider): string {
  return provider === 'Google'
    ? 'Gmail calendars need a Google sign-in; a mail password cannot read them.'
    : 'Outlook and Microsoft 365 calendars need a Microsoft sign-in; a mail password cannot read them.'
}

/** Mail domains of personal accounts: one person per address, so a sign-in on the same domain says nothing. */
const PERSONAL_DOMAINS = /^(gmail\.com|outlook\.[a-z.]+|hotmail\.[a-z.]+|live\.[a-z.]+|msn\.com|passport\.com)$/

/** An address as its provider tells accounts apart: Gmail ignores dots and a `+tag`, and googlemail.com is gmail.com. */
export function canonicalAddress(address: string): string {
  const a = address.trim().toLowerCase()
  const at = a.lastIndexOf('@')
  if (at < 1) return a
  let local = a.slice(0, at)
  let domain = a.slice(at + 1)
  if (domain === 'googlemail.com') domain = 'gmail.com'
  if (domain === 'gmail.com') local = local.split('+')[0].replace(/\./g, '')
  return `${local}@${domain}`
}

/**
 * Whether a sign-in as `signedInAs` is the mail account `address` itself: the same address as
 * its provider reads it, or (a Google Workspace or Microsoft 365 account) any name on the same
 * work domain, since a sign-in name is often not the mail address (a UPN like rlee@ for
 * robin.lee@). Anything else is another account, which the person must choose to use.
 */
export function sameAccount(signedInAs: string, address: string): boolean {
  const a = canonicalAddress(signedInAs)
  const b = canonicalAddress(address)
  if (a === b) return true
  const domain = b.slice(b.lastIndexOf('@') + 1)
  return !!domain && a.slice(a.lastIndexOf('@') + 1) === domain && !PERSONAL_DOMAINS.test(domain)
}
