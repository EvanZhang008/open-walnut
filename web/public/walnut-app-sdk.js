/**
 * Walnut plugin-app SDK — load it in a plugin app page, get `window.Walnut`.
 *
 *   <script src="/walnut-app-sdk.js"></script>
 *   <script>
 *     Walnut.ready(function (ctx) {           // ctx = { appId, pluginId, theme }
 *       Walnut.api('GET', '/api/tasks').then(function (tasks) { render(tasks); });
 *       Walnut.on('task:', function (name, data) { refresh(); });
 *       document.getElementById('home').onclick = function () { Walnut.open('/'); };
 *     });
 *   </script>
 *
 * Your page runs in a sandboxed iframe with NO same-origin access: no Walnut
 * localStorage, no device token, no direct fetch to /api. Everything goes
 * through the four postMessage calls this file wraps. Plain ES5, no build step.
 */
(function (window) {
  'use strict';

  var API_TIMEOUT_MS = 30000;
  /** Retry the handshake once — the host may attach its listener after our load. */
  var READY_RETRY_MS = 500;

  var readyCallbacks = [];
  var context = null;              // { appId, pluginId, theme } once init arrives
  var pending = {};                // id → { resolve, reject, timer }
  var listeners = [];              // { prefix, cb }
  var nextId = 0;

  /** Post a message to the Walnut host. '*' because our origin is opaque. */
  function send(msg) {
    window.parent.postMessage(msg, '*');
  }

  function handleInit(payload) {
    if (context) return;           // ignore a duplicate init from the retry
    context = payload || {};
    var cbs = readyCallbacks;
    readyCallbacks = [];
    for (var i = 0; i < cbs.length; i++) {
      try { cbs[i](context); } catch (e) { console.error('[walnut-sdk] ready callback failed', e); }
    }
  }

  function handleApiResult(msg) {
    var entry = pending[msg.id];
    if (!entry) return;
    delete pending[msg.id];
    clearTimeout(entry.timer);
    if (msg.ok) entry.resolve(msg.data);
    else entry.reject({ status: msg.status, error: msg.error || 'request failed' });
  }

  function handleEvent(msg) {
    for (var i = 0; i < listeners.length; i++) {
      if (msg.name.indexOf(listeners[i].prefix) !== 0) continue;
      try { listeners[i].cb(msg.name, msg.data); }
      catch (e) { console.error('[walnut-sdk] event callback failed', e); }
    }
  }

  window.addEventListener('message', function (event) {
    var msg = event.data;
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
    if (msg.type === 'walnut:init') handleInit(msg.payload);
    else if (msg.type === 'walnut:api-result') handleApiResult(msg);
    else if (msg.type === 'walnut:event') handleEvent(msg);
  });

  var Walnut = {
    /**
     * Run `cb(ctx)` once the host has answered the handshake. Registering after
     * init already arrived calls back immediately.
     * @param {function({appId: string, pluginId: string, theme: string})} cb
     */
    ready: function (cb) {
      if (typeof cb !== 'function') return;
      if (context) { cb(context); return; }
      readyCallbacks.push(cb);
    },

    /**
     * Call a Walnut HTTP API through the host. Resolves with the parsed body;
     * rejects with `{ status, error }`. Config WRITES are refused by the host
     * (change provider settings in Walnut's own Settings UI).
     * @param {'GET'|'POST'|'PUT'|'PATCH'|'DELETE'} method
     * @param {string} path e.g. '/api/tasks'
     * @param {*} [body] JSON-serializable request body
     * @returns {Promise<*>}
     */
    api: function (method, path, body) {
      return new Promise(function (resolve, reject) {
        var id = 'a' + (++nextId);
        var timer = setTimeout(function () {
          delete pending[id];
          reject({ status: undefined, error: 'timed out after ' + API_TIMEOUT_MS + 'ms' });
        }, API_TIMEOUT_MS);
        pending[id] = { resolve: resolve, reject: reject, timer: timer };
        send({ type: 'walnut:api', id: id, method: method, path: path, body: body });
      });
    },

    /**
     * Subscribe to Walnut bus events whose name starts with `prefix` (pass a
     * full name for an exact one, e.g. 'task:created', or 'task:' for all task
     * events). Every registered prefix is re-sent as ONE subscribe message.
     * Host cap: 16 prefixes.
     * @param {string} prefix
     * @param {function(string, *)} cb receives (eventName, data)
     * @returns {function()} unsubscribe
     */
    on: function (prefix, cb) {
      if (typeof prefix !== 'string' || typeof cb !== 'function') return function () {};
      var entry = { prefix: prefix, cb: cb };
      listeners.push(entry);
      resubscribe();
      return function () {
        var i = listeners.indexOf(entry);
        if (i >= 0) listeners.splice(i, 1);
        resubscribe();
      };
    },

    /**
     * Navigate the Walnut SPA (the app stays embedded only if you open another
     * /apps/… path). Must be an absolute in-app path.
     * @param {string} path e.g. '/tasks'
     */
    open: function (path) {
      send({ type: 'walnut:open', path: path });
    },
  };

  function resubscribe() {
    var prefixes = [];
    for (var i = 0; i < listeners.length; i++) {
      if (prefixes.indexOf(listeners[i].prefix) === -1) prefixes.push(listeners[i].prefix);
    }
    send({ type: 'walnut:subscribe', prefixes: prefixes });
  }

  window.Walnut = Walnut;

  // Handshake: announce ourselves now, and once more shortly after in case the
  // host's listener attached after this script ran.
  send({ type: 'walnut:ready' });
  setTimeout(function () {
    if (!context) send({ type: 'walnut:ready' });
  }, READY_RETRY_MS);
})(window);
