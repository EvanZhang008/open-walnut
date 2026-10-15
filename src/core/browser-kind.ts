/**
 * A human name for a browser from its User-Agent, e.g. "iPhone Safari",
 * "iPhone Home Screen" or "Mac Chrome". Stored as the signed-in browser's
 * deviceName at sign-in (routes/browser-pair.ts) so Settings can tell two
 * browsers apart; the credential's own name stays browser-<6 hex>. Display
 * only, never trusted.
 *
 * `standalone` is the page's own word that it runs as a Home Screen app
 * (display-mode: standalone, sent with the code). A phone or tablet then reads
 * "<device> Home Screen", so a Safari tab and the Home Screen app on the same
 * iPhone are two different rows, not "iPhone Safari" and "iPhone Safari 2".
 * Not guessed from the UA: an in-app browser's UA looks like a Home Screen app's.
 */
export function browserKindFromUserAgent(ua: string | undefined, opts: { standalone?: boolean } = {}): string {
  const s = ua ?? ''
  const device = /iPhone|iPod/.test(s) ? 'iPhone'
    : /iPad/.test(s) ? 'iPad'
    : /Android/.test(s) ? (/Mobile/.test(s) ? 'Android phone' : 'Android tablet')
    : /Macintosh|Mac OS X/.test(s) ? 'Mac'
    : /Windows/.test(s) ? 'Windows'
    : /CrOS/.test(s) ? 'Chromebook'
    : /Linux/.test(s) ? 'Linux'
    : ''
  // Order matters: every Chromium UA also says Safari, Edge also says Chrome,
  // and iOS browsers name themselves with Crios/FxiOS/EdgiOS.
  const app = /Edg(e|A|iOS)?\//.test(s) ? 'Edge'
    : /OPR\/|Opera/.test(s) ? 'Opera'
    : /Firefox\/|FxiOS\//.test(s) ? 'Firefox'
    : /Chrome\/|CriOS\/|Chromium\//.test(s) ? 'Chrome'
    : /Safari\//.test(s) || /AppleWebKit\//.test(s) ? 'Safari'
    : ''
  const mobile = device === 'iPhone' || device === 'iPad' || device.startsWith('Android')
  if (mobile && opts.standalone === true) return `${device} Home Screen`
  const name = [device, app].filter(Boolean).join(' ')
  return name || 'Browser'
}
