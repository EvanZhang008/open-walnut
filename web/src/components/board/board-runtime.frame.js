/*
 * Board runtime, part 1 of 2 (the core): runs INSIDE the sandboxed board frame.
 * TaskBoardPane.tsx injects it, followed by board-elements.frame.js, at the top
 * of the frame's <head>. Plain ES2017, no imports: both files are loaded as
 * strings (`?raw`) and never run in the app's own document.
 *
 * The frame has an opaque origin (sandbox="allow-scripts", no allow-same-origin),
 * so everything goes through postMessage: the host posts `wn-board:data`
 * (refs, threads, marks, seen, drafts) and acks; the frame posts requests up.
 * This part owns the state, the bridge, links, scroll and the shared helpers,
 * and hands them to the elements as `window.__wnBoardKit`.
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

  var state = { boardTaskId: '', refs: {}, threads: {}, marks: {}, seen: {}, drafts: {} };
  var flags = { hasData: false, filter: '' };
  var live = new Set();
  var deferred = new Set();
  var acks = {};
  var counter = { n: 0 };

  var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  var URL_RE = /https?:\/\/[^\s<>"']+/g;
  var ACK_TIMEOUT_MS = 30000;

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

  /** Escaped text, http(s) URLs as links, newlines as <br>. */
  function richText(text) {
    var src = String(text || '');
    var out = '';
    var last = 0;
    var m;
    URL_RE.lastIndex = 0;
    while ((m = URL_RE.exec(src))) {
      var url = m[0].replace(/[.,;:!?)\]}]+$/, '');
      out += esc(src.slice(last, m.index)) + '<a class="wn-link" href="' + esc(url) + '">' + esc(url) + '</a>';
      last = m.index + url.length;
      URL_RE.lastIndex = last;
    }
    return (out + esc(src.slice(last))).replace(/\n/g, '<br>');
  }

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

  /** Show only sections of status `f` ('' = all). Only what this hid is unhidden. */
  function applyFilter(f) {
    flags.filter = f;
    topSections().forEach(function (s) {
      var hide = !!f && s.getAttribute('data-status') !== f;
      if (hide && !s.hidden) { s.hidden = true; s.setAttribute('data-wn-hidden', ''); }
      if (!hide && s.hasAttribute('data-wn-hidden')) { s.hidden = false; s.removeAttribute('data-wn-hidden'); }
      if (f && !hide && s.tagName === 'DETAILS') s.open = true;
    });
    renderAll();
  }

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

  window.__wnBoardKit = {
    state: state, flags: flags, live: live, Base: Base,
    send: send, request: request, trusted: trusted, nextId: nextId, esc: esc, richText: richText, hhmm: hhmm, when: when,
    parsePairs: parsePairs, whoOf: whoOf, unreadIn: unreadIn, markSeen: markSeen, addMessage: addMessage,
    renderAll: renderAll, setHtml: setHtml, openAncestors: openAncestors, topSections: topSections,
    threadEls: threadEls, applyFilter: applyFilter,
  };

  // ── Host messages ──
  window.addEventListener('message', function (e) {
    if (e.source !== window.parent) return;
    var d = e.data;
    if (!d || typeof d !== 'object') return;
    if (d.t === 'wn-board:data') {
      state.boardTaskId = String(d.boardTaskId || '');
      state.refs = d.refs || {};
      state.threads = d.threads || {};
      state.marks = d.marks || {};
      state.seen = d.seen || {};
      state.drafts = d.drafts || {};
      flags.hasData = true;
      renderAll();
    } else if (d.t === 'wn-board:ack') {
      var cb = acks[d.reqId];
      if (cb) cb(d);
    } else if (d.t === 'wn-board:scroll' && typeof d.y === 'number') {
      window.scrollTo(0, d.y);
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
  var recountTimer = null;
  function recount() {
    if (recountTimer) return;
    recountTimer = setTimeout(function () {
      recountTimer = null;
      live.forEach(function (el) { if (el.wnRecount) el.wnRender(); });
    }, 120);
  }

  function ready() {
    deferred.forEach(function (el) { deferred.delete(el); if (el.isConnected) el.connectedCallback(); });
    new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var t = records[i].target;
        // The components' own re-renders are not section changes (and would loop).
        if (t.nodeType !== 1 || !t.closest('walnut-strip, walnut-unread, walnut-task, walnut-thread, walnut-mark')) {
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
