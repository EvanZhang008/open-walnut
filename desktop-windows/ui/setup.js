// The setup page: two ways to use Walnut on this PC, then the setup script's steps as it runs.
const $ = (id) => document.getElementById(id)
const api = window.walnutApp
const STAGES = ['wsl', 'linux', 'start', 'walnut']
let mode = 'own'
let current = null

/** "  Linux ............. OpenWalnut ready (Ubuntu 24.04, user pc)" -> "OpenWalnut ready (...)". */
function stepText(line) {
  let s = line.trim().replace(/^\d\/\d\s+/, '')
  s = s.replace(/^Start with Windows\s+\.*\s*/, '')
  const m = s.match(/^([^.]+?) \.+ (.*)$/)
  if (!m) return s
  // The Linux join's own steps keep their name: "Login service: running".
  return m[1] === 'Walnut' || m[1] === 'WSL' || m[1] === 'Linux' || m[1] === 'Start menu' ? m[2] : `${m[1]}: ${m[2]}`
}

function mark(stage, cls) {
  const li = document.querySelector(`li[data-stage="${stage}"]`)
  if (!li) return
  li.classList.remove('active', 'done', 'failed')
  if (cls) li.classList.add(cls)
}

function enter(stage) {
  if (stage === current) return
  const at = STAGES.indexOf(stage)
  for (let i = 0; i < at; i++) mark(STAGES[i], 'done')
  mark(stage, 'active')
  current = stage
}

async function start(which) {
  $('join-error').hidden = true
  mode = which
  const r = await api.startSetup(which, which === 'join' ? $('invite').value : '')
  if (!r || !r.ok) {
    $('join-error').textContent = (r && r.error) || 'Setup could not start.'
    $('join-error').hidden = false
    return
  }
  $('choose').hidden = true
  $('progress').hidden = false
  $('end').hidden = true
  $('log').textContent = ''
  current = null
  for (const s of STAGES) mark(s, null)
  if (which === 'join') {
    $('progress-title').textContent = 'Adding this PC to your Walnut'
    $('walnut-step').textContent = 'Joining your Walnut'
    $('walnut-now').textContent = 'Walnut, its service, then the join'
  } else {
    $('progress-title').textContent = 'Setting up Walnut on this PC'
    $('walnut-step').textContent = 'Walnut'
    $('walnut-now').textContent = 'Installed in that Linux'
  }
  enter('wsl')
}

api.onSetupLine(({ line, stage }) => {
  const log = $('log')
  log.textContent += line + '\n'
  log.scrollTop = log.scrollHeight
  if (!stage) return
  enter(stage)
  const now = document.querySelector(`li[data-stage="${stage}"] .now`)
  if (now) now.textContent = stepText(line)
})

api.onSetupEnd(({ end }) => {
  $('end').hidden = false
  const button = $('end-button')
  if (end === 'done') {
    for (const s of STAGES) mark(s, 'done')
    $('end-text').textContent = mode === 'own' ? 'Walnut is ready.' : 'This PC is one of your Walnut machines now.'
    button.textContent = 'Open Walnut'
    button.onclick = () => api.continue()
    setTimeout(() => api.continue(), 1500)
  } else if (end === 'restart') {
    if (current) mark(current, 'done')
    $('end-text').textContent = mode === 'own'
      ? 'WSL is on. Restart Windows, then open Walnut from the Start menu: setup carries on from here.'
      : 'WSL is on. Restart Windows, then open Walnut from the Start menu and paste a new link from your Mac (each link works once, for 10 minutes).'
    button.textContent = 'Close'
    button.onclick = () => window.close()
  } else {
    if (current) mark(current, 'failed')
    $('end-text').textContent = 'Setup stopped. The details below say why.'
    $('details').open = true
    button.textContent = 'Try again'
    button.onclick = () => { $('progress').hidden = true; $('choose').hidden = false }
  }
  button.focus()
})

$('own').addEventListener('click', () => start('own'))
$('join').addEventListener('click', () => start('join'))
$('invite').addEventListener('keydown', (e) => { if (e.key === 'Enter') start('join') })

// Whose Walnut the link joins, before the click: the join runs that Walnut's script on this PC.
function showHost(fromClipboard) {
  const m = $('invite').value.match(/https:\/\/([A-Za-z0-9.-]+(?::[0-9]+)?)\/join\/[A-Za-z0-9-]+/)
  const ticket = /wn1-[A-Za-z0-9_-]+/.test($('invite').value)
  const hint = $('join-host')
  hint.textContent = m ? `This PC joins the Walnut at ${m[1]}${fromClipboard ? ' (the link from your clipboard)' : ''}.`
    : ticket ? `This PC joins the Mac that made this ticket${fromClipboard ? ' (from your clipboard)' : ''}.` : ''
  hint.hidden = !hint.textContent
}
$('invite').addEventListener('input', () => showHost(false))

// After the restart WSL needed, an own setup carries on by itself.
if (new URLSearchParams(location.search).get('auto') === 'own') start('own')

api.clipboardInvite().then((invite) => {
  if (invite && !$('invite').value) { $('invite').value = invite; showHost(true) }
})
