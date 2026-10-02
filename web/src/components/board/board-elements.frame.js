/*
 * Board runtime, part 2 of 2 (the elements): the five walnut-* custom elements,
 * built on the core in board-runtime.frame.js (`window.__wnBoardKit`). Same
 * rules: plain ES2017, loaded as a string, runs only inside the board frame.
 *
 * Every element renders into its own light DOM (no shadow DOM, so the board's
 * CSS can restyle it) and re-renders from the kit's state on every data
 * message, keeping a typed draft, the focus and an opened <details>.
 */
(function (kit) {
  'use strict';
  // The kit is ours alone from here on: an author script must not reach `request`.
  try { delete window.__wnBoardKit; } catch (e) { window.__wnBoardKit = undefined; }
  if (!kit || customElements.get('walnut-task')) return;
  var trusted = kit.trusted;
  var state = kit.state;
  var esc = kit.esc;

  var PHASES = { TODO: 'To do', IN_PROGRESS: 'In progress', NEED_ACTION: 'Needs you', WAITING: 'Waiting', COMPLETE: 'Done' };
  var DEFAULT_STATES = 'revisit:Revisit,reviewed:Reviewed,waiting:Waiting on others';
  var DEFAULT_LABELS = 'decide:Needs you,wip:In progress,wait:Waiting on others,done:Done';

  // ── <walnut-task id compact?>: a live chip; click or Enter goes to the task ──
  class WalnutTask extends kit.Base {
    static get observedAttributes() { return ['id', 'compact']; }
    attributeChangedCallback() { if (kit.live.has(this)) this.wnRender(); }
    wnSetup() {
      var self = this;
      this.addEventListener('click', function (e) { e.preventDefault(); if (trusted(e)) self.wnOpen(); });
      this.addEventListener('keydown', function (e) {
        if (trusted(e) && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); self.wnOpen(); }
      });
    }
    wnOpen() {
      var id = this.getAttribute('id') || '';
      var ref = state.refs[id];
      if (id) kit.send({ t: 'wn-board:open-task', id: ref ? ref.id : id });
    }
    wnRender() {
      var id = this.getAttribute('id') || '';
      var ref = state.refs[id];
      var phase = ref ? ref.phase : '';
      var title = ref ? ref.title : id;
      var label = this.hasAttribute('compact') || !ref ? '' : '<span class="wn-phase">' + esc(PHASES[phase] || phase) + '</span>';
      kit.setHtml(this, '<span class="wn-task' + (!ref && kit.flags.hasData ? ' wn-unknown' : '') + '" data-phase="' + esc(phase)
        + '" role="link" tabindex="0" title="' + esc(title) + '"><span class="wn-dot"></span><span class="wn-title">'
        + esc(title) + '</span>' + label + '</span>');
    }
  }

  // ── <walnut-thread id title? task?>: composer, newest-first messages, unread ──
  var io = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        var el = en.target;
        // Half of it on screen, or (a thread taller than two screens) half the screen.
        el.wnVisible = en.isIntersecting
          && (en.intersectionRatio >= 0.5 || en.intersectionRect.height >= window.innerHeight * 0.5);
        if (el.wnVisible) el.wnArm(); else el.wnDisarm();
      });
    }, { threshold: [0, 0.1, 0.25, 0.5, 0.75, 1] })
    : null;

  class WalnutThread extends kit.Base {
    static get observedAttributes() { return ['title']; }
    attributeChangedCallback(name, oldValue, value) {
      // The title moves to data-title so the browser does not tooltip the whole thread.
      if (name === 'title' && value !== null) {
        this.setAttribute('data-title', value);
        this.removeAttribute('title');
      }
      if (kit.live.has(this)) this.wnRender();
    }
    get wnId() { return this.getAttribute('id') || ''; }
    wnSetup() {
      var self = this;
      this.wnLocal = [];
      this.classList.add('wn-thread');
      this.innerHTML = '<div class="wn-thread-head"><span class="wn-thread-title"></span>'
        + '<span class="wn-badge" hidden></span><a class="wn-mark-read" href="#" role="button" hidden>Mark read</a></div>'
        + '<div class="wn-composer"><textarea class="wn-input" rows="2" placeholder="Ask or note here. It goes to the leader."></textarea>'
        + '<button type="button" class="wn-send">Send</button></div><div class="wn-msgs"></div>';
      this.wnInput = this.querySelector('.wn-input');
      this.wnList = this.querySelector('.wn-msgs');
      // Every write to Walnut starts from a trusted event: a synthetic one an
      // author script dispatched cannot post as the user or move a mark.
      this.wnInput.addEventListener('keydown', function (e) {
        if (trusted(e) && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); self.wnSubmit(); }
      });
      this.wnInput.addEventListener('input', function (e) {
        if (!trusted(e)) return;
        clearTimeout(self.wnDraftTimer);
        self.wnDraftTimer = setTimeout(function () { self.wnDraft(self.wnInput.value); }, 300);
      });
      this.wnInput.addEventListener('focus', function (e) { if (trusted(e)) kit.markSeen(self.wnId); });
      this.querySelector('.wn-send').addEventListener('click', function (e) { if (trusted(e)) self.wnSubmit(); });
      this.querySelector('.wn-mark-read').addEventListener('click', function (e) { e.preventDefault(); if (trusted(e)) kit.markSeen(self.wnId); });
    }
    wnAttach() { if (io) io.observe(this); }
    wnDetach() { if (io) io.unobserve(this); this.wnDisarm(); }
    /** Visible for 1.5 s with something unread: it has been read. */
    wnArm() {
      var self = this;
      if (this.wnTimer || kit.unreadIn(this.wnId) === 0) return;
      this.wnTimer = setTimeout(function () {
        self.wnTimer = null;
        if (self.wnVisible && !document.hidden) kit.markSeen(self.wnId);
      }, 1500);
    }
    wnDisarm() { clearTimeout(this.wnTimer); this.wnTimer = null; }
    /** The host keeps the draft, so a re-rendered board gives it back. */
    wnDraft(text) {
      clearTimeout(this.wnDraftTimer);
      kit.send({ t: 'wn-board:draft', thread: this.wnId, text: text });
    }
    wnSubmit() {
      var self = this;
      var text = this.wnInput.value.trim();
      if (!text || !this.wnId) return;
      var local = { key: 'local-' + kit.nextId(), text: text, ts: new Date().toISOString(), status: 'pending' };
      // A new send retires the rows of earlier failures (their text came back to the composer).
      this.wnLocal = this.wnLocal.filter(function (l) { return l.status !== 'failed'; }).concat([local]);
      this.wnInput.value = '';
      this.wnDraft('');
      this.wnRender();
      kit.request({ t: 'wn-board:post', thread: this.wnId, text: text }, function (ack) {
        if (ack.ok && ack.message) {
          self.wnLocal = self.wnLocal.filter(function (l) { return l !== local; });
          kit.addMessage(self.wnId, ack.message);
        } else {
          local.status = 'failed';
          local.error = ack.error || 'Not sent';
          if (!self.wnInput.value.trim()) { self.wnInput.value = text; self.wnDraft(text); }
        }
        kit.renderAll();
      });
    }
    wnRow(m, cls, extra) {
      var unread = !cls && m.author !== 'user' && m.ts > (state.seen[this.wnId] || '');
      return '<div class="wn-msg' + (cls ? ' ' + cls : '') + '" data-ts="' + esc(m.ts) + '" data-author="' + esc(m.author) + '"'
        + (unread ? ' data-unread=""' : '') + '><div class="wn-msg-meta"><span class="wn-who">' + esc(kit.whoOf(m.author))
        + '</span><span class="wn-when">' + esc(kit.when(m.ts)) + '</span>' + (extra || '') + '</div><div class="wn-text">'
        + kit.richText(m.text) + '</div></div>';
    }
    wnRender() {
      var self = this;
      var id = this.wnId;
      var n = kit.unreadIn(id);
      var title = this.querySelector('.wn-thread-title');
      var heading = this.getAttribute('data-title') || this.getAttribute('title') || id;
      if (title.textContent !== heading) title.textContent = heading;
      var badge = this.querySelector('.wn-badge');
      badge.hidden = n === 0;
      badge.textContent = n ? n + ' new' : '';
      this.querySelector('.wn-mark-read').hidden = n === 0;
      // A draft the host kept across a re-render of the board html comes back once.
      if (kit.flags.hasData && !this.wnDraftDone) {
        this.wnDraftDone = true;
        var draft = state.drafts && state.drafts[id];
        if (draft && !this.wnInput.value && document.activeElement !== this.wnInput) this.wnInput.value = draft;
      }
      var rows = (state.threads[id] || []).map(function (m, i) { return { ts: m.ts, i: i, html: self.wnRow(m) }; });
      var base = rows.length;
      this.wnLocal.forEach(function (l, i) {
        var failed = l.status === 'failed';
        rows.push({
          ts: l.ts, i: base + i,
          html: self.wnRow({ author: 'user', ts: l.ts, text: l.text }, failed ? 'wn-failed' : 'wn-pending',
            failed ? '<span class="wn-error">' + esc(l.error) + '</span>' : ''),
        });
      });
      // Newest first; equal times keep their append order, reversed.
      rows.sort(function (a, b) { return a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : b.i - a.i; });
      kit.setHtml(this.wnList, rows.map(function (r) { return r.html; }).join(''));
      if (n > 0 && this.wnVisible) this.wnArm();
    }
  }

  // ── <walnut-mark id states?>: the user's own mark and note, saved in Walnut ──
  class WalnutMark extends kit.Base {
    get wnId() { return this.getAttribute('id') || ''; }
    wnSetup() {
      var self = this;
      // Buttons, not a <select>: one click sets a state, and every change comes
      // from a trusted click or keystroke (a synthetic `change` has no path here).
      this.wnStates = kit.parsePairs(this.getAttribute('states'), DEFAULT_STATES);
      this.classList.add('wn-mark');
      this.innerHTML = '<span class="wn-mark-label">Your mark</span><span class="wn-mark-states" role="group" aria-label="Your mark"></span>'
        + '<textarea class="wn-mark-note" rows="1" placeholder="Note for the leader" aria-label="Note for the leader"></textarea>'
        + '<span class="wn-saved" aria-live="polite"></span>';
      this.wnGroup = this.querySelector('.wn-mark-states');
      this.wnNote = this.querySelector('.wn-mark-note');
      this.wnStatus = this.querySelector('.wn-saved');
      this.wnValue = '';
      this.wnSaveSeq = 0;
      this.wnGroup.addEventListener('click', function (e) {
        var b = e.target.closest ? e.target.closest('.wn-mark-state') : null;
        if (!b || !self.wnGroup.contains(b) || !trusted(e)) return;
        e.preventDefault();
        var v = b.getAttribute('data-state') || '';
        // Clicking the state already set clears it.
        self.wnValue = v === self.wnValue ? '' : v;
        self.wnDirty = true;
        self.wnPaint();
        self.wnSave();
      });
      this.wnNote.addEventListener('input', function (e) {
        if (!trusted(e)) return;
        self.wnDirty = true;
        clearTimeout(self.wnTimer);
        self.wnTimer = setTimeout(function () { self.wnSave(); }, 500);
      });
      this.wnPaint();
    }
    /** The state buttons, the current one pressed; a state the list does not name still shows. */
    wnPaint() {
      var list = this.wnStates.slice();
      var v = this.wnValue;
      if (v && !list.some(function (o) { return o.key === v; })) list.push({ key: v, label: v });
      this.wnGroup.innerHTML = list.map(function (o) {
        var on = o.key === v;
        return '<button type="button" class="wn-mark-state' + (on ? ' wn-on' : '') + '" data-state="' + esc(o.key)
          + '" aria-pressed="' + (on ? 'true' : 'false') + '">' + esc(o.label) + '</button>';
      }).join('');
    }
    wnSetStatus(text, failed) {
      this.wnStatus.textContent = text;
      this.wnStatus.classList.toggle('wn-failed', !!failed);
    }
    wnSave() {
      var self = this;
      clearTimeout(this.wnTimer);
      var mine = ++this.wnSaveSeq;
      this.wnSaving = true;
      this.wnSetStatus('Saving…');
      kit.request({ t: 'wn-board:mark', id: this.wnId, state: this.wnValue, note: this.wnNote.value }, function (ack) {
        if (mine !== self.wnSaveSeq) return; // a newer save owns the status line
        self.wnSaving = false;
        if (!ack.ok) { self.wnSetStatus(ack.error || 'Not saved', true); return; }
        self.wnDirty = false;
        if (ack.mark) state.marks[self.wnId] = ack.mark; else delete state.marks[self.wnId];
        self.wnSetStatus('Saved ' + kit.hhmm(new Date()));
      });
    }
    wnRender() {
      // What the user is typing (or has not saved yet) wins over what arrives.
      if (this.wnDirty || this.wnSaving || document.activeElement === this.wnNote) return;
      var mark = state.marks[this.wnId];
      var value = mark && mark.state ? mark.state : '';
      if (value !== this.wnValue) { this.wnValue = value; this.wnPaint(); }
      var note = mark && mark.note ? mark.note : '';
      if (this.wnNote.value !== note) this.wnNote.value = note;
    }
  }

  // ── <walnut-strip labels?>: sections counted by data-status, click to filter ──
  class WalnutStrip extends kit.Base {
    wnSetup() {
      var self = this;
      this.wnRecount = true;
      this.addEventListener('click', function (e) {
        var box = e.target.closest ? e.target.closest('.wn-box') : null;
        if (!box || !self.contains(box)) return;
        e.preventDefault();
        var f = box.getAttribute('data-f') || '';
        kit.applyFilter(f && f === kit.flags.filter ? '' : f);
      });
    }
    wnRender() {
      var counts = {};
      var sections = kit.topSections();
      sections.forEach(function (s) {
        var k = s.getAttribute('data-status');
        counts[k] = (counts[k] || 0) + 1;
      });
      function box(f, n, label) {
        return '<button type="button" class="wn-box" data-f="' + esc(f) + '" aria-pressed="'
          + (kit.flags.filter === f ? 'true' : 'false') + '"><b>' + n + '</b><span>' + esc(label) + '</span></button>';
      }
      var boxes = kit.parsePairs(this.getAttribute('labels'), DEFAULT_LABELS).map(function (l) {
        return box(l.key, counts[l.key] || 0, l.label);
      });
      kit.setHtml(this, '<div class="wn-strip" role="group" aria-label="Filter sections by status">'
        + boxes.join('') + box('', sections.length, 'All') + '</div>');
    }
  }

  // ── <walnut-unread>: the page's unread total; click goes to the first one ──
  class WalnutUnread extends kit.Base {
    wnSetup() {
      var self = this;
      this.wnRecount = true;
      this.addEventListener('click', function (e) { e.preventDefault(); self.wnJump(); });
      this.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); self.wnJump(); } });
    }
    wnJump() {
      var target = kit.threadEls().filter(function (t) { return kit.unreadIn(t.getAttribute('id')) > 0; })[0];
      if (!target) return;
      if (target.closest('[data-wn-hidden]')) kit.applyFilter('');
      kit.openAncestors(target);
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    wnRender() {
      var n = 0;
      kit.threadEls().forEach(function (t) { n += kit.unreadIn(t.getAttribute('id')); });
      var text = n === 0 ? 'No new messages' : n === 1 ? '1 new message' : n + ' new messages';
      kit.setHtml(this, '<span class="wn-unread" role="button" tabindex="0" data-count="' + n + '"><span class="wn-unread-n">'
        + text + '</span></span>');
    }
  }

  customElements.define('walnut-task', WalnutTask);
  customElements.define('walnut-thread', WalnutThread);
  customElements.define('walnut-mark', WalnutMark);
  customElements.define('walnut-strip', WalnutStrip);
  customElements.define('walnut-unread', WalnutUnread);
})(window.__wnBoardKit);
