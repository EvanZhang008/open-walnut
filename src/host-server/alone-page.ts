/**
 * The page a browser gets from a host server that can reach neither the Mac nor
 * the cloud companion (docs/plan/walnut-servers-everywhere.md, "Host server,
 * leader away").
 *
 * Without a device token it says why Walnut is away and names nothing. With the
 * token this browser signed in with (the same origin, so the same storage), it
 * lists this Walnut's sessions on this host, shows a conversation, sends a
 * message to a running session and answers its permission prompts, all through
 * /_alone/ (alone-api.ts). It asks /_alone/state every few seconds and opens
 * the full console again as soon as the Mac or the companion answers, unless
 * something typed here would be lost.
 *
 * One file, no build step, no dependency: the host server serves it as it is.
 * Every text goes in through textContent. The script and style run under a
 * per-response nonce.
 */

import { aloneMessage } from './pages.js'

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

export function aloneContentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'none'", `script-src 'nonce-${nonce}'`, `style-src 'nonce-${nonce}'`,
    "connect-src 'self'", "img-src 'self' data:", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
  ].join('; ')
}

const STYLE = `
  :root { color-scheme: light dark; --bg: #f6f5f2; --fg: #2b2a27; --muted: #6f6b63; --card: #fff; --line: #e4e1da; --accent: #5b6b3a; --warn: #9a5b00; --user: #e9efe0; }
  @media (prefers-color-scheme: dark) { :root { --bg: #1d1c1a; --fg: #e9e6df; --muted: #a29d93; --card: #272624; --line: #3a3835; --accent: #a9bf7a; --warn: #e0a548; --user: #2f3626; } }
  * { box-sizing: border-box; }
  body { font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; background: var(--bg); color: var(--fg); }
  main { max-width: 44rem; margin: 0 auto; padding: 1rem 1rem 6rem; }
  h1 { font-size: 1.2rem; margin: .5rem 0 .25rem; }
  p { margin: 0 0 .75rem; }
  .muted { color: var(--muted); font-size: .875rem; }
  .row { display: flex; gap: .5rem; align-items: center; }
  button { font: inherit; border: 1px solid var(--line); background: var(--card); color: var(--fg); border-radius: .5rem; padding: .45rem .9rem; cursor: pointer; }
  button.primary { background: var(--accent); border-color: var(--accent); color: var(--bg); }
  button:disabled { opacity: .5; cursor: default; }
  .list { display: grid; gap: .5rem; margin-top: 1rem; }
  .session { text-align: left; display: block; width: 100%; padding: .75rem; }
  .session .title { font-weight: 600; display: block; }
  .chip { display: inline-block; font-size: .75rem; padding: 0 .45rem; border-radius: 1rem; border: 1px solid var(--line); color: var(--muted); }
  .chip.needs { color: var(--warn); border-color: var(--warn); }
  .chip.working { color: var(--accent); border-color: var(--accent); }
  .msgs { display: grid; gap: .5rem; margin: 1rem 0; }
  .msg { padding: .5rem .75rem; border-radius: .6rem; background: var(--card); border: 1px solid var(--line); white-space: pre-wrap; overflow-wrap: anywhere; }
  .msg.user { background: var(--user); margin-left: 2.5rem; }
  .msg.tool { font-size: .8rem; color: var(--muted); background: transparent; border-style: dashed; }
  .prompt { border: 1px solid var(--warn); border-radius: .6rem; padding: .75rem; margin: 1rem 0; background: var(--card); }
  .prompt pre { white-space: pre-wrap; overflow-wrap: anywhere; font-size: .8rem; margin: .5rem 0; max-height: 12rem; overflow: auto; }
  .option.on { border-color: var(--accent); color: var(--accent); }
  .composer { position: fixed; left: 0; right: 0; bottom: 0; background: var(--bg); border-top: 1px solid var(--line); padding: .5rem; }
  .composer .inner { max-width: 44rem; margin: 0 auto; display: flex; gap: .5rem; align-items: flex-end; }
  textarea { flex: 1; font: inherit; min-height: 2.6rem; max-height: 10rem; padding: .5rem; border-radius: .5rem; border: 1px solid var(--line); background: var(--card); color: var(--fg); resize: vertical; }
  .error { color: var(--warn); font-size: .875rem; }
  .banner { border: 1px solid var(--accent); border-radius: .6rem; padding: .5rem .75rem; margin: .75rem 0; }
  [hidden] { display: none !important; }
`

/** The browser side. ES2017, no modules: phones on older Safari run it too. */
const SCRIPT = `
(function () {
  var TOKEN_KEY = 'walnut.deviceToken';
  var token = null;
  try { token = localStorage.getItem(TOKEN_KEY); } catch (e) { token = null; }
  var $ = function (id) { return document.getElementById(id); };
  var state = { route: 'alone', sessions: [], open: null, sending: false, choices: {} };
  var drafts = {};

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }

  function api(method, path, body) {
    var headers = { 'Accept': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    if (body) headers['Content-Type'] = 'application/json';
    return fetch('/_alone/' + path, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (json) {
          if (res.ok) return json;
          var err = new Error((json && json.error && json.error.message) || ('Walnut answered ' + res.status));
          err.status = res.status; err.code = json && json.error && json.error.code;
          throw err;
        });
      });
  }

  function typing() {
    var box = $('text');
    return (box && box.value.trim() !== '') || state.sending || Object.keys(state.choices).length > 0;
  }

  function checkRoute() {
    return api('GET', 'state').then(function (s) {
      state.route = s.route;
      $('why').hidden = s.route !== 'alone';
      if (s.route === 'alone') { $('back-banner').hidden = true; return; }
      // The Mac or the companion answers: the full console, unless that loses what was typed.
      if (!typing()) { location.reload(); return; }
      $('back-banner').hidden = false;
      $('send-error').textContent = '';
    }).catch(function () { /* the next check */ });
  }

  var LABEL = { needs: 'Needs you', working: 'Working', idle: 'Idle', stopped: 'Stopped' };
  function kindOf(s) { return s.prompt ? 'needs' : s.state; }

  function renderList() {
    var list = $('sessions');
    list.textContent = '';
    if (state.sessions.length === 0) {
      list.appendChild(el('p', 'muted', 'No sessions of yours are on this host right now.'));
      return;
    }
    state.sessions.forEach(function (s) {
      var b = el('button', 'session');
      b.setAttribute('data-sid', s.sid);
      b.appendChild(el('span', 'title', s.title || s.taskTitle || s.sid.slice(0, 8)));
      var line = el('span', 'row');
      var k = kindOf(s);
      line.appendChild(el('span', 'chip ' + k, LABEL[k] || k));
      if (s.taskTitle && s.taskTitle !== s.title) line.appendChild(el('span', 'muted', s.taskTitle));
      b.appendChild(line);
      b.onclick = function () { location.hash = 's=' + encodeURIComponent(s.sid); };
      list.appendChild(b);
    });
  }

  function loadSessions() {
    return api('GET', 'sessions').then(function (r) {
      var order = { needs: 0, working: 1, idle: 2, stopped: 3 };
      state.sessions = (r.sessions || []).slice().sort(function (a, b) {
        var d = (order[kindOf(a)] || 9) - (order[kindOf(b)] || 9);
        return d !== 0 ? d : String(b.lastActiveAt || '').localeCompare(String(a.lastActiveAt || ''));
      });
      $('list-error').textContent = '';
      if (!state.open) renderList();
      else renderOpen();
    }).catch(function (err) {
      $('list-error').textContent = err.message;
      if (err.status === 401) showSignedOut(err.message);
    });
  }

  function current() {
    for (var i = 0; i < state.sessions.length; i++) if (state.sessions[i].sid === state.open) return state.sessions[i];
    return null;
  }

  function inputText(input) {
    if (!input || typeof input !== 'object') return '';
    if (typeof input.command === 'string') return input.command;
    if (typeof input.file_path === 'string') return input.file_path;
    try { return JSON.stringify(input, null, 2).slice(0, 4000); } catch (e) { return ''; }
  }

  function answerPrompt(s, allow) {
    var body = { requestId: s.prompt.requestId, allow: allow };
    var picked = state.choices;
    if (allow && Object.keys(picked).length > 0) body.answers = picked;
    $('prompt-error').textContent = '';
    return api('POST', 'sessions/' + encodeURIComponent(s.sid) + '/permission', body).then(function () {
      state.choices = {};
      return loadSessions().then(loadTranscript);
    }).catch(function (err) { $('prompt-error').textContent = err.message; });
  }

  function renderPrompt(s) {
    var box = $('prompt');
    box.textContent = '';
    if (!s || !s.prompt) { box.hidden = true; return; }
    box.hidden = false;
    var p = s.prompt;
    var questions = p.toolName === 'AskUserQuestion' && p.input && Array.isArray(p.input.questions) ? p.input.questions : null;
    if (questions) {
      box.appendChild(el('strong', '', 'The session asks you'));
      questions.forEach(function (q) {
        var text = String(q.question || '');
        box.appendChild(el('p', '', text));
        var row = el('div', 'row');
        (Array.isArray(q.options) ? q.options : []).forEach(function (o) {
          var label = String(o && o.label !== undefined ? o.label : o);
          var b = el('button', 'option' + (state.choices[text] === label ? ' on' : ''), label);
          b.onclick = function () { state.choices[text] = label; renderPrompt(s); };
          row.appendChild(b);
        });
        box.appendChild(row);
      });
    } else {
      box.appendChild(el('strong', '', (p.toolName || 'A tool') + ' needs your permission'));
      if (p.reason) box.appendChild(el('p', 'muted', p.reason));
      var detail = inputText(p.input);
      if (detail) box.appendChild(el('pre', '', detail));
    }
    var actions = el('div', 'row');
    var allow = el('button', 'primary', questions ? 'Answer' : 'Allow');
    allow.setAttribute('data-action', 'allow');
    allow.disabled = !!questions && questions.some(function (q) { return !state.choices[String(q.question || '')]; });
    allow.onclick = function () { answerPrompt(s, true); };
    var deny = el('button', '', 'Deny');
    deny.setAttribute('data-action', 'deny');
    deny.onclick = function () { answerPrompt(s, false); };
    actions.appendChild(allow); actions.appendChild(deny);
    box.appendChild(actions);
    box.appendChild(el('p', 'error', '')).id = 'prompt-error';
  }

  function renderOpen() {
    var s = current();
    $('open-title').textContent = s ? (s.title || s.taskTitle || s.sid.slice(0, 8)) : 'Session';
    var k = s ? kindOf(s) : 'stopped';
    $('open-state').textContent = LABEL[k] || k;
    $('open-state').className = 'chip ' + k;
    renderPrompt(s);
    var live = !!s && s.state !== 'stopped';
    $('text').disabled = !live || state.sending;
    $('send').disabled = !live || state.sending;
    $('stopped-note').hidden = live;
  }

  function renderTranscript(messages) {
    var box = $('messages');
    var atBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 80;
    box.textContent = '';
    messages.forEach(function (m) {
      if (m.kind === 'thinking') return;
      if (m.kind === 'tool') { box.appendChild(el('div', 'msg tool', m.text + (m.detail ? ' \\u00b7 ' + m.detail : ''))); return; }
      box.appendChild(el('div', 'msg ' + (m.role === 'user' ? 'user' : 'assistant'), m.text));
    });
    if (atBottom) window.scrollTo(0, document.body.scrollHeight);
  }

  function loadTranscript() {
    if (!state.open) return Promise.resolve();
    var sid = state.open;
    return api('GET', 'sessions/' + encodeURIComponent(sid) + '/transcript').then(function (t) {
      if (state.open === sid) renderTranscript(t.messages || []);
    }).catch(function (err) { if (state.open === sid) $('send-error').textContent = err.message; });
  }

  function send() {
    var s = current();
    var box = $('text');
    var text = box.value.trim();
    if (!s || !text || state.sending) return;
    state.sending = true;
    $('send-error').textContent = '';
    var id = drafts[s.sid] && drafts[s.sid].text === text ? drafts[s.sid].id : ('qm-alone-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10));
    drafts[s.sid] = { text: text, id: id };
    renderOpen();
    api('POST', 'sessions/' + encodeURIComponent(s.sid) + '/messages', { text: text, messageId: id }).then(function () {
      if (box.value.trim() === text) box.value = '';
      delete drafts[s.sid];
      return loadTranscript();
    }).catch(function (err) {
      $('send-error').textContent = err.message;
    }).then(function () { state.sending = false; renderOpen(); });
  }

  function showSignedOut(message) {
    $('signed-out').hidden = false;
    if (message) $('signed-out-why').textContent = message;
    $('list-view').hidden = true;
    $('open-view').hidden = true;
  }

  function route() {
    var m = /^#s=(.+)$/.exec(location.hash);
    state.open = m ? decodeURIComponent(m[1]) : null;
    state.choices = {};
    $('list-view').hidden = !!state.open;
    $('open-view').hidden = !state.open;
    $('composer').hidden = !state.open;
    $('send-error').textContent = '';
    $('messages').textContent = '';
    if (state.open) { renderOpen(); loadTranscript(); } else { renderList(); }
  }

  if (!token) { showSignedOut(''); setInterval(checkRoute, 5000); return; }
  $('send').onclick = send;
  $('text').onkeydown = function (e) { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } };
  $('back').onclick = function () { location.hash = ''; };
  $('reload').onclick = function () { location.reload(); };
  window.addEventListener('hashchange', route);
  route();
  loadSessions();
  setInterval(checkRoute, 5000);
  setInterval(function () {
    // Back with the Mac or the companion: nothing more to read here (the banner says so).
    if (state.route !== 'alone') return;
    loadSessions().then(function () { if (state.open && !state.sending) return loadTranscript(); });
  }, 4000);
})();
`

export function alonePage(label: string, why: string, nonce: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Walnut on ${escape(label)}</title>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body>
<main data-testid="host-server-alone" data-why="${escape(why)}">
  <h1>Walnut on ${escape(label)}</h1>
  <p id="why" class="muted">${escape(aloneMessage(label, why))}</p>
  <div id="back-banner" class="banner row" hidden><span>Walnut answers again. What you wrote here stays until you open it.</span><button id="reload" class="primary">Open Walnut</button></div>
  <section id="signed-out" hidden>
    <p>This browser is not signed in to Walnut here, so this page shows nothing more.</p>
    <p class="muted" id="signed-out-why">Sign this browser in while your Mac answers (Settings, Phones &amp; Cloud), and this page will list your sessions on this host the next time it is away.</p>
  </section>
  <section id="list-view">
    <p>Your sessions on ${escape(label)}. You can read them, write to a running one, and answer what it asks.</p>
    <p id="list-error" class="error"></p>
    <div id="sessions" class="list"></div>
  </section>
  <section id="open-view" hidden>
    <div class="row"><button id="back">Back</button><span id="open-state" class="chip"></span></div>
    <h1 id="open-title"></h1>
    <div id="messages" class="msgs"></div>
    <div id="prompt" class="prompt" hidden></div>
    <p id="stopped-note" class="muted" hidden>This session is not running. Your Mac can resume it when it answers again.</p>
  </section>
</main>
<div id="composer" class="composer" hidden>
  <div class="inner">
    <textarea id="text" rows="2" placeholder="Message this session" aria-label="Message"></textarea>
    <button id="send" class="primary">Send</button>
  </div>
  <div class="inner"><span id="send-error" class="error"></span></div>
</div>
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>
`
}
