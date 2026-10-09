/**
 * The name a person knows a host by, for every sentence Walnut shows about one.
 *
 * A host's label when it has one, else its alias. The cloud box is the one alias
 * no user ever typed (`__cloudbox__` is an internal key, cloud-box-host.ts), so
 * without a label it is still "Cloud". Gate measurements found that alias in
 * eight user sentences ("Cannot create directory on __cloudbox__", "Remote read
 * failed (__cloudbox__)", "Could not reach __cloudbox__", ...): each one built
 * its own name from `host`.
 *
 * The daemon pool keeps the alias in its OWN errors on purpose: those are log
 * lines and notification cause keys (notifications/error-cause.ts reads the host
 * out of "Connection to <alias> failed 3s ago"), and a renamed host would break
 * the key a recovery is matched by. `inHostTerms` turns such a sentence into the
 * host's own name at the edge where a person reads it.
 *
 * No runtime imports beyond the leaf cloud-box-host.ts, so any layer may use it.
 */

import { CLOUD_BOX_HOST_ALIAS, CLOUD_BOX_HOST_LABEL } from './cloud-box-host.js'

/** `host`'s name in a sentence: its label, else its alias (the cloud box is "Cloud"). */
export function hostDisplayName(host: string, label?: unknown): string {
  if (typeof label === 'string' && label.trim()) return label.trim()
  return host === CLOUD_BOX_HOST_ALIAS ? CLOUD_BOX_HOST_LABEL : host
}

/** The bridge alias of the Mac's own daemon. */
const MAC_DAEMON_ALIAS = '__local__'

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * `text` (an error from a lower layer) with every whole mention of the alias
 * replaced by the host's name. Whole mentions only: an alias that is also part
 * of a word, a hostname or a path is left alone.
 */
export function inHostTerms(text: string, host: string, label?: unknown): string {
  // The Mac's own daemon key is never a name a person reads, whichever host the
  // sentence is about (a relay error can mention the Mac's link).
  if (text.includes(MAC_DAEMON_ALIAS)) text = text.split(MAC_DAEMON_ALIAS).join('your Mac')
  const name = hostDisplayName(host, label)
  if (!host || name === host || !text.includes(host)) return text
  // Not inside a word, a hostname (`box.example.test`) or a path (`/srv/box/x`);
  // a sentence's closing period is not a hostname.
  return text.replace(new RegExp(`(?<![\\w./-])${escapeRe(host)}(?![\\w/-]|\\.\\w)`, 'g'), name)
}

/** hostDisplayName with the label read from the host's row in config. */
export async function hostDisplayNameFor(host: string): Promise<string> {
  try {
    const { getConfig } = await import('../config-manager.js')
    const def = (await getConfig()).hosts?.[host] as { label?: unknown } | undefined
    return hostDisplayName(host, def?.label)
  } catch {
    return hostDisplayName(host)
  }
}
