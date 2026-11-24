/**
 * A credential or sign-in failure whose cause is the network (2026-11-19: the Mac lost its network
 * for about 90 minutes; ten sessions ended on "API Error: 502 could not fetch credentials for
 * <profile>: CredentialRetrievalError ... dns error: failed to lookup address information: nodename
 * nor servname provided, or not known" and "... lookup <host>: no such host", and Walnut read them
 * as credentials only the user can fix, Needs you with "Retry it or open it"). Nothing about the
 * credentials was wrong: the credential service could not be reached, and the same turn goes
 * through once the network is back. So such a text is a transient failure (the daemon's turn retry,
 * then session-auto-continue, then the task's lead), never the user's kind.
 *
 * The same goes for a credential fetch that hung (a timeout) or that a gateway answered with a 502,
 * 503 or 504 (2026-11-20: the same 07:59 text reported again; a hung credential process answers
 * "credential process timed out after 30s" under the same 502).
 *
 * A rejection the service gave (a 401 or 403, an expired, revoked or invalid credential, a sign-in
 * asked for) keeps the text the user's, whatever network words ride beside it: a gateway's 503
 * "no account has working credentials ... if the login expired, sign in again" stays his.
 *
 * One self-contained function: it has no outside reference, and
 * user-status.ts (browser-safe) reads it through sessions/session-error-owner.ts.
 * tests/core/sessions/network-caused-auth.test.ts holds the corpus.
 */
export function networkCausedAuthError(text: string | null | undefined): boolean {
  if (!text) return false
  // The network failed under the request: the name did not resolve, nothing answered, the
  // connection was refused, reset or timed out.
  const network = [
    /dns error|failed to lookup address|nodename nor servname|no such host|name or service not known|temporary failure in name resolution|could not resolve host/i,
    /\bENOTFOUND\b|\bEAI_AGAIN\b|getaddrinfo/i,
    /\bECONNREFUSED\b|\bECONNRESET\b|\bETIMEDOUT\b|\bEHOSTUNREACH\b|\bENETUNREACH\b|\bEHOSTDOWN\b|\bENETDOWN\b/,
    /connection (?:refused|reset|timed out)|error trying to connect|unable to connect|network is unreachable|no route to host|operation timed out|i\/o timeout/i,
    // The client's words for a connection that failed or dropped (the endpoint wait's own classes).
    /fetch failed|socket hang up|\bconnection error\b|connection dropped|connection (?:was )?closed unexpectedly|\bEPIPE\b/i,
    // The credential source hung ("credential process timed out after 30s").
    /\btimed out\b|\btime-?out\b/i,
    // A gateway answered for a source it could not reach (the 502 "could not fetch credentials"
    // above, a 503 or 504 the same way): a status, never a port or an account number.
    /\b(?:API Error|status(?: code)?|HTTP(?:\/\d(?:\.\d)?)?)[: ]+50[234]\b|bad gateway|service unavailable|gateway time-?out|server-side issue|temporarily unavailable/i,
  ]
  // The service answered and said no, or the spend is refused: that stays the user's.
  const rejected = /\b401\b|\b403\b|unauthori[sz]ed|forbidden|expired|revoked|denied|invalid (?:api[_ ]?)?key|invalid (?:access )?token|invalid credentials|reauthenticate|re-authenticate|not logged in|(?:log|sign) ?in again|budget|quota|bil{2}ing|payment|credit balance|spend(?:ing)? limit|usage limit|\b402\b/i
  return !rejected.test(text) && network.some((re) => re.test(text))
}
