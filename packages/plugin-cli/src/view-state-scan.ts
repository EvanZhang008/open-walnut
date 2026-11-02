/**
 * Finds a view choice kept only in component state: the guard behind "Walnut remembers what was
 * open" (2026-11-02, the user: "it keep lost my state like the open state of the session, like
 * full screen, file ... make it default feature in walnut no matter where include plugin").
 *
 * The class: a `useState` whose name says it holds what the user picked to see (a tab, a
 * filter, a mode, a section, a pane shown or hidden, the item open or selected), started from a
 * literal (read from no storage, no URL, no prop), so it comes back reset when the component
 * mounts again. A name only nominates: what the state is set to decides (`setterUses`). One that
 * is filled from loaded data (`.then(setView)`, `setView(await load())`) or set in a `catch` (an
 * error message) and never by a pick of the user holds no choice, whatever its name (2026-11-02,
 * the first plugin to adopt the scan: a `view` holding fetched stats, an `openError`). Walnut's own code keeps such a choice with usePageView (web/src/utils/
 * view-memory.ts) or lists it as a passing thing (tests/web/view-memory-guard.test.ts); a
 * plugin keeps it with `walnut.ui.useView`, and `walnut-plugin validate` warns on one kept in
 * `useState`. One matcher for both, so a plugin is held to the same rule as Walnut.
 */

/** Names that hold a view choice. */
export const VIEW_NAME = /^(?:\w*(?:Tab|Filter|View|Sort|Section|Scope|Mode|Group|Pick|Collapsed|Expanded|Hidden|Shown|Open|Target|Fullscreen|FullScreen|Maximized|Pane|Panel|Split|Page|Step)|tab|filter|view|sort|section|scope|mode|group|collapsed|expanded|hidden|fullscreen|maximized|pane|panel|split|page|step|show[A-Z]\w*|active[A-Z]\w*|selected\w*|open[A-Z]\w*)$/

/**
 * Names of a passing thing by its kind, whatever component holds it: a menu, picker, popover
 * or dialog open now (it closes on its own and opening it again starts it fresh), the keyboard
 * cursor in such a list, and a drag or a right-click in progress.
 */
export const PASSING_KIND = /^(?:\w*(?:Menu|menu|Picker|picker|Popup|popup|Popover|popover|Dropdown|dropdown|Flyout|flyout|Tip|tip|Palette|palette|Dialog|dialog|Confirm|confirm|Modal|modal|Overlay|overlay)Open|(?:menu|kebab|mention|plus|palette|tip|dropdown|popup|picker)Open|selected(?:Idx|Index)|\w*Drag\w*|ctxTarget|dropTarget)$/

/** A start that comes from nowhere: a literal, a constant, an empty collection (or a function returning one). */
export const LITERAL = /^(?:\(\)\s*=>\s*)?(?:'[^']*'|"[^"]*"|-?\d+|true|false|null|undefined|\[\]|\{\}|new (?:Set|Map)(?:<[^>]*>)?\(\)|[A-Z][A-Z0-9_]+)?$/

const DECL = /const\s*\[\s*(\w+)\s*,\s*(\w+)\s*,?\s*\]\s*=\s*(?:React\.)?useState\b\s*/g
const VIEW_DECL = /const\s*\[\s*(\w+)\s*,\s*(\w+)\s*[,\]][^\]=]*\]?\s*=\s*(?:[\w.]+\.)?useView\b/g

export interface StateDecl { name: string; setter: string; start: string; line: number }

const lineAt = (src: string, i: number) => src.slice(0, i).split('\n').length

/** The text between the `(` at `open` and its matching `)`. */
function argsAt(src: string, open: number): string {
  let j = open
  for (let depth = 0; j < src.length; j++) {
    if (src[j] === '(') depth++
    else if (src[j] === ')' && --depth === 0) break
  }
  return src.slice(open + 1, j)
}

/** Every `const [name, setName] = useState<T>(start)` in a source: its name, setter, start and line, generics and line breaks skipped. */
export function useStates(src: string): StateDecl[] {
  const out: StateDecl[] = []
  for (const m of src.matchAll(DECL)) {
    let i = m.index! + m[0].length
    if (src[i] === '<') {
      // A generic, nested ones too (Record<string, Set<string>>); `=>` inside it is not a close.
      for (let depth = 0; i < src.length; i++) {
        if (src[i] === '<') depth++
        else if (src[i] === '>' && src[i - 1] !== '=' && --depth === 0) { i++; break }
      }
    }
    while (/\s/.test(src[i] ?? '')) i++
    if (src[i] !== '(') continue
    const start = argsAt(src, i).trim().replace(/,$/, '').trim().replace(/\s+as\s+[\w.<>[\]| '"]+$/, '').trim()
    out.push({ name: m[1], setter: m[2], start, line: lineAt(src, m.index!) })
  }
  return out
}

/**
 * How a setter is used, each place it appears:
 *  - `typed`: it takes what the user types (`e.target.value` of an input, a textarea or an editor,
 *    or the value an `onChange` / `onInput` hands it), never a `<select>`, checkbox or radio;
 *  - `pick`: the user picks it (a literal, a toggle, or a call inside a click or select handler);
 *  - `loaded`: it takes loaded data (`.then(setX)`, an `await`, a `.json()`, inside a `.then`);
 *  - `caught`: it is set inside a `catch` (an error message);
 *  - `other`: anything else (a reset, a value from a prop).
 */
export type SetterUse = 'typed' | 'pick' | 'loaded' | 'caught' | 'other'

const TEXT_HANDLERS = /^(?:Change|Input|ValueChange|Update|TextChange|ChangeText|BeforeInput)$/
const PICK_HANDLERS = /^(?:Click|Select|Toggle|PointerDown|PointerUp|MouseDown|MouseUp|KeyDown|KeyUp|Pick|OpenChange|CheckedChange|TabChange|DoubleClick|Submit|Close|Open)$/
/** The handler a call sits in: the nearest `onX=` / `onX:` before it in its statement. */
function handlerOf(stmt: string): string | null {
  let last: string | null = null
  for (const m of stmt.matchAll(/\bon([A-Z]\w*)\s*[=:]/g)) last = m[1]
  return last
}
/** Loaded data by its source: an `await`, a `.json()`, a fetch, or a name defined from one. */
function loadedArg(src: string, arg: string): boolean {
  if (/\bawait\b|\.json\(\)|\bfetch\(/.test(arg)) return true
  const ident = /^\s*([A-Za-z_$][\w$]*)/.exec(arg)?.[1]
  if (!ident) return false
  if (/^(?:data|res|resp|response|result|results|json|body|payload|loaded|fetched|stats|rows)$/.test(ident)) return true
  const def = new RegExp(`(?:const|let|var)\\s+(?:\\{[^}]*\\b${ident}\\b[^}]*\\}|${ident})\\s*=([^;\\n]*)`).exec(src)
  return !!def && /\bawait\b|\.json\(\)|\bfetch\(|\.get\(|\.call\(|\bload\w*\(/.test(def[1])
}
const LITERAL_ARG = /^\s*(?:'[^']*'|"[^"]*"|`[^`$]*`|-?\d+|true|false|!\s*[\w.]+|\(?\s*\w+\s*\)?\s*=>\s*!\s*\w+)\s*$/

/** The JSX element a handler at `i` belongs to: the last `<tag` before it, with its attributes so far. */
function elementBefore(src: string, i: number): { tag: string; attrs: string } {
  const before = src.slice(Math.max(0, i - 800), i)
  const at = Math.max(before.lastIndexOf('<'), 0)
  const m = /^<([A-Za-z][\w.]*)/.exec(before.slice(at))
  return { tag: m?.[1] ?? '', attrs: before.slice(at) }
}

/** The statement a call at `i` sits in, from the last `;` or blank line before it. */
function statementBefore(src: string, i: number): string {
  const before = src.slice(Math.max(0, i - 600), i)
  return before.slice(Math.max(before.lastIndexOf(';'), before.lastIndexOf('\n\n')) + 1)
}

/** Whether `i` is inside a `catch` block or `.catch(` callback that opened before it and is still open. */
function inCatch(src: string, i: number): boolean {
  const before = src.slice(Math.max(0, i - 600), i)
  const at = before.lastIndexOf('catch')
  if (at < 0) return false
  // Its block (or callback) must still be open at `i`: once it closed, the call is past it.
  let rest = before.slice(at + 'catch'.length)
  // `catch (err) {`: the block opens at its `{`, past the parameter.
  const param = /^\s*\(\s*[\w$]*\s*\)\s*(?=\{)/.exec(rest)
  if (param) rest = rest.slice(param[0].length)
  let depth = 0
  let opened = false
  for (const c of rest) {
    if (c === '{' || c === '(') { depth++; opened = true }
    else if (c === '}' || c === ')') { depth--; if (opened && depth <= 0) return false }
  }
  return depth > 0
}

export function setterUses(src: string, setter: string): SetterUse[] {
  const out: SetterUse[] = []
  const re = new RegExp(`\\b${setter}\\b`, 'g')
  for (const m of src.matchAll(re)) {
    const i = m.index!
    const after = src.slice(i + setter.length).match(/^\s*(\(|.)/)?.[1]
    const lead = src.slice(Math.max(0, i - 40), i)
    // The declaration itself.
    if (/\[\s*\w+\s*,\s*$/.test(lead)) continue
    if (after !== '(') {
      // Passed as a value.
      if (/\.then\(\s*$/.test(lead)) out.push('loaded')
      else if (/\bon(?:Change|Input|ValueChange|Update|TextChange|ChangeText)\s*[=:]\s*\{?\s*$/.test(lead)) out.push(textElement(src, i) ? 'typed' : 'pick')
      else out.push('other')
      continue
    }
    const open = src.indexOf('(', i + setter.length)
    const arg = argsAt(src, open)
    const stmt = statementBefore(src, i)
    const handler = handlerOf(stmt)
    if (inCatch(src, i)) out.push('caught')
    else if (loadedArg(src, arg) || /\.then\(\s*(?:async\s*)?(?:\([^()]*\)|\w+)\s*=>/.test(stmt)) out.push('loaded')
    else if (/\.target\.value\b|currentTarget\.value\b/.test(arg) || (handler && TEXT_HANDLERS.test(handler))) out.push(textElement(src, i) ? 'typed' : 'pick')
    // Back to nothing (null, undefined, an empty string) is a reset, not a pick.
    else if (/^\s*(?:null|undefined|''|""|``)?\s*$/.test(arg)) out.push('other')
    else if (LITERAL_ARG.test(arg) || (handler && PICK_HANDLERS.test(handler))) out.push('pick')
    else out.push('other')
  }
  return out
}

/** Whether a handler at `i` belongs to a box the user types in (not a select, checkbox, radio or range). */
function textElement(src: string, i: number): boolean {
  const { tag, attrs } = elementBefore(src, i)
  if (/^select$/i.test(tag)) return false
  if (/type\s*=\s*["'{]?\s*["']?(?:checkbox|radio|range|color|file)\b/.test(attrs)) return false
  return true
}

/** Loaded data or an error message, never picked by the user: no view choice, whatever its name. */
function holdsNoChoice(uses: SetterUse[], name: string): boolean {
  if (/(?:Error|Err)$/.test(name)) return true
  return uses.some((u) => u === 'loaded' || u === 'caught') && !uses.includes('pick')
}

/** The view choices a source keeps only in component state (passing kinds, loaded data and errors left out). */
export function viewStatesInMemory(src: string): StateDecl[] {
  return useStates(src).filter((d) => VIEW_NAME.test(d.name) && LITERAL.test(d.start) && !PASSING_KIND.test(d.name)
    && !holdsNoChoice(setterUses(src, d.setter), d.name))
}

/**
 * Text the user is typing (a draft) has its own home: `walnut.ui.useDraft(name, { id })`, Walnut's
 * draft store, one key per draft, never in the synced settings. Kept in `useState` it is lost on a
 * reload; kept in `useView` it rides ui-prefs (a write into the synced config as the user types)
 * under one key per name, so the last writer of any item wins on every device and the oldest of
 * many items are dropped; kept in the plugin's own localStorage keys it is outside what Walnut
 * keeps across cleared browser data. 2026-11-02, found by a practice plugin moving onto useView.
 *
 * A draft is told by what it holds: a string state the user types into (`setterUses` says
 * `typed`), whatever its name (a `lesson`, a `code`), or one named a draft; a typed search, filter
 * or query is a passing thing and starts empty. A `localStorage.setItem` is a draft when its key
 * (the text, or the definition of the name or function it calls) says draft, or its value is such
 * a typed state.
 */
export const DRAFT_NAME = /draft/i
/** A typed box that is no draft: a search, a filter, a query starts empty. */
const NOT_A_DRAFT = /search|query|filter|find|pattern|lookup/i

export type DraftHome = 'useState' | 'useView' | 'localStorage'
export interface DraftDecl { name: string; line: number; home: DraftHome }

/** A string start: what typed text begins as. */
const STRING_START = /^(?:\(\)\s*=>\s*)?(?:'[^']*'|"[^"]*"|`[^`$]*`)$/
const STORAGE_SET = /\blocalStorage\s*\.\s*setItem\s*\(/g

/** Whether `i` sits in a `//` comment on its line. */
const inLineComment = (src: string, i: number) => /\/\//.test(src.slice(src.lastIndexOf('\n', i) + 1, i))

/** The first argument and the rest of a call's argument text, split at its first top-level comma. */
function splitFirst(args: string): [string, string] {
  let depth = 0
  for (let i = 0; i < args.length; i++) {
    const c = args[i]
    if ('([{'.includes(c)) depth++
    else if (')]}'.includes(c)) depth--
    else if (c === ',' && depth === 0) return [args.slice(0, i).trim(), args.slice(i + 1).trim()]
  }
  return [args.trim(), '']
}

/** Whether a key expression says draft: its own text, or the definitions of the names it uses (two levels deep). */
function keySaysDraft(src: string, key: string, depth = 0): boolean {
  if (DRAFT_NAME.test(key)) return true
  if (depth >= 2) return false
  for (const [ident] of key.matchAll(/[A-Za-z_$][\w$]*/g)) {
    if (/^(?:const|let|var|function|return|id|key|String|JSON|localStorage)$/.test(ident)) continue
    const def = new RegExp(`(?:const|let|var)\\s+${ident}\\s*=([^;\\n]*)|function\\s+${ident}\\s*\\(([^]{0,300}?)\\}`).exec(src)
    const text = def?.[1] ?? def?.[2]
    if (text && keySaysDraft(src, text, depth + 1)) return true
  }
  return false
}

/** Every draft a source keeps anywhere but `walnut.ui.useDraft`. */
export function draftsOffDevice(src: string): DraftDecl[] {
  const out: DraftDecl[] = []
  const typed = new Set<string>()
  for (const d of useStates(src)) {
    if (!STRING_START.test(d.start) || NOT_A_DRAFT.test(d.name)) continue
    const isTyped = setterUses(src, d.setter).includes('typed')
    if (isTyped) typed.add(d.name)
    if (isTyped || DRAFT_NAME.test(d.name)) out.push({ name: d.name, line: d.line, home: 'useState' })
  }
  for (const m of src.matchAll(VIEW_DECL)) {
    const [, name, setter] = m
    if (inLineComment(src, m.index!) || NOT_A_DRAFT.test(name)) continue
    const call = src.indexOf('(', m.index! + m[0].length)
    const viewName = /^\s*([`'"])([^`'"]*)\1/.exec(argsAt(src, call))?.[2] ?? name
    const isTyped = setterUses(src, setter).includes('typed')
    if (isTyped) typed.add(name)
    if (isTyped || DRAFT_NAME.test(viewName) || DRAFT_NAME.test(name)) out.push({ name: viewName, line: lineAt(src, m.index!), home: 'useView' })
  }
  for (const m of src.matchAll(STORAGE_SET)) {
    if (inLineComment(src, m.index!)) continue
    const [key, value] = splitFirst(argsAt(src, m.index! + m[0].length - 1))
    const valueTyped = [...typed].some((n) => new RegExp(`\\b${n}\\b`).test(value))
    if (keySaysDraft(src, key) || valueTyped) out.push({ name: key, line: lineAt(src, m.index!), home: 'localStorage' })
  }
  return out.sort((a, b) => a.line - b.line)
}
