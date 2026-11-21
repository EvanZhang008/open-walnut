/**
 * Walnut's passkey window (passkey.html, opened by bg-passkey.ts for one page's request): it says
 * which site and account, lets the person pick a passkey when there are several, unlock when Walnut
 * is locked, and say yes. The yes is Touch ID through this extension's confirm key (the browser's
 * own WebAuthn, for the extension itself: its key never leaves the browser's authenticator), or the
 * master password. "Use the browser instead" hands the request back to the browser's own dialog; Cancel or
 * closing the window tells the site no.
 */
import { ask as askBackground } from './ext'
import { unlockRefusal } from './unlock-send'
import { carryTyped } from './popup-view'
import { avatar, h, icon } from './dom'
import { fromB64u, toB64u } from './passkey-wire'

interface Match { itemId: string; title: string; credentialId: string; userName?: string; userDisplayName?: string; createdAt?: string }
interface Data {
  ok: boolean; error?: string; code?: string
  op: 'create' | 'get'; origin: string; site: string; rpName?: string; userName?: string; userDisplayName?: string
  matches: Match[]; locked: boolean; confirmKey: string | null
}

const k = new URLSearchParams(location.search).get('k') ?? ''
const ask = <T = Record<string, unknown>>(msg: { type: string; [x: string]: unknown }) => askBackground<T>({ ...msg, k })
const root = document.getElementById('root')!

let data: Data | null = null
let chosen = ''
let usePassword = false
let busy = false
let error = ''
let platformOk = false

// The background keeps this request while the window is open (a message every few seconds keeps it awake).
// Once the site has its answer the request is over by design (Touch ID set-up may still run): no "ended" then.
let answered = false
setInterval(() => { if (!answered) void ask({ type: 'passkey-ping' }).then((r) => { if (!r.ok && !answered) ended() }).catch(() => undefined) }, 15_000)

function ended(text = 'This request has ended. Go back to the site and try again.'): void {
  root.replaceChildren(h('div', { class: 'pk' }, header(), h('p', { class: 'pk-note', role: 'status', 'data-testid': 'passkey-ended' }, text)))
  fitWindow()
}

function header(): HTMLElement {
  return h('div', { class: 'pk-head' }, h('span', { class: 'logo' }, icon('key')), h('span', { class: 'pk-brand' }, 'Walnut'))
}

const dateOf = (iso?: string) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '')
const accountOf = (m: { userName?: string; userDisplayName?: string; title?: string }) => m.userName || m.userDisplayName || m.title || 'Account'

let focusChoice = false

/** The window is as tall as what it shows (no empty band above the footer), within the screen. */
function fitWindow(): void {
  const el = root.firstElementChild as HTMLElement | null
  if (!el) return
  const want = Math.min(Math.max(el.scrollHeight + (window.outerHeight - window.innerHeight), 160), Math.min(640, screen.availHeight))
  if (Math.abs(window.outerHeight - want) > 4) { try { window.resizeTo(window.outerWidth, want) } catch { /* the browser keeps its size */ } }
}

function render(): void {
  if (!data) return
  const d = data
  const create = d.op === 'create'
  const title = create ? `Save a passkey for ${d.site}` : `Sign in to ${d.site}`
  const parts: Array<HTMLElement | null> = [header(), h('h1', { class: 'pk-title', 'data-testid': 'passkey-title' }, title)]
  // The page that asks, when it is not the site itself (a sign-in page of the site's own domain).
  const asker = (() => { try { return new URL(d.origin).host } catch { return '' } })()
  if (asker && asker !== d.site) parts.push(h('p', { class: 'pk-sub', 'data-testid': 'passkey-asker' }, `Asked by ${asker}`))

  if (create) {
    parts.push(h('div', { class: 'pk-account', 'data-testid': 'passkey-account' }, avatar(d.site),
      h('span', { class: 'row-text' }, h('span', { class: 'row-title' }, d.userName || d.userDisplayName || 'New account'),
        h('span', { class: 'row-sub' }, d.userDisplayName && d.userDisplayName !== d.userName ? `${d.userDisplayName} · ${d.site}` : d.site))))
    parts.push(h('p', { class: 'pk-note' }, 'Walnut keeps it in your vault, and you confirm each time it is used.'))
  } else if (!d.locked) {
    if (!chosen || !d.matches.some((m) => m.credentialId === chosen)) chosen = d.matches[0]?.credentialId ?? ''
    if (d.matches.length > 1) {
      parts.push(h('p', { class: 'pk-note' }, 'Choose the account:'))
      parts.push(h('div', { class: 'group pk-list', role: 'radiogroup', 'data-testid': 'passkey-list' }, ...d.matches.map((m) => {
        const row = h('label', { class: `row pk-row${m.credentialId === chosen ? ' on' : ''}`, 'data-testid': 'passkey-choice' },
          h('input', { type: 'radio', name: 'pk', value: m.credentialId, ...(m.credentialId === chosen ? { checked: true } : {}) }),
          avatar(d.site), h('span', { class: 'row-text' }, h('span', { class: 'row-title' }, accountOf(m)), h('span', { class: 'row-sub' }, m.createdAt ? `Passkey saved ${dateOf(m.createdAt)}` : m.title)))
        row.querySelector('input')!.addEventListener('change', () => { chosen = m.credentialId; focusChoice = true; render() })
        return row
      })))
    } else if (d.matches[0]) {
      const m = d.matches[0]
      parts.push(h('div', { class: 'pk-account', 'data-testid': 'passkey-account' }, avatar(d.site),
        h('span', { class: 'row-text' }, h('span', { class: 'row-title' }, accountOf(m)), h('span', { class: 'row-sub' }, m.createdAt ? `Passkey saved ${dateOf(m.createdAt)}` : d.site))))
    }
  }

  if (d.locked) {
    const pw = h('input', { class: 'input', id: 'pk-unlock-pw', type: 'password', placeholder: 'Master password', autocomplete: 'current-password', 'data-testid': 'passkey-unlock-password', 'aria-label': 'Master password' }) as HTMLInputElement
    const go = h('button', { class: 'btn btn-primary pk-main', type: 'button', 'data-testid': 'passkey-unlock' }, 'Unlock') as HTMLButtonElement
    const run = () => void step(async () => {
      const r = await ask<Data>({ type: 'passkey-unlock', password: pw.value })
      if (!r.ok) throw new Error(unlockRefusal(r))
      // Unlocked, the site's checks ended the request (no passkey here: the browser asks instead;
      // a site that may not have one: the page was told).
      if ((r as { gone?: boolean }).gone) { ended('Walnut has nothing to do here. The site has its answer.'); return }
      data = r
    })
    go.onclick = run
    pw.addEventListener('keydown', (e) => { if (e.key === 'Enter') run() })
    parts.push(h('p', { class: 'pk-note' }, 'Your passwords are locked. Unlock them to use your passkeys.'), pw, go)
    setTimeout(() => pw.focus(), 0)
  } else if (d.confirmKey && !usePassword) {
    const go = h('button', { class: 'btn btn-primary pk-main', type: 'button', 'data-testid': 'passkey-verify' }, icon('lock'), h('span', {}, create ? 'Verify it\'s you and save' : 'Verify it\'s you and sign in')) as HTMLButtonElement
    go.onclick = () => void step(() => confirmWithKey(d.confirmKey!))
    const other = h('button', { class: 'btn btn-quiet pk-link', type: 'button', 'data-testid': 'passkey-use-password' }, 'Use the master password instead') as HTMLButtonElement
    other.onclick = () => { usePassword = true; error = ''; render() }
    parts.push(h('p', { class: 'pk-sub' }, 'Your browser asks for Touch ID or your computer password.'), go, other)
  } else {
    const pw = h('input', { class: 'input', id: 'pk-pw', type: 'password', placeholder: 'Master password', autocomplete: 'current-password', 'data-testid': 'passkey-password', 'aria-label': 'Master password' }) as HTMLInputElement
    const remember = platformOk && !d.confirmKey
      ? h('input', { type: 'checkbox', id: 'pk-touch', 'data-testid': 'passkey-enroll', checked: true }) as HTMLInputElement
      : null
    const go = h('button', { class: 'btn btn-primary pk-main', type: 'button', 'data-testid': 'passkey-confirm' }, create ? 'Save passkey' : 'Sign in') as HTMLButtonElement
    const run = () => void step(() => confirmWithPassword(pw.value, !!remember?.checked))
    go.onclick = run
    pw.addEventListener('keydown', (e) => { if (e.key === 'Enter') run() })
    parts.push(h('p', { class: 'pk-note' }, 'Confirm with your Walnut master password.'), pw)
    if (remember) parts.push(h('label', { class: 'pk-check', for: 'pk-touch' }, remember, h('span', {}, 'Next time, confirm with Touch ID (your browser asks you once, right after)')))
    parts.push(go)
    setTimeout(() => pw.focus(), 0)
  }

  if (error) parts.push(h('p', { class: 'err wrap', role: 'alert', 'data-testid': 'passkey-error' }, error))
  const another = h('button', { class: 'btn btn-quiet', type: 'button', 'data-testid': 'passkey-another', title: 'The browser\'s own passkey dialog takes this request' }, 'Use the browser instead') as HTMLButtonElement
  another.onclick = () => void ask({ type: 'passkey-leave' }).then(() => window.close())
  const cancel = h('button', { class: 'btn btn-quiet', type: 'button', 'data-testid': 'passkey-cancel' }, 'Cancel') as HTMLButtonElement
  cancel.onclick = () => void ask({ type: 'passkey-cancel' }).then(() => window.close())
  parts.push(h('div', { class: 'pk-foot' }, another, cancel))
  // A redraw (busy, an error, a ping) keeps what the person typed, as the popup does.
  const view = h('div', { class: `pk${busy ? ' busy' : ''}` }, ...parts.filter(Boolean) as HTMLElement[])
  carryTyped(root, view)
  root.replaceChildren(view)
  for (const b of root.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input')) b.disabled = busy
  if (busy) { const main = root.querySelector<HTMLElement>('.pk-main'); if (main) main.textContent = 'Checking\u2026' }
  // The picked account keeps the keyboard focus across a redraw.
  if (focusChoice) { root.querySelector<HTMLInputElement>('.pk-list input:checked')?.focus(); focusChoice = false }
  fitWindow()
}

async function step(work: () => Promise<void>): Promise<void> {
  if (busy) return
  busy = true; error = ''; render()
  try { await work() } catch (e) {
    error = e instanceof DOMException && e.name === 'NotAllowedError' ? 'Not confirmed. Try again, or use the master password.' : e instanceof Error ? e.message : String(e)
  } finally { busy = false }
  if (root.querySelector('[data-testid=passkey-done], [data-testid=passkey-ended]')) return
  render()
}

/** The server's challenge for this request, then the person's yes, then the site's answer goes back. */
async function begin(): Promise<{ id: string; challenge: string }> {
  const b = await ask<{ id: string; challenge: string }>({ type: 'passkey-begin', ...(data?.op === 'get' ? { credentialId: chosen } : {}) })
  if (!b.ok) { if (b.code === 'gone') ended(); throw new Error(b.error ?? 'Walnut could not start this.') }
  return b
}

async function approved(r: { ok: boolean; error?: string; code?: string }): Promise<void> {
  if (!r.ok) {
    if (r.code === 'gone') { ended(); return }
    // Walnut's own clock for this yes ran out (2 minutes): the request is still open, ask again here.
    if (r.code === 'passkey_approval_gone') throw new Error('That took too long. Try again.')
    throw new Error(r.code === 'wrong_password' ? 'That is not the master password.' : r.error ?? 'Walnut did not confirm it.')
  }
}

function done(note?: string): void {
  const create = data?.op === 'create'
  root.replaceChildren(h('div', { class: 'pk' }, header(), h('p', { class: 'pk-done', role: 'status', 'data-testid': 'passkey-done' },
    h('span', { class: 'logo' }, '✓'), h('span', {}, create ? 'Saved to Walnut. Finish on the site: Walnut cannot see whether it took the passkey.' : 'Passkey sent. Finish on the site.')),
  ...(note ? [h('p', { class: 'pk-note', 'data-testid': 'passkey-done-note' }, note)] : [])))
  fitWindow()
  setTimeout(() => window.close(), note ? 6000 : create ? 2600 : 1200)
}

async function confirmWithKey(keyId: string): Promise<void> {
  const b = await begin()
  const cred = await navigator.credentials.get({ publicKey: {
    challenge: fromB64u(b.challenge), allowCredentials: [{ type: 'public-key', id: fromB64u(keyId) }], userVerification: 'required', timeout: 60_000,
  } }) as PublicKeyCredential | null
  if (!cred) throw new Error('Not confirmed.')
  const res = cred.response as AuthenticatorAssertionResponse
  const r = await ask({ type: 'passkey-approve', id: b.id, assertion: {
    credentialId: toB64u(cred.rawId), clientDataJSON: toB64u(res.clientDataJSON), authenticatorData: toB64u(res.authenticatorData), signature: toB64u(res.signature),
  } })
  await approved(r)
  if (r.ok) { answered = true; done() }
}

async function confirmWithPassword(password: string, enroll: boolean): Promise<void> {
  if (!password) throw new Error('Type your Walnut master password.')
  const b = await begin()
  const r = await ask({ type: 'passkey-approve', id: b.id, password })
  await approved(r)
  if (!r.ok) return
  answered = true
  // The site has its answer; Touch ID for next time is set up after, so a failure here costs nothing.
  // A failure here costs nothing but the set-up, and the person is told.
  const missed = enroll ? await enrollTouchId(password).then((ok) => !ok, () => true) : false
  done(missed ? 'Touch ID was not set up this time. You can turn it on at your next passkey.' : undefined)
}

/** True once Touch ID confirms Walnut's passkeys from now on. */
async function enrollTouchId(password: string): Promise<boolean> {
  const e = await ask<{ id: string; challenge: string; userId: string }>({ type: 'passkey-enroll-begin' })
  if (!e.ok) return false
  const cred = await navigator.credentials.create({ publicKey: {
    challenge: fromB64u(e.challenge), rp: { name: 'Walnut' }, user: { id: fromB64u(e.userId), name: 'Walnut passkey confirmations', displayName: 'Walnut' },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
    authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' },
    attestation: 'none', timeout: 60_000,
  } }) as PublicKeyCredential | null
  if (!cred) return false
  const res = cred.response as AuthenticatorAttestationResponse
  const spki = res.getPublicKey()
  if (!spki) return false
  const r = await ask({ type: 'passkey-enroll', enrollId: e.id, password, name: navigator.userAgent.includes('Firefox') ? 'Firefox' : 'Chrome', credential: {
    credentialId: toB64u(cred.rawId), publicKey: toB64u(spki), clientDataJSON: toB64u(res.clientDataJSON), authenticatorData: toB64u(res.getAuthenticatorData()),
  } })
  return !!r.ok
}

/** Whether this computer can confirm with Touch ID (or its own password) through the browser: offers "Next time, confirm with Touch ID". */
async function checkPlatform(): Promise<void> {
  const ok = await (typeof PublicKeyCredential !== 'undefined' && PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable
    ? PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable().catch(() => false) : Promise.resolve(false))
  if (ok === platformOk) return
  platformOk = ok
  // Drawn again only while nothing is typed: a redraw makes the field anew.
  const pw = root.querySelector<HTMLInputElement>('[data-testid=passkey-password]')
  if (data && !busy && pw && !pw.value) render()
}

async function start(): Promise<void> {
  const r = await ask<Data>({ type: 'passkey-data' })
  if (!r.ok) { ended(); return }
  data = r
  render()
  await checkPlatform()
  window.addEventListener('focus', () => void checkPlatform())
}

void start()
