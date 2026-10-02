/*
 * Board runtime, part 5 of 5 (the sections): a small red "updated" dot on every
 * `[data-project]` section whose content changed since the user last saw it.
 * Same rules: plain ES2017, loaded as a string, runs only inside the board
 * frame. Being the last part, it takes the kit off window first: from here on
 * an author script cannot reach `request` (or post as the user).
 *
 * The frame hashes a section's text (its normalized textContent, without
 * Walnut's own controls, chips and threads: those have their own unread
 * rules); the host keeps the hash the user last saw per section (payload
 * `section_seen`, written by `wn-board:seen-section {id, hash}`). No record
 * yet: the current hash is recorded silently, so first sight shows no dot.
 * Seen: 2 s on screen by the thread rule (an open section), or the user opens
 * its <details>. Dotted sections count in <walnut-unread> (`kit.updatedSections`).
 */
(function (kit) {
  'use strict';
  try { delete window.__wnBoardKit; } catch (e) { window.__wnBoardKit = undefined; }
  if (!kit || kit.updatedSections) return;
  var state = kit.state;
  var SEEN_AFTER_MS = 2000;
  // Rendered by Walnut, not written by the author: never part of a section's text.
  var SKIP = 'walnut-thread, walnut-mark, walnut-strip, walnut-unread, walnut-task, walnut-project, [data-wn-ui], '
    + 'script, style, template, noscript';
  var HEADINGS = 'h1, h2, h3, h4, h5, h6';

  /** FNV-1a, twice with different seeds: 16 hex chars, a change detector (not a secret). */
  function fnv(s, seed) {
    var h = seed >>> 0;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return ('0000000' + h.toString(16)).slice(-8);
  }
  function hashOf(s) { return fnv(s, 2166136261) + fnv(s, 3735928559); }

  function textOf(el) {
    var out = [];
    (function walk(n) {
      for (var c = n.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) out.push(c.nodeValue);
        else if (c.nodeType === 1 && !c.matches(SKIP)) walk(c);
      }
    })(el);
    return out.join('').replace(/\s+/g, ' ').trim();
  }

  function storedHash(id) {
    var r = state.section_seen[id];
    if (typeof r === 'string') return r;
    return r && typeof r.hash === 'string' ? r.hash : null;
  }

  function record(id, hash) {
    state.section_seen[id] = { hash: hash, at: new Date().toISOString() };
    kit.send({ t: 'wn-board:seen-section', id: id, hash: hash });
  }

  /** The section's own first heading (inside its summary when it has one), else its summary; null = none. */
  function dotHost(sec) {
    function own(list) {
      for (var i = 0; i < list.length; i++) if (list[i].closest('[data-project]') === sec && !list[i].closest(SKIP)) return list[i];
      return null;
    }
    var summary = own(sec.querySelectorAll('summary'));
    if (summary) return own(summary.querySelectorAll(HEADINGS)) || summary;
    return own(sec.querySelectorAll(HEADINGS));
  }

  function paintDot(sec, on) {
    var dot = sec.wnDot;
    if (!on) {
      if (dot && dot.parentNode) dot.parentNode.removeChild(dot);
      if (sec.hasAttribute('data-updated')) sec.removeAttribute('data-updated');
      return;
    }
    if (!dot) {
      dot = document.createElement('span');
      dot.className = 'wn-updated';
      dot.setAttribute('data-wn-ui', '');
      dot.setAttribute('role', 'img');
      dot.setAttribute('aria-label', 'Updated since you last looked');
      dot.title = 'Updated since you last looked';
      sec.wnDot = dot;
    }
    var host = dotHost(sec) || sec;
    dot.classList.toggle('wn-corner', host === sec);
    if (host.firstChild !== dot) host.insertBefore(dot, host.firstChild);
    if (!sec.hasAttribute('data-updated')) sec.setAttribute('data-updated', '');
  }

  var observed = new Set();
  var io = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        var el = en.target;
        el.wnSectionVisible = en.isIntersecting
          && (en.intersectionRatio >= 0.5 || en.intersectionRect.height >= window.innerHeight * 0.5);
        if (el.wnSectionVisible) arm(el); else disarm(el);
      });
    }, { threshold: [0, 0.1, 0.25, 0.5, 0.75, 1] })
    : null;

  /** A closed <details> shows only its summary: that is not reading it. */
  function readable(el) { return !!el.wnSectionVisible && !document.hidden && (el.tagName !== 'DETAILS' || el.open); }
  function arm(el) {
    if (el.wnSeenTimer || !el.wnUpdated) return;
    el.wnSeenTimer = setTimeout(function () {
      el.wnSeenTimer = null;
      if (el.wnUpdated && readable(el)) seen(el);
    }, SEEN_AFTER_MS);
  }
  function disarm(el) { clearTimeout(el.wnSeenTimer); el.wnSeenTimer = null; }

  function seen(el) {
    if (!el.wnUpdated) return;
    el.wnUpdated = false;
    disarm(el);
    record(el.wnSectionId, el.wnSectionHash);
    paintDot(el, false);
    kit.renderAll(); // the unread total
  }

  // A project tagged on an overview row as well as its section: the dot is the section's.
  var ROW_TAGS = { TR: 1, TD: 1, TH: 1, LI: 1, SPAN: 1, A: 1 };
  /** One element per project id, in page order: the first that is not a row, else the first. */
  function sections() {
    var byId = {};
    var order = [];
    var all = document.querySelectorAll('[data-project]');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      var id = el.getAttribute('data-project') || '';
      if (!id || el.closest(SKIP)) continue;
      if (!byId[id]) { byId[id] = el; order.push(id); } else if (ROW_TAGS[byId[id].tagName] && !ROW_TAGS[el.tagName]) byId[id] = el;
    }
    return order.map(function (id) { return byId[id]; });
  }

  function scan() {
    if (!kit.flags.hasData) return;
    var all = sections();
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      var id = el.getAttribute('data-project') || '';
      var hash = hashOf(textOf(el));
      var stored = storedHash(id);
      if (stored === null) record(id, hash);
      el.wnSectionId = id;
      el.wnSectionHash = hash;
      el.wnUpdated = stored !== null && stored !== hash;
      paintDot(el, el.wnUpdated);
      if (!observed.has(el)) { observed.add(el); if (io) io.observe(el); }
      if (el.wnUpdated && el.wnSectionVisible) arm(el);
      if (!el.wnUpdated) disarm(el);
    }
    // Gone from the page, retagged, or no longer the one element of its project: forget it.
    observed.forEach(function (el) {
      if (el.isConnected && all.indexOf(el) >= 0) return;
      if (io) io.unobserve(el);
      disarm(el);
      el.wnUpdated = false;
      paintDot(el, false);
      observed.delete(el);
    });
  }

  // Opening a section's <details> is reading it (toggle does not bubble: capture).
  document.addEventListener('toggle', function (e) {
    var d = e.target;
    if (!d || d.tagName !== 'DETAILS' || !d.open) return;
    for (var sec = d.closest('[data-project]'); sec; sec = sec.parentElement ? sec.parentElement.closest('[data-project]') : null) {
      if (sec.wnUpdated) { seen(sec); return; }
    }
  }, true);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) observed.forEach(function (el) { if (el.wnSectionVisible) arm(el); });
  });

  kit.watchers.push(scan);
  kit.updatedSections = function () {
    var out = [];
    observed.forEach(function (el) { if (el.wnUpdated && el.isConnected) out.push(el); });
    return out;
  };
})(window.__wnBoardKit);
