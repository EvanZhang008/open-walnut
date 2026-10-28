/*
 * Board runtime, part 4 of 5 (the items): <walnut-mark>, <walnut-project>,
 * <walnut-check>, <walnut-choice> and the Remind me control (`kit.Remind`,
 * which <walnut-thread> uses too), built on the core in board-runtime.frame.js. Same
 * rules: plain ES2017, loaded as a string, runs only inside the board frame.
 *
 * These are the user talking to the leader, so every write starts from a
 * trusted event and goes up as a request the host acks. An agent may tick a
 * point or answer a choice too (through the server, never this frame): its
 * record carries `by_name`, shown beside the result ("by the CEO"); the user's
 * own carries none and reads as it always did. Writes going up: `wn-board:mark` (a
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
  /** An agent's name on a record (`by` set and not the user), else '' (the user's own). */
  function agentName(by, name) { return by && by !== 'human' ? String(name || 'an agent') : ''; }
  function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
  /** Who set a status, in the board's words. */
  function writerLabel(by) {
    if (by === 'human') return 'you';
    if (by === 'agent') return 'an agent';
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
        + '<button type="button" class="wn-mark-voice" aria-pressed="false"'
        + ' title="Write the note in Walnut\'s composer, voice included">Dictate…</button>'
        + '<span class="wn-mark-by" hidden></span>'
        + '<span class="wn-saved" aria-live="polite"></span>';
      this.wnNote = this.querySelector('.wn-mark-note');
      this.wnBy = this.querySelector('.wn-mark-by');
      this.wnNoteToggle = this.querySelector('.wn-mark-note-toggle');
      this.wnVoice = this.querySelector('.wn-mark-voice');
      // The frame has no microphone: a trusted click asks the host to dock its
      // composer (voice included) over a slot here, as a thread's "Reply…" does.
      this.wnVoice.addEventListener('click', function (e) { e.preventDefault(); if (trusted(e)) self.wnCompose(); });
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
    /**
     * "Dictate…": the host docks its composer for this note, starting from the
     * text here, and owns the text from then on: it saves the composer's words,
     * or hands them back as the note's draft when the box closes. What is typed
     * here and not saved yet goes first, so the host's save is the last one.
     */
    wnCompose() {
      if (!this.wnId || !kit.flags.hasData) return;
      if (this.wnDirty) this.wnSave();
      this.wnDirty = false;
      // Back from the box, the field shows only if the note has text (a cleared one is "Add note" again).
      this.wnNoteOpen = false;
      kit.send({ t: 'wn-board:compose', mark: this.wnId, text: this.wnNote.value, title: 'Note for the leader' });
    }
    /** The note shows while it has text or the user opened it; while the host's composer is docked here, the slot shows instead. */
    wnPaintNote() {
      var composing = !!this.wnId && kit.flags.composingMark === this.wnId;
      var slot = this.querySelector('.wn-dock-slot');
      if (composing && !slot) { this.wnStatus.insertAdjacentHTML('beforebegin', kit.slotHtml()); kit.trackSlot(); }
      if (!composing && slot) slot.remove();
      if (this.wnVoice.hidden !== composing) this.wnVoice.hidden = composing;
      this.wnVoice.setAttribute('aria-pressed', composing ? 'true' : 'false');
      this.wnVoice.disabled = !kit.flags.hasData;
      if (composing) {
        if (!this.wnNote.hidden) this.wnNote.hidden = true;
        if (!this.wnNoteToggle.hidden) this.wnNoteToggle.hidden = true;
        return;
      }
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
      // The host's composer owns the note while it is docked here: its words come
      // back (saved, or as a kept draft this saves) when it closes.
      if (kit.flags.composingMark === this.wnId) { this.wnPaintNote(); return; }
      // What the user is typing (or has not saved yet) wins over what arrives.
      if (this.wnDirty || this.wnSaving || document.activeElement === this.wnNote) { this.wnPaintNote(); return; }
      var mark = state.marks[this.wnId];
      var note = mark && mark.note ? mark.note : '';
      // A note an agent wrote says so; the user's own carries no name.
      var by = mark && note ? agentName(mark.by, mark.by_name) : '';
      if (this.wnBy.hidden !== !by) this.wnBy.hidden = !by;
      if (this.wnBy.textContent !== (by ? 'Written by ' + by : '')) this.wnBy.textContent = by ? 'Written by ' + by : '';
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
      ctl.innerHTML = '<button type="button" class="wn-check-box" aria-pressed="false"></button><span class="wn-check-hint" hidden></span>'
        + '<span class="wn-check-by" hidden></span>';
      this.wnCtl = ctl;
      this.wnBox = ctl.querySelector('.wn-check-box');
      this.wnHint = ctl.querySelector('.wn-check-hint');
      this.wnBy = ctl.querySelector('.wn-check-by');
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
      // An agent's tick says whose it is; the user's own says nothing.
      var by = read && !this.wnSaving ? agentName(c.by, c.by_name) : '';
      var label = read ? 'Read' + (by ? ' by ' + by : '') + '. Click to mark it unread.'
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
      this.wnBy.hidden = !by;
      this.wnBy.textContent = by ? 'by ' + by : '';
      this.wnBy.title = by ? 'Marked read by ' + by + (c.read_at ? ', ' + kit.when(c.read_at) : '') : '';
    }
  }

  // ── <walnut-choice id options recommended? title? task?>: numbered options, or the user's
  // own words (the host's docked composer, as a thread's Reply… is); the answer goes to the leader ──
  class WalnutChoice extends kit.Base {
    static get observedAttributes() { return ['title', 'options', 'recommended', 'task', 'summary']; }
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
      // The user's own words: what they wrote, and the field that docks the composer for more.
      this.wnWords = document.createElement('div');
      this.wnWords.className = 'wn-choice-words';
      this.wnWords.hidden = true;
      this.wnOwn = document.createElement('div');
      this.wnOwn.className = 'wn-composer wn-choice-own';
      this.wnOwn.innerHTML = '<button type="button" class="wn-reply" aria-pressed="false">Answer in your own words…</button>';
      this.wnOwnBtn = this.wnOwn.firstChild;
      this.wnFoot = document.createElement('div');
      this.wnFoot.className = 'wn-choice-foot';
      this.wnFoot.innerHTML = '<span class="wn-choice-status" aria-live="polite"></span>'
        + '<button type="button" class="wn-fold-btn" hidden>Fold</button>';
      // Answered, the choice folds to one row (what was asked, what the user said, the
      // leader's `summary` of the outcome); a click opens it, and the view keeps that.
      this.wnFoldRow = document.createElement('button');
      this.wnFoldRow.type = 'button';
      this.wnFoldRow.className = 'wn-fold-row';
      this.wnFoldRow.setAttribute('aria-expanded', 'false');
      this.wnFoldRow.title = 'Answered. Click to open the whole choice.';
      this.wnFoldRow.hidden = true;
      [this.wnFoldRow, this.wnHead, this.wnOpts, this.wnWords, this.wnOwn, this.wnFoot].forEach(function (el) { el.setAttribute('data-wn-ui', ''); });
      this.insertBefore(this.wnHead, this.firstChild);
      this.insertBefore(this.wnFoldRow, this.wnHead);
      this.wnFoldBtn = this.wnFoot.querySelector('.wn-fold-btn');
      this.wnFoldRow.addEventListener('click', function (e) { e.preventDefault(); self.wnFold(false); });
      this.wnFoldBtn.addEventListener('click', function (e) { e.preventDefault(); self.wnFold(true); });
      this.appendChild(this.wnOpts);
      this.appendChild(this.wnWords);
      this.appendChild(this.wnOwn);
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
      // Only a trusted click or focus docks the composer (an author script cannot answer for the user).
      this.wnOwnBtn.addEventListener('click', function (e) { e.preventDefault(); if (trusted(e)) self.wnCompose(); });
      this.wnOwnBtn.addEventListener('focus', function (e) { if (trusted(e)) self.wnCompose(); });
    }
    /** Fold (or open) an answered choice. The reader's choice outlives a rewritten board (core: setFold). */
    wnFold(fold) {
      this.wnKeepOpen = false;
      kit.setFold('choice:' + this.wnId, !fold);
      this.wnRender();
    }
    /** "Answer in your own words…": the host docks its composer for this choice (a click and its focus count once). */
    wnCompose() {
      var now = Date.now();
      if (!this.wnId || (this.wnComposeAt && now - this.wnComposeAt < 400)) return;
      this.wnComposeAt = now;
      kit.send({
        t: 'wn-board:compose', choice: this.wnId,
        title: this.getAttribute('data-title') || this.wnId, task: this.getAttribute('task') || '',
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
          // Answered just now, here: it stays open under the user's eyes until the board is rewritten.
          self.wnKeepOpen = true;
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

      // The words, beside the pick or instead of it (the user's, or an agent's that says so).
      var words = answer && answer.text ? String(answer.text) : '';
      var pickBy = answer ? agentName(answer.by, answer.by_name) : '';
      var wordsBy = answer ? agentName(answer.text_by, answer.text_by_name) : '';
      kit.setHtml(this.wnWords, words
        ? '<div class="wn-msg-meta"><span class="wn-who">' + (wordsBy ? esc(cap(wordsBy)) + ' wrote' : 'You wrote') + '</span>'
          + (answer.text_at ? '<span class="wn-when">' + esc(kit.when(answer.text_at)) + '</span>' : '')
          + '</div><div class="wn-text">' + kit.richText(words) + '</div>'
        : '');
      if (this.wnWords.hidden !== !words) this.wnWords.hidden = !words;
      // Answering here: the field gives its place to the slot Walnut's composer sits on.
      var composing = !!id && kit.flags.composingChoice === id;
      var ownText = words ? 'Change your words…' : 'Answer in your own words…';
      if (this.wnOwnBtn.textContent !== ownText) this.wnOwnBtn.textContent = ownText;
      if (this.wnOwnBtn.hidden !== composing) this.wnOwnBtn.hidden = composing;
      this.wnOwnBtn.setAttribute('aria-pressed', composing ? 'true' : 'false');
      this.wnOwnBtn.disabled = !kit.flags.hasData;
      var slot = this.wnOwn.querySelector('.wn-dock-slot');
      if (composing && !slot) { this.wnOwn.insertAdjacentHTML('beforeend', kit.slotHtml()); kit.trackSlot(); }
      if (!composing && slot) slot.remove();

      // An answer the options no longer list still says what it was.
      var listed = options.filter(function (o) { return o.key === chosen; })[0];
      var status = this.wnStatus || (chosen
        ? (listed ? 'Answered' + (pickBy ? ' by ' + pickBy : '') : (pickBy ? cap(pickBy) : 'You') + ' chose "' + (answer.label || chosen) + '"')
          + (answer.at ? ' ' + kit.when(answer.at) : '')
        : words ? (wordsBy ? 'Answered by ' + wordsBy : 'Answered in your own words') : '');
      if (this.wnStatusEl.textContent !== status) this.wnStatusEl.textContent = status;
      this.wnStatusEl.classList.toggle('wn-failed', this.wnFailed);

      // Answered (a pick or the user's words): here, and on every element the author
      // linked to it (an overview row drops out by CSS).
      var answered = !!chosen || !!words;
      if (this.hasAttribute('data-answered') !== answered) this.toggleAttribute('data-answered', answered);
      var folded = answered && !this.wnKeepOpen && !this.wnSending && !composing && !kit.folds()['choice:' + id];
      if (this.hasAttribute('data-folded') !== folded) this.toggleAttribute('data-folded', folded);
      if (this.wnFoldRow.hidden !== !folded) this.wnFoldRow.hidden = !folded;
      if (folded) {
        var summary = (this.getAttribute('summary') || '').trim();
        var pick = chosen ? (listed ? listed.label : answer.label || chosen) : '';
        var said = words.replace(/\s+/g, ' ').trim();
        var at = answer.text_at && (!answer.at || answer.text_at > answer.at) ? answer.text_at : answer.at;
        // Whose answer it is: the pick's writer, else the words' (none for the user's own).
        var foldBy = chosen ? pickBy : wordsBy;
        kit.setHtml(this.wnFoldRow, '<span class="wn-fold-caret" aria-hidden="true">\u25b8</span>'
          + '<span class="wn-fold-title">' + esc(title || id) + '</span>'
          + (pick ? '<span class="wn-fold-pick">' + esc(pick) + '</span>' : '')
          + (summary ? '<span class="wn-fold-sum">' + esc(summary) + '</span>'
            : said ? '<span class="wn-fold-sum wn-fold-words">"' + esc(said.length > 140 ? said.slice(0, 139) + '\u2026' : said) + '"</span>' : '')
          + (foldBy ? '<span class="wn-fold-by">by ' + esc(foldBy) + '</span>' : '')
          + (at ? '<span class="wn-fold-when">' + esc(kit.when(at)) + '</span>' : ''));
      }
      var foldable = answered && !folded && !composing && !this.wnSending;
      if (this.wnFoldBtn.hidden !== !foldable) this.wnFoldBtn.hidden = !foldable;
      var linked = id ? document.querySelectorAll('[data-choice="' + cssId(id) + '"]') : [];
      for (var i = 0; i < linked.length; i++) {
        if (linked[i].hasAttribute('data-answered') !== answered) linked[i].toggleAttribute('data-answered', answered);
      }
      if (this.wnRemind) this.wnRemind.render();
    }
  }

  // The user's words on a choice were saved through the docked composer: how far they went.
  kit.onHost['wn-board:choice-words'] = function (d) {
    var id = String(d.id || '');
    var delivered = d.delivery && (d.delivery.state === 'queued' || d.delivery.state === 'deferred');
    var all = id ? document.querySelectorAll('walnut-choice[id="' + cssId(id) + '"]') : [];
    for (var i = 0; i < all.length; i++) {
      all[i].wnStatus = delivered ? 'Sent to the leader' : 'Saved. The leader sees it on the board.';
      all[i].wnFailed = false;
      all[i].wnKeepOpen = true;
    }
    kit.renderAll();
  };

  customElements.define('walnut-mark', WalnutMark);
  customElements.define('walnut-project', WalnutProject);
  customElements.define('walnut-check', WalnutCheck);
  customElements.define('walnut-choice', WalnutChoice);
})(window.__wnBoardKit);
