/**
 * The bar that offers to save a login just sent, or to update a saved one's password. An
 * extension page in an iframe (the page cannot read or press it). The person can correct the
 * username and password before saving, and pick which saved login to update when the site has
 * several; the login itself stays in the background until then.
 */
import { ask as askBackground } from './ext'
import { avatar, h, icon } from './dom'
import { frameGuard } from './frame-guard'
import { currentNonce, onNonce, onUnlockChange } from './nonce'
import { distinctName } from './savebar-name'

/** The nonce the content script hands this frame (nonce.ts): every message carries it. */
const ask = <T = Record<string, unknown>>(msg: { type: string; [k: string]: unknown }) => askBackground<T>({ ...msg, nonce: currentNonce() })
const guard = frameGuard()

interface Choice { id: string; title: string; username?: string }
/** `elsewhere`: the host of the page the bar is on now, when the login was made on another (`site`). */
interface Data { kind: 'save' | 'update' | 'locked'; site: string; username: string; password?: string; title: string; itemId?: string; choices?: Choice[]; elsewhere?: string }
/** The person opened the full bar from its short form (on another page than the login's). */
let expanded = false
const root = document.getElementById('root')!
const NEW = '__new__'

/** The frame's height: the bar and the margin its shadow is drawn in (ui.css body.bar). */
function size(): void {
  const b = getComputedStyle(document.body)
  void ask({ type: 'savebar-size', height: Math.ceil(document.body.getBoundingClientRect().height + parseFloat(b.marginTop) + parseFloat(b.marginBottom)) + 2 })
}

/** The bar becomes one short line (what was done), then closes itself. */
function done(text: string, ms: number, ...extra: HTMLElement[]): void {
  root.replaceChildren(h('div', { class: 'bar-done', role: 'status' },
    h('span', { class: 'logo' }, '✓'), h('span', { class: 'bar-done-text' }, text), ...extra))
  size()
  setTimeout(() => void ask({ type: 'savebar-action', action: 'close' }), ms)
}

async function act(action: string, extra: Record<string, unknown> = {}, label = ''): Promise<void> {
  const r = await ask<{ never?: string }>({ type: 'savebar-action', action, ...extra })
  if (!r.ok) {
    root.querySelector('.err')?.remove()
    root.querySelector('.bar-in')?.append(h('p', { class: 'err', role: 'alert' }, r.error ?? 'That did not work.'))
    size()
    return
  }
  if (action === 'save') done(label ? `Saved to Walnut: ${label}` : 'Saved to Walnut', 2200)
  else if (action === 'update') done(label ? `Password updated in Walnut: ${label}` : 'Password updated in Walnut', 2200)
  else if (action === 'never' && typeof r.never === 'string' && r.never) {
    // Said, with a way back: the entry also stays in Settings, where it can be removed later.
    const entry = r.never
    const undo = h('button', { class: 'btn btn-quiet bar-undo', type: 'button', 'data-testid': 'savebar-undo' }, 'Undo') as HTMLButtonElement
    undo.onclick = guard.wrap(() => {
      undo.disabled = true
      void ask({ type: 'savebar-action', action: 'undo-never', entry }).then((u) => {
        if (u.ok) done(`Walnut will offer to save logins on ${entry} again.`, 1800)
        else undo.disabled = false
      })
    })
    done(`Walnut won\u2019t offer to save logins on ${entry}. Settings lists it.`, 6000, undo)
  }
}

/** The password as sent, hidden until the person asks to see it. */
function passwordField(value: string): { wrap: HTMLElement; input: HTMLInputElement } {
  const input = h('input', { class: 'input mono', id: 'password', type: 'password', value, 'aria-label': 'Password', autocomplete: 'off', spellcheck: 'false' })
  const eye = h('button', { class: 'icon-btn', type: 'button', title: 'Show password', 'aria-label': 'Show password', 'data-testid': 'savebar-reveal' }, icon('eye'))
  eye.onclick = () => {
    const show = input.type === 'password'
    input.type = show ? 'text' : 'password'
    eye.title = show ? 'Hide password' : 'Show password'
    eye.setAttribute('aria-label', eye.title)
  }
  return { wrap: h('div', { class: 'pw-wrap' }, input, eye), input }
}

async function render(): Promise<void> {
  const d = await ask<Data>({ type: 'savebar-data' })
  if (!d.ok) {
    // A bar reloaded after its login was dropped says so, never vanishes silently; any other refusal
    // (nothing left to save) just closes.
    const r = d as { code?: string; error?: string }
    if (r.code === 'gone' && r.error) {
      root.replaceChildren(h('div', { class: 'bar-in' }, h('p', { class: 'err', role: 'alert' }, r.error)))
      size()
      setTimeout(() => void ask({ type: 'savebar-action', action: 'close' }), 8_000)
      return
    }
    void ask({ type: 'savebar-action', action: 'close' })
    return
  }
  const sub = d.username ? `${d.username} · ${d.site}` : d.site
  const head = (title: string | HTMLElement) => h('div', { class: 'bar-head' }, avatar(d.site),
    h('div', { class: 'row-text' }, typeof title === 'string' ? h('span', { class: 'bar-title' }, title) : title, h('span', { class: 'row-sub' }, sub)))
  const later = h('button', { class: 'btn btn-quiet', type: 'button', onclick: guard.wrap(() => void act('later')) }, 'Not now')
  let body: HTMLElement
  // On another page than the login's (review R3-12): one short line that names where it was made,
  // so it never reads as saving the page on screen; Save takes it as sent, Edit opens the full bar.
  if (d.elsewhere && !expanded) {
    const update = d.kind === 'update'
    const save = h('button', { class: 'btn btn-primary', type: 'button', 'data-testid': update ? 'savebar-update' : 'savebar-save' }, d.kind === 'locked' ? 'Unlock' : update ? 'Update' : 'Save')
    const edit = h('button', { class: 'btn btn-quiet', type: 'button', 'data-testid': 'savebar-expand' }, 'Edit')
    const label = distinctName(d.title, d.username, (d.choices ?? []).map((c) => c.title))
    save.onclick = guard.wrap(() => {
      if (d.kind === 'locked') void act('unlock')
      else if (update) void act('update', { username: d.username, password: d.password ?? '', itemId: d.itemId }, (d.choices ?? []).find((c) => c.id === d.itemId)?.title ?? '')
      else void act('save', { username: d.username, password: d.password ?? '', title: label }, label || d.title)
    })
    edit.onclick = guard.wrap(() => { expanded = true; void render() })
    body = h('div', { class: 'bar-in', 'data-testid': 'savebar-elsewhere' },
      head(update ? `Update the password you changed on ${d.site}?` : `Save the login you made on ${d.site}?`),
      d.kind === 'locked' ? h('p', { class: 'muted', style: 'margin:0' }, 'Unlock passwords first; the login waits here for a few minutes.') : null,
      h('div', { class: 'bar-actions' }, d.kind === 'locked' ? null : edit, h('span', { class: 'spacer' }), later, save))
    root.replaceChildren(body)
    requestAnimationFrame(size)
    return
  }
  if (d.kind === 'locked') {
    body = h('div', { class: 'bar-in' }, head('Save this login to Walnut?'),
      h('p', { class: 'muted', style: 'margin:0' }, 'Unlock passwords first; the login waits here for a few minutes.'),
      h('div', { class: 'bar-actions' }, later, h('button', { class: 'btn btn-primary', type: 'button', onclick: guard.wrap(() => void act('unlock')) }, 'Unlock')))
    root.replaceChildren(body)
    requestAnimationFrame(size)
    return
  }
  const choices = d.choices ?? []
  const user = h('input', { class: 'input', id: 'username', value: d.username, 'aria-label': 'Username', autocomplete: 'off', spellcheck: 'false' })
  const pw = passwordField(d.password ?? '')
  // A name that tells this login apart from the site's others ("Lab Shop (newuser@lab.test)").
  const named = (user: string) => distinctName(d.title, user, choices.map((c) => c.title))
  let suggested = named(d.username)
  const title = h('input', { class: 'input', id: 'title', value: suggested, 'aria-label': 'Name' })
  // Which login this goes to: a saved one of this site (update), or a new one (save).
  const target = h('select', { class: 'select', id: 'target', 'aria-label': 'Save to', 'data-testid': 'savebar-target' },
    ...choices.map((c) => h('option', { value: c.id }, c.username ? `${c.title} · ${c.username}` : c.title)),
    h('option', { value: NEW }, 'A new login'))
  target.value = d.kind === 'update' && d.itemId ? d.itemId : NEW
  const nameWrap = h('div', {}, h('label', { class: 'field-label', for: 'title' }, 'Name'), title)
  const go = h('button', { class: 'btn btn-primary', type: 'button' }) as HTMLButtonElement
  const heading = h('span', { class: 'bar-title' })
  // A password-only page sent no username: the login picked to update shows its own.
  let shownUser = d.username
  const sync = () => {
    const isNew = target.value === NEW
    const picked = choices.find((c) => c.id === target.value)
    if (user.value === shownUser) { shownUser = (isNew ? d.username : picked?.username ?? d.username) || ''; user.value = shownUser }
    heading.textContent = isNew ? 'Save this login to Walnut?' : `Update the password for ${picked?.title ?? 'this login'}?`
    go.textContent = isNew ? 'Save' : 'Update'
    go.dataset.testid = isNew ? 'savebar-save' : 'savebar-update'
    nameWrap.style.display = isNew ? '' : 'none'
    hint.style.display = isNew ? 'none' : ''
    size()
  }
  const hint = h('p', { class: 'muted', style: 'margin:6px 0 0;font-size:12px' }, 'The old password stays in its history.')
  target.onchange = sync
  // A corrected username changes the suggested name too, until the person edits the name themself.
  user.addEventListener('input', () => { if (title.value === suggested) { suggested = named(user.value.trim()); title.value = suggested } })
  go.onclick = guard.wrap(() => {
    const fields = { username: user.value.trim(), password: pw.input.value }
    if (!fields.password) { pw.input.focus(); return }
    if (target.value === NEW) void act('save', { ...fields, title: title.value.trim() }, title.value.trim() || d.title)
    else void act('update', { ...fields, itemId: target.value }, choices.find((c) => c.id === target.value)?.title ?? '')
  })
  body = h('div', { class: 'bar-in' },
    head(heading),
    h('div', { class: 'bar-fields' },
      choices.length ? h('label', { class: 'field-label', for: 'target' }, 'Save to') : null, choices.length ? target : null,
      h('label', { class: 'field-label', for: 'username' }, 'Username'), user,
      h('label', { class: 'field-label', for: 'password' }, 'Password'), pw.wrap,
      nameWrap),
    hint,
    h('div', { class: 'bar-actions' },
      h('button', { class: 'btn btn-quiet', type: 'button', onclick: guard.wrap(() => void act('never')) }, 'Never for this site'),
      h('span', { class: 'spacer' }), later, go))
  root.replaceChildren(body)
  sync()
  requestAnimationFrame(size)
}

// Drawn once the nonce arrives, and again when the vault is unlocked or locked meanwhile.
onNonce(() => void render())
onUnlockChange(() => void render())
