/*
 * Board runtime, part 4 of 5 (the items): <walnut-mark>, <walnut-project>,
 * <walnut-check>, <walnut-choice> and the Remind me control (`kit.Remind`,
 * which <walnut-thread> uses too), built on the core in board-runtime.frame.js. Same
 * rules: plain ES2017, loaded as a string, runs only inside the board frame.
 *
 * These are the user talking to the leader, so every write starts from a
 * trusted event and goes up as a request the host acks: `wn-board:mark` (a
 * note), `wn-board:project` (a status the user picks), `wn-board:check`,
 * `wn-board:choice`, `wn-board:remind`. A check's hash is the server's (the
 * frame never hashes a point): "read" means read THIS version of its text.
 * A note's text also goes up on every keystroke (`wn-board:note-draft`, no
 * ack): the host keeps it until it is saved, because a board edit replaces this
 * document, and the next one gets it back in `note_drafts`.
 */
(function (kit) {
  'use strict';
  if (!kit || customElements.get('walnut-check')) return;
  var trusted = kit.trusted;
  var state = kit.state;
  var esc = kit.esc;
  var HOUR_MS = 3600 * 1000;

  function cssId(id) { return window.CSS && CSS.escape ? CSS.escape(id) : String(id).replace(/["\\]/g, '\\$&'); }
  function pad(n) { return n < 10 ? '0' + n : String(n); }
  /** A Date as the value of a datetime-local input (local time, minutes). */
  function localValue(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function presetAt(preset) {
    var d = new Date();
    if (preset === '1h') return new Date(d.getTime() + HOUR_MS);
    if (preset === '3h') return new Date(d.getTime() + 3 * HOUR_MS);
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    return d;
  }
  /** Who set a status, in the board's words. */
  function writerLabel(by) {
    if (by === 'human') return 'you';
    var id = String(by || '').indexOf('task:') === 0 ? by.slice(5) : '';
    if (id && id === state.boardTaskId) return 'the leader';
    var ref = id ? state.refs[id] : null;
    return ref && ref.title ? ref.title : 'a worker';
  }

  // ── Remind me: a trigger (where the host puts it) and an inline panel (never overflows) ──
  var openReminds = new Set();

  function Remind(host) {
    var self = this;
    this.host = host;
    this.open = false;
    this.busy = false;
    this.trigger = document.createElement('span');
    this.trigger.className = 'wn-remind';
    this.trigger.setAttribute('data-wn-ui', '');
    this.panel = document.createElement('div');
    this.panel.className = 'wn-remind-panel';
    this.panel.setAttribute('data-wn-ui', '');
    this.panel.hidden = true;
    this.panel.innerHTML = '<span class="wn-remind-label">Remind me</span>'
      + '<button type="button" class="wn-remind-preset" data-preset="1h">In 1 hour</button>'
      + '<button type="button" class="wn-remind-preset" data-preset="3h">In 3 hours</button>'
      + '<button type="button" class="wn-remind-preset" data-preset="tomorrow">Tomorrow 09:00</button>'
      + '<span class="wn-remind-pick"><input type="datetime-local" class="wn-remind-at" aria-label="Remind me at">'
      + '<button type="button" class="wn-remind-set">Set</button></span>'
      + '<span class="wn-remind-error" role="alert"></span>';
    this.input = this.panel.querySelector('.wn-remind-at');
    this.error = this.panel.querySelector('.wn-remind-error');
    this.trigger.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b || !self.trigger.contains(b)) return;
      e.preventDefault();
      if (!trusted(e)) return;
      if (b.classList.contains('wn-remind-clear')) self.save(null);
      else self.toggle(!self.open);
    });
    this.panel.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b || !self.panel.contains(b)) return;
      e.preventDefault();
      if (!trusted(e)) return;
      var preset = b.getAttribute('data-preset');
      if (preset) self.save(presetAt(preset).toISOString());
      else if (b.classList.contains('wn-remind-set')) self.saveInput();
    });
    this.panel.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); self.toggle(false); self.focusTrigger(); }
      else if (e.key === 'Enter' && e.target === self.input && trusted(e)) { e.preventDefault(); self.saveInput(); }
    });
  }
  Remind.prototype.target = function () { return this.host.getAttribute('id') || ''; };
  Remind.prototype.focusTrigger = function () {
    var b = this.trigger.querySelector('.wn-remind-btn');
    if (b) b.focus();
  };
  Remind.prototype.toggle = function (open) {
    var hadFocus = this.trigger.contains(document.activeElement);
    this.open = open;
    if (open) {
      openReminds.add(this);
      var r = kit.reminderOf(this.target());
      var at = r && !kit.reminderDue(r) ? new Date(r.at) : presetAt('1h');
      this.input.value = localValue(at);
      this.input.min = localValue(new Date());
      this.error.textContent = '';
    } else {
      openReminds.delete(this);
    }
    this.render();
    if (hadFocus) this.focusTrigger();
  };
  Remind.prototype.fail = function (text) { this.error.textContent = text; };
  Remind.prototype.saveInput = function () {
    var d = this.input.value ? new Date(this.input.value) : null;
    if (!d || isNaN(d.getTime())) { this.fail('Pick a date and time.'); return; }
    if (d.getTime() <= Date.now()) { this.fail('Pick a time in the future.'); return; }
    this.save(d.toISOString());
  };
  Remind.prototype.save = function (at) {
    var self = this;
    var target = this.target();
    if (!target || this.busy) return;
    this.busy = true;
    this.error.textContent = '';
    this.render();
    kit.request({ t: 'wn-board:remind', target: target, at: at }, function (ack) {
      self.busy = false;
      if (ack.ok) {
        if (ack.reminder) state.reminders[target] = ack.reminder; else delete state.reminders[target];
        self.toggle(false);
        kit.scheduleDue();
        kit.renderAll();
        return;
      }
      // The panel says what went wrong, and keeps what the user picked.
      if (!self.open) self.toggle(true);
      self.fail(ack.error || 'The reminder was not saved.');
      self.render();
    });
  };
  Remind.prototype.render = function () {
    var target = this.target();
    var r = kit.flags.hasData ? kit.reminderOf(target) : null;
    var due = kit.reminderDue(r);
    var mode = r ? (due ? 'due' : 'pending') : '';
    if ((this.host.getAttribute('data-reminder') || '') !== mode) {
      if (mode) this.host.setAttribute('data-reminder', mode); else this.host.removeAttribute('data-reminder');
    }
    var off = !kit.flags.hasData || !target;
    if (this.trigger.hidden !== off) this.trigger.hidden = off;
    if (this.panel.hidden !== (off || !this.open)) this.panel.hidden = off || !this.open;
    if (off) return;
    var dis = this.busy ? ' disabled' : '';
    var expanded = ' aria-expanded="' + (this.open ? 'true' : 'false') + '"';
    var html;
    if (!r) {
      html = '<button type="button" class="wn-remind-btn"' + expanded + dis + '>Remind me</button>';
    } else {
      var when = new Date(r.at);
      var tip = (due ? 'Reminder was due ' : 'Reminder at ') + when.toLocaleString() + (r.note ? ': ' + r.note : '') + '. Click to change it.';
      html = '<button type="button" class="wn-remind-btn ' + (due ? 'wn-remind-due' : 'wn-remind-on') + '"' + expanded + dis
        + ' title="' + esc(tip) + '">' + (due ? 'Reminder due' : 'Reminder ' + esc(kit.when(r.at))) + '</button>'
        + '<button type="button" class="wn-remind-clear" aria-label="Clear the reminder" title="Clear the reminder"' + dis + '>×</button>';
    }
    kit.setHtml(this.trigger, html);
  };
  // A click anywhere else closes an open panel (the trigger and the panel handle their own).
  // The path as dispatched: the trigger re-renders its buttons, so the target may be detached by now.
  document.addEventListener('click', function (e) {
    var path = e.composedPath ? e.composedPath() : [e.target];
    openReminds.forEach(function (rm) {
      if (path.indexOf(rm.trigger) < 0 && path.indexOf(rm.panel) < 0) rm.toggle(false);
    });
  });
  kit.Remind = Remind;

  // ── <walnut-mark id>: the user's note for the leader, saved in Walnut ──
  // (A project's status is <walnut-project>'s: the user picks it there. A `states`
  // attribute from an older board is ignored.)
  class WalnutMark extends kit.Base {
    get wnId() { return this.getAttribute('id') || ''; }
    wnSetup() {
      var self = this;
      this.classList.add('wn-mark');
      // Compact: one "Add note" button until the note has text.
      this.innerHTML = '<button type="button" class="wn-mark-note-toggle" aria-expanded="false">Add note</button>'
        + '<textarea class="wn-mark-note" rows="1" placeholder="Note for the leader" aria-label="Note for the leader" hidden></textarea>'
        + '<span class="wn-saved" aria-live="polite"></span>';
      this.wnNote = this.querySelector('.wn-mark-note');
      this.wnNoteToggle = this.querySelector('.wn-mark-note-toggle');
      this.wnStatus = this.querySelector('.wn-saved');
      this.wnSaveSeq = 0;
      this.wnNoteOpen = false;
      this.wnNoteToggle.addEventListener('click', function (e) {
        e.preventDefault();
        self.wnNoteOpen = true;
        self.wnPaintNote();
        self.wnNote.focus();
      });
      this.wnNote.addEventListener('blur', function () {
        if (!self.wnNote.value) { self.wnNoteOpen = false; self.wnPaintNote(); }
      });
      this.wnNote.addEventListener('input', function (e) {
        self.wnFit();
        if (!trusted(e)) return;
        self.wnDirty = true;
        // The host keeps the text until it is saved: a leader's board edit replaces this document.
        kit.send({ t: 'wn-board:note-draft', id: self.wnId, note: self.wnNote.value });
        clearTimeout(self.wnTimer);
        self.wnTimer = setTimeout(function () { self.wnSave(); }, 500);
      });
    }
    /** The note shows while it has text or the user opened it. */
    wnPaintNote() {
      var shown = this.wnNoteOpen || !!this.wnNote.value || document.activeElement === this.wnNote;
      if (this.wnNote.hidden !== !shown) this.wnNote.hidden = !shown;
      if (this.wnNoteToggle.hidden !== shown) this.wnNoteToggle.hidden = shown;
      this.wnNoteToggle.setAttribute('aria-expanded', shown ? 'true' : 'false');
      this.wnFit();
    }
    /** The note grows with its text (up to the CSS max-height, then it scrolls), so the user reads all of it. */
    wnFit() {
      var t = this.wnNote;
      if (t.hidden) return;
      t.style.height = 'auto';
      t.style.height = (t.scrollHeight + t.offsetHeight - t.clientHeight) + 'px';
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
      kit.request({ t: 'wn-board:mark', id: this.wnId, note: this.wnNote.value }, function (ack) {
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
      var note = mark && mark.note ? mark.note : '';
      // Typed in the document before this one and not saved yet: shown again, and saved now.
      var draft = Object.prototype.hasOwnProperty.call(state.note_drafts, this.wnId) ? state.note_drafts[this.wnId] : null;
      if (typeof draft === 'string' && draft !== note) {
        this.wnNote.value = draft;
        this.wnNoteOpen = true;
        this.wnDirty = true;
        this.wnPaintNote();
        this.wnSave();
        return;
      }
      if (this.wnNote.value !== note) this.wnNote.value = note;
      this.wnPaintNote();
    }
  }

  // ── <walnut-project id labels?>: the project's status pill (the user picks one there) and its tasks as chips ──
  var openPickers = new Set();

  class WalnutProject extends kit.Base {
    get wnId() { return this.getAttribute('id') || ''; }
    wnSetup() {
      var self = this;
      this.wnRecount = true;
      this.wnOpen = false;
      this.wnBusy = false;
      this.wnError = '';
      this.addEventListener('click', function (e) {
        var b = e.target.closest ? e.target.closest('button') : null;
        if (!b || !self.contains(b)) return;
        e.preventDefault();
        if (!trusted(e)) return;
        if (b.classList.contains('wn-proj-pill')) self.wnToggle(!self.wnOpen);
        else if (b.classList.contains('wn-proj-cancel')) self.wnToggle(false, true);
        else if (b.hasAttribute('data-pick')) self.wnPick(b.getAttribute('data-pick'));
      });
      this.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && self.wnOpen) { e.preventDefault(); self.wnToggle(false, true); }
      });
    }
    /** The four statuses Walnut knows, in order; `labels` only renames them (an unknown key is not offered). */
    wnLabels() {
      var custom = {};
      kit.parsePairs(this.getAttribute('labels'), '').forEach(function (l) { custom[l.key] = l.label; });
      return kit.parsePairs(kit.DEFAULT_LABELS).map(function (d) {
        return { key: d.key, label: Object.prototype.hasOwnProperty.call(custom, d.key) ? custom[d.key] : d.label };
      });
    }
    /** Open or close the picker; `refocus` puts the focus back on the pill. */
    wnToggle(open, refocus) {
      this.wnOpen = open;
      this.wnError = '';
      if (open) openPickers.add(this); else openPickers.delete(this);
      this.wnFocus = open ? 'pick' : refocus ? 'pill' : '';
      this.wnRender();
    }
    wnPick(status) {
      var self = this;
      var id = this.wnId;
      if (!id || this.wnBusy) return;
      // The status it already has: nothing to tell the leader.
      if (status === kit.projectStatus(id)) { this.wnToggle(false, true); return; }
      this.wnBusy = true;
      this.wnError = '';
      this.wnRender();
      kit.request({ t: 'wn-board:project', id: id, status: status }, function (ack) {
        self.wnBusy = false;
        if (!ack.ok) {
          self.wnError = ack.error || 'The status was not saved.';
          self.wnRender();
          return;
        }
        if (ack.project) state.projects[id] = ack.project; else delete state.projects[id];
        self.wnToggle(false, true);
        kit.applyProjects();
        kit.renderAll();
      });
    }
    wnRender() {
      if (!kit.flags.hasData) return;
      var id = this.wnId;
      var p = state.projects[id] || null;
      var status = kit.projectStatus(id);
      var labels = this.wnLabels();
      var label = status;
      labels.forEach(function (l) { if (l.key === status) label = l.label; });
      var by = p && (p.status_by || p.updated_by);
      var at = p && (p.status_at || p.updated_at);
      var tip = (p && p.status ? 'Set by ' + writerLabel(by) + (at ? ', ' + kit.when(at) : '') : 'From the board itself') + '. Click to change it.';
      // data-proj-status, never data-status: the strip counts [data-status] as sections.
      var pill = '<button type="button" class="wn-proj-pill' + (status ? '' : ' wn-proj-unset') + '"'
        + (status ? ' data-proj-status="' + esc(status) + '"' : '')
        + ' aria-haspopup="true" aria-expanded="' + (this.wnOpen ? 'true' : 'false') + '"' + (this.wnOpen ? ' hidden' : '')
        + ' title="' + esc(tip) + '">'
        + esc(status ? label : 'Set status') + '</button>';
      var pick = '';
      if (this.wnOpen) {
        var dis = this.wnBusy ? ' disabled' : '';
        pick = '<span class="wn-proj-pick" role="group" aria-label="Status of this project">'
          + labels.map(function (l) {
            var on = l.key === status;
            return '<button type="button" class="wn-proj-opt' + (on ? ' wn-on' : '') + '" data-pick="' + esc(l.key)
              + '" data-proj-status="' + esc(l.key) + '" aria-pressed="' + (on ? 'true' : 'false') + '"' + dis + '>' + esc(l.label) + '</button>';
          }).join('')
          + '<button type="button" class="wn-proj-cancel" aria-label="Close" title="Close"' + dis + '>×</button>'
          + (this.wnError ? '<span class="wn-proj-error" role="alert">' + esc(this.wnError) + '</span>' : '')
          + '</span>';
      }
      var tasks = p && Array.isArray(p.tasks) ? p.tasks : [];
      var chips = tasks.map(function (t) { return '<walnut-task id="' + esc(t) + '" compact></walnut-task>'; }).join('');
      // New data while the user is on a control (the leader edited the board) rebuilds the
      // buttons: the focus goes to the same control in the new ones.
      var had = this.contains(document.activeElement) ? document.activeElement : null;
      var keep = !had ? '' : had.hasAttribute('data-pick') ? 'opt:' + had.getAttribute('data-pick')
        : had.classList.contains('wn-proj-pill') ? 'pill' : had.classList.contains('wn-proj-cancel') ? 'cancel' : '';
      kit.setHtml(this, '<span class="wn-proj">' + pill + pick + (chips ? '<span class="wn-proj-tasks">' + chips + '</span>' : '') + '</span>');
      var focus = this.wnFocus;
      this.wnFocus = '';
      if (!focus && keep && !this.contains(document.activeElement)) {
        var same = keep === 'pill' ? this.querySelector('.wn-proj-pill') : keep === 'cancel' ? this.querySelector('.wn-proj-cancel')
          : this.querySelector('.wn-proj-opt[data-pick="' + kit.cssId(keep.slice(4)) + '"]');
        if (same) same.focus();
        return;
      }
      var target = focus === 'pill' ? this.querySelector('.wn-proj-pill')
        : focus === 'pick' ? this.querySelector('.wn-proj-opt.wn-on') || this.querySelector('.wn-proj-opt') : null;
      if (target) target.focus();
    }
  }
  // A click anywhere else closes an open picker (its own clicks are handled above).
  document.addEventListener('click', function (e) {
    var path = e.composedPath ? e.composedPath() : [e.target];
    openPickers.forEach(function (pk) { if (path.indexOf(pk) < 0) pk.wnToggle(false); });
  });

  // ── <walnut-check id>: one point; the author's children are its text, and one control goes first ──
  class WalnutCheck extends kit.Base {
    get wnId() { return this.getAttribute('id') || ''; }
    wnSetup() { this.classList.add('wn-check'); }
    wnBuild() {
      var self = this;
      var ctl = document.createElement('span');
      ctl.className = 'wn-check-ctl';
      ctl.setAttribute('data-wn-ui', '');
      ctl.innerHTML = '<button type="button" class="wn-check-box" aria-pressed="false"></button><span class="wn-check-hint" hidden></span>';
      this.wnCtl = ctl;
      this.wnBox = ctl.firstChild;
      this.wnHint = ctl.lastChild;
      this.wnBox.addEventListener('click', function (e) { e.preventDefault(); if (trusted(e)) self.wnToggle(); });
    }
    wnToggle() {
      var self = this;
      var id = this.wnId;
      var c = state.checks[id];
      if (!c || !c.hash || this.wnSaving) return;
      this.wnSaving = true;
      this.wnWant = !c.read;
      this.wnError = '';
      this.wnRender();
      kit.request({ t: 'wn-board:check', id: id, read: this.wnWant, hash: c.hash }, function (ack) {
        self.wnSaving = false;
        // A point that changed under the click comes back with its new hash, unread.
        if (ack.check) state.checks[id] = ack.check;
        self.wnError = ack.ok ? '' : ack.error || 'Not saved';
        kit.renderAll();
      });
    }
    wnRender() {
      var c = kit.flags.hasData ? state.checks[this.wnId] : null;
      if (!c || !c.hash) {
        // Not a point Walnut knows (yet): nothing extra on the page.
        if (this.wnCtl && this.wnCtl.parentNode === this) this.removeChild(this.wnCtl);
        this.removeAttribute('data-read');
        this.removeAttribute('data-changed');
        return;
      }
      if (!this.wnCtl) this.wnBuild();
      if (this.firstChild !== this.wnCtl) this.insertBefore(this.wnCtl, this.firstChild);
      var read = this.wnSaving ? !!this.wnWant : !!c.read;
      var changed = !read && !!c.changed;
      if (this.hasAttribute('data-read') !== read) this.toggleAttribute('data-read', read);
      if (this.hasAttribute('data-changed') !== changed) this.toggleAttribute('data-changed', changed);
      var label = read ? 'Read. Click to mark it unread.'
        : changed ? 'Changed since you read it. Click to mark it read.' : 'Mark as read';
      this.wnBox.setAttribute('aria-pressed', read ? 'true' : 'false');
      this.wnBox.setAttribute('aria-label', label);
      this.wnBox.title = label;
      this.wnBox.textContent = read ? '✓' : '';
      this.wnBox.disabled = !!this.wnSaving;
      var hint = this.wnError || (changed ? 'Changed' : '');
      this.wnHint.hidden = !hint;
      this.wnHint.textContent = hint;
      this.wnHint.classList.toggle('wn-failed', !!this.wnError);
    }
  }

  // ── <walnut-choice id options recommended? title? task?>: numbered options; the pick goes to the leader ──
  class WalnutChoice extends kit.Base {
    static get observedAttributes() { return ['title', 'options', 'recommended', 'task']; }
    attributeChangedCallback(name, oldValue, value) {
      // The title moves to data-title so the browser does not tooltip the whole choice.
      if (name === 'title' && value !== null) {
        this.setAttribute('data-title', value);
        this.removeAttribute('title');
      }
      if (kit.live.has(this)) this.wnRender();
    }
    get wnId() { return this.getAttribute('id') || ''; }
    wnSetup() {
      var self = this;
      this.classList.add('wn-choice');
      this.wnSending = '';
      this.wnStatus = '';
      this.wnFailed = false;
      // The author's own children (the context) stay between the title and the options.
      this.wnHead = document.createElement('div');
      this.wnHead.className = 'wn-choice-head';
      this.wnOpts = document.createElement('div');
      this.wnOpts.className = 'wn-choice-opts';
      this.wnOpts.setAttribute('role', 'group');
      this.wnFoot = document.createElement('div');
      this.wnFoot.className = 'wn-choice-foot';
      this.wnFoot.innerHTML = '<span class="wn-choice-status" aria-live="polite"></span>';
      [this.wnHead, this.wnOpts, this.wnFoot].forEach(function (el) { el.setAttribute('data-wn-ui', ''); });
      this.insertBefore(this.wnHead, this.firstChild);
      this.appendChild(this.wnOpts);
      this.appendChild(this.wnFoot);
      this.wnStatusEl = this.wnFoot.firstChild;
      if (kit.Remind) {
        this.wnRemind = new kit.Remind(this);
        this.wnFoot.appendChild(this.wnRemind.trigger);
        this.appendChild(this.wnRemind.panel);
      }
      this.wnOpts.addEventListener('click', function (e) {
        var b = e.target.closest ? e.target.closest('.wn-choice-opt') : null;
        if (!b || !self.wnOpts.contains(b)) return;
        e.preventDefault();
        if (trusted(e)) self.wnPick(b.getAttribute('data-option') || '');
      });
    }
    wnPick(value) {
      var self = this;
      var id = this.wnId;
      var cur = state.choices[id];
      if (!value || !id || !kit.flags.hasData || this.wnSending) return;
      if (cur && cur.option === value) return; // the chosen option again: nothing to send
      this.wnSending = value;
      this.wnStatus = 'Sending…';
      this.wnFailed = false;
      this.wnRender();
      kit.request({ t: 'wn-board:choice', id: id, option: value }, function (ack) {
        self.wnSending = '';
        if (ack.ok) {
          state.choices[id] = ack.choice || { option: value, at: new Date().toISOString() };
          // Answering clears a due reminder on it (the server does the same in that write).
          if (kit.reminderDue(kit.reminderOf(id))) delete state.reminders[id];
          var delivered = ack.delivery && (ack.delivery.state === 'queued' || ack.delivery.state === 'deferred');
          self.wnStatus = delivered ? 'Sent to the leader' : 'Saved. The leader sees it on the board.';
        } else {
          self.wnStatus = ack.error || 'Not sent';
          self.wnFailed = true;
        }
        kit.renderAll();
      });
    }
    wnRender() {
      var self = this;
      var id = this.wnId;
      var options = kit.parsePairs(this.getAttribute('options'), '');
      var rec = this.getAttribute('recommended') || '';
      var title = this.getAttribute('data-title') || '';
      var task = this.getAttribute('task') || '';
      kit.setHtml(this.wnHead, (title ? '<span class="wn-choice-title">' + esc(title) + '</span>' : '')
        + (task ? '<walnut-task id="' + esc(task) + '" compact></walnut-task>' : ''));
      this.wnHead.hidden = !title && !task;
      if (title) this.wnOpts.setAttribute('aria-label', title); else this.wnOpts.removeAttribute('aria-label');

      var answer = kit.flags.hasData ? state.choices[id] : null;
      var chosen = answer && answer.option ? answer.option : '';
      var shown = this.wnSending || chosen;
      var busy = !kit.flags.hasData || !!this.wnSending;
      var focused = this.wnOpts.contains(document.activeElement) ? document.activeElement.getAttribute('data-option') : null;
      kit.setHtml(this.wnOpts, options.map(function (o, i) {
        var on = o.key === shown;
        return '<button type="button" class="wn-choice-opt' + (on ? ' wn-on' : '') + (o.key === rec ? ' wn-rec' : '')
          + (on && self.wnSending ? ' wn-sending' : '') + '" data-option="' + esc(o.key) + '" aria-pressed="' + (on ? 'true' : 'false') + '"'
          + (busy ? ' disabled' : '') + '><span class="wn-choice-n">' + (i + 1) + '.</span><span class="wn-choice-label">'
          + esc(o.label) + '</span>' + (o.key === rec ? '<span class="wn-choice-rec">Recommended</span>' : '') + '</button>';
      }).join(''));
      if (focused !== null) {
        var again = this.wnOpts.querySelector('[data-option="' + cssId(focused) + '"]');
        if (again && document.activeElement !== again) again.focus();
      }

      // An answer the options no longer list still says what it was.
      var listed = options.filter(function (o) { return o.key === chosen; })[0];
      var status = this.wnStatus || (chosen
        ? (listed ? 'Answered' : 'You chose "' + (answer.label || chosen) + '"') + (answer.at ? ' ' + kit.when(answer.at) : '')
        : '');
      if (this.wnStatusEl.textContent !== status) this.wnStatusEl.textContent = status;
      this.wnStatusEl.classList.toggle('wn-failed', this.wnFailed);

      // Answered: here, and on every element the author linked to it (an overview row drops out by CSS).
      var answered = !!chosen;
      if (this.hasAttribute('data-answered') !== answered) this.toggleAttribute('data-answered', answered);
      var linked = id ? document.querySelectorAll('[data-choice="' + cssId(id) + '"]') : [];
      for (var i = 0; i < linked.length; i++) {
        if (linked[i].hasAttribute('data-answered') !== answered) linked[i].toggleAttribute('data-answered', answered);
      }
      if (this.wnRemind) this.wnRemind.render();
    }
  }

  customElements.define('walnut-mark', WalnutMark);
  customElements.define('walnut-project', WalnutProject);
  customElements.define('walnut-check', WalnutCheck);
  customElements.define('walnut-choice', WalnutChoice);
})(window.__wnBoardKit);
