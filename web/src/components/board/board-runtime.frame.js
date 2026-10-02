/*
 * Board runtime, part 1 of 5 (the core): runs INSIDE the sandboxed board frame.
 * TaskBoardPane.tsx injects it, followed by board-markdown.frame.js (the message
 * renderer, `kit.richText`), board-elements.frame.js, board-items.frame.js and
 * board-sections.frame.js, at the top of the frame's <head>. Plain ES2017, no
 * imports: all five are loaded as strings (`?raw`) and never run in the app's
 * own document.
 *
 * The frame has an opaque origin (sandbox="allow-scripts", no allow-same-origin),
 * so everything goes through postMessage: the host posts `wn-board:data` (refs,
 * threads, marks, seen, projects, checks, choices, reminders,
 * section_seen, composing) and acks; the frame posts requests up. This part owns the state,
 * the bridge, links, scroll, the project statuses and the shared helpers, and
 * hands them to the other parts as `window.__wnBoardKit` (the last part takes it
 * off window before any author script runs).
 */
(function () {
  'use strict';
  if (window.__wnBoardKit) return;

  // The host accepts a frame message only with this nonce. It lives in this
  // closure alone: the host inlines it here, the <script> element is removed
  // before any author script runs, and postMessage is bound now, so a script the
  // board's author wrote cannot speak to the host as the user (post a thread
  // message, set a mark). Author code may still render, style and filter freely.
  var NONCE = '__WN_BOARD_NONCE__';
  var post = window.parent.postMessage.bind(window.parent);
  if (document.currentScript) document.currentScript.remove();

  var state = {
    boardTaskId: '', refs: {}, threads: {}, marks: {}, seen: {},
    projects: {}, checks: {}, choices: {}, reminders: {}, section_seen: {},
  };
  // composing: the thread the host's docked composer replies in ('' = none).
  var flags = { hasData: false, filter: '', composing: '' };
  // Other host messages (the docked composer's sending / sent / send-failed), by type.
  var onHost = {};
  var live = new Set();
  var deferred = new Set();
  var acks = {};
  var counter = { n: 0 };

  var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  var ACK_TIMEOUT_MS = 30000;
  // A section's status words, shared by <walnut-strip> and <walnut-project>.
  var DEFAULT_LABELS = 'decide:Needs you,wip:In progress,wait:Waiting on others,done:Done';
  // setTimeout's own ceiling is ~24.8 days; a farther reminder is re-armed on the way.
  var MAX_TIMER_MS = 6 * 3600 * 1000;

  function send(msg) { msg.nonce = NONCE; post(msg, '*'); }
  /** A real user gesture, never a synthetic event an author script dispatched. */
  function trusted(e) { return !!(e && e.isTrusted); }
  function nextId() { counter.n += 1; return counter.n; }

  /** One request, one answer: `cb` runs exactly once, with the ack or a timeout. */
  function request(msg, cb) {
    var reqId = 'wn' + nextId() + '-' + Date.now().toString(36);
    var done = false;
    var timer = setTimeout(function () { finish({ ok: false, error: 'Walnut did not answer. Try again.' }); }, ACK_TIMEOUT_MS);
    function finish(ack) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      delete acks[reqId];
      cb(ack);
    }
    acks[reqId] = finish;
    msg.reqId = reqId;
    send(msg);
  }

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ESC[c]; }); }

  function pad(n) { return n < 10 ? '0' + n : String(n); }
  function hhmm(d) { return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  /** HH:MM today, with the date on any other day. */
  function when(ts) {
    var d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    var now = new Date();
    if (d.toDateString() === now.toDateString()) return hhmm(d);
    var day = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return day + (d.getFullYear() !== now.getFullYear() ? ' ' + d.getFullYear() : '') + ' ' + hhmm(d);
  }

  /** "key:Label,key:Label" → [{ key, label }]; an empty or broken list falls back. */
  function parsePairs(attr, fallback) {
    var out = [];
    String(attr || fallback).split(',').forEach(function (part) {
      var i = part.indexOf(':');
      var key = (i < 0 ? part : part.slice(0, i)).trim();
      var label = (i < 0 ? part : part.slice(i + 1)).trim();
      if (key) out.push({ key: key, label: label || key });
    });
    return out.length || attr === fallback ? out : parsePairs(fallback, fallback);
  }

  function whoOf(author) {
    if (author === 'user') return 'You';
    var id = String(author || '').indexOf('task:') === 0 ? author.slice(5) : '';
    if (id && id === state.boardTaskId) return 'Leader';
    var ref = id ? state.refs[id] : null;
    return ref && ref.title ? ref.title : 'Agent';
  }

  /** Messages in a thread this browser has not read (never the user's own). */
  function unreadIn(id) {
    var list = state.threads[id] || [];
    var seen = state.seen[id] || '';
    var n = 0;
    for (var i = 0; i < list.length; i++) if (list[i].author !== 'user' && list[i].ts > seen) n++;
    return n;
  }

  function newestTs(id) {
    var list = state.threads[id] || [];
    var ts = '';
    for (var i = 0; i < list.length; i++) if (list[i].ts > ts) ts = list[i].ts;
    return ts;
  }

  function renderAll() { live.forEach(function (el) { el.wnRender(); }); }

  /** Read up to the newest message: optimistic here, remembered by the host. */
  function markSeen(id) {
    var ts = newestTs(id);
    if (!id || !ts || (state.seen[id] || '') >= ts) return;
    state.seen[id] = ts;
    send({ t: 'wn-board:seen', thread: id, ts: ts });
    renderAll();
  }

  function addMessage(thread, message) {
    var list = state.threads[thread] || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === message.id) return;
    state.threads[thread] = list.concat([message]);
  }

  function removeMessage(thread, id) {
    var list = state.threads[thread];
    if (!list) return;
    var rest = list.filter(function (m) { return m.id !== id; });
    if (rest.length) state.threads[thread] = rest; else delete state.threads[thread];
  }

  /** innerHTML only when it changed: an unchanged re-render keeps focus and selection. */
  function setHtml(el, html) {
    if (el.wnHtml === html) return;
    el.wnHtml = html;
    el.innerHTML = html;
  }

  function openAncestors(el) {
    for (var p = el.parentElement; p; p = p.parentElement) if (p.tagName === 'DETAILS') p.open = true;
  }

  /** Sections the strip counts: `[data-status]` elements not inside another one. */
  function topSections() {
    var all = document.querySelectorAll('[data-status]');
    var out = [];
    for (var i = 0; i < all.length; i++) {
      var parent = all[i].parentElement;
      if (!parent || !parent.closest('[data-status]')) out.push(all[i]);
    }
    return out;
  }

  function choiceAnswered(id) { var c = id ? state.choices[id] : null; return !!(c && c.option); }
  /**
   * A section's status for counting and filtering. One that "needs you" only
   * for choices the user has answered (`data-choice="id"` on it, or every
   * <walnut-choice> inside) no longer does: it counts as 'answered' until the
   * leader moves it on.
   */
  function sectionStatus(s) {
    var status = s.getAttribute('data-status') || '';
    if (status !== 'decide') return status;
    if (s.hasAttribute('data-choice') && choiceAnswered(s.getAttribute('data-choice'))) return 'answered';
    var choices = s.querySelectorAll('walnut-choice[id]');
    if (!choices.length) return status;
    for (var i = 0; i < choices.length; i++) if (!choiceAnswered(choices[i].getAttribute('id'))) return status;
    return 'answered';
  }

  /**
   * The statuses <walnut-strip> counts: a project ONCE however many elements
   * carry its `data-project` (a section and an overview row), answered when any
   * of them is; every other top-level `[data-status]` section as itself.
   */
  function countedStatuses() {
    var out = [];
    var at = {};
    topSections().forEach(function (s) {
      var id = s.getAttribute('data-project') || '';
      var status = sectionStatus(s);
      if (!id) { out.push(status); return; }
      if (!Object.prototype.hasOwnProperty.call(at, id)) { at[id] = out.length; out.push(status); return; }
      if (status === 'answered') out[at[id]] = 'answered';
    });
    return out;
  }

  /** The page's threads, one per id. */
  function threadEls() {
    var seenIds = {};
    var out = [];
    var all = document.querySelectorAll('walnut-thread');
    for (var i = 0; i < all.length; i++) {
      var id = all[i].getAttribute('id') || '';
      if (id && !seenIds[id]) { seenIds[id] = true; out.push(all[i]); }
    }
    return out;
  }

  function cssId(id) { return window.CSS && CSS.escape ? CSS.escape(id) : String(id).replace(/["\\]/g, '\\$&'); }

  /**
   * Walnut's project status onto every `[data-project]` element, so the
   * strip, the filter and the board's own CSS follow it. The author's value is
   * kept aside and comes back when Walnut has no status for that project.
   */
  function applyProjects() {
    var all = document.querySelectorAll('[data-project]');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      var cat = state.projects[el.getAttribute('data-project') || ''];
      var status = cat && typeof cat.status === 'string' ? cat.status : '';
      if (status) {
        if (!el.hasAttribute('data-wn-author-status')) el.setAttribute('data-wn-author-status', el.getAttribute('data-status') || '');
        if (el.getAttribute('data-status') !== status) el.setAttribute('data-status', status);
      } else if (el.hasAttribute('data-wn-author-status')) {
        var authored = el.getAttribute('data-wn-author-status');
        el.removeAttribute('data-wn-author-status');
        if (authored) el.setAttribute('data-status', authored); else el.removeAttribute('data-status');
      }
    }
  }

  /** A project's status: Walnut's, else the author's on its section. */
  function projectStatus(id) {
    var cat = state.projects[id];
    if (cat && cat.status) return String(cat.status);
    var section = id ? document.querySelector('[data-project="' + cssId(id) + '"]') : null;
    return section ? section.getAttribute('data-wn-author-status') || section.getAttribute('data-status') || '' : '';
  }

  // ── Reminders (on a <walnut-choice> or a <walnut-thread>) ──

  function reminderOf(target) {
    var r = target ? state.reminders[target] : null;
    return r && typeof r.at === 'string' ? r : null;
  }
  /** Due: Walnut already told the leader, or its time has come (board-items-model.ts reminderDue). */
  function reminderDue(r) {
    if (!r) return false;
    if (r.fired_at) return true;
    var at = Date.parse(r.at);
    return !isNaN(at) && at <= Date.now();
  }
  /** The page's choices and threads, one per id, in document order. */
  function reminderTargets() {
    var seenIds = {};
    var out = [];
    var all = document.querySelectorAll('walnut-choice[id], walnut-thread[id]');
    for (var i = 0; i < all.length; i++) {
      var id = all[i].getAttribute('id') || '';
      if (id && !seenIds[id]) { seenIds[id] = true; out.push(all[i]); }
    }
    return out;
  }
  function dueTargets() {
    return reminderTargets().filter(function (el) { return reminderDue(reminderOf(el.getAttribute('id'))); });
  }
  /** One timer for the nearest pending reminder: the page turns it "due" on time, server or not. */
  var dueTimer = null;
  function scheduleDue() {
    clearTimeout(dueTimer);
    dueTimer = null;
    var next = Infinity;
    Object.keys(state.reminders).forEach(function (k) {
      var r = state.reminders[k];
      if (!r || r.fired_at) return;
      var at = Date.parse(r.at);
      if (!isNaN(at) && at > Date.now() && at < next) next = at;
    });
    if (next === Infinity) return;
    dueTimer = setTimeout(function () { dueTimer = null; renderAll(); scheduleDue(); },
      Math.min(MAX_TIMER_MS, Math.max(0, next - Date.now()) + 50));
  }

  /** Show only sections of status `f` ('' = all). Only what this hid is unhidden. */
  function applyFilter(f, refresh) {
    flags.filter = f;
    topSections().forEach(function (s) {
      var hide = !!f && sectionStatus(s) !== f;
      if (hide && !s.hidden) { s.hidden = true; s.setAttribute('data-wn-hidden', ''); }
      if (!hide && s.hasAttribute('data-wn-hidden')) { s.hidden = false; s.removeAttribute('data-wn-hidden'); }
      // A user's pick opens what it shows; a refresh (new data) leaves open and closed alone.
      if (f && !hide && !refresh && s.tagName === 'DETAILS') s.open = true;
    });
    renderAll();
  }

  // Page-level passes (board-sections.frame.js: the "updated" dots) that run on
  // new data and when the page's sections change, before the elements render.
  var watchers = [];
  function runWatchers() { watchers.forEach(function (w) { w(); }); }

  /** Shared lifecycle: a component connected while the document still parses
   *  sets up at DOMContentLoaded, once its parsed children are in place. */
  class Base extends HTMLElement {
    connectedCallback() {
      if (document.readyState === 'loading') { deferred.add(this); return; }
      live.add(this);
      if (!this.wnSetUp) { this.wnSetUp = true; this.wnSetup(); }
      this.wnAttach();
      this.wnRender();
    }
    disconnectedCallback() { live.delete(this); deferred.delete(this); this.wnDetach(); }
    wnSetup() {}
    wnAttach() {}
    wnDetach() {}
    wnRender() {}
  }

  // `richText` (the message renderer) is added by board-markdown.frame.js, `Remind` by board-items.frame.js.
  window.__wnBoardKit = {
    state: state, flags: flags, live: live, Base: Base, DEFAULT_LABELS: DEFAULT_LABELS,
    send: send, request: request, trusted: trusted, nextId: nextId, esc: esc, hhmm: hhmm, when: when,
    parsePairs: parsePairs, whoOf: whoOf, unreadIn: unreadIn, markSeen: markSeen, addMessage: addMessage,
    removeMessage: removeMessage, renderAll: renderAll, setHtml: setHtml, openAncestors: openAncestors, topSections: topSections,
    threadEls: threadEls, applyFilter: applyFilter, projectStatus: projectStatus, sectionStatus: sectionStatus,
    countedStatuses: countedStatuses,
    choiceAnswered: choiceAnswered, cssId: cssId, watchers: watchers, onHost: onHost,
    reminderOf: reminderOf, reminderDue: reminderDue, reminderTargets: reminderTargets, dueTargets: dueTargets,
    scheduleDue: scheduleDue,
  };

  function obj(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; }

  // ── Host messages ──
  window.addEventListener('message', function (e) {
    if (e.source !== window.parent) return;
    var d = e.data;
    if (!d || typeof d !== 'object') return;
    if (d.t === 'wn-board:data') {
      state.boardTaskId = String(d.boardTaskId || '');
      state.refs = obj(d.refs);
      state.threads = obj(d.threads);
      state.marks = obj(d.marks);
      state.seen = obj(d.seen);
      state.projects = obj(d.projects);
      state.checks = obj(d.checks);
      state.choices = obj(d.choices);
      state.reminders = obj(d.reminders);
      state.section_seen = obj(d.section_seen);
      flags.composing = typeof d.composing === 'string' ? d.composing : '';
      flags.hasData = true;
      applyProjects();
      scheduleDue();
      // A section that changed status under an active filter follows it (applyFilter renders all).
      runWatchers();
      if (flags.filter) applyFilter(flags.filter, true); else renderAll();
    } else if (d.t === 'wn-board:ack') {
      var cb = acks[d.reqId];
      if (cb) cb(d);
    } else if (d.t === 'wn-board:scroll' && typeof d.y === 'number') {
      window.scrollTo(0, d.y);
    } else if (typeof d.t === 'string' && Object.prototype.hasOwnProperty.call(onHost, d.t)) {
      onHost[d.t](d);
    }
  });

  // ── Links: a sandboxed frame cannot open a tab, and a same-page `#` link in a
  // srcdoc document would navigate the frame to the app's own URL. ──
  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0) return;
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    var href = a.getAttribute('href') || '';
    e.preventDefault();
    if (href.charAt(0) === '#') {
      var id = href.slice(1);
      try { id = decodeURIComponent(id); } catch (err) { /* keep the raw id */ }
      var target = id ? (document.getElementById(id) || document.getElementsByName(id)[0]) : null;
      if (target) { openAncestors(target); target.scrollIntoView(); } else if (!id) window.scrollTo(0, 0);
      return;
    }
    if (/^https?:\/\//i.test(href)) send({ t: 'wn-board:open-link', href: href });
  });

  // ── Scroll position, so a re-rendered board opens where the user was ──
  var lastScroll = 0;
  var scrollTimer = null;
  function postScroll() { lastScroll = Date.now(); send({ t: 'wn-board:scroll', y: window.scrollY }); }
  window.addEventListener('scroll', function () {
    var since = Date.now() - lastScroll;
    if (since >= 250) { postScroll(); return; }
    if (!scrollTimer) scrollTimer = setTimeout(function () { scrollTimer = null; postScroll(); }, 250 - since);
  }, { passive: true });

  // ── Recount the strip and the unread total when sections change ──
  var COMPONENTS = 'walnut-strip, walnut-unread, walnut-task, walnut-thread, walnut-mark, walnut-project, walnut-check, walnut-choice';
  var recountTimer = null;
  function recount() {
    if (recountTimer) return;
    recountTimer = setTimeout(function () {
      recountTimer = null;
      if (flags.hasData) runWatchers();
      live.forEach(function (el) { if (el.wnRecount) el.wnRender(); });
    }, 120);
  }

  function ready() {
    deferred.forEach(function (el) { deferred.delete(el); if (el.isConnected) el.connectedCallback(); });
    new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var t = records[i].target;
        // The components' own re-renders are not section changes (and would loop).
        if (t.nodeType !== 1 || !t.closest(COMPONENTS)) {
          recount();
          return;
        }
      }
    }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-status'] });
    send({ t: 'wn-board:ready' });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready);
  else setTimeout(ready, 0);
})();
