// The Text View: one conversation, a quick answer or Main, streamed while it is written.
//
// A new question starts curl in the background, writing the answer's stream to a file; the view
// re-runs this script every 0.1 s (`rerun`) and shows what the file holds so far, until the
// answer ends. Both stream NDJSON: a quick answer from POST /api/v1/quick/ask, Main's reply from
// POST /api/v1/quick/main with `follow`, which sends the message and then streams Main's words
// for that message (the server matches the turn that took it).
//
// State lives in the workflow's cache folder: chat.json (the conversation), stream.txt (the
// answer coming in) and stream.json (what that stream is).

const QUICK_TIMEOUT_MS = 90 * 1000
const MAIN_TIMEOUT_MS = 15 * 60 * 1000
const FRESH_AFTER_MS = 3 * 60 * 1000

function cacheDir() {
  const dir = envVar('alfred_workflow_cache') || (envVar('HOME') + '/Library/Caches/walnut-alfred')
  makeDir(dir)
  return dir
}

function paths() {
  const dir = cacheDir()
  return { chat: dir + '/chat.json', stream: dir + '/stream.txt', meta: dir + '/stream.json', request: dir + '/request.json' }
}

function newChat(mode) {
  return {
    mode: mode === 'main' ? 'main' : 'quick',
    conversation: 'alfred-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
    messages: [],
    at: Date.now(),
  }
}

function loadChat(p) {
  const raw = readText(p.chat)
  if (!raw) return null
  try { return JSON.parse(raw) } catch (e) { return null }
}

function saveChat(p, chat) {
  chat.at = Date.now()
  writeText(p.chat, JSON.stringify(chat))
}

function preview(text, max) {
  const flat = String(text).replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : flat.slice(0, max - 1) + '…'
}

function render(chat, partial) {
  const lines = []
  lines.push(chat.mode === 'main' ? '### CEO' : '### Quick answer')
  if (chat.selection) {
    lines.push('> ' + (chat.app ? 'Selected in ' + chat.app : 'Selected text') + ': “' + preview(chat.selection, 160) + '”')
  }
  for (const m of chat.messages) {
    if (m.role === 'user') lines.push('', '**You:** ' + m.text, '')
    else lines.push(m.text, '', '---')
  }
  if (partial !== undefined) lines.push(partial)
  if (chat.messages.length === 0 && partial === undefined) {
    lines.push('', chat.selection ? 'Type what to do with the selected text, then press ↵.' : 'Type a question, then press ↵.')
  }
  return lines.join('\n')
}

function footer(chat) {
  const open = chat.mode === 'main' ? ' · ⇧↵ Open CEO' : ''
  return '↵ Follow up · ⌘↵ New · ⌥↵ Paste answer · ⌃↵ Copy answer' + open
}

function output(chat, body, opts) {
  const out = {
    response: body,
    footer: footer(chat),
    behaviour: { response: 'replace', scroll: 'end', inputfield: 'clear' },
    variables: { walnut_streaming: opts && opts.streaming ? '1' : '' },
  }
  if (opts && opts.streaming) out.rerun = 0.1
  return JSON.stringify(out)
}

/** True while `pid` is a running curl (the one this view started: a pid is only reused much later). */
function processAlive(pid) {
  const n = parseInt(pid, 10)
  if (!(n > 1)) return false
  return sh('/bin/ps -p ' + n + ' -o comm= 2>/dev/null').trim().split('/').pop() === 'curl'
}

/** Kill the background curl of the stream that is running, if any. */
function stopStream(p) {
  const metaRaw = readText(p.meta)
  if (metaRaw) {
    try {
      const meta = JSON.parse(metaRaw)
      if (meta.pid > 1 && processAlive(meta.pid)) sh('/bin/kill ' + parseInt(meta.pid, 10) + ' 2>/dev/null || true')
    } catch (e) { /* nothing to stop */ }
  }
  removeFile(p.meta)
  removeFile(p.stream)
}

/** The question's text, with the selected text on the first question only (the conversation keeps it). */
function withSelection(chat, question, asContext) {
  if (!chat.selection || chat.messages.filter((m) => m.role === 'user').length !== 1) return { text: question }
  const note = (chat.app ? 'Text selected in ' + chat.app : 'Selected text') + ':\n' + chat.selection
  return asContext ? { text: question, context: note } : { text: question + '\n\n' + note }
}

/** curl in the background: POST `body` to `path`, its streamed answer into the stream file. */
function startStream(p, kind, path, body, maxSeconds, question) {
  writeText(p.request, JSON.stringify(body))
  writeText(p.stream, '')
  const pid = sh('/usr/bin/curl -sN --max-time ' + maxSeconds + ' -X POST -H ' + shellQuote('content-type: application/json')
    + ' --data-binary @' + shellQuote(p.request) + ' ' + shellQuote(walnutBase() + path)
    + ' > ' + shellQuote(p.stream) + ' 2>/dev/null & echo $!').trim()
  writeText(p.meta, JSON.stringify({ kind: kind, pid: parseInt(pid, 10) || 0, startedAt: Date.now(), question: question }))
}

function startQuick(p, chat, question) {
  const body = withSelection(chat, question, true)
  body.conversation = chat.conversation
  startStream(p, 'quick', '/api/v1/quick/ask', body, 120, question)
}

function startMain(p, chat, question) {
  const body = withSelection(chat, question, false)
  body.follow = true
  startStream(p, 'main', '/api/v1/quick/main', body, 900, question)
}

/** The NDJSON stream so far: { text, done, error, activity, held, taskId }. */
function readStream(raw) {
  let text = ''
  let activity = ''
  let taskId = ''
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let value
    try { value = JSON.parse(line) } catch (e) { continue }
    if (value.type === 'sent') taskId = value.taskId || ''
    else if (value.type === 'held') return { text: '', done: true, held: true, taskId: value.taskId || '' }
    else if (value.type === 'text') { text += value.delta || ''; activity = '' }
    else if (value.type === 'reset') text = ''
    else if (value.type === 'activity') activity = value.detail || 'working'
    else if (value.type === 'result') return { text: value.text || text, done: true, unfinished: !!value.unfinished, taskId: taskId }
    else if (value.type === 'error') return { text: text, done: true, error: value.message || 'The answer failed', taskId: taskId }
  }
  return { text: text, done: false, activity: activity, taskId: taskId }
}

function continueStream(p, chat) {
  const metaRaw = readText(p.meta)
  if (!metaRaw) return output(chat, render(chat))
  const meta = JSON.parse(metaRaw)
  const raw = readText(p.stream) || ''
  const age = Date.now() - meta.startedAt
  const got = readStream(raw)
  if (got.taskId) chat.mainTaskId = got.taskId
  const main = meta.kind === 'main'
  // curl gone with nothing written: the server was not there.
  const ended = !got.done && raw === '' && age > 1500 && !processAlive(meta.pid)
  if (got.done || ended || age > (main ? MAIN_TIMEOUT_MS : QUICK_TIMEOUT_MS)) {
    let answer
    if (ended) answer = '⚠️ ' + NOT_RUNNING
    else if (got.held) answer = 'The CEO is waiting for your answer to its question first, so nothing was sent. ⇧↵ opens the CEO.'
    else if (got.error) answer = (got.text ? got.text + '\n\n' : '') + '⚠️ ' + got.error
    else if (got.done && !got.unfinished) answer = got.text || (main ? 'The CEO finished without a written reply. ⇧↵ opens its chat.' : '⚠️ No answer came back.')
    else answer = got.text ? got.text + (main ? '\n\n_The CEO is still working. ⇧↵ opens its chat._' : ' [no more came]') : (main ? 'The CEO is still working. ⇧↵ opens its chat.' : '⚠️ No answer came back.')
    chat.messages.push({ role: 'assistant', text: answer })
    saveChat(p, chat)
    stopStream(p)
    return output(chat, render(chat))
  }
  saveChat(p, chat)
  const partial = got.text || (main ? (got.activity ? '_The CEO is working: ' + got.activity + '…_' : '_The CEO is reading it…_') : '…')
  return output(chat, render(chat, partial), { streaming: true })
}

/** The answer streaming now, cut short by a new question: what came so far stays in the conversation. */
function keepPartial(p, chat) {
  const metaRaw = readText(p.meta)
  if (!metaRaw) return
  const got = readStream(readText(p.stream) || '')
  if (got.text) chat.messages.push({ role: 'assistant', text: got.text + ' [cut short]' })
}

function run(argv) {
  const p = paths()
  const typed = (argv[0] || '').trim()
  const entry = envVar('walnut_entry')
  const mode = envVar('walnut_mode') || 'quick'
  let chat = loadChat(p)

  // A re-run while an answer streams carries the question that started it (or nothing); anything
  // else typed is a new question, which goes ahead of the one still streaming.
  if (envVar('walnut_streaming') === '1' && chat) {
    const metaRaw = readText(p.meta)
    let streamingQuestion = ''
    try { streamingQuestion = metaRaw ? JSON.parse(metaRaw).question || '' : '' } catch (e) { streamingQuestion = '' }
    if (!typed || typed === streamingQuestion) return continueStream(p, chat)
  }

  // A new entry (the keyword, the hotkey with a selection, a fallback search) carries an id of its
  // own (walnut_entry_id); the follow-ups typed in this view carry the same one. A new entry starts
  // a new conversation unless the last one is the same kind and was used moments ago.
  const entryId = envVar('walnut_entry_id')
  if (!chat || (entryId && entryId !== chat.entryId)) {
    const recent = chat && chat.mode === mode && Date.now() - (chat.at || 0) < FRESH_AFTER_MS
      && entry !== 'selection' && envVar('walnut_entry_fresh') !== '1'
    if (!recent) {
      stopStream(p)
      chat = newChat(mode)
    }
    if (entry === 'selection') {
      chat.selection = envVar('walnut_selection') || ''
      chat.app = envVar('walnut_app') || ''
    }
    chat.entryId = entryId
    saveChat(p, chat)
  }
  if (!typed) return output(chat, render(chat))

  keepPartial(p, chat)
  stopStream(p)
  chat.messages.push({ role: 'user', text: typed })
  saveChat(p, chat)
  if (chat.mode === 'main') startMain(p, chat, typed)
  else startQuick(p, chat, typed)
  return output(chat, render(chat, chat.mode === 'main' ? '_The CEO is reading it…_' : '…'), { streaming: true })
}
