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
