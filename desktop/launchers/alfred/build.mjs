#!/usr/bin/env bun
/**
 * Builds the Walnut Alfred workflow: `bun desktop/launchers/alfred/build.mjs [--out <dir>]`
 * writes `Walnut.alfredworkflow` (a zip Alfred imports on double-click) and the unpacked folder
 * beside it. Needs Alfred 5.5 or newer with the Powerpack (workflows and the Text View).
 *
 * What it adds to Alfred:
 *   - the keyword (`w` by default) with a Script Filter: Enter = quick answer, Cmd+Enter = Tell
 *     Main, and the matching tasks below (Enter opens one in Walnut)
 *   - a Text View that streams the answer and takes follow-ups
 *     (Cmd+Enter new, Option+Enter paste the answer, Control+Enter copy it, Shift+Enter open Main)
 *   - a Hotkey (unset; the user picks one) and a Universal Action that bring the selected text
 *   - a fallback search ("Ask Walnut '…'")
 * The scripts are JavaScript for Automation with curl (desktop/launchers/alfred/*.js), so the
 * workflow needs nothing else installed; it talks to the local server's /api/v1/quick routes.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const here = path.dirname(new URL(import.meta.url).pathname)
const repo = path.resolve(here, '../../..')
const outArg = process.argv.indexOf('--out')
const outDir = path.resolve(outArg > 0 ? process.argv[outArg + 1] : path.join(here, 'dist'))
const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'))

const read = (name) => fs.readFileSync(path.join(here, name), 'utf8')
const common = read('common.js')
const script = (...parts) => [common, ...parts].join('\n')

// Fixed ids, so an imported update replaces the objects instead of adding new ones.
const ID = {
  filter: '2B4E7C1A-0D3F-4A61-9E52-7A1F6C0B9D01',
  route: '2B4E7C1A-0D3F-4A61-9E52-7A1F6C0B9D02',
  openTask: '2B4E7C1A-0D3F-4A61-9E52-7A1F6C0B9D03',
  view: '2B4E7C1A-0D3F-4A61-9E52-7A1F6C0B9D04',
  newChat: '2B4E7C1A-0D3F-4A61-9E52-7A1F6C0B9D05',
  answerPaste: '2B4E7C1A-0D3F-4A61-9E52-7A1F6C0B9D06',
  paste: '2B4E7C1A-0D3F-4A61-9E52-7A1F6C0B9D07',
  answerCopy: '2B4E7C1A-0D3F-4A61-9E52-7A1F6C0B9D08',
  copy: '2B4E7C1A-0D3F-4A61-9E52-7A1F6C0B9D09',
  openMainLink: '2B4E7C1A-0D3F-4A61-9E52-7A1F6C0B9D0A',
  openMain: '2B4E7C1A-0D3F-4A61-9E52-7A1F6C0B9D0B',
  hotkey: '2B4E7C1A-0D3F-4A61-9E52-7A1F6C0B9D0C',
  universal: '2B4E7C1A-0D3F-4A61-9E52-7A1F6C0B9D0D',
  selection: '2B4E7C1A-0D3F-4A61-9E52-7A1F6C0B9D0E',
  fallback: '2B4E7C1A-0D3F-4A61-9E52-7A1F6C0B9D0F',
  fallbackEntry: '2B4E7C1A-0D3F-4A61-9E52-7A1F6C0B9D10',
}
const MOD = { none: 0, shift: 131072, control: 262144, option: 524288, command: 1048576 }

const jxa = (body, version = 2) => ({
  type: 'alfred.workflow.action.script',
  version,
  config: { concurrently: false, escaping: 102, script: body, scriptargtype: 1, scriptfile: '', type: 7 },
})
const openUrl = () => ({
  type: 'alfred.workflow.action.script',
  version: 2,
  config: { concurrently: false, escaping: 102, script: 'open "$1"', scriptargtype: 1, scriptfile: '', type: 0 },
})
const clipboard = (autopaste) => ({
  type: 'alfred.workflow.output.clipboard',
  version: 3,
  config: { autopaste, clipboardtext: '{query}', ignoredynamicplaceholders: true, transient: false },
})
const entryScript = (kind) => script(`const WALNUT_ENTRY_KIND = ${JSON.stringify(kind)}`, read('entry.js'))
const answerScript = (kind) => script(`const WALNUT_ANSWER_KIND = ${JSON.stringify(kind)}`, read('answer.js'))

const objects = {
  [ID.filter]: {
    type: 'alfred.workflow.input.scriptfilter',
    version: 3,
    config: {
      alfredfiltersresults: false, alfredfiltersresultsmatchmode: 0, argumenttreatemptyqueryasnil: true,
      argumenttrimmode: 0, argumenttype: 1, escaping: 102, keyword: '{var:walnut_keyword}',
      queuedelaycustom: 1, queuedelayimmediatelyinitially: true, queuedelaymode: 0, queuemode: 1,
      runningsubtext: 'Looking in Walnut…', script: script(read('filter.js')), scriptargtype: 1, scriptfile: '',
      skipuniversalaction: true, subtext: 'Quick answer, Tell Main, or find a task', title: 'Ask Walnut', type: 7, withspace: true,
    },
  },
  [ID.route]: {
    type: 'alfred.workflow.utility.conditional',
    version: 1,
    config: {
      conditions: [{
        inputstring: '{var:walnut_kind}', matchcasesensitive: false, matchmode: 0, matchstring: 'task',
        outputlabel: 'Open task', uid: '2B4E7C1A-0D3F-4A61-9E52-7A1F6C0B9D20',
      }],
      elselabel: 'Ask', hideelse: false,
    },
  },
  [ID.openTask]: openUrl(),
  [ID.view]: {
    type: 'alfred.workflow.userinterface.text',
    version: 1,
    config: {
      behaviour: 2, fontmode: 0, fontsizing: 0,
      footertext: '↵ Follow up · ⌘↵ New · ⌥↵ Paste answer · ⌃↵ Copy answer · ⇧↵ Open in Walnut',
      inputfile: 'walnut-chat', inputtype: 1, loadingtext: 'Asking Walnut…', outputmode: 1,
      scriptinput: 2, spellchecking: 0, stackview: false,
    },
  },
  [ID.newChat]: jxa(entryScript('new-chat')),
  [ID.answerPaste]: jxa(answerScript('answer')),
  [ID.paste]: clipboard(true),
  [ID.answerCopy]: jxa(answerScript('answer')),
  [ID.copy]: clipboard(false),
  [ID.openMainLink]: jxa(answerScript('open')),
  [ID.openMain]: openUrl(),
  [ID.hotkey]: {
    type: 'alfred.workflow.trigger.hotkey',
    version: 2,
    config: {
      action: 0, argument: 1, focusedappvariable: true, focusedappvariablename: 'walnut_app',
      hotkey: 0, hotmod: 0, leftcursor: false, modsmode: 0, relatedAppsMode: 0,
    },
  },
  [ID.universal]: {
    type: 'alfred.workflow.trigger.universalaction',
    version: 1,
    config: { acceptsfiles: false, acceptsmulti: 0, acceptstext: true, acceptsurls: false, name: 'Ask Walnut about this text' },
  },
  [ID.selection]: jxa(entryScript('selection')),
  [ID.fallback]: {
    type: 'alfred.workflow.trigger.fallback',
    version: 1,
    config: { text: "Ask Walnut '{query}'" },
  },
  [ID.fallbackEntry]: jxa(entryScript('new')),
}

const link = (to, modifiers = MOD.none, subtext = '', vitoclose = false) => ({ destinationuid: to, modifiers, modifiersubtext: subtext, vitoclose })
const connections = {
  [ID.filter]: [link(ID.route)],
  [ID.route]: [
    { ...link(ID.openTask), sourceoutputuid: '2B4E7C1A-0D3F-4A61-9E52-7A1F6C0B9D20' },
    link(ID.view),
  ],
  [ID.view]: [
    link(ID.newChat, MOD.command, 'New conversation', true),
    link(ID.answerPaste, MOD.option, 'Paste the answer into the app you came from', false),
    link(ID.answerCopy, MOD.control, 'Copy the answer', false),
    link(ID.openMainLink, MOD.shift, 'Open in Walnut', false),
  ],
  [ID.newChat]: [link(ID.view)],
  [ID.answerPaste]: [link(ID.paste)],
  [ID.answerCopy]: [link(ID.copy)],
  [ID.openMainLink]: [link(ID.openMain)],
  [ID.hotkey]: [link(ID.selection)],
  [ID.universal]: [link(ID.selection)],
  [ID.selection]: [link(ID.view)],
  [ID.fallback]: [link(ID.fallbackEntry)],
  [ID.fallbackEntry]: [link(ID.view)],
}

const uidata = {}
Object.keys(objects).forEach((uid, i) => { uidata[uid] = { xpos: 60 + (i % 4) * 230, ypos: 40 + Math.floor(i / 4) * 150 } })

const workflow = {
  bundleid: 'dev.openwalnut.alfred',
  category: 'Productivity',
  createdby: 'Open Walnut',
  description: 'Ask Walnut from Alfred: quick answers, Tell Main, find a task',
  disabled: false,
  name: 'Walnut',
  objects: Object.entries(objects).map(([uid, o]) => ({ ...o, uid })),
  connections,
  uidata,
  readme: [
    'Ask Walnut from Alfred. Walnut must be running on this Mac (the Walnut app, or `walnut web`).',
    '',
    '- `w <text>`: ↵ a quick answer, ⌘↵ Tell Main (goes to Main\'s chat), or ↵ on a task to open it.',
    '- In the answer: ↵ follow up, ⌘↵ new, ⌥↵ paste it into the app you came from, ⌃↵ copy, ⇧↵ open in Walnut.',
    '- Set a Hotkey on the hotkey trigger to ask about the selected text, or use the Universal Action.',
  ].join('\n'),
  userconfigurationconfig: [
    {
      type: 'textfield', variable: 'walnut_keyword', label: 'Keyword', description: 'What you type in Alfred to ask Walnut',
      config: { default: 'w', placeholder: 'w', required: true, trim: true },
    },
    {
      type: 'textfield', variable: 'walnut_port', label: 'Walnut port', description: 'Where the local Walnut server listens',
      config: { default: '3456', placeholder: '3456', required: false, trim: true },
    },
  ],
  variablesdontexport: [],
  version: String(pkg.version ?? '1.0.0'),
  webaddress: 'https://openwalnut.dev',
}

// ── plist XML ────────────────────────────────────────────────────────────────
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
function plistValue(v, indent) {
  const pad = '\t'.repeat(indent)
  if (Array.isArray(v)) {
    if (v.length === 0) return `${pad}<array/>`
    return `${pad}<array>\n${v.map((x) => plistValue(x, indent + 1)).join('\n')}\n${pad}</array>`
  }
  if (v && typeof v === 'object') {
    const keys = Object.keys(v).sort()
    if (keys.length === 0) return `${pad}<dict/>`
    return `${pad}<dict>\n${keys.map((k) => `${pad}\t<key>${esc(k)}</key>\n${plistValue(v[k], indent + 1)}`).join('\n')}\n${pad}</dict>`
  }
  if (typeof v === 'boolean') return `${pad}<${v}/>`
  if (typeof v === 'number') return Number.isInteger(v) ? `${pad}<integer>${v}</integer>` : `${pad}<real>${v}</real>`
  return `${pad}<string>${esc(v)}</string>`
}
const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n${plistValue(workflow, 0)}\n</plist>\n`

const folder = path.join(outDir, 'Walnut')
fs.rmSync(folder, { recursive: true, force: true })
fs.mkdirSync(folder, { recursive: true })
fs.writeFileSync(path.join(folder, 'info.plist'), xml)
const chatFile = path.join(folder, 'walnut-chat')
fs.writeFileSync(chatFile, `#!/usr/bin/osascript -l JavaScript\n${script(read('chat.js'))}`)
fs.chmodSync(chatFile, 0o755)
fs.copyFileSync(path.join(repo, 'web/public/walnut-icon.png'), path.join(folder, 'icon.png'))
fs.copyFileSync(path.join(repo, 'web/public/walnut-icon.png'), path.join(folder, 'task.png'))
execFileSync('/usr/bin/plutil', ['-lint', path.join(folder, 'info.plist')], { stdio: 'pipe' })
const archive = path.join(outDir, 'Walnut.alfredworkflow')
fs.rmSync(archive, { force: true })
execFileSync('/usr/bin/zip', ['-qr', archive, '.'], { cwd: folder })
console.log(archive)
