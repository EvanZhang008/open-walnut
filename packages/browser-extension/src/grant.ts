/**
 * grant.html: the fallback page where the person lets Walnut use Chrome's debugger, for a copy of
 * the extension that lacks the permission (the manifest lists it as required, so a copy Walnut set
 * up holds it after its next reload: trusted-switch.ts). grant-open.ts opens it from "Show it live"
 * in a task's Browser view. Chrome asks for a permission only inside a click on an extension page,
 * so the request is the first thing the Allow button does, with nothing awaited before it. Allow
 * stores live pictures on (trusted-switch.ts grantLivePictures), says it is done and closes the page.
 */
import { ext } from './ext'
import { h } from './dom'
import { followTheme } from './panel-theme'
import { grantLivePictures, migrateRealInput } from './trusted-switch'

export const GRANT_WORDS = {
  title: "Show Walnut's agent window live",
  body: "When other windows cover Walnut's agent window, Chrome stops drawing it, so a task's Browser view in Walnut gets no new picture. "
    + "Allow lets Walnut take those pictures through Chrome's debugger. It never brings the window forward and never clicks or types for this.",
  bar: "While Walnut uses it, Chrome shows its \"started debugging this browser\" bar. You can turn live pictures off in the extension's Settings.",
  done: 'Done. The Browser view in Walnut shows the agent\'s tab live now. This page closes itself.',
  no: 'Chrome did not allow it. Click Allow to try again.',
}

/** How long "Done" stays before the page closes itself. */
export const CLOSE_MS = 1800

function closeSelf(): void {
  const tabs = ext.tabs as unknown as { getCurrent?: () => Promise<{ id?: number } | undefined> }
  void (tabs.getCurrent?.() ?? Promise.resolve(undefined)).then((t) => (t?.id !== undefined ? ext.tabs.remove(t.id) : globalThis.close?.())).catch(() => globalThis.close?.())
}

export async function startGrantPage(root: HTMLElement): Promise<void> {
  followTheme()
  // Before any click: the real-input switch is settled as stored now (the person's choice stays theirs).
  await migrateRealInput().catch(() => false)
  const line = h('p', { class: 'grant-line', role: 'status', 'data-testid': 'grant-line' })
  const allow = h('button', { class: 'btn btn-primary btn-block', type: 'button', 'data-testid': 'grant-allow' }, 'Allow') as HTMLButtonElement
  allow.onclick = () => {
    // Asked inside the click: nothing is awaited before Chrome's permission request.
    allow.disabled = true
    // What real input is now is read inside this click (grantLivePictures), never kept from the page's opening.
    void grantLivePictures().then((on) => {
      if (!on) { line.textContent = GRANT_WORDS.no; allow.disabled = false; return }
      line.textContent = GRANT_WORDS.done
      allow.remove()
      setTimeout(closeSelf, CLOSE_MS)
    })
  }
  root.append(h('main', { class: 'grant-page' },
    h('h1', {}, GRANT_WORDS.title), h('p', {}, GRANT_WORDS.body), h('p', { class: 'grant-note' }, GRANT_WORDS.bar), allow, line))
}

const root = typeof document !== 'undefined' ? document.getElementById('root') : null
if (root) void startGrantPage(root)
