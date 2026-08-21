/*
 * Hello Walnut app — plain JS, no framework, no network of its own.
 *
 * Everything reaches Walnut through the SDK loaded by index.html:
 *   Walnut.ready(cb)              -> cb({ appId, pluginId, theme })
 *   Walnut.api(method, path, body) -> Promise with the parsed JSON body
 *   Walnut.on(prefix, cb)          -> live event-bus frames; returns unsubscribe
 *   Walnut.open(path)              -> navigate the host console
 *
 * The page runs in a sandboxed iframe, so there is no cookie, no localStorage,
 * and no direct fetch to /api. Walnut.api is the only door.
 */

const el = (id) => document.getElementById(id);

// ── Boot ────────────────────────────────────────────────────────────────────

Walnut.ready((ctx) => {
  applyTheme(ctx.theme);
  loadStatus();
  loadTasks();
  watchTaskEvents();
});

/** The host tells us which theme it is in; mirror it instead of guessing. */
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'dark' ? 'dark' : 'light';
}

// ── Server status ───────────────────────────────────────────────────────────
// GET /api/v1/status -> { mode, cloud, version, serverTime, lastSyncAt? }

async function loadStatus() {
  try {
    const status = await Walnut.api('GET', '/api/v1/status');
    el('status-mode').textContent = status.mode === 'REPLICA' ? 'Cloud replica' : 'Primary';
    el('status-version').textContent = status.version || 'unknown';
    el('status-time').textContent = formatTime(status.serverTime);
    el('status-dot').dataset.state = 'ok';
  } catch (err) {
    el('status-mode').textContent = 'unreachable';
    el('status-version').textContent = '—';
    el('status-time').textContent = '—';
    el('status-dot').dataset.state = 'bad';
    console.warn('status failed', err);
  }
}

// ── Recent tasks ────────────────────────────────────────────────────────────
// GET /api/v1/tasks -> { tasks: [ProjectedTask], syncedAt }
// Scope is all open tasks plus the last 14 days of completions, so sorting by
// updated_at and taking five gives "what I touched recently".

const TASK_LIMIT = 5;

async function loadTasks() {
  const list = el('tasks-list');
  try {
    const payload = await Walnut.api('GET', '/api/v1/tasks');
    const tasks = (payload.tasks || [])
      .slice()
      .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
      .slice(0, TASK_LIMIT);

    if (tasks.length === 0) {
      list.innerHTML = '<li class="empty">No tasks yet.</li>';
      return;
    }

    list.textContent = '';
    for (const task of tasks) {
      list.appendChild(taskRow(task));
    }
  } catch (err) {
    list.innerHTML = '<li class="empty">Could not load tasks.</li>';
    console.warn('tasks failed', err);
  }
}

function taskRow(task) {
  const li = document.createElement('li');
  li.className = 'task';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'task-open';
  // Walnut.open navigates the HOST console, which is how an app hands the user
  // back to the real UI instead of trying to rebuild it.
  button.addEventListener('click', () => Walnut.open('/tasks'));

  const title = document.createElement('span');
  title.className = 'task-title';
  title.textContent = task.title;

  const meta = document.createElement('span');
  meta.className = 'task-meta';
  meta.textContent = [task.project || 'Inbox', prettyStatus(task.status)].join(' · ');

  button.append(title, meta);
  li.appendChild(button);
  return li;
}

function prettyStatus(status) {
  if (status === 'in_progress') return 'in progress';
  if (status === 'done') return 'done';
  return 'todo';
}

el('tasks-refresh').addEventListener('click', () => {
  el('tasks-list').innerHTML = '<li class="empty">Loading…</li>';
  loadTasks();
});

// ── Send a message to the Personal AI ───────────────────────────────────────
// Message ids are per-conversation, and v1 conversation ids look like
// `conv-…` — there is no "main" alias on this path. So: take the most recent
// conversation, or create one when the box has none yet.
//   GET  /api/v1/conversations?limit=1     -> [ { id, title?, updatedAt, … } ]
//   POST /api/v1/conversations             -> 201 { id }
//   POST /api/v1/conversations/<id>/messages { text } -> 202 { turnId }

async function resolveConversationId() {
  const list = await Walnut.api('GET', '/api/v1/conversations?limit=1');
  if (Array.isArray(list) && list.length > 0 && list[0].id) return list[0].id;
  const created = await Walnut.api('POST', '/api/v1/conversations', { title: 'Hello Walnut' });
  return created.id;
}

el('say-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = el('say-text');
  const hint = el('say-hint');
  const button = el('say-send');
  const text = input.value.trim();
  if (!text) return;

  button.disabled = true;
  hint.textContent = 'Sending…';
  try {
    const conversationId = await resolveConversationId();
    await Walnut.api('POST', `/api/v1/conversations/${conversationId}/messages`, { text });
    input.value = '';
    hint.textContent = 'Sent. The turn runs in the background — open the chat to read the reply.';
  } catch (err) {
    // 409 turn_active means a turn is already running on that conversation.
    hint.textContent = `Could not send: ${err && err.message ? err.message : 'unknown error'}`;
  } finally {
    button.disabled = false;
  }
});

// ── Live task events ────────────────────────────────────────────────────────
// Walnut.on takes ONE event-name PREFIX, so 'task:' covers task:created,
// task:updated, task:completed, task:deleted, task:phase-changed, and so on.

const EVENT_LOG_LIMIT = 6;
let eventCount = 0;

function watchTaskEvents() {
  Walnut.on('task:', (event) => {
    eventCount += 1;
    el('events-count').textContent = String(eventCount);
    logEvent(event);
    // A task event means the list we drew is stale.
    if (event.name === 'task:created' || event.name === 'task:deleted') loadTasks();
  });
}

function logEvent(event) {
  const list = el('events-list');
  const placeholder = list.querySelector('.empty');
  if (placeholder) placeholder.remove();

  const li = document.createElement('li');
  li.className = 'event';

  const name = document.createElement('code');
  name.textContent = event.name;

  const label = document.createElement('span');
  const task = event.data && event.data.task;
  label.textContent = task && task.title ? task.title : '';

  const time = document.createElement('time');
  time.textContent = formatTime(new Date().toISOString());

  li.append(name, label, time);
  list.prepend(li);

  while (list.children.length > EVENT_LOG_LIMIT) {
    list.removeChild(list.lastChild);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatTime(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
