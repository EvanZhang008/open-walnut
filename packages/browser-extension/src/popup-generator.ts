/**
 * The popup's password generator: a random password (8 to 64 characters, which kinds of
 * character) or a passphrase (3 to 12 words, separator, capitals, a digit). The choice is kept
 * (settings.ts), and the in-page strong password starts from it too.
 */
import { ask } from './ext'
import { h, icon } from './dom'
import { getSettings, setSettings, type GeneratorPrefs } from './settings'
import { copySecret, iconButton, topBar } from './popup-ui'

export async function generatorView(root: HTMLElement, back: () => void): Promise<void> {
  const prefs: GeneratorPrefs = (await getSettings()).generator
  const out = h('div', { class: 'gen-out mono', 'data-testid': 'gen-out', 'aria-live': 'polite' })
  const options = h('div', {})
  const make = async () => {
    const r = await ask<{ value: string }>({ type: 'generate', options: prefs.kind === 'words' ? prefs.words : prefs.random })
    out.textContent = r.ok ? r.value : r.error ?? ''
  }
  const save = () => { void setSettings({ generator: prefs }); void make() }

  const check = (label: string, on: boolean, set: (v: boolean) => void, testid: string) => {
    const box = h('input', { type: 'checkbox', 'data-testid': testid }) as HTMLInputElement
    box.checked = on
    box.onchange = () => { set(box.checked); save() }
    return h('label', {}, box, label)
  }
  const slider = (label: string, min: number, max: number, value: number, unit: string, set: (n: number) => void, testid: string) => {
    const shown = h('span', { class: 'muted' }, `${value} ${unit}`)
    const range = h('input', { type: 'range', min: String(min), max: String(max), value: String(value), style: 'width:100%', 'aria-label': label, 'data-testid': testid }) as HTMLInputElement
    range.oninput = () => { set(Number(range.value)); shown.textContent = `${range.value} ${unit}`; save() }
    return h('div', {}, h('div', { class: 'gen-row' }, h('span', {}, label), shown), range)
  }

  const drawOptions = () => {
    if (prefs.kind === 'random') {
      const r = prefs.random
      options.replaceChildren(
        slider('Length', 8, 64, Math.min(64, Math.max(8, r.length)), 'characters', (n) => { r.length = n }, 'gen-length'),
        h('div', { class: 'gen-sets' },
          check('A to Z', r.upper, (v) => { r.upper = v }, 'gen-upper'),
          check('a to z', r.lower, (v) => { r.lower = v }, 'gen-lower'),
          check('0 to 9', r.digits, (v) => { r.digits = v }, 'gen-digits'),
          check('Symbols', r.symbols, (v) => { r.symbols = v }, 'gen-symbols'),
          check('No look-alikes (l 1 O 0)', r.avoidAmbiguous, (v) => { r.avoidAmbiguous = v }, 'gen-ambiguous')))
    } else {
      const w = prefs.words
      const sep = h('select', { class: 'select', 'aria-label': 'Separator', 'data-testid': 'gen-separator', style: 'width:auto' },
        ...[['-', 'Hyphen'], [' ', 'Space'], ['.', 'Period'], ['_', 'Underscore'], ['', 'None']].map(([v, l]) => h('option', { value: v }, l))) as HTMLSelectElement
      sep.value = w.separator
      sep.onchange = () => { w.separator = sep.value; save() }
      options.replaceChildren(
        slider('Words', 3, 12, w.words, 'words', (n) => { w.words = n }, 'gen-words'),
        h('div', { class: 'gen-row' }, h('span', {}, 'Separator'), sep),
        h('div', { class: 'gen-sets' },
          check('Capitals', w.capitalize, (v) => { w.capitalize = v }, 'gen-capitalize'),
          check('A digit', w.number, (v) => { w.number = v }, 'gen-number')))
    }
  }
  const kindBtn = (kind: GeneratorPrefs['kind'], label: string) => {
    const b = h('button', { type: 'button', 'aria-pressed': String(prefs.kind === kind), 'data-testid': `gen-kind-${kind}` }, label)
    b.onclick = () => {
      prefs.kind = kind
      for (const x of kinds.querySelectorAll('button')) x.setAttribute('aria-pressed', String(x === b))
      drawOptions()
      save()
    }
    return b
  }
  const kinds = h('div', { class: 'gen-kinds', role: 'group', 'aria-label': 'Kind' }, kindBtn('random', 'Password'), kindBtn('words', 'Passphrase'))
  drawOptions()
  void make()
  root.replaceChildren(h('div', {},
    topBar('Password generator', back),
    h('div', { class: 'pane' }, kinds, out,
      h('div', { style: 'display:flex;gap:6px;margin-top:10px' },
        h('button', { class: 'btn btn-primary', type: 'button', style: 'flex:1', 'data-testid': 'gen-copy', onclick: () => void copySecret(out.textContent ?? '', 'Password') }, 'Copy'),
        iconButton(icon('dice'), 'Make another', () => void make(), { class: 'btn icon-only', 'data-testid': 'gen-again' })),
      options,
      h('p', { class: 'muted', style: 'font-size:12px;margin-top:14px' }, 'On a sign-up page, Walnut offers a strong password in the field itself (made to fit what the field accepts) and saves it when you send the form.'))))
}
