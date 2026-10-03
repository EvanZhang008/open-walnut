/*
 * Board runtime, part 3 of 5 (the elements): <walnut-task>, <walnut-thread>,
 * <walnut-strip> and <walnut-unread>, built on the core in board-runtime.frame.js (`window.__wnBoardKit`,
 * with `richText` from board-markdown.frame.js). Same rules: plain ES2017,
 * loaded as a string, runs only inside the board frame. board-items.frame.js
 * (part 4) adds the project, check and choice elements and the Remind me
 * control the thread uses (`kit.Remind`); board-sections.frame.js (part 5)
 * adds the "updated" dots and takes the kit off window.
 *
 * Every element renders into its own light DOM (no shadow DOM, so the board's
 * CSS can restyle it) and re-renders from the kit's state on every data
 * message, keeping a typed draft, the focus and an opened <details>.
 */
(function (kit) {
  'use strict';
  if (!kit || customElements.get('walnut-task')) return;
  var trusted = kit.trusted;
  var state = kit.state;
  var esc = kit.esc;

  var PHASES = { TODO: 'To do', IN_PROGRESS: 'In progress', NEED_ACTION: 'Needs you', WAITING: 'Waiting', COMPLETE: 'Done' };
  // The first click on a message's × arms it for this long; the second deletes.
  var DELETE_ARM_MS = 4000;
  var DEFAULT_LABELS = kit.DEFAULT_LABELS;
  // A thread scrolled within this of its bottom stays pinned there as messages arrive.
  var PIN_SLACK_PX = 24;

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

  // ── <walnut-thread id title? task?>: a conversation, oldest first, composer below, unread ──
  var io = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        var el = en.target;
        // Half of it on screen, or (a thread taller than two screens) half the screen.
        el.wnVisible = en.isIntersecting
          && (en.intersectionRatio >= 0.5 || en.intersectionRect.height >= window.innerHeight * 0.5);
        if (el.wnVisible) el.wnArm(); else el.wnDisarm();
        // Coming into view (a section opened, a filter lifted): a pinned thread shows its newest message.
        if (en.isIntersecting) el.wnRepin();
      });
    }, { threshold: [0, 0.1, 0.25, 0.5, 0.75, 1] })
    : null;
  // The message area gets its size late (a <details> opens, a filter lifts, a row grows):
  // a pinned thread then goes back to its newest message.
  var ro = typeof ResizeObserver === 'function'
    ? new ResizeObserver(function (entries) {
      entries.forEach(function (en) {
        var thread = en.target.closest ? en.target.closest('walnut-thread') : null;
        if (thread && thread.wnPinned && thread.wnScroll) thread.wnToBottom();
      });
    })
    : null;

  function atBottom(s) { return s.scrollHeight - s.scrollTop - s.clientHeight <= PIN_SLACK_PX; }

  // The docked composer (TaskBoardPane) reports its sends: pending, then stored or failed.
  function threadsWithId(id) {
    return Array.prototype.filter.call(document.querySelectorAll('walnut-thread'), function (t) {
      return !!id && t.getAttribute('id') === id && !!t.wnLocal;
    });
  }
  kit.onHost['wn-board:sending'] = function (d) {
    threadsWithId(String(d.thread || '')).forEach(function (t) { t.wnSending(String(d.key || ''), String(d.text || '')); });
  };
  kit.onHost['wn-board:sent'] = function (d) {
    var thread = String(d.thread || '');
    if (d.message && typeof d.message === 'object' && d.message.id) kit.addMessage(thread, d.message);
    // Posting answers a due reminder on this thread (the server clears it in the same write).
    if (kit.reminderDue(kit.reminderOf(thread))) delete state.reminders[thread];
    threadsWithId(thread).forEach(function (t) { t.wnDropLocal(String(d.key || '')); });
    kit.renderAll();
  };
  kit.onHost['wn-board:send-failed'] = function (d) {
    threadsWithId(String(d.thread || '')).forEach(function (t) { t.wnFailLocal(String(d.key || ''), String(d.error || 'Not sent')); });
    kit.renderAll();
  };

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
      this.wnPinned = true;
      this.classList.add('wn-thread');
      // Like the app's chat: the conversation, then the composer under it. The
      // composer is Walnut's own (voice included), laid by the host over a slot
      // here (core: slotHtml): "Reply…" asks for it, and the host owns the draft.
      this.innerHTML = '<div class="wn-thread-head"><span class="wn-thread-title"></span>'
        + '<span class="wn-badge" hidden></span><span class="wn-thread-tools">'
        + '<a class="wn-mark-read" href="#" role="button" hidden>Mark read</a>'
        + '<button type="button" class="wn-fold-btn" hidden>Fold</button></span></div>'
        + '<button type="button" class="wn-fold-more" hidden></button>'
        + '<div class="wn-scroll-wrap" hidden><div class="wn-scroll"><div class="wn-msgs"></div></div>'
        + '<button type="button" class="wn-jump" hidden></button></div>'
        + '<div class="wn-composer"><button type="button" class="wn-reply" aria-pressed="false">Reply…</button></div>';
      this.wnReply = this.querySelector('.wn-reply');
      this.wnComposer = this.querySelector('.wn-composer');
      this.wnList = this.querySelector('.wn-msgs');
      this.wnScroll = this.querySelector('.wn-scroll');
      this.wnWrap = this.querySelector('.wn-scroll-wrap');
      this.wnJumpBtn = this.querySelector('.wn-jump');
      // A thread in a section marked done folds to its newest message (one click shows the rest).
      this.wnFoldMore = this.querySelector('.wn-fold-more');
      this.wnFoldBtn = this.querySelector('.wn-fold-btn');
      this.wnFoldMore.addEventListener('click', function (e) { e.preventDefault(); self.wnFold(false); });
      this.wnFoldBtn.addEventListener('click', function (e) { e.preventDefault(); self.wnFold(true); });
      // Scrolled up to read: new messages leave the position alone until the user is back at the bottom.
      this.wnScroll.addEventListener('scroll', function () {
        // A scroll the browser makes on its own (the area got its size) is not the reader leaving the bottom.
        if (self.wnScroll.clientHeight > 0) self.wnPinned = atBottom(self.wnScroll);
        self.wnPaintJump();
        if (self.wnVisible) self.wnArm();
        kit.reportView();
      }, { passive: true });
      this.wnJumpBtn.addEventListener('click', function (e) { e.preventDefault(); self.wnReveal(); });
      if (kit.Remind) {
        this.wnRemind = new kit.Remind(this);
        this.querySelector('.wn-thread-tools').appendChild(this.wnRemind.trigger);
        this.insertBefore(this.wnRemind.panel, this.wnWrap);
      }
      // Every write to Walnut starts from a trusted event: a synthetic one an
      // author script dispatched cannot open the reply box, post as the user or move a mark.
      this.wnReply.addEventListener('click', function (e) { e.preventDefault(); if (trusted(e)) self.wnCompose(); });
      this.wnReply.addEventListener('focus', function (e) { if (trusted(e)) self.wnCompose(); });
      this.querySelector('.wn-mark-read').addEventListener('click', function (e) { e.preventDefault(); if (trusted(e)) kit.markSeen(self.wnId); });
      // Delete is two trusted clicks (the sandbox has no allow-modals, so no confirm()).
      // One listener on the list: the rows are rebuilt on every render.
      this.wnArmed = '';
      this.wnDeleting = {};
      this.wnDeleteErrors = {};
      this.wnList.addEventListener('click', function (e) {
        var b = e.target && e.target.closest ? e.target.closest('.wn-del') : null;
        if (!b || !self.wnList.contains(b)) return;
        e.preventDefault();
        if (!trusted(e)) return;
        var id = b.getAttribute('data-id') || '';
        if (!id || self.wnDeleting[id]) return;
        var refocus = document.activeElement === b;
        if (self.wnArmed === id) self.wnDelete(id); else self.wnArmDelete(id);
        if (refocus) self.wnFocusDelete(id);
      });
    }
    wnAttach() {
      if (io) io.observe(this);
      if (ro) { ro.observe(this.wnScroll); ro.observe(this.wnList); }
    }
    wnDetach() {
      if (io) io.unobserve(this);
      if (ro) { ro.unobserve(this.wnScroll); ro.unobserve(this.wnList); }
      this.wnDisarm();
      this.wnDisarmDelete();
    }
    wnToBottom() {
      this.wnPinned = true;
      this.wnScroll.scrollTop = this.wnScroll.scrollHeight;
      this.wnPaintJump();
    }
    /**
     * One rule for every thread: oldest first, opened at the newest message, and
     * left where the reader scrolled. A thread laid out while hidden (a closed
     * <details>, a folded section) could not scroll, so it opened at its oldest;
     * this runs again when it is shown.
     */
    wnRepin() { if (this.wnPinned && this.wnScroll && !atBottom(this.wnScroll)) this.wnToBottom(); }
    /** The reader had scrolled up here before the board was rewritten: back to that spot. */
    wnKeepAt(top) {
      this.wnPinned = false;
      this.wnScroll.scrollTop = top;
      this.wnPaintJump();
    }
    /** A row inside the message area's view and the window's. */
    wnInView(row) {
      var r = row.getBoundingClientRect();
      var v = this.wnScroll.getBoundingClientRect();
      return r.top < v.bottom && r.bottom > v.top && r.top < window.innerHeight && r.bottom > 0;
    }
    /** Back to the newest message (the unread total and the thread's own way down). */
    wnReveal() { this.wnToBottom(); }
    /** The newest unread message: reading up to it is what marks the thread read. */
    wnNewestUnread() {
      var all = this.wnList.querySelectorAll('.wn-msg[data-unread]');
      return all.length ? all[all.length - 1] : null;
    }
    /** Scrolled up: a button back to the newest (naming what is unread). */
    wnPaintJump() {
      var show = !this.wnPinned && !this.wnWrap.hidden && !this.hasAttribute('data-folded');
      var n = show ? kit.unreadIn(this.wnId) : 0;
      var text = n === 0 ? 'Latest ↓' : n === 1 ? '1 new message ↓' : n + ' new messages ↓';
      if (this.wnJumpBtn.hidden !== !show) this.wnJumpBtn.hidden = !show;
      if (show && this.wnJumpBtn.textContent !== text) this.wnJumpBtn.textContent = text;
    }
    wnArmDelete(id) {
      var self = this;
      clearTimeout(this.wnArmTimer);
      this.wnArmed = id;
      delete this.wnDeleteErrors[id];
      this.wnArmTimer = setTimeout(function () {
        self.wnArmTimer = null;
        if (self.wnArmed === id) { self.wnArmed = ''; self.wnRender(); }
      }, DELETE_ARM_MS);
      this.wnRender();
    }
    wnDisarmDelete() { clearTimeout(this.wnArmTimer); this.wnArmTimer = null; this.wnArmed = ''; }
    /** A rebuilt row takes the focus back, so a keyboard user can confirm with a second Enter. */
    wnFocusDelete(id) {
      var all = this.wnList.querySelectorAll('.wn-del');
      for (var i = 0; i < all.length; i++) if (all[i].getAttribute('data-id') === id) { all[i].focus(); return; }
    }
    wnDelete(id) {
      var self = this;
      var thread = this.wnId;
      this.wnDisarmDelete();
      this.wnDeleting[id] = true;
      this.wnRender();
      kit.request({ t: 'wn-board:delete', thread: thread, id: id }, function (ack) {
        delete self.wnDeleting[id];
        if (ack.ok) kit.removeMessage(thread, id);
        else self.wnDeleteErrors[id] = ack.error || 'Not deleted';
        kit.renderAll();
      });
    }
    /** Visible for 1.5 s with the newest unread message in view: it has been read (as in the chat). */
    wnArm() {
      var self = this;
      if (this.wnTimer || kit.unreadIn(this.wnId) === 0) return;
      this.wnTimer = setTimeout(function () {
        self.wnTimer = null;
        if (!self.wnVisible || document.hidden) return;
        var row = self.wnNewestUnread();
        // Scrolled up away from it: it waits until the user is back down (the scroll re-arms this).
        if (!row || self.wnInView(row)) kit.markSeen(self.wnId);
      }, 1500);
    }
    wnDisarm() { clearTimeout(this.wnTimer); this.wnTimer = null; }
    /** Fold to the newest message (or open it all, at the newest). The reader's choice outlives a rewritten board. */
    wnFold(fold) {
      this.wnKeepOpen = false;
      kit.setFold('thread:' + this.wnId, !fold);
      this.wnRender();
      if (!fold) this.wnToBottom();
    }
    /** "Reply…": the host docks its composer for this thread (a click and its focus count once). */
    wnCompose() {
      var now = Date.now();
      if (this.wnComposeAt && now - this.wnComposeAt < 400) return;
      this.wnComposeAt = now;
      kit.markSeen(this.wnId);
      kit.send({
        t: 'wn-board:compose', thread: this.wnId,
        title: this.getAttribute('data-title') || this.wnId, task: this.getAttribute('task') || '',
      });
    }
    /** The docked composer is sending: a pending row, and the thread goes to its newest message. */
    wnSending(key, text) {
      // A new send retires the rows of earlier failures (their text is still in the reply box).
      this.wnLocal = this.wnLocal.filter(function (l) { return l.status !== 'failed'; })
        .concat([{ key: key, text: text, ts: new Date().toISOString(), status: 'pending' }]);
      this.wnPinned = true;
      this.wnKeepOpen = true;
      this.wnRender();
    }
    wnDropLocal(key) { this.wnLocal = this.wnLocal.filter(function (l) { return l.key !== key; }); }
    wnFailLocal(key, error) {
      this.wnLocal.forEach(function (l) { if (l.key === key) { l.status = 'failed'; l.error = error; } });
    }
    /** A stored message's × (armed: "Delete?"), and the error of a delete that failed. */
    wnDeleteControl(id) {
      var error = this.wnDeleteErrors[id];
      var head = error ? '<span class="wn-error">' + esc(error) + '</span>' : '';
      if (this.wnDeleting[id]) {
        return head + '<button type="button" class="wn-del wn-deleting" data-id="' + esc(id) + '" disabled>Deleting…</button>';
      }
      if (this.wnArmed === id) {
        return head + '<button type="button" class="wn-del wn-armed" data-id="' + esc(id)
          + '" aria-label="Click again to delete this message">Delete?</button>';
      }
      return head + '<button type="button" class="wn-del" data-id="' + esc(id) + '" aria-label="Delete this message">×</button>';
    }
    wnRow(m, cls, extra) {
      var unread = !cls && m.author !== 'user' && m.ts > (state.seen[this.wnId] || '');
      var stored = !cls && !!m.id;
      return '<div class="wn-msg' + (cls ? ' ' + cls : '') + '"' + (stored ? ' data-id="' + esc(m.id) + '"' : '')
        + ' data-ts="' + esc(m.ts) + '" data-author="' + esc(m.author) + '"'
        + (unread ? ' data-unread=""' : '') + '><div class="wn-msg-meta"><span class="wn-who">' + esc(kit.whoOf(m.author))
        + '</span><span class="wn-when">' + esc(kit.when(m.ts)) + '</span>' + (extra || '')
        + (stored ? this.wnDeleteControl(m.id) : '') + '</div><div class="wn-text">'
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
      // Composing here: the Reply… field gives its place to the slot Walnut's composer sits on.
      var composing = !!id && kit.flags.composing === id;
      if (this.wnReply.hidden !== composing) this.wnReply.hidden = composing;
      this.wnReply.setAttribute('aria-pressed', composing ? 'true' : 'false');
      var slot = this.wnComposer.querySelector('.wn-dock-slot');
      if (composing && !slot) { this.wnComposer.insertAdjacentHTML('beforeend', kit.slotHtml()); kit.trackSlot(); }
      if (!composing && slot) slot.remove();
      // Oldest first, newest last (equal times keep their append order); the rows
      // still being sent (or that failed) come last, as they are the newest.
      var rows = (state.threads[id] || []).map(function (m, i) { return { ts: m.ts, i: i, html: self.wnRow(m) }; });
      rows.sort(function (a, b) { return a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.i - b.i; });
      this.wnLocal.forEach(function (l) {
        var failed = l.status === 'failed';
        rows.push({
          html: self.wnRow({ author: 'user', ts: l.ts, text: l.text }, failed ? 'wn-failed' : 'wn-pending',
            failed ? '<span class="wn-error">' + esc(l.error) + '</span>' : ''),
        });
      });
      // Finished (its section is done) and not being written to: the newest message only (seeing it reads the thread).
      var section = this.closest('[data-status]');
      var done = !!section && section.getAttribute('data-status') === 'done';
      var folded = done && rows.length > 1 && !composing && !this.wnLocal.length && !this.wnKeepOpen
        && !kit.folds()['thread:' + id];
      if (this.hasAttribute('data-folded') !== folded) this.toggleAttribute('data-folded', folded);
      var more = folded ? (rows.length === 2 ? 'Show 1 earlier message' : 'Show ' + (rows.length - 1) + ' earlier messages') : '';
      if (this.wnFoldMore.hidden !== !folded) this.wnFoldMore.hidden = !folded;
      if (this.wnFoldMore.textContent !== more) this.wnFoldMore.textContent = more;
      var foldable = done && rows.length > 1 && !folded && !composing;
      if (this.wnFoldBtn.hidden !== !foldable) this.wnFoldBtn.hidden = !foldable;
      var before = this.wnList.wnHtml;
      kit.setHtml(this.wnList, rows.map(function (r) { return r.html; }).join(''));
      if (this.wnWrap.hidden !== (rows.length === 0)) this.wnWrap.hidden = rows.length === 0;
      if (this.wnList.wnHtml !== before && this.wnPinned) this.wnToBottom();
      this.wnPaintJump();
      if (this.wnRemind) this.wnRemind.render();
      if (n > 0 && this.wnVisible) this.wnArm();
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
      // A project counts once; an answered choice no longer needs the user (core countedStatuses).
      var sections = kit.countedStatuses();
      sections.forEach(function (k) { counts[k] = (counts[k] || 0) + 1; });
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
    /** Everything that waits for the user, in page order: unread threads, due reminders, updated sections. */
    wnTargets() {
      var list = kit.threadEls().filter(function (t) { return kit.unreadIn(t.getAttribute('id')) > 0; })
        .concat(kit.dueTargets(), kit.updatedSections ? kit.updatedSections() : []);
      return list.filter(function (el, i) { return list.indexOf(el) === i; }).sort(function (a, b) {
        return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
      });
    }
    wnJump() {
      var target = this.wnTargets()[0];
      if (!target) return;
      if (target.closest('[data-wn-hidden]') || target.hasAttribute('data-wn-hidden')) kit.applyFilter('');
      kit.openAncestors(target);
      if (target.tagName === 'DETAILS') target.open = true;
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      if (target.wnReveal) target.wnReveal();
    }
    wnRender() {
      var n = 0;
      kit.threadEls().forEach(function (t) { n += kit.unreadIn(t.getAttribute('id')); });
      var due = kit.dueTargets().length;
      var updated = kit.updatedSections ? kit.updatedSections().length : 0;
      var parts = [];
      if (n) parts.push(n === 1 ? '1 new message' : n + ' new messages');
      if (due) parts.push(due === 1 ? '1 reminder due' : due + ' reminders due');
      if (updated) parts.push(updated === 1 ? '1 updated section' : updated + ' updated sections');
      var text = parts.length ? parts.join(', ') : 'No new messages';
      kit.setHtml(this, '<span class="wn-unread" role="button" tabindex="0" data-count="' + (n + due + updated)
        + '"><span class="wn-unread-n">' + text + '</span></span>');
    }
  }

  customElements.define('walnut-task', WalnutTask);
  customElements.define('walnut-thread', WalnutThread);
  customElements.define('walnut-strip', WalnutStrip);
  customElements.define('walnut-unread', WalnutUnread);
})(window.__wnBoardKit);
